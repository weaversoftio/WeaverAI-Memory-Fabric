/**
 * Prewarm runner — invoked once at session_init Case 2 (immediately after
 * the control plane registers the session and the SessionStore has its
 * `initialized` state). For every hook declaring
 * `cacheStrategy ∈ {"session_init", "hybrid"}`, this runs `hook.prewarm(input)`
 * in parallel and persists the resulting blocks into `HookCacheRepo`.
 *
 * Semantics:
 *   - Best-effort. Single-hook failure → warn-log + skip (no cache for that hook).
 *   - Total timeout (default 8s). Hooks not finished by then → warn-log + skip.
 *   - The whole call NEVER throws (silently degrades to no caching).
 *
 * The repo write is the side-effect; this function returns the list of
 * successfully cached hookIds for diagnostics/tests.
 */

import type { HookCacheRepo } from "../db/hookCacheRepo.js";
import type {
  ContextBlock,
  HookRegistry,
  InjectionHook,
  PrewarmInput,
} from "./types.js";

export interface PrewarmOptions {
  /** Total timeout for the whole prewarm pass, in ms. Defaults to 20000. */
  totalTimeoutMs?: number;
  /**
   * Refresh-only: before prewarm, first `clearBySession` to wipe all existing caches of the session,
   * making this prewarm's result the **sole authority**. Default `false` (keeps the first session_init
   * semantics: on a cache miss the pipeline runs execute() to self-heal).
   *
   * Why this switch is needed - the first session_init and the mem:sync refresh share the same entry point
   * `prewarmFromConfig`, but the semantics differ:
   *   - First time: the cache is empty to begin with; if prewarm gets `[]`/error it skips the write, and when the pipeline's
   *     get returns null it runs execute() to fetch once and self-heals the cache - a closed loop.
   *   - Refresh: the cache **already holds old data**. If some hook gets `[]` in prewarm (e.g. the user
   *     just unbound wiki+codegraph) or times out / throws, `prewarmAll` skips the write and the old data
   *     stays untouched in storage; on the next request the pipeline reads the old snapshot back from storage and keeps injecting it, which shows up
   *     as "the asset was unbound but the injection still carries it".
   *
   * With `clearBefore` on, the semantics become "whatever prewarm gets is what there is; if it gets nothing, there is nothing":
   *   - hook A has content -> overwrites the cache (normal).
   *   - hook B gets `[]` -> the old cache is cleared by the clear above and no longer hits (fixes that knowledge bug).
   *   - hook C prewarm throws/times out -> the old cache is likewise cleared, and next time the pipeline falls back to execute()
   *     - a single network blip won't let an old snapshot live forever.
   */
  clearBefore?: boolean;
}

export interface PrewarmResult {
  cachedHookIds: string[];
  skipped: Array<{ hookId: string; reason: string }>;
  durationMs: number;
}

// 8s -> 20s (2026-07-11): wamf-profile-memory-injector prewarm needs to read
// self + the L2 index + L3 persona of the agent behind each imported chat_memory
// (via remote storage); when imported agents exist or storage is slow, 8s often timed out and
// the whole <wamf_profile_memory> section was lost. Relaxed to 20s to cover the typical dev-machine scenario.
const DEFAULT_TOTAL_TIMEOUT_MS = 20000;

function shouldPrewarm(hook: InjectionHook): boolean {
  const s = hook.cacheStrategy ?? "none";
  return s === "session_init" || s === "hybrid";
}

/** Run a promise with a per-task timeout. Rejects on timeout. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`prewarm timeout(${ms}ms): ${label}`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Prewarm all eligible hooks for a freshly initialized session.
 *
 * @param registry  The injection HookRegistry (typically the global one).
 * @param repo      Where to persist the prewarmed blocks.
 * @param input     PrewarmInput (sessionInfo, agentDetail, taskDetail, keyId).
 * @param opts      Optional knobs (timeout, etc.).
 */
