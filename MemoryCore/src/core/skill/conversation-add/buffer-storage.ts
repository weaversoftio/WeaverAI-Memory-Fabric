/**
 * SkillBufferStorage — wraps all storage object reads and writes in §4.
 *
 * Path rules (under the memory global PathPrefix, subPath defaults to "skill_buffer"):
 *   Session level:
 *     {subPath}/{space}/{user}/{team}/{agent}/{session}/data-current.jsonl
 *     {subPath}/{space}/{user}/{team}/{agent}/{session}/data-<ts>.jsonl
 *     {subPath}/{space}/{user}/{team}/{agent}/{session}/meta.json
 *   Agent level:
 *     {subPath}/{space}/{user}/{team}/{agent}/_tasks.json
 *
 * Reuses the existing memory StorageAdapter underneath (local or MongoDB).
 *
 * Read/write rules:
 *   - data-current: plain JSON (no append semantics; fully overwritten each time)
 *   - meta:         plain JSON (sessions are serial, no CAS)
 *   - archive:      plain JSON (exists() check before writing; if it already exists, treat as success)
 *   - _tasks.json:  plain JSON (read-modify-write, protected by the upper-layer SkillAgentTaskQueue with a short Redis lock)
 */

import type { StorageAdapter } from "../../storage/adapter.js";

export interface SessionKey {
  /**
   * 2026-07-30: added instance_id so trigger.archive can put it into the queue when constructing the AgentTuple,
   * and after dequeuing the worker dynamically resolves the matching instance's
   * storage/database/LLM resources by instance_id. buffer-storage internals (sessionDir/agentDir/tasksKey)
   * do not use instance_id (that part is provided by the per-instance storage root);
   * it is only passed through as tuple ownership information.
   */
  instance_id: string;
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  session_id: string;
}

// The AgentTuple 5-segment type is exported from agent-task-queue as the single source; re-exported here so old import paths keep working.
// agentDir/tasksKey in buffer-storage use only user/team/agent (instance/space are provided by the upper-layer
// StorageAdapter's per-instance prefix), but the types stay consistent for passing across modules.
export type { AgentTuple } from "./agent-task-queue.js";
import type { AgentTuple } from "./agent-task-queue.js";

/** meta.json structure (§4.2). Holds counters only. */
export interface SessionMeta {
  session_id: string;
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  tool_call_count: number;
  byte_count: number;
  last_appended_at_ms?: number;
  last_archived_at_ms?: number;
}

/** A single task entry in _tasks.json (§4.3). */
export interface SkillTaskEntry {
  task_id: string;
  session_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  space_id: string;
  task_ref_id?: string;
  archive_key: string;
  archived_at_ms: number;
  enqueued_at_ms: number;
  /**
   * Exclusive to direct-trigger (`/v3/skill/extract`): the
   * "main Agent extraction hint" injected into the extractor prompt. Not written by the conversation/add path. The Worker passes it through to
   * `ISkillExtractor.extract({ reason })` when consuming.
   */
  reason?: string;
  /**
   * Exclusive to direct-trigger: the extractor LLM iteration cap. Not written by the conversation/add path.
   * The Worker passes it through as `extractor.extract({ options: { max_iterations } })` when consuming.
   */
  max_iterations?: number;
  /**
   * Cumulative **permanent** failure count (class B: 400/422/JSON parse/schema).
   * Class A transient (401/403/429/5xx/network/timeout) is not counted, to avoid confusion with class B.
   * After reaching the Worker's `permanentMaxRetries` threshold (default 3), the task is moved to
   * `_tasks_dlq.json` (see dlqKey below).
   */
  retry_count?: number;
  /**
   * The most recent failure's error.message (truncated to <=1024 characters on the Worker side), used only for
   * troubleshooting; no effect on the Worker's scheduling logic.
   */
  last_error?: string;
}

/** Overall structure of _tasks.json. */
export interface AgentTasksDoc {
  team_id: string;
  agent_id: string;
  updated_at_ms: number;
  tasks: SkillTaskEntry[];
}

