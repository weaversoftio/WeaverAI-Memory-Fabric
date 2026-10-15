/**
 * KvSessionRepo —— SessionRepo backed by ProxyStorage.
 *
 * Key path:
 *   ttl/<spaceId>/<userId>/<agentSource>/<sessionId>/inj-sess.json
 *
 * spaceId is the tenant isolation segment. Old callers passing an empty string fall back to `_default`.
 *
 * `upsert` is an async write-through - after the caller's `await` completes, L2a has definitely been persisted.
 * This is the direct basis of the 2026-07-13 fix for "cross-node session-init intermediate-state race -> request passes through to the LLM"
 * (under the original fire-and-forget semantics, the storage PUT could still be in flight when pod A closed the stream,
 * and pod B's turn-2 fell into the tryHistoryScan fallback due to an L2a miss -> bypass).
 * Write failures stay silently degraded: after catch only warn, no throw - upstream L1 is still authoritative.
 *
 * Read interfaces are async; a miss returns null and never throws.
 *
 * `loadAllInitialized`:
 *   - SqliteStorage / FsStorage / MemoryStorage use listNames + getJSON,
 *     decomposing the key back into the four identity segments (spaceId, userId, agentSource, sessionId)
 */
import type { SessionRepo, HydratedSessionRow } from "./sessionRepo.js";
import type { SessionInitState } from "../session/types.js";
import type { ProxyStorage } from "../storage/proxy-storage.js";
import { sessionDirOf } from "../storage/key-utils.js";

const TTL_BUCKET_PREFIX = "ttl/";
const MAIN_FILENAME = "inj-sess.json";

function mainKey(
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  const sp = spaceId || "_default";
  return `${sessionDirOf("ttl", sp, userId, agentSource, sessionId)}${MAIN_FILENAME}`;
}

export class KvSessionRepo implements SessionRepo {
  constructor(private readonly storage: ProxyStorage) {}

  async upsert(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    state: SessionInitState,
  ): Promise<void> {
    // Compute the key up front - assertKeySegment / assertAgentSource validation throws synchronously here,
    // so callers see illegal arguments at the assembly layer (instead of a silent async failure).
    const key = mainKey(spaceId, userId, agentSource, sessionId);
    try {
      await this.storage.putJSON(key, state);
    } catch (err) {
      // Silent degradation: L1 is still the authoritative write-through target; an L2a write failure does not block the main flow.
      const e = err as { statusCode?: number; code?: string; message?: string };
      console.warn(
        `[kv-session] upsert FAIL key=${key}: ` +
          `${e?.statusCode ?? ""} ${e?.code ?? ""} ${e?.message ?? String(err)}`,
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
      return await this.storage.getJSON<SessionInitState>(
        mainKey(spaceId, userId, agentSource, sessionId),
      );
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
    this.storage
      .del(mainKey(spaceId, userId, agentSource, sessionId))
      .catch(() => { /* silent */ });
  }

  async loadAllInitialized(): Promise<HydratedSessionRow[]> {
    try {
      // listNames is passed the "ttl/" prefix; the returned name is the path with that prefix removed,
      // expected to look like "<spaceId>/<userId>/<agentSource>/<sessionId>/inj-sess.json".
      const names = await this.storage.listNames(TTL_BUCKET_PREFIX);
      const out: HydratedSessionRow[] = [];
      const suffix = `/${MAIN_FILENAME}`;
      for (const name of names) {
        if (!name.endsWith(suffix)) continue;
        const stem = name.slice(0, -suffix.length);
        const segs = stem.split("/");
        if (segs.length !== 4) continue;
        const [spaceId, userId, agentSource, sessionId] = segs;
        const state = await this.storage.getJSON<SessionInitState>(
          TTL_BUCKET_PREFIX + name,
        );
        if (!state || state.status !== "initialized") continue;
        out.push({ spaceId, userId, agentSource, sessionId, state });
      }
      return out;
    } catch {
      return [];
    }
  }
}
