/**
 * SessionRepo — persistence layer for SessionInitState.
 *
 * The proxy's runtime continues to use the in-memory `SessionStore` as L1
 * cache. This Repo provides a durable L2 so that on process restart
 * we can hydrate `status='initialized'` rows back into memory and avoid
 * forcing the user through session_init again.
 *
 * Persistence semantics:
 *   - upsert:            write-through on every store.set().
 *   - getBySessionId:    main lookup — read the current state for
 *                        (spaceId, userId, agentSource, sessionId).
 *   - deleteBySessionId: drop the row.
 *   - loadAllInitialized: hydrate on startup (bulk read of initialized rows).
 *
 * All SQL goes through prepared statements with bound parameters.
 *
 * ── History note ────────────────────────────────────────────────────────────
 * The previous version (2026-07-10) had only a three-segment primary key (userId, agentSource, sessionId).
 * A later version adds a spaceId segment for per-space isolation - in the sqlite
 * composite primary key the spaceId segment comes first (old callers that omit it use the `_default` fallback).
 */

import type Database from "better-sqlite3";

import { getDb } from "./index.js";
import type { SessionInitState } from "../session/types.js";

export interface PersistedSessionRow {
  session_id: string;
  session_key: string;
  status: string;
  agent_id: string | null;
  task_id: string | null;
  user_id: string | null;
  cb_user_id: string | null;
  agent_detail_json: string | null;
  task_detail_json: string | null;
  session_info_json: string | null;
  state_json: string;
  created_at: number;
  updated_at: number;
}

/**
 * Stable id used in the `sessions` table for a given state.
 *
 * Composite key: `${spaceId}:${userId}:${agentSource}:${sessionId}` - the spaceId segment was
 * added for per-space isolation. An empty spaceId uses the `_default` fallback
 * segment (old deployments keep working). The Sqlite schema is unchanged; the primary key string just has one more segment.
 */
export function sessionRowId(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  const sp = spaceId || "_default";
  return `${sp}:${userId}:${agentSource}:${sessionId}`;
}