/**
 * A single dead-letter record in `_tasks_dlq.json`.
 *
 * The DLQ is written to disk only, with no endpoint: a human rescues entries with `cat` / `mv`, or a grafana alert script scans the
 * file directly. There is currently no TTL / size limit (one file per agent; users handle it themselves when large).
 */
export interface SkillDeadTaskEntry extends SkillTaskEntry {
  /** Wall-clock timestamp when appended to the DLQ. */
  dead_lettered_at_ms: number;
}

/** Overall structure of `_tasks_dlq.json`. */
export interface AgentDeadTasksDoc {
  team_id: string;
  agent_id: string;
  updated_at_ms: number;
  tasks: SkillDeadTaskEntry[];
}

/** data-current / archive cache content. Uses { messages: [...] } rather than plain JSONL, to simplify reads and writes. */
export interface BufferedMessages {
  messages: Array<Record<string, unknown>>;
}

export interface SkillBufferStorageOptions {
  storage: StorageAdapter;
  /** Storage subpath prefix. Default "skill_buffer". */
  subPath?: string;
}

const DEFAULT_SUB_PATH = "skill_buffer";

export class SkillBufferStorage {
  private readonly storage: StorageAdapter;
  private readonly subPath: string;

  constructor(opts: SkillBufferStorageOptions) {
    this.storage = opts.storage;
    this.subPath = (opts.subPath ?? DEFAULT_SUB_PATH).replace(/\/+$/, "");
  }

  // ── Path helpers ──────────────────────────────────────────────────────────

  // Path rules aligned with design doc §15.3: SkillBufferStorage is only responsible for the levels under subPath
  // ({user}/{team}/{agent}/...); space_id/instanceId are provided by the upper-layer StorageAdapter's
  // per-instance prefix. Including space_id would make `{space}/` appear again after the per-instance storage root
  // (`.../{instanceId}/`).
  private sessionDir(sess: SessionKey): string {
    return `${this.subPath}/${sess.user_id}/${sess.team_id}/${sess.agent_id}/${sess.session_id}`;
  }

  private agentDir(agent: AgentTuple): string {
    return `${this.subPath}/${agent.user_id}/${agent.team_id}/${agent.agent_id}`;
  }

  currentKey(sess: SessionKey): string {
    return `${this.sessionDir(sess)}/data-current.jsonl`;
  }

  metaKey(sess: SessionKey): string {
    return `${this.sessionDir(sess)}/meta.json`;
  }

  archiveKey(sess: SessionKey, archivedAtMs: number): string {
    return `${this.sessionDir(sess)}/data-${archivedAtMs}.jsonl`;
  }

  tasksKey(agent: AgentTuple): string {
    return `${this.agentDir(agent)}/_tasks.json`;
  }

  dlqKey(agent: AgentTuple): string {
    return `${this.agentDir(agent)}/_tasks_dlq.json`;
  }

  // ── data-current ──────────────────────────────────────────────────────────

  async readCurrent(sess: SessionKey): Promise<BufferedMessages> {
    const raw = await this.storage.readFile(this.currentKey(sess));
    if (!raw) return { messages: [] };
    try {
      const parsed = JSON.parse(raw) as BufferedMessages;
      if (!parsed.messages) return { messages: [] };
      return { messages: parsed.messages };
    } catch {
      // Corrupt → treat as empty
      return { messages: [] };
    }
  }

  async writeCurrent(sess: SessionKey, buf: BufferedMessages): Promise<void> {
    await this.storage.writeFile(this.currentKey(sess), JSON.stringify(buf));
  }

  // ── session meta.json ────────────────────────────────────────────────────

  async readMeta(sess: SessionKey): Promise<SessionMeta> {
    const raw = await this.storage.readFile(this.metaKey(sess));
    if (!raw) return this.defaultMeta(sess);
    try {
      const parsed = JSON.parse(raw) as Partial<SessionMeta>;
      return {
        ...this.defaultMeta(sess),
        ...parsed,
        // Force key fields to match (prevents space_id/session_id of an old object from being substituted)
        session_id: sess.session_id,
        space_id: sess.space_id,
        user_id: sess.user_id,
        team_id: sess.team_id,
        agent_id: sess.agent_id,
      };
    } catch {
      return this.defaultMeta(sess);
    }
  }

