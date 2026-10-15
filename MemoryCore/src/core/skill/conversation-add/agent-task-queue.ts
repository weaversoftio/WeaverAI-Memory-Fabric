/**
 * SkillAgentTaskQueue — agent-level scheduling signal + short lock protecting `_tasks.json`.
 *
 * Corresponds to design doc §5, §9.
 *
 * The abstract interface `ISkillAgentTaskQueue` defines three groups of capabilities:
 *   1) agent queue (List + Set): enqueueAgent / dequeueAgent / requeueAgent / removeAgent
 *   2) tasks-mutex (protects read-modify-write of `_tasks.json`, second-level TTL): withTasksMutex
 *   3) extract-lock (Worker's exclusive right to extract an agent, TTL 10 min): acquire/renew/releaseExtractLock
 *
 * The production implementation uses Redis (`RedisSkillAgentTaskQueue`, in this file),
 * the test implementation is in-memory (`LocalSkillAgentTaskQueue`, in this file).
 *
 * agent tuple serialization format:
 *   `{space}|{user}|{team}|{agent}` — identical to the Redis List element and the lock key suffix.
 */

import { randomUUID } from "node:crypto";

// ── Common types ──────────────────────────────────────────────────────────

/**
 * Agent 5-tuple: (instance_id, space_id, user_id, team_id, agent_id).
 *
 * Extended from 4 segments to 5 on 2026-07-30: instance_id added so a worker can route from the queue element
 * itself to the matching instance's storage / database / LLM resources, no longer relying on the historical coupling of
 * "a worker bound to per-instance resources". See
 * docs/design/2026-07-30-skill-worker-instance-decoupling.md.
 *
 * Compatibility:
 *   - parseAgentTuple receiving a 4-segment string → instance_id = "__legacy__",
 *     which the upper-layer worker drops with an error log when it sees __legacy__.
 *   - No segment may contain `|` (aligned with ID_FORBIDDEN_CHAR in add-handler),
 *     and serialize throws when it detects one.
 */
export interface AgentTuple {
  instance_id: string;
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
}

/** Fallback instance_id value when deserializing an old 4-segment tuple. See the AgentTuple comment. */
export const LEGACY_INSTANCE_ID = "__legacy__";

const TUPLE_FORBIDDEN_CHAR = "|";