function jsonOrNull<T>(v: T | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function rowFromState(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
  state: SessionInitState,
): PersistedSessionRow {
  const now = Date.now();
  return {
    session_id: sessionRowId(spaceId, userId, agentSource, sessionId),
    session_key: sessionId,
    status: state.status,
    agent_id: state.sessionInfo?.agent_id ?? state.agentDetail?.id ?? null,
    task_id: state.sessionInfo?.task_id ?? state.taskDetail?.id ?? null,
    user_id: state.sessionInfo?.user_id ?? userId,
    cb_user_id: state.userId ?? null,
    agent_detail_json: jsonOrNull(state.agentDetail ?? null),
    task_detail_json: jsonOrNull(state.taskDetail ?? null),
    session_info_json: jsonOrNull(state.sessionInfo ?? null),
    state_json: JSON.stringify(state),
    created_at: now,
    updated_at: now,
  };
}

function safeParse<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function rowToState(row: PersistedSessionRow): SessionInitState | null {
  const parsed = safeParse<SessionInitState>(row.state_json);
  return parsed;
}

/**
 * Decompose a composite primary key back into (spaceId, userId, agentSource, sessionId).
 * Composite primary key format: `{spaceId}:{userId}:{agentSource}:{sessionId}`.
 * A spaceId segment of `_default` means an old caller lacked spaceId context.
 */
function parseSessionRowId(
  id: string,
): { spaceId: string; userId: string; agentSource: string; sessionId: string } | null {
  const parts = id.split(":");
  if (parts.length < 4) return null;
  const [spaceId, userId, agentSource, ...rest] = parts;
  return { spaceId, userId, agentSource, sessionId: rest.join(":") };
}

const UPSERT_SQL = `
INSERT INTO sessions (
  session_id, session_key, status, agent_id, task_id, user_id, cb_user_id,
  agent_detail_json, task_detail_json, session_info_json, state_json,
  created_at, updated_at
) VALUES (
  @session_id, @session_key, @status, @agent_id, @task_id, @user_id, @cb_user_id,
  @agent_detail_json, @task_detail_json, @session_info_json, @state_json,
  @created_at, @updated_at
)
ON CONFLICT(session_id) DO UPDATE SET
  session_key       = excluded.session_key,
  status            = excluded.status,
  agent_id          = excluded.agent_id,
  task_id           = excluded.task_id,
  user_id           = excluded.user_id,
  cb_user_id        = excluded.cb_user_id,
  agent_detail_json = excluded.agent_detail_json,
  task_detail_json  = excluded.task_detail_json,
  session_info_json = excluded.session_info_json,
  state_json        = excluded.state_json,
  updated_at        = excluded.updated_at
`;

/**
 * `loadAllInitialized` return structure: contains the four identity segments spaceId / userId / agentSource / sessionId,
 * letting the assembly layer put the identity back into SessionStore in one go.
 */
export interface HydratedSessionRow {
  spaceId: string;
  userId: string;
  agentSource: string;
  sessionId: string;
  state: SessionInitState;
}

export interface SessionRepo {
  /**
   * Write-through semantics: when await completes, L2a has been persisted (or the failure was silently degraded).
   *
   * See the 2026-07-13 fix: under the original fire-and-forget semantics in a multi-node deployment, the storage PUT was still in flight
   * when pod A closed the stream, and pod B's turn-2 fell into the
   * `tryHistoryScan` fallback due to an L2a miss -> bypass -> the request passed through to the LLM, skipping the session state machine.
   *
   * Implementation detail: write failures do not throw (keeping the degradation contract "L1 is authoritative, L2a is a persistent backup"),
   * but the write must be awaited, because in cross-node scenarios L2a is the real shared state.
   */
  upsert(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    state: SessionInitState,
  ): Promise<void>;
  getBySessionId(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<SessionInitState | null>;
  deleteBySessionId(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): void;
  loadAllInitialized(): Promise<HydratedSessionRow[]>;
}

class SqliteSessionRepo implements SessionRepo {
  constructor(private db: Database.Database) {}

  async upsert(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    state: SessionInitState,
  ): Promise<void> {
    // better-sqlite3 is a synchronous API; wrapping it in async is only to match the SessionRepo contract,
    // so the await semantics on the store side are uniform (cross-node deployments use KvSessionRepo/RedisSessionRepo,
    // which are truly async).
    try {
      const row = rowFromState(spaceId, userId, agentSource, sessionId, state);
      this.db.prepare(UPSERT_SQL).run(row);
    } catch (err) {
      console.warn(
        "[session-db] upsert failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async getBySessionId(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): Promise<SessionInitState | null> {
    try {
      const row = this.db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sessionRowId(spaceId, userId, agentSource, sessionId)) as
        | PersistedSessionRow
        | undefined;
      return row ? rowToState(row) : null;
    } catch {
      return null;
    }
  }

  deleteBySessionId(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
  ): void {
    try {
      this.db
        .prepare("DELETE FROM sessions WHERE session_id = ?")
        .run(sessionRowId(spaceId, userId, agentSource, sessionId));
    } catch (err) {
      console.warn(
        "[session-db] delete failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async loadAllInitialized(): Promise<HydratedSessionRow[]> {
    try {
      const rows = this.db
        .prepare("SELECT * FROM sessions WHERE status = 'initialized'")
        .all() as PersistedSessionRow[];
      const out: HydratedSessionRow[] = [];
      for (const r of rows) {
        const s = rowToState(r);
        if (!s) continue;
        const parsed = parseSessionRowId(r.session_id);
        if (!parsed) continue;
        out.push({ ...parsed, state: s });
      }
      return out;
    } catch {
      return [];
    }
  }
}

/** Null repo used when SQLite init fails — silently no-ops on writes. */
class NullSessionRepo implements SessionRepo {
  async upsert(): Promise<void> {}
  async getBySessionId(): Promise<SessionInitState | null> {
    return null;
  }
  deleteBySessionId(): void {}
  async loadAllInitialized(): Promise<HydratedSessionRow[]> {
    return [];
  }
}

let _repo: SessionRepo | null = null;

export function getSessionRepo(): SessionRepo {
  if (_repo) return _repo;
  const db = getDb();
  _repo = db ? new SqliteSessionRepo(db) : new NullSessionRepo();
  return _repo;
}

/** Replace the singleton with a Redis-backed repo (called at injection pipeline init). */
export function setSessionRepo(repo: SessionRepo): void {
  _repo = repo;
}

/** Reset singleton — tests only. */
export function __resetSessionRepoForTests(): void {
  _repo = null;
}