  async writeMeta(sess: SessionKey, meta: SessionMeta): Promise<void> {
    await this.storage.writeFile(this.metaKey(sess), JSON.stringify(meta));
  }

  private defaultMeta(sess: SessionKey): SessionMeta {
    return {
      session_id: sess.session_id,
      space_id: sess.space_id,
      user_id: sess.user_id,
      team_id: sess.team_id,
      agent_id: sess.agent_id,
      tool_call_count: 0,
      byte_count: 0,
    };
  }

  // ── archive ────────────────────────────────────────────────────────────

  /**
   * Write the archive file; if the key already exists, treat as success (aligned with design §7.4 ④).
   *
   * Note: we do not use the If-None-Match: * header (not exposed by the storage abstraction layer),
   * but a two-step exists() → putObject. The same session is serialized by the proxy,
   * and archived_at_ms increases (millisecond timestamp), so collisions do not actually occur.
   */
  async writeArchive(sess: SessionKey, archivedAtMs: number, buf: BufferedMessages): Promise<void> {
    const key = this.archiveKey(sess, archivedAtMs);
    if (await this.storage.exists(key)) {
      // Treat as success, skip the write
      return;
    }
    await this.storage.writeFile(key, JSON.stringify(buf));
  }

  async readArchive(archiveKey: string): Promise<BufferedMessages | null> {
    const raw = await this.storage.readFile(archiveKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as BufferedMessages;
    } catch {
      return null;
    }
  }

  // ── agent _tasks.json ────────────────────────────────────────────────────

  async readTasks(agent: AgentTuple): Promise<AgentTasksDoc> {
    const raw = await this.storage.readFile(this.tasksKey(agent));
    if (!raw) return this.defaultTasks(agent);
    try {
      const parsed = JSON.parse(raw) as Partial<AgentTasksDoc>;
      return {
        team_id: agent.team_id,
        agent_id: agent.agent_id,
        updated_at_ms: parsed.updated_at_ms ?? 0,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      };
    } catch {
      return this.defaultTasks(agent);
    }
  }

  async writeTasks(agent: AgentTuple, doc: AgentTasksDoc): Promise<void> {
    await this.storage.writeFile(this.tasksKey(agent), JSON.stringify(doc));
  }

  private defaultTasks(agent: AgentTuple): AgentTasksDoc {
    return {
      team_id: agent.team_id,
      agent_id: agent.agent_id,
      updated_at_ms: 0,
      tasks: [],
    };
  }

  // ── agent _tasks_dlq.json (dead-letter queue) ─────────────────────────────────────
  //
  // The DLQ is only appended to by the Worker (which already holds the extract-lock, so each agent has a single writer),
  // so no tasks-mutex protection is needed - but read-modify-write still requires read before write, to avoid truncating old content.

  async readDlq(agent: AgentTuple): Promise<AgentDeadTasksDoc> {
    const raw = await this.storage.readFile(this.dlqKey(agent));
    if (!raw) return this.defaultDlq(agent);
    try {
      const parsed = JSON.parse(raw) as Partial<AgentDeadTasksDoc>;
      return {
        team_id: agent.team_id,
        agent_id: agent.agent_id,
        updated_at_ms: parsed.updated_at_ms ?? 0,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      };
    } catch {
      return this.defaultDlq(agent);
    }
  }

  async appendDlq(agent: AgentTuple, dead: SkillDeadTaskEntry): Promise<void> {
    const doc = await this.readDlq(agent);
    doc.tasks.push(dead);
    doc.updated_at_ms = dead.dead_lettered_at_ms;
    await this.storage.writeFile(this.dlqKey(agent), JSON.stringify(doc));
  }

  private defaultDlq(agent: AgentTuple): AgentDeadTasksDoc {
    return {
      team_id: agent.team_id,
      agent_id: agent.agent_id,
      updated_at_ms: 0,
      tasks: [],
    };
  }
}