export async function prewarmAll(
  registry: HookRegistry,
  repo: HookCacheRepo,
  input: PrewarmInput,
  opts: PrewarmOptions = {},
): Promise<PrewarmResult> {
  const startedAt = Date.now();
  const sessionId = input.sessionInfo.session_id;
  const totalBudget = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const cachedHookIds: string[] = [];
  const skipped: Array<{ hookId: string; reason: string }> = [];

  const all = registry.getAll();
  const targets = all.filter(shouldPrewarm);

  if (targets.length === 0) {
    console.log(
      `[hook-cache] prewarm session=${sessionId}: no hooks declared cacheStrategy, skipping`,
    );
    return { cachedHookIds, skipped, durationMs: Date.now() - startedAt };
  }

  // Refresh scenario: first clear the existing caches of all hooks of the session, so this prewarm becomes
  // the sole authority. See the comment on `PrewarmOptions.clearBefore` for why the first
  // session_init does not need this while a refresh must do it.
  //
  // The position is deliberately where targets is non-empty -> before each hook runs: if the registry has no
  // hook that needs prewarm at all, clearing is pointless (and could wrongly clear what others wrote under the same session).
  //
  // clearBySession swallows underlying errors internally (see each hookCacheRepo implementation), so it won't
  // block the subsequent prewarm, consistent with the overall semantics that "prewarm is best-effort".
  if (opts.clearBefore) {
    try {
      await repo.clearBySession(input.spaceId ?? "", input.userId, input.agentSource, sessionId);
      console.log(
        `[hook-cache] prewarm session=${sessionId}: clearBefore=true, cleared existing entries`,
      );
    } catch (err) {
      console.warn(
        `[hook-cache] prewarm session=${sessionId}: clearBefore failed (continuing):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Per-hook budget: shared total, but each individual call also caps at
  // `totalBudget` so a single hang can't starve siblings (Promise.allSettled
  // ensures we observe all settlements regardless).
  const runs = targets.map(async (hook) => {
    try {
      if (typeof hook.prewarm !== "function") {
        return { hookId: hook.id, status: "skipped" as const, reason: "no prewarm() implemented" };
      }
      const blocks = await withTimeout(
        Promise.resolve(hook.prewarm(input)),
        totalBudget,
        `hook=${hook.id}`,
      );
      const arr: ContextBlock[] = Array.isArray(blocks) ? blocks : [];
      if (arr.length === 0) {
        return { hookId: hook.id, status: "skipped" as const, reason: "empty blocks" };
      }
      return { hookId: hook.id, status: "ok" as const, blocks: arr };
    } catch (err) {
      return {
        hookId: hook.id,
        status: "error" as const,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Top-level total deadline: even if one hook hangs longer than per-hook,
  // we don't want session_init to block forever.
  const settled = await Promise.race([
    Promise.allSettled(runs),
    new Promise<PromiseSettledResult<unknown>[]>((resolve) => {
      setTimeout(() => resolve([]), totalBudget + 500);
    }),
  ]);

  if (settled.length === 0) {
    console.warn(
      `[hook-cache] prewarm session=${sessionId}: global timeout ${totalBudget}ms exceeded`,
    );
    return { cachedHookIds, skipped, durationMs: Date.now() - startedAt };
  }

  const okEntries: Array<{ hookId: string; blocks: ContextBlock[] }> = [];
  for (const s of settled) {
    if (s.status !== "fulfilled") {
      // allSettled wrapped each task's catch already; this branch is unreachable
      // in practice, but kept for safety.
      skipped.push({ hookId: "<unknown>", reason: String((s as PromiseRejectedResult).reason) });
      continue;
    }
    const r = s.value as
      | { hookId: string; status: "ok"; blocks: ContextBlock[] }
      | { hookId: string; status: "skipped"; reason: string }
      | { hookId: string; status: "error"; reason: string };
    if (r.status === "ok") {
      okEntries.push({ hookId: r.hookId, blocks: r.blocks });
      cachedHookIds.push(r.hookId);
    } else {
      skipped.push({ hookId: r.hookId, reason: r.reason });
    }
  }

  if (okEntries.length > 0) {
    await repo.putMany(input.spaceId ?? "", input.userId, input.agentSource, sessionId, okEntries);
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `[hook-cache] prewarm session=${sessionId}: cached=${cachedHookIds.length} skipped=${skipped.length} durationMs=${durationMs}`,
  );
  if (skipped.length > 0) {
    for (const s of skipped) {
      console.log(`[hook-cache]   - skip hook=${s.hookId} reason=${s.reason}`);
    }
  }

  return { cachedHookIds, skipped, durationMs };
}