function assertTupleField(name: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[skill-agent-queue] ${name} must be a non-empty string`);
  }
  if (value.includes(TUPLE_FORBIDDEN_CHAR)) {
    throw new Error(
      `[skill-agent-queue] ${name} cannot contain '${TUPLE_FORBIDDEN_CHAR}': got ${JSON.stringify(value)}`,
    );
  }
}

export function serializeAgentTuple(a: AgentTuple): string {
  assertTupleField("instance_id", a.instance_id);
  assertTupleField("space_id", a.space_id);
  assertTupleField("user_id", a.user_id);
  assertTupleField("team_id", a.team_id);
  assertTupleField("agent_id", a.agent_id);
  return `${a.instance_id}|${a.space_id}|${a.user_id}|${a.team_id}|${a.agent_id}`;
}

export function parseAgentTuple(raw: string): AgentTuple | null {
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length === 5) {
    const [instance_id, space_id, user_id, team_id, agent_id] = parts;
    if (!instance_id || !space_id || !user_id || !team_id || !agent_id) return null;
    return { instance_id, space_id, user_id, team_id, agent_id };
  }
  if (parts.length === 4) {
    // Legacy 4 segments: old-format leftovers may exist in Redis during the upgrade transition. Treated as __legacy__;
    // the upper-layer worker drops them with an error log. We do not return null here so the upper layer
    // can clearly recognize them as legacy rather than a parse error (null would be treated as corrupt data).
    const [space_id, user_id, team_id, agent_id] = parts;
    if (!space_id || !user_id || !team_id || !agent_id) return null;
    return {
      instance_id: LEGACY_INSTANCE_ID,
      space_id,
      user_id,
      team_id,
      agent_id,
    };
  }
  return null;
}

export interface ExtractLockHandle {
  key: string;      // string of the serialized agent tuple
  token: string;    // release/renew credential
}

/**
 * peekAgent implementation strategy, reflecting the capability level of the underlying Redis (three-level fallback):
 *
 *   - "lmove"                — native LMOVE k k RIGHT LEFT (Redis 6.2+), server-side atomic
 *   - "evalsha"              — SCRIPT LOAD + EVALSHA (Redis 2.6+), Lua single-threaded, atomically equivalent
 *   - "eval"                 — full-script EVAL each time (intermediate state when evalsha fails but eval works; currently unused)
 *   - "rpop_lpush_downgrade" — last-resort fallback: only RPOP, with the caller (extract-worker) requeueing
 *                              itself inside tasks-mutex. **Non-atomic**, with the millisecond window of v1 §4.5; on this path
 *                              the selfHealScan periodic scan fallback must be enabled
 *
 * The strategy is probed by `RedisSkillAgentTaskQueue.probePeekStrategy` on the first peekAgent call,
 * and the result is cached on the instance so later calls branch directly. See docs/design/2026-07-21-skill-worker-crash-recovery.md §5.
 */
export type PeekStrategy = "lmove" | "evalsha" | "eval" | "rpop_lpush_downgrade";

export interface ISkillAgentTaskQueue {
  // ── Agent queue ──
  /**
   * Idempotent enqueue. If the Set already contains it, no repeated LPUSH. Returns whether this was a "new enqueue" (true on first entry into the Set).
   */
  enqueueAgent(tuple: AgentTuple): Promise<boolean>;
  /**
   * BRPOP-style dequeue. Blocks until an element arrives or the timeout; returns null on timeout.
   * Note: dequeue only pops from the List and does not delete from the Set (the Worker decides after processing whether to requeue or remove).
   */
  dequeueAgent(blockMs: number): Promise<AgentTuple | null>;
  /**
   * At-least-once peek: after getting an agent, the agent stays in the List (atomic LMOVE semantics:
   * pop tail → push head). If the worker crashes at any moment, the next peek/dequeue round can get it again,
   * completely closing the "taken out but not finished" millisecond window left over from v1 §4.5.
   *
   * Semantics:
   *   - blockMs=0    → try peek once and return (null immediately if the List is empty)
   *   - blockMs>0    → poll every pollIntervalMs until one is obtained or the timeout, null on timeout
   *   - when obtained: the agent's position in the List = queue head (equivalent to RPOP + LPUSH), and the next peek can still get the same agent
   *
   * See `PeekStrategy` for the three-level fallback; on rpop_lpush_downgrade the caller must requeue itself (atomicity is lost).
   */
  peekAgent(blockMs: number): Promise<AgentTuple | null>;
  /**
   * Returns the peek strategy actually in use by the underlying layer. extract-worker uses it to decide whether to take the degraded path (needs an explicit requeue).
   * If no probe has run before the call, returns the default (usually "lmove", the optimistic preset).
   */
  getPeekStrategy(): PeekStrategy;
  /**
   * Called when tasks are still non-empty after processing; pushes back to the queue head (equivalent to going to the tail for rotation). The Set is kept.
   */
  requeueAgent(tuple: AgentTuple): Promise<void>;
  /**
   * Take the agent offline when tasks are empty: SREM from the Set; if the List still has leftovers, clean them as well.
   */
  removeAgent(tuple: AgentTuple): Promise<void>;

  /**
   * Force-clear Set + List leftovers by raw string (skipping tuple serialize).
   *
   * 2026-08-03: under peek semantics a legacy 4-segment tuple would be moved back to the queue head by LMOVE repeatedly, causing
   * the loop to spin idle. This interface lets the caller SREM + LREM directly by the raw string.
   * Also used by selfHealScan to clean legacy 4-segment leftovers.
   */
  purgeRawAgent(raw: string): Promise<void>;

  // ── Primitives needed by selfHealScan (2026-08-03 crash-recovery PR-3) ──────────────
  /**
   * One-shot snapshot of all raw strings in pending-agents-set, for selfHealScan to iterate.
   * Redis uses SMEMBERS, Local returns Array.from(set).
   */
  scanAgentSet(): Promise<string[]>;

  /**
   * Check whether the List contains the given raw. Redis uses LPOS (6.0.6+), Local iterates the array.
   */
  listContains(raw: string): Promise<boolean>;

  /**
   * LPUSH to the List directly by raw string, skipping SADD (the caller guarantees the Set already has it).
   * Used by selfHealScan when topping up the List: having obtained the raw via SMEMBERS means it is in the Set, so only the List needs topping up.
   */
  enqueueRawAgent(raw: string): Promise<void>;

  // ── tasks-mutex (short lock protecting read-modify-write of `_tasks.json`) ──
  /**
   * Contend for the tasks-mutex and run fn; on failure **back off and retry until waitDeadlineMs**; the lock itself has lockTtlMs as a deadlock safeguard.
   *
   * Why the two parameters are separate (the old implementation used one value for deadline and ttl → 30 concurrent calls on the same agent all timed out with 500):
   *   - `lockTtlMs`: the expiry of the lock itself on Redis; a safeguard that auto-releases when the lock-holding process crashes (a few seconds suffice).
   *   - `waitDeadlineMs`: the longest the caller is willing to block in the queue; it should be >> lockTtlMs,
   *     covering the accumulated critical-section time needed by N concurrent waiters (e.g. 30 critical sections of 300ms = 9s,
   *     so waitDeadline needs at least 15-30s to avoid false timeout reports).
   */
  withTasksMutex<T>(
    tuple: AgentTuple,
    opts: { lockTtlMs: number; waitDeadlineMs: number },
    fn: () => Promise<T>,
  ): Promise<T>;

  // ── extract-lock (Worker's exclusive right to extract an agent) ──
  acquireExtractLock(tuple: AgentTuple, ttlMs: number): Promise<ExtractLockHandle | null>;
  renewExtractLock(handle: ExtractLockHandle, ttlMs: number): Promise<boolean>;
  releaseExtractLock(handle: ExtractLockHandle): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────
// Local (in-memory) implementation — for unit tests only
// ────────────────────────────────────────────────────────────────────────────

interface WaitingConsumer {
  resolve: (t: AgentTuple | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LocalSkillAgentTaskQueue implements ISkillAgentTaskQueue {
  private readonly list: string[] = [];      // head = LPUSH, tail = RPOP - matches Redis semantics
  private readonly set = new Set<string>();
  private readonly tasksMutex = new Map<string, { token: string; expireAt: number }>();
  private readonly extractLocks = new Map<string, { token: string; expireAt: number }>();
  private readonly waiters: WaitingConsumer[] = [];

  private notify(): void {
    while (this.waiters.length > 0 && this.list.length > 0) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      const raw = this.list.pop()!; // RPOP
      const parsed = parseAgentTuple(raw);
      w.resolve(parsed);
    }
  }

  async enqueueAgent(tuple: AgentTuple): Promise<boolean> {
    const key = serializeAgentTuple(tuple);
    const added = !this.set.has(key);
    if (added) {
      this.set.add(key);
      this.list.unshift(key); // LPUSH
    }
    this.notify();
    return added;
  }

  async dequeueAgent(blockMs: number): Promise<AgentTuple | null> {
    if (this.list.length > 0) {
      const raw = this.list.pop()!; // RPOP
      return parseAgentTuple(raw);
    }
    if (blockMs <= 0) return null;
    return new Promise<AgentTuple | null>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, blockMs);
      this.waiters.push({ resolve, timer });
    });
  }

  /**
   * at-least-once peek: in-memory version = single-process Node, pop + unshift is naturally atomic.
   * Semantically equivalent to Redis 6.2+ LMOVE k k RIGHT LEFT.
   */
  async peekAgent(blockMs: number): Promise<AgentTuple | null> {
    const deadline = Date.now() + Math.max(0, blockMs);
    while (true) {
      if (this.list.length > 0) {
        const raw = this.list.pop()!;    // RPOP
        this.list.unshift(raw);          // LPUSH
        return parseAgentTuple(raw);
      }
      if (blockMs === 0) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      // The Node in-memory implementation has no Redis-style blocking wakeup; polling every 20 ms is enough
      await sleep(Math.min(20, remaining));
    }
  }

  getPeekStrategy(): PeekStrategy {
    return "lmove"; // semantically equivalent, atomic in single-process memory
  }

  async requeueAgent(tuple: AgentTuple): Promise<void> {
    const key = serializeAgentTuple(tuple);
    // Push back to the queue head (LPUSH semantics); the Set is kept
    this.set.add(key);
    this.list.unshift(key);
    this.notify();
  }

  async removeAgent(tuple: AgentTuple): Promise<void> {
    const key = serializeAgentTuple(tuple);
    this.set.delete(key);
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i] === key) this.list.splice(i, 1);
    }
  }

  async purgeRawAgent(raw: string): Promise<void> {
    this.set.delete(raw);
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i] === raw) this.list.splice(i, 1);
    }
  }

  async scanAgentSet(): Promise<string[]> {
    return Array.from(this.set);
  }

  async listContains(raw: string): Promise<boolean> {
    return this.list.includes(raw);
  }

  async enqueueRawAgent(raw: string): Promise<void> {
    this.list.unshift(raw);
    this.notify();
  }

  // ── mutex ──

  async withTasksMutex<T>(
    tuple: AgentTuple,
    opts: { lockTtlMs: number; waitDeadlineMs: number },
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = `mutex:${serializeAgentTuple(tuple)}`;
    const deadline = Date.now() + opts.waitDeadlineMs;
    while (true) {
      const now = Date.now();
      const cur = this.tasksMutex.get(key);
      if (!cur || cur.expireAt <= now) {
        const token = randomUUID();
        this.tasksMutex.set(key, { token, expireAt: now + opts.lockTtlMs });
        try {
          return await fn();
        } finally {
          const held = this.tasksMutex.get(key);
          if (held && held.token === token) this.tasksMutex.delete(key);
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`[skill-agent-queue] tasks-mutex wait timeout for ${key}`);
      }
      await sleep(10);
    }
  }

  // ── extract lock ──

  async acquireExtractLock(tuple: AgentTuple, ttlMs: number): Promise<ExtractLockHandle | null> {
    const key = serializeAgentTuple(tuple);
    const now = Date.now();
    const cur = this.extractLocks.get(key);
    if (cur && cur.expireAt > now) return null;
    const token = randomUUID();
    this.extractLocks.set(key, { token, expireAt: now + ttlMs });
    return { key, token };
  }

  async renewExtractLock(handle: ExtractLockHandle, ttlMs: number): Promise<boolean> {
    const cur = this.extractLocks.get(handle.key);
    if (!cur || cur.token !== handle.token) return false;
    cur.expireAt = Date.now() + ttlMs;
    return true;
  }

  async releaseExtractLock(handle: ExtractLockHandle): Promise<void> {
    const cur = this.extractLocks.get(handle.key);
    if (!cur) return;
    if (cur.token !== handle.token) return;
    this.extractLocks.delete(handle.key);
  }

  // ── test helpers ──

  /** For tests: peek current state. */
  _snapshot(): { list: string[]; set: string[] } {
    return { list: [...this.list], set: [...this.set] };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ────────────────────────────────────────────────────────────────────────────
// Redis implementation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Minimal subset of the ioredis client, avoiding a direct import of the Redis types (consistent with the existing redis-queue-v2).
 *
 * 2026-08-03: the `lmove` / `evalsha` / `script` methods are used by peekAgent for three-level fallback probing.
 * All three are optional - on old/degraded Redis they may be missing (LMOVE < 6.2), disabled (cluster policy bans EVAL) or
 * omitted by the client library. When missing, peekAgent automatically degrades to the next level in order.
 */
export interface RedisLike {
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  lpush(key: string, ...values: string[]): Promise<number>;
  lrem(key: string, count: number, value: string): Promise<number>;
  brpop(key: string, timeoutSec: number): Promise<[string, string] | null>;
  rpop(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  pexpire(key: string, ms: number): Promise<number>;
  // ── Optional (called on demand when probing; missing → take the next fallback level) ──
  lmove?(src: string, dst: string, srcSide: string, dstSide: string): Promise<string | null>;
  evalsha?(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  script?(subcommand: string, ...args: string[]): Promise<string>;
  /**
   * LPOS queries the position of raw in the List (Redis 6.0.6+); null = not present. When missing, degrades to
   * `LRANGE + JS iteration`, see the RedisSkillAgentTaskQueue.listContains implementation.
   */
  lpos?(key: string, value: string): Promise<number | null>;
  /** LRANGE used as a fallback when lpos is unavailable. */
  lrange?(key: string, start: number, stop: number): Promise<string[]>;
}

export interface RedisSkillAgentTaskQueueOptions {
  client: RedisLike;
  /** Redis key prefix, default "skill". */
  keyPrefix?: string;
  /**
   * dequeueAgent polling interval in ms, default 200.
   *
   * 2026-07-21 - historically dequeueAgent used `BRPOP <key> 5`; zero-latency wakeup was
   * achieved, but BRPOP is a **blocking command**, and other skill commands sharing the same ioredis connection
   * (`SET NX PX` grabbing the tasks-mutex, `SADD`/`LPUSH` enqueueAgent, `EVAL`
   * releasing the lock) all had to queue behind BRPOP; each archive in the handler hit 3 BRPOP windows
   * ≈ 15s. After switching to non-blocking `RPOP` + `setTimeout(pollIntervalMs)` polling, the main
   * connection is no longer stuck and handler-side Redis IO is back to milliseconds; the cost is a worst-case pollInterval
   * of wakeup latency (default 200ms; skill extraction itself takes a dozen seconds of LLM time, so this latency is unnoticeable).
   *
   * Semantics align with the memory-side `RedisStateBackend.consumeTask`
   * (redis-backend.ts:312 - XREADGROUP without BLOCK, with an outer sleep of 200ms).
   */
  pollIntervalMs?: number;
}

/**
 * Default value of the Redis key prefix.
 *
 * Production recommendation: have the wire layer pass a prefix like `${memoryPrefix}:skill-conv`, tied to the memory
 * `keyPrefix` (e.g. `wamf_memory_prod_v3`), to avoid Redis key collisions
 * across environments. The default `"skill-conv"` is only a fallback when none is passed explicitly.
 */
const DEFAULT_PREFIX = "skill-conv";

const LUA_RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const LUA_RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * peek lua: atomic "RPOP tail + LPUSH head", semantically equivalent to LMOVE k k RIGHT LEFT.
 * Used only on the EVALSHA/EVAL fallback for Redis < 6.2.
 *
 * KEYS[1] = pending-agents list
 * return  = the raw obtained (string) or nil
 */
const LUA_PEEK = `
local raw = redis.call('RPOP', KEYS[1])
if raw then
  redis.call('LPUSH', KEYS[1], raw)
end
return raw
`;

/**
 * Decide whether a Redis error message indicates "command not supported" (LMOVE on Redis < 6.2 or some mocks).
 * Semantic boundary: match only the "command unknown / not enabled" class; other errors (connection lost, auth failure) must propagate
 * to the caller, to avoid misjudging and degrading to the non-atomic path.
 */
function isUnknownCommand(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return /ERR\s+unknown command/i.test(msg) || /command\s+.*\s+is not allowed/i.test(msg);
}

/**
 * Decide whether this is a NOSCRIPT returned by EVALSHA (Redis restarted / script cache flushed). On NOSCRIPT
 * we should SCRIPT LOAD again and then EVALSHA, instead of treating it as a failure and degrading.
 */
function isNoScript(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return /NOSCRIPT/i.test(msg);
}

/**
 * Decide whether EVAL / SCRIPT was rejected by cluster policy (permission / cluster disabled). This class is, like
 * unknown-command, a "capability not supported" case and needs to degrade to the next level.
 */
function isEvalDisabled(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return (
    /command\s+'?EVAL'?\s+is not allowed/i.test(msg) ||
    /NOPERM/i.test(msg) ||
    /ERR\s+unknown command\s+'?(EVAL|EVALSHA|SCRIPT)/i.test(msg)
  );
}

export class RedisSkillAgentTaskQueue implements ISkillAgentTaskQueue {
  private readonly client: RedisLike;
  private readonly listKey: string;
  private readonly setKey: string;
  private readonly extractLockPrefix: string;
  private readonly tasksMutexPrefix: string;
  private readonly pollIntervalMs: number;

  constructor(opts: RedisSkillAgentTaskQueueOptions) {
    this.client = opts.client;
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
    const prefix = opts.keyPrefix ?? DEFAULT_PREFIX;
    // Key layout (aligned with §5 & §21.5):
    //   {prefix}:pending-agents         — List (LPUSH enqueue / RPOP poll dequeue)
    //   {prefix}:pending-agents-set     — Set (SADD/SREM idempotent de-duplication)
    //   {prefix}:extract-lock:{tuple}   — Worker's exclusive right to extract the agent (10min TTL)
    //   {prefix}:tasks-mutex:{tuple}    — protects read-modify-write of _tasks.json (5s TTL)
    this.listKey = `${prefix}:pending-agents`;
    this.setKey = `${prefix}:pending-agents-set`;
    this.extractLockPrefix = `${prefix}:extract-lock:`;
    this.tasksMutexPrefix = `${prefix}:tasks-mutex:`;
  }

  async enqueueAgent(tuple: AgentTuple): Promise<boolean> {
    const raw = serializeAgentTuple(tuple);
    const added = await this.client.sadd(this.setKey, raw);
    if (added === 1) {
      await this.client.lpush(this.listKey, raw);
      return true;
    }
    return false;
  }

  async dequeueAgent(blockMs: number): Promise<AgentTuple | null> {
    // Non-blocking RPOP + sleep polling; BRPOP is rejected. See the comment at pollIntervalMs.
    //
    // blockMs=0 - try only once, return null immediately if the list is empty.
    // blockMs>0 - try every pollIntervalMs until an element is obtained or the deadline is exceeded.
    const deadline = Date.now() + Math.max(0, blockMs);
    while (true) {
      const raw = await this.client.rpop(this.listKey);
      if (raw !== null) return parseAgentTuple(raw);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      // Take the smaller of pollInterval and remaining, so that when blockMs is less than pollInterval it can return as soon as expected.
      await sleep(Math.min(this.pollIntervalMs, remaining));
    }
  }

  /**
   * At-least-once peek — see the ISkillAgentTaskQueue.peekAgent docs + docs/design/2026-07-21 §5.
   *
   * The main line uses Redis 6.2+ `LMOVE k k RIGHT LEFT`; old Redis goes through the LUA_PEEK script via EVALSHA;
   * when EVAL is disabled, it degrades to non-atomic RPOP (the caller requeues inside the mutex).
   *
   * Probing: on the first call, `probePeekStrategy` decides the strategy and caches it (idempotent, concurrency-safe).
   */
  async peekAgent(blockMs: number): Promise<AgentTuple | null> {
    if (!this.peekProbed) await this.probePeekStrategy();
    const deadline = Date.now() + Math.max(0, blockMs);
    while (true) {
      const raw = await this.executePeek();
      if (raw !== null) return parseAgentTuple(raw);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await sleep(Math.min(this.pollIntervalMs, remaining));
    }
  }

  getPeekStrategy(): PeekStrategy {
    return this.peekStrategy;
  }

  // ── peek three-level fallback probe ─────────────────────────────────────────────────
  //
  // The first peekAgent call triggers one probe, the result is cached in peekStrategy and later calls branch directly.
  // The probe itself may also obtain an element (LMOVE on an empty list returns null, a no-op; on a non-empty list LMOVE
  // obtains an element that stays in the List, so the semantics are correct).
  //
  // Concurrency safety: `probePromise` ensures concurrent first calls run the probe only once, and the other callers wait for the result of that one
  // probe. If the probe throws (not "capability unsupported") it is not cached, and will probe again next time.

  private peekStrategy: PeekStrategy = "lmove";     // optimistic default
  private peekScriptSha: string | null = null;
  private peekProbed = false;
  private probePromise: Promise<void> | null = null;

  private async probePeekStrategy(): Promise<void> {
    if (this.peekProbed) return;
    if (this.probePromise) {
      await this.probePromise;
      return;
    }
    this.probePromise = (async () => {
      // Level 1: probe LMOVE. Try once against the real listKey - getting null also counts as a successful probe
      // (as long as it does not throw unknown-command). For a non-empty list the element obtained is still in the List, so the semantics are correct.
      try {
        if (typeof this.client.lmove === "function") {
          await this.client.lmove(this.listKey, this.listKey, "RIGHT", "LEFT");
          this.peekStrategy = "lmove";
          this.peekProbed = true;
          return;
        }
      } catch (err) {
        if (!isUnknownCommand(err)) throw err; // non-capability errors propagate
      }

      // Level 2: probe EVALSHA + SCRIPT LOAD.
      if (typeof this.client.script === "function" && typeof this.client.evalsha === "function") {
        try {
          this.peekScriptSha = await this.client.script("LOAD", LUA_PEEK);
          // Immediately verify with one EVALSHA that it runs (returning null on an empty list is also OK)
          await this.client.evalsha(this.peekScriptSha, 1, this.listKey);
          this.peekStrategy = "evalsha";
          this.peekProbed = true;
          return;
        } catch (err) {
          if (!isEvalDisabled(err) && !isUnknownCommand(err)) throw err;
        }
      }

      // Level 3: last-resort fallback - non-atomic RPOP.
      // Raise a P1 alert; the caller (extract-worker) must use getPeekStrategy to detect this path and
      // do an explicit requeue itself inside the tasks-mutex (the original v1 §4.5 scheme), and the pool side must enable the periodic
      // selfHealScan (delivered in PR-3).
      this.peekStrategy = "rpop_lpush_downgrade";
      this.peekProbed = true;
    })().finally(() => {
      this.probePromise = null;
    });
    await this.probePromise;
  }

  private async executePeek(): Promise<string | null> {
    switch (this.peekStrategy) {
      case "lmove":
        // After a successful probe the unknown-command branch is no longer taken; no fallback degradation here either (let the error propagate), to avoid
        // covert degradation caused by a Redis version switch midway.
        return this.client.lmove!(this.listKey, this.listKey, "RIGHT", "LEFT");

      case "evalsha":
        try {
          return (await this.client.evalsha!(this.peekScriptSha!, 1, this.listKey)) as
            | string
            | null;
        } catch (err) {
          if (isNoScript(err)) {
            // Redis restart lost the script cache: LOAD again and EVALSHA once more.
            // Retry only once; if NOSCRIPT persists, propagate it (it means the client or server is abnormal and must not degrade silently).
            this.peekScriptSha = await this.client.script!("LOAD", LUA_PEEK);
            return (await this.client.evalsha!(this.peekScriptSha, 1, this.listKey)) as
              | string
              | null;
          }
          throw err;
        }

      case "eval":
        return (await this.client.eval(LUA_PEEK, 1, this.listKey)) as string | null;

      case "rpop_lpush_downgrade": {
        // Non-atomic: only RPOP, the caller requeues itself inside the mutex. Semantically the same as one pop of dequeueAgent.
        return this.client.rpop(this.listKey);
      }
    }
  }

  async requeueAgent(tuple: AgentTuple): Promise<void> {
    const raw = serializeAgentTuple(tuple);
    // Idempotent: ensure it is in the Set too
    await this.client.sadd(this.setKey, raw);
    await this.client.lpush(this.listKey, raw);
  }

  async removeAgent(tuple: AgentTuple): Promise<void> {
    const raw = serializeAgentTuple(tuple);
    await this.client.srem(this.setKey, raw);
    // The List may still have leftovers (gone if the Worker already popped it; this is the safeguard)
    await this.client.lrem(this.listKey, 0, raw);
  }

  async purgeRawAgent(raw: string): Promise<void> {
    // Clear the Set + List directly by raw string, without tuple serialize. Used for legacy 4-segment cleanup
    // + the safeguard for corrupt leftovers in selfHealScan.
    await this.client.srem(this.setKey, raw);
    await this.client.lrem(this.listKey, 0, raw);
  }

  async scanAgentSet(): Promise<string[]> {
    return this.client.smembers(this.setKey);
  }

  async listContains(raw: string): Promise<boolean> {
    if (typeof this.client.lpos === "function") {
      const pos = await this.client.lpos(this.listKey, raw);
      return pos !== null && pos >= 0;
    }
    if (typeof this.client.lrange === "function") {
      // Fallback: LRANGE to get everything and iterate. In scale the List length = active agents, generally <= thousands, acceptable.
      const all = await this.client.lrange(this.listKey, 0, -1);
      return all.includes(raw);
    }
    // Both missing → conservatively assume the List has it (topping up one fewer LPUSH beats a mistaken duplicate LPUSH; the next round of
    // selfHealScan will come around anyway).
    return true;
  }

  async enqueueRawAgent(raw: string): Promise<void> {
    // The Set already has it (the caller guarantees), only the List needs topping up.
    await this.client.lpush(this.listKey, raw);
  }

  async withTasksMutex<T>(
    tuple: AgentTuple,
    opts: { lockTtlMs: number; waitDeadlineMs: number },
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = this.tasksMutexPrefix + serializeAgentTuple(tuple);
    const token = randomUUID();
    const deadline = Date.now() + opts.waitDeadlineMs;
    while (true) {
      // SET NX PX: short TTL safeguards the crash scenario; waitDeadline covers the concurrent queueing time
      const ok = await this.client.set(key, token, "NX", "PX", opts.lockTtlMs);
      if (ok === "OK") {
        try {
          return await fn();
        } finally {
          try {
            await this.client.eval(LUA_RELEASE, 1, key, token);
          } catch {
            /* swallow */
          }
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`[skill-agent-queue] tasks-mutex wait timeout for ${key}`);
      }
      await sleep(20 + Math.floor(Math.random() * 30));
    }
  }

  async acquireExtractLock(tuple: AgentTuple, ttlMs: number): Promise<ExtractLockHandle | null> {
    const key = this.extractLockPrefix + serializeAgentTuple(tuple);
    const token = randomUUID();
    const ok = await this.client.set(key, token, "NX", "PX", ttlMs);
    if (ok !== "OK") return null;
    return { key, token };
  }

  async renewExtractLock(handle: ExtractLockHandle, ttlMs: number): Promise<boolean> {
    const raw = handle.key.startsWith(this.extractLockPrefix)
      ? handle.key
      : this.extractLockPrefix + handle.key;
    const result = await this.client.eval(LUA_RENEW, 1, raw, handle.token, ttlMs);
    return result === 1;
  }

  async releaseExtractLock(handle: ExtractLockHandle): Promise<void> {
    const raw = handle.key.startsWith(this.extractLockPrefix)
      ? handle.key
      : this.extractLockPrefix + handle.key;
    try {
      await this.client.eval(LUA_RELEASE, 1, raw, handle.token);
    } catch {
      /* swallow */
    }
  }
}
