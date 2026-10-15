/**
 * skill-bridge — reverse proxy for `<proxy>/skill-bridge/v3/skill/*` → core gateway.
 *
 * Why: the LLM uses Bash to curl skill operations (see <skill_tools> block in
 * system prompt). We do NOT want the bearer token to land in the prompt, and we
 * want to stamp `(user_id, team_id, agent_id, task_id?)` from the session into
 * outbound bodies so the LLM cannot fake identity.
 *
 * Behaviour:
 *   1. Match path `/skill-bridge/v3/skill/<sub>`. Anything else → 404.
 *   2. Refuse `_gc/versions` (ops-only).
 *   3. Require initialized session (`x-conversation-id` keyed). Else 401.
 *   4. Parse JSON body; merge IdFields from session, overwriting if conflict.
 *   5. POST to `${coreSkill.endpoint}/v3/skill/<sub>` with auth headers.
 *   6. Pass through status + JSON body unchanged.
 *
 * No streaming, no body logging (responses may contain SKILL.md content).
 */

import type { Context } from "hono";
import type { Redis } from "ioredis";
import { getSessionStore } from "../session/store.js";
import type { BindingRepo } from "../db/binding-repo.js";
import { KvBindingRepo } from "../db/kv-binding-repo.js";
import { RedisBindingRepo } from "../db/binding-repo.js";
// getSkillExtractTrigger / KvExtractStore were deleted together with the old path.
// See the header comment of handler-glue.ts -- the skill_extract trigger path is currently unavailable,
// the core side will later provide a manual archive endpoint, and the agent tool will then be pointed at that endpoint again.
import { getRedisClient } from "../db/redis-client.js";
import { VersionPinRepo } from "./version-pin-repo.js";
import { KvVersionPinRepo } from "./kv-version-pin-repo.js";
import { getProxyStorage } from "../storage/factory.js";
import { getMetadataClient } from "../meta/client.js";
import type { ProxyConfig } from "../types.js";
import { emitBridgeToolCallTelemetry, emitBridgeRejectTelemetry, agentSourceFromSessionKey } from "../memory/bridge-telemetry.js";
import { getCoreSkillClient, type CoreSkillClient } from "./core-client.js";
import { BRIDGE_SIG_HEADER, verifyBridgeSession } from "../bridge-signature.js";

/**
 * Either-or pin repo (KvVersionPinRepo or VersionPinRepo) --
 * the interfaces are aligned (getVersion/pinMany/upsertVersion), and business code need not know the concrete implementation.
 *
 * All methods take
 * two required parameters `userId + agentSource`.
 *
 * Later a `spaceId` first parameter was added -- all methods of KvVersionPinRepo need 5 segments
 * to assemble the correct storage key. The old VersionPinRepo (Redis) is adapted to the same
 * 5-parameter signature with a wrapper, and the spaceId segment is simply swallowed (the Redis version's key does not carry spaceId).
 *
 * Previously the 4-parameter signature + stuffing KvVersionPinRepo directly into PinRepoLike would cause:
 *   spaceId ← ids.user_id
 *   userId  ← ids.agent_source
 *   agentSource ← sessionKey
 *   sessionId ← skillId
 * -> keys completely garbled and tenant isolation lost; node B reads always miss, and the symptom matches
 *   "written but not visible on another node". See docs/design/2026-07-13-proxy-multinode-state-audit.md P0-1.
 */
interface PinRepoLike {
  getVersion(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    skillId: string,
  ): Promise<number | null>;
  pinMany(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    pairs: Array<{ skillId: string; version: number }>,
  ): Promise<void>;
  upsertVersion(
    spaceId: string,
    userId: string,
    agentSource: string,
    sessionId: string,
    skillId: string,
    version: number,
  ): Promise<void>;
}

/**
 * Wrap the 4-parameter Redis-based VersionPinRepo into the 5-parameter PinRepoLike.
 * The Redis key schema (skill:vpin:<userId>:<agentSource>:<sessionId>) originally
 * did not carry spaceId -- a single-instance Redis is generally one-to-one with or non-overlapping with a space,
 * so the old behaviour is kept and the spaceId parameter is simply discarded.
 */
function adaptRedisPinRepo(inner: VersionPinRepo): PinRepoLike {
  return {
    getVersion: (_space, u, a, s, sk) => inner.getVersion(u, a, s, sk),
    pinMany:    (_space, u, a, s, pairs) => inner.pinMany(u, a, s, pairs),
    upsertVersion: (_space, u, a, s, sk, v) => inner.upsertVersion(u, a, s, sk, v),
  };
}

/**
 * Assembly decision -- a single entry point, so skill-bridge gets the "currently effective" storage combination.
 *
 *   storage.enabled + mode!=off -> use ProxyStorage (KvVersionPinRepo)
 *   otherwise if redis.enabled       -> use Redis (VersionPinRepo)
 *   otherwise                          -> null (in-memory fallback)
 *
 * KvExtractStore / RedisExtractStore used to be assembled here for the old-path
 * SkillExtractTrigger, and have been deleted together with the old path.
 */
export interface SkillBackingBundle {
  redis: Redis | null;
  pinRepo: PinRepoLike | null;
  /**
   * BindingRepo is taken directly from SessionStore (injected when the injection pipeline was assembled),
   * not reconstructed, ensuring the instance the bridge L2 lookup uses is the same as the one the handler writes binding with
   * -- after a unit test injects SessionStore.setBindingRepo, the bridge also reads the same mock.
   */
  bindingRepo: BindingRepo | null;
}

function resolveBacking(config: ProxyConfig): SkillBackingBundle {
  const bindingRepo = getSessionStore().getBindingRepo() ?? null;
  if (config.storage?.enabled) {
    const storage = getProxyStorage(config.storage);
    return {
      redis: null,
      pinRepo: new KvVersionPinRepo(storage),
      bindingRepo: bindingRepo ?? new KvBindingRepo(storage),
    };
  }
  const redis = config.redis?.enabled ? getRedisClient(config.redis) : null;
  return {
    redis,
    pinRepo: redis ? adaptRedisPinRepo(new VersionPinRepo(redis, config.redis?.ttlSeconds)) : null,
    bindingRepo: bindingRepo ?? (redis ? new RedisBindingRepo(redis) : null),
  };
}

const TAG = "[skill-bridge]";

// Subpaths the bridge will forward. Keep this allowlist tight on purpose so we
// can audit exactly which core endpoints are reachable from the LLM.
const ALLOWED_SUBPATHS = new Set<string>([
  "search",
  "list",
  "get",
  "get-by-name",
  "create",
  "update",
  "patch",
  "delete",
  "versions",
  "files/read",
  "files/download",
  "files/write",
  "files/remove",
  "listing",
  // The agent-side tool is named skill_extract; the bridge forwards to core force-archive
  // (does not depend on messages; core takes them from the conversation buffer). See the sub === "extract" branch below.
  "extract",
]);

/** Write subpaths — rejected when `allowLlmWrite=false`. */
const WRITE_SUBPATHS = new Set<string>([
  "create",
  "update",
  "patch",
  "delete",
  "files/write",
  "files/remove",
]);

// Note: there used to be RESET_EXTRACT_SUBPATHS, used to zero the proxy-side buffer counter
// after a write succeeded or an extract completed (the old path KvExtractStore). After the old path was deleted the counter
// is gone too, and this constant was deleted with it.

/**
 * Version pinning — see docs/design/2026-06-29-skill-version-pinning.md.
 *
 * Read ops: proxy injects `version` into outbound so plugin returns the pinned
 *   version's content (instead of head). Cross-tool consistency.
 * Write ops: proxy injects `expected_version` for optimistic locking. If head
 *   moved (external update), plugin returns 40901 SKILL_VERSION_STALE.
 * Delete / create / extract / search / listing / list / versions / files-download
 *   do NOT participate (delete is unconditional; others are stateless).
 */
const READ_VERSION_OPS = new Set<string>(["get", "files/read"]);
const WRITE_LOCK_OPS = new Set<string>([
  "update",
  "patch",
  "files/write",
  "files/remove",
]);

interface SessionIdFields {
  user_id: string;
  team_id: string;
  agent_id: string;
  /**
   * agentSource on the URL path side (`claude-code` / `codebuddy` ...) -- used for the
   * Repo three-segment isolation key. Derived back from the keyId under which SessionStore stores the session
   * (keyId looks like `${agentSource}:${sessionId}`).
   */
  agent_source: string;
  /**
   * Kernel tenant/instance ID for `x-wamf-service-id`. Extracted from
   * `SessionInfo.space_id` (which itself was captured from the original
   * request path `/{agent}/{spaceId}/...`). Undefined for legacy sessions
   * created before space_id tracking — caller falls back to
   * `config.coreSkill.serviceId`.
   */
  space_id?: string;
  /**
   * User API key (`x-wamf-user-key`). Captured during session init from the
   * upstream request's api key exchange. Required by kernel /v3/meta/* endpoints
   * to enforce per-user ACL/visibility. Missing here means the session upstream
   * bypassed apikey verification — that's a programming bug, not a rejectable
   * runtime state; team-wide search returns 500 rather than silently opening up.
   */
  user_key?: string;
  /**
   * Composite key actually used to load state from SessionStore
   * (`${agentSource}:${sessionId}`). Used by telemetry to align with the session_key of session_init_logs --
   * telemetry must not guess the prefix; it must use the key that was actually hit.
   */
  composite_key?: string;
}

/**
 * The bridge takes only 2 headers:
 *   - x-conversation-id (or x-session-id / x-chat-id / x-thread-id) -> sessionId
 *   - x-wamf-service-id → spaceId
 *
 * No longer relies on Authorization to look up userId -- see docs/design/2026-08-03-binding-flatten.md;
 * the L2 fallthrough goes via the flattened (spaceId, sessionId) -> binding.json, stamping directly.
 */
function deriveSessionId(c: Context): string | null {
  return (
    c.req.header("x-conversation-id") ??
    c.req.header("x-session-id") ??
    c.req.header("x-chat-id") ??
    c.req.header("x-thread-id") ??
    null
  );
}

function stateToIdFields(
  state: import("../session/types.js").SessionInitState | undefined,
  matchedKey: string,
): SessionIdFields | null {
  if (!state || state.status !== "initialized" || !state.sessionInfo) return null;
  const s = state.sessionInfo;
  if (!s.user_id || !s.team_id || !s.agent_id) return null;
  // agentSource is derived back from matchedKey (the hit L1 key looks like `${agentSource}:${sessionId}`);
  // the L2b branch takes it directly from binding.agentSource (see bindingToIdFields).
  const colonIdx = matchedKey.indexOf(":");
  const agentSource = colonIdx > 0 ? matchedKey.slice(0, colonIdx) : "claude-code";
  return {
    user_id: s.user_id,
    team_id: s.team_id,
    agent_id: s.agent_id,
    agent_source: agentSource,
    space_id: s.space_id,
    user_key: s.user_key,
    composite_key: matchedKey,
  };
}

function bindingToIdFields(
  binding: import("../db/binding-repo.js").SessionBinding,
  spaceId: string,
  sessionId: string,
): SessionIdFields | null {
  if (binding.outcome !== "initialized") return null;
  if (!binding.userId || !binding.teamId || !binding.agentId) return null;
  const agentSource = binding.agentSource || "claude-code";
  return {
    user_id: binding.userId,
    team_id: binding.teamId,
    agent_id: binding.agentId,
    agent_source: agentSource,
    space_id: spaceId,
    user_key: binding.userKey,
    composite_key: `${agentSource}:${sessionId}`,
  };
}

/**
 * L1: try the bare sessionId first (the keyId stored by handler.ts is `${agentSource}:${sessionId}`;
 * the bridge curl cannot get agentSource, so it probes in candidate prefix order).
 *
 * WARNING: candidate polling is transitional compatibility: within the same pod the main conversation path has created the session, the key in the L1 Map carries the
 * agentSource prefix, and a bare sessionId does not hit. After plan B flattening, the L2b binding hits
 * the 2-segment key directly and prefix polling is no longer needed; L1 is kept here so that if L2b has a problem, we can still
 * recover from in-memory L1 without a 401.
 */
function loadSessionIdsL1(sessionId: string): SessionIdFields | null {
  const candidates = sessionId.includes(":")
    ? [sessionId]
    : [sessionId, `codebuddy:${sessionId}`, `claude-code:${sessionId}`];
  for (const k of candidates) {
    const s = getSessionStore().get(k);
    if (s) {
      const fields = stateToIdFields(s, k);
      if (fields) return fields;
    }
  }
  return null;
}

/**
 * L2 fallthrough -- after flattening it takes only (spaceId, sessionId). See
 * docs/design/2026-08-03-binding-flatten.md.
 *
 * No longer goes through the verifyUserKey + getOrRecover 4-segment path. Reasons:
 *   1) the bridge curl template does not carry Authorization: Bearer, so verify cannot get userId
 *   2) after flattening, binding.json already stores user_id/team_id/agent_id/agent_source/user_key,
 *      one GET is enough, with no need to additionally fetch kernel getAgent/getTask
 */
async function loadSessionIdsL2(
  bindingRepo: BindingRepo | null,
  spaceId: string,
  sessionId: string,
): Promise<SessionIdFields | null> {
  if (!bindingRepo) return null;
  try {
    const binding = await bindingRepo.getBinding(spaceId, sessionId);
    if (!binding) return null;
    return bindingToIdFields(binding, spaceId, sessionId);
  } catch (err) {
    console.warn(`${TAG} L2 getBinding error space=${spaceId} sid=${sessionId}: ${(err as Error).message}`);
    return null;
  }
}

function envelope(code: number, message: string, httpStatus = 200) {
  return new Response(
    JSON.stringify({ code, message, request_id: `bridge-${Date.now()}` }),
    { status: httpStatus, headers: { "content-type": "application/json" } },
  );
}

function extractSubpath(path: string): string | null {
  // path comes in as `/skill-bridge/v3/skill/<sub...>` (or the segment after
  // the bridge prefix, depending on how it was mounted).
  const m = path.match(/^\/skill-bridge\/v3\/skill\/(.+)$/);
  if (!m) return null;
  return m[1].replace(/\/+$/, "");
}

/**
 * Contract for the ACL/visibility resolver invoked by team-wide search.
 * Production implementation calls MetadataClient.listAccessibleAssets with
 * asset_type='skill' + action='read' + visibility='team'. Tests inject a stub.
 *
 * No caching: skill_search is low-frequency (0-3 times per session), meta call
 * is ~tens-of-ms next to a seconds-long LLM turn, and a cache would introduce
 * a stale window that contradicts the panel (a visibility flip on the panel
 * should be visible to the LLM's next search immediately).
 */
export type VisibleSkillIdsResolver = (input: {
  user_id: string;
  team_id: string;
  user_key: string;
  space_id?: string;
}) => Promise<{ ids: string[] }>;

export interface SkillBridgeDeps {
  /** Override fetcher (tests). */
  fetcher?: typeof fetch;
  /** Override `Date.now` (tests). */
  now?: () => number;
  /**
   * Override the visibility whitelist lookup (tests). When omitted, the bridge
   * uses the production resolver that calls kernel /v3/meta/asset/list-accessible.
   */
  resolveVisibleSkillIds?: VisibleSkillIdsResolver;
  /**
   * Override the core skill client (tests). When omitted, uses the singleton
   * built from config. Used by team-search to enumerate agent-owned skills
   * (B) and already-injected skills (C) — see whitelist composition below.
   */
  coreClient?: CoreSkillClient;
}

/**
 * Plugin's hard upper bound for /v3/skill/search `top_k` (see
 * searchRequestSchema in plugin — z.number().int().min(1).max(50)).
 *
 * We overfetch to this cap on team-wide search so the response-side visibility
 * filter has room to drop non-whitelisted items without starving the LLM. The
 * BM25 top-50 is a strict superset of top-N (for N ≤ 50), so slicing after the
 * filter yields the same ordering as if plugin had returned exactly N.
 *
 * Cost: ~20KB of extra JSON per team search + a Set.has per item. Trivial.
 * Failure mode: only if the team has more than 50 team-visible skills that
 * match the query AND enough of the top-50 hits are non-whitelisted to leave
 * fewer than N — vanishingly unlikely for the current corpus size. If it ever
 * matters, raise plugin's cap; this stays as-is.
 *
 * TODO(upgrade): in the long run, if the number of entries remaining after team-search filtering is often < the user's
 * top_k (whitelist merged is significantly larger than 50, or the filter hit rate P95 < 0.2), it means
 * the team's skill pool has overflowed the top-50 and overfetch cannot cover it -> upgrade to request-side
 * filtering (the proxy passes `skill_ids: [...]` -> core retrieves exactly within the pool).
 * See `docs/design/2026-08-10-skill-search-scope-fix.md` section 3 Plan A.
 */
const PLUGIN_SEARCH_HARD_TOPK = 50;

/** Default `top_k` the LLM sees if it doesn't specify one. Matches plugin default. */
const DEFAULT_SEARCH_TOPK = 10;

/**
 * Default resolver: call kernel /v3/meta/asset/list-accessible each time.
 *
 * Failure: kernel call throws → propagate; skill-bridge fail-closes with
 * empty items so LLM never sees an unfiltered team search.
 */
function defaultVisibleSkillIdsResolver(
  config: ProxyConfig,
): VisibleSkillIdsResolver {
  return async ({ user_id, team_id, user_key, space_id }) => {
    // Use the real space_id from the request (kernel routes tenants by
    // x-wamf-service-id header) — fall back to config only for legacy sessions.
    const serviceId = space_id || config.coreSkill.serviceId;
    const client = getMetadataClient(config.coreSkill, serviceId, user_key);
    const assets = await client.listAccessibleAssets({
      user_id,
      team_id,
      asset_type: "skill",
      action: "read",
      // Aligns with the frontend "team assets" tab (SkillsPanel.tsx:132-136):
      // strictly visibility='team'. Private/ACL-restricted skills are hidden
      // from LLM-driven search, same as they're hidden from other members
      // in the panel.
      visibility: "team",
    });
    // For skill assets, asset_id === skill_id by kernel convention.
    return { ids: assets.map((a) => a.asset_id) };
  };
}

/**
 * Build a Hono-compatible handler. Hono passes its `Context`; we use `c.req.raw`
 * to get the underlying Request, then issue an outbound fetch and adapt the
 * response back to a `Response`.
 */
export function createSkillBridgeHandler(
  config: ProxyConfig,
  deps: SkillBridgeDeps = {},
): (c: Context) => Promise<Response> {
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);

  return async (c: Context): Promise<Response> => {
    const t0 = (deps.now ?? Date.now)();

    const path = new URL(c.req.url).pathname;
    const sub = extractSubpath(path);
    // Early-exit telemetry for pre-check failures: before every return emit a bridge_call with a non-empty reject_reason.
    // sessionKey may not be derived yet at this point; passing "" is allowed (the helper falls back to agentSource='unknown').
    if (!sub) {
      emitBridgeRejectTelemetry({
        sessionKey: "", bridgeSource: "skill-bridge",
        rejectReason: "unknown_path", httpStatus: 404,
      });
      return envelope(40401, `${TAG} unknown path ${path}`, 404);
    }
    if (!ALLOWED_SUBPATHS.has(sub)) {
      emitBridgeRejectTelemetry({
        sessionKey: "", bridgeSource: "skill-bridge",
        rejectReason: "subpath_forbidden", httpStatus: 403,
        executedEndpoint: sub,
      });
      return envelope(40301, `${TAG} subpath '${sub}' not allowed via bridge`, 403);
    }
    if (c.req.method !== "POST") {
      emitBridgeRejectTelemetry({
        sessionKey: "", bridgeSource: "skill-bridge",
        rejectReason: "method_not_allowed", httpStatus: 405,
        executedEndpoint: sub,
      });
      return envelope(40501, `${TAG} method ${c.req.method} not allowed`, 405);
    }

    const ct = c.req.header("content-type") ?? "";
    if (!ct.toLowerCase().includes("application/json")) {
      emitBridgeRejectTelemetry({
        sessionKey: "", bridgeSource: "skill-bridge",
        rejectReason: "content_type_invalid", httpStatus: 415,
        executedEndpoint: sub,
      });
      return envelope(41501, `${TAG} content-type must be application/json`, 415);
    }

    // Session must be initialized — IdFields come from there.
    // The curl template carries only two headers (x-conversation-id, x-wamf-service-id);
    // on an L1 miss, use these two to look up nottl/<spaceId>/<sessionId>/binding.json.
    const sessionKey = deriveSessionId(c);
    if (!sessionKey) {
      emitBridgeRejectTelemetry({
        sessionKey: "", bridgeSource: "skill-bridge",
        rejectReason: "missing_conversation_id", httpStatus: 401,
        executedEndpoint: sub,
      });
      return envelope(40101, `${TAG} missing x-conversation-id (or x-session-id / x-chat-id / x-thread-id) header`, 401);
    }
    // The session ID alone is not a credential (it appears in logs and upstream headers):
    // the recipe must also carry the signature this proxy injected for it.
    if (!verifyBridgeSession(c.req.header(BRIDGE_SIG_HEADER), sessionKey, c.req.header("x-wamf-service-id"))) {
      emitBridgeRejectTelemetry({
        sessionKey, bridgeSource: "skill-bridge",
        rejectReason: "bridge_signature_invalid", httpStatus: 401,
        executedEndpoint: sub,
      });
      return envelope(40102, `${TAG} missing or invalid ${BRIDGE_SIG_HEADER}; use the curl recipe from the system prompt`, 401);
    }
    const spaceId = c.req.header("x-wamf-service-id")
      ?? config.wamf?.serviceId
      ?? config.coreSkill?.serviceId
      ?? "";

    // Backing storage for extract trigger + version pin.
    // When storage.enabled + mode!=off → ProxyStorage (Kv* repos).
    // Otherwise → Redis (or null when disabled).
    const backing = resolveBacking(config);
    const pinRepoInline = backing.pinRepo;
    const bindingRepoInline = backing.bindingRepo;

    let ids = loadSessionIdsL1(sessionKey);
    if (!ids && bindingRepoInline && spaceId) {
      console.log(`${TAG} session=${sessionKey} L1 miss → L2 binding lookup (space=${spaceId})`);
      ids = await loadSessionIdsL2(bindingRepoInline, spaceId, sessionKey);
    }
    if (!ids) {
      emitBridgeRejectTelemetry({
        sessionKey, bridgeSource: "skill-bridge",
        rejectReason: "session_not_initialized", httpStatus: 401,
        executedEndpoint: sub, spaceId,
      });
      return envelope(40101, `${TAG} session not initialized; cannot derive identity`, 401);
    }
    // backing.redis used to serve the old-path SkillExtractTrigger; the old path is deleted,
    // so this function body no longer uses redis directly; the backing structure is kept because the pinRepo
    // branch that goes through redis still needs it.

    // Ablation experiment: reject write operations when allowLlmWrite=false
    const allowLlmWrite = config.skillRuntime?.allowLlmWrite ?? false;
    if (!allowLlmWrite && WRITE_SUBPATHS.has(sub)) {
      emitBridgeRejectTelemetry({
        sessionKey, bridgeSource: "skill-bridge",
        rejectReason: "write_ops_disabled", httpStatus: 403,
        executedEndpoint: sub,
        spaceId: ids.space_id, userId: ids.user_id, teamId: ids.team_id,
        agentId: ids.agent_id, agentSource: ids.agent_source,
      });
      return envelope(40302, `${TAG} LLM write access to skill is disabled (skillRuntime.allowLlmWrite=false)`, 403);
    }

    // Parse body. Empty body → {}. Malformed → 400.
    let inboundBody: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          inboundBody = parsed as Record<string, unknown>;
        } else {
          emitBridgeRejectTelemetry({
            sessionKey, bridgeSource: "skill-bridge",
            rejectReason: "body_not_object", httpStatus: 400,
            executedEndpoint: sub, requestBody: raw.slice(0, 512),
            spaceId: ids.space_id, userId: ids.user_id, teamId: ids.team_id,
            agentId: ids.agent_id, agentSource: ids.agent_source,
          });
          return envelope(40001, `${TAG} body must be a JSON object`, 400);
        }
      }
    } catch (err) {
      emitBridgeRejectTelemetry({
        sessionKey, bridgeSource: "skill-bridge",
        rejectReason: "invalid_json_body", httpStatus: 400,
        executedEndpoint: sub,
        spaceId: ids.space_id, userId: ids.user_id, teamId: ids.team_id,
        agentId: ids.agent_id, agentSource: ids.agent_source,
      });
      return envelope(40001, `${TAG} invalid JSON body: ${(err as Error).message}`, 400);
    }

    // ── files/download: read from core, decode, return raw bytes ──────
    // LLM uses `curl -o <local_path>` to save directly; no JSON parsing needed.
    if (sub === "files/download") {
      const outbound = {
        ...inboundBody,
        user_id: ids.user_id,
        team_id: ids.team_id,
        agent_id: ids.agent_id,
      };
      const upstreamUrl = `${config.coreSkill.endpoint.replace(/\/$/, "")}/v3/skill/files/read`;
      const headers: Record<string, string> = {
        "Authorization": `Bearer ${config.coreSkill.serviceToken}`,
        // Prefer session-derived tenant; fall back to config for legacy sessions.
        "x-wamf-service-id": ids.space_id || config.coreSkill.serviceId,
        "Content-Type": "application/json",
      };
      const dlOutboundBody = JSON.stringify(outbound);
      const dlCallStart = (deps.now ?? Date.now)();
      let coreResp: Response;
      try {
        coreResp = await fetcher(upstreamUrl, {
          method: "POST",
          headers,
          body: dlOutboundBody,
          signal: AbortSignal.timeout(Math.max(5000, config.coreSkill.timeoutMs * 4)),
        });
      } catch (err) {
        console.warn(`${TAG} files/download upstream fetch failed: ${(err as Error).message}`);
        // Telemetry completion: symmetric with main path :822; an unresponsive upstream also counts as a call.
        // Previously this catch branch silently returned, making CH have one fewer entry than the "N calls" seen from curl's view.
        const dlEmitKey = ids.composite_key ?? sessionKey;
        emitBridgeToolCallTelemetry({
          sessionKey: dlEmitKey,
          spaceId: ids.space_id,
          userId: ids.user_id,
          teamId: ids.team_id,
          agentId: ids.agent_id,
          agentSource: ids.agent_source || agentSourceFromSessionKey(dlEmitKey),
          bridgeSource: "skill-bridge",
          executedEndpoint: "files/download",
          requestBody: dlOutboundBody.slice(0, 512),
          upstreamStatus: 0,
          elapsedMs: (deps.now ?? Date.now)() - dlCallStart,
        });
        return envelope(50301, `${TAG} upstream unavailable: ${(err as Error).message}`, 502);
      }
      const coreText = await coreResp.text().catch(() => "");
      const elapsed = (deps.now ?? Date.now)() - t0;
      console.log(`${TAG} sub=files/download status=${coreResp.status} elapsed=${elapsed}ms`);

      // Core error → pass through as JSON envelope
      if (coreResp.status < 200 || coreResp.status >= 300) {
        return new Response(coreText, {
          status: coreResp.status,
          headers: { "content-type": coreResp.headers.get("content-type") ?? "application/json" },
        });
      }

      // Parse envelope, extract file content
      let parsed: { code?: number; data?: { content?: string; encoding?: string; mime_type?: string; size_bytes?: number } };
      try {
        parsed = JSON.parse(coreText);
      } catch {
        return envelope(50001, `${TAG} files/download: failed to parse core response`, 502);
      }
      if (parsed.code !== 0 || !parsed.data?.content) {
        return new Response(coreText, {
          status: coreResp.status,
          headers: { "content-type": "application/json" },
        });
      }

      const { content, encoding, mime_type } = parsed.data;
      const rawBytes = encoding === "base64"
        ? Buffer.from(content, "base64")
        : Buffer.from(content, "utf-8");

      return new Response(rawBytes, {
        status: 200,
        headers: {
          "content-type": mime_type ?? "application/octet-stream",
          "content-length": String(rawBytes.length),
        },
      });
    }

    // Stamp identity. team_id / agent_id / user_id are all required by
    // the v3 strict-isolation middleware (collectV3Missing in v2-router.ts).
    //
    // user_id was historically skipped for read paths to avoid filtering
    // team-shared skills, but the v2 gateway now requires it for all /v3/*
    // paths.  The core layer handles this safely: when team_id is present,
    // core strips user_id before passing to store (skill-core.ts:365,384).
    //
    // For "search" subpath, we additionally stamp scope="team" so the
    // handler can skip agent_id owner-filtering and do a team-wide search.
    const isTeamWideSearch = sub === "search";
    /**
     * When we enter team-wide search, the whitelist we compute here also drives
     * the response-side filter (see below, after upstream response arrives). Kept
     * in the outer scope so the response handler can see it without a second
     * meta call. `originalTopK` is what the LLM asked for; we overfetch to
     * PLUGIN_SEARCH_HARD_TOPK from plugin to survive whitelist attrition, then
     * slice back to originalTopK before returning.
     */
    let searchVisibleIds: Set<string> | null = null;
    let searchOriginalTopK = 0;
    let outbound: Record<string, unknown>;
    /**
     * If the upstream path is inconsistent with `/v3/skill/${sub}` (e.g. extract -> force-archive),
     * a branch writes this variable; by default it follows sub.
     */
    let upstreamSubpathOverride: string | null = null;
    if (sub === "extract") {
      // The agent-side tool is called skill_extract, with the semantics "archive the current conversation immediately and trigger one skill extraction".
      // Forward to core `/v3/skill/conversation/force-archive` -- this endpoint does not take messages,
      // and gets the accumulated full conversation from the conversation buffer (/v3/skill/conversation/add pushed each round by the proxy main conversation path).
      // See core skill-schemas.ts forceArchiveRequestSchema.
      //
      // outbound needs only (space_id, user_id, team_id, agent_id, session_id) + an optional reason;
      // the messages / task_id passed by the agent are never passed through (irrelevant from the agent's view, implicit within the session).
      upstreamSubpathOverride = "conversation/force-archive";
      const reason = typeof inboundBody.reason === "string" && inboundBody.reason.trim()
        ? inboundBody.reason.trim().slice(0, 2000)
        : undefined;
      outbound = {
        space_id: ids.space_id || config.coreSkill.serviceId,
        user_id: ids.user_id,
        team_id: ids.team_id,
        agent_id: ids.agent_id,
        session_id: (() => {
          const composite = ids.composite_key ?? sessionKey;
          const colonIdx = composite.indexOf(":");
          return colonIdx > 0 ? composite.slice(colonIdx + 1) : composite;
        })(),
        ...(reason ? { reason } : {}),
      };
    } else {
      // v3 strict-isolation: ALL /v3 paths need team_id + agent_id + user_id.
      // Core layer strips user_id when team_id is present (team-shared semantics).
      outbound = {
        ...inboundBody,
        team_id: ids.team_id,
        agent_id: ids.agent_id,
        user_id: ids.user_id,
      };
      // For "search" subpath: stamp scope="team" so the handler skips
      // agent_id owner-filtering → team-wide search.
      if (isTeamWideSearch) {
        // Enforce visibility whitelist via **control-plane / data-plane composition**.
        //
        // Layering (see design discussion 2026-07-07):
        //   - Plugin (/v3/skill/*) is the data plane — pure business logic
        //     (CRUD + FTS). It does NOT know about ACL/visibility. Do not
        //     push authorization concerns into it.
        //   - Meta (/v3/meta/*) is the control plane — owns visibility × ACL.
        //     Frontend team-assets tab already composes on it
        //     (SkillsPanel.tsx: list-accessible + visibility='team').
        //   - Proxy composes: consult meta for a visibility whitelist, call
        //     plugin unchanged, filter the response.
        //
        // Contract:
        //   - Missing user_key → programming bug (session-init should have
        //     stored it). Return 500 rather than silently opening up.
        //   - Resolver throws → fail-closed: return {items: []}. Never widen
        //     to an unfiltered search on infra failure.
        //   - Empty whitelist → short-circuit: return {items: []} without
        //     hitting core (user has 0 visible team skills).
        //   - Non-empty whitelist → overfetch top_k=PLUGIN_SEARCH_HARD_TOPK,
        //     filter response items by whitelist, slice back to caller's top_k.
        if (!ids.user_key) {
          console.error(`${TAG} team search: session lacks user_key — session-init should have stored it (sessionKey=${sessionKey})`);
          return envelope(50001, `${TAG} team search misconfigured: session has no user_key`, 500);
        }

        // Whitelist = A union B (see docs/design/2026-08-10-skill-search-scope-fix.md section 4):
        //   A = meta list-accessible(visibility='team') — team-shared skill
        //   B = core /v3/skill/list (the agent's own full set)   -- includes private
        //
        // Originally there was C = listing "already injected in this session" for subtraction, but C is a live listing result,
        // and skills newly created within the session would appear in C and be subtracted -> unsearchable (Issue #1006).
        // C subtraction is removed: the cost is that already-injected skills may appear again in search results (harmless),
        // but there is no "forever unsearchable" blind spot.
        //
        // Failure degradation strategy:
        //   A fails -> fail-closed returns empty (safety fallback: never let the LLM see unfiltered results)
        //   B fails -> treated as an empty set, degrading to pure A (roughly the behaviour before the fix)
        const coreClient = deps.coreClient ?? getCoreSkillClient(config.coreSkill);
        const resolver = deps.resolveVisibleSkillIds
          ?? defaultVisibleSkillIdsResolver(config);

        const promiseA = resolver({
          user_id: ids.user_id,
          team_id: ids.team_id,
          user_key: ids.user_key,
          space_id: ids.space_id,
        }).then(r => ({ ok: true as const, ids: r.ids }))
          .catch(err => ({ ok: false as const, err: err as Error }));

        // B limit=1000 is the core listRequestSchema cap (paginationSchema.limit.max(1000)).
        // A single agent's own skills never reach the 1000 level, so fetch all at once without pagination.
        const promiseB = coreClient.listSkills(
          {
            team_id: ids.team_id,
            agent_id: ids.agent_id,
            pagination: { limit: 1000 },
          },
          { serviceId: ids.space_id },
        ).then(r => r.items.map(s => s.skill_id))
          .catch(err => {
            console.warn(`${TAG} team search B (list) failed, treating as empty: ${(err as Error).message}`);
            return [] as string[];
          });

        const [aResult, bIds] = await Promise.all([promiseA, promiseB]);

        if (!aResult.ok) {
          // Fail-closed: if A is down we must not degrade to unfiltered search.
          console.warn(`${TAG} team search whitelist resolver (A) failed, fail-closed: ${aResult.err.message}`);
          return new Response(
            JSON.stringify({ code: 0, message: "ok", request_id: `bridge-${(deps.now ?? Date.now)()}`, data: { items: [] } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        const whitelist: string[] = Array.from(new Set<string>([...aResult.ids, ...bIds]));
        console.log(
          `${TAG} team search whitelist A=${aResult.ids.length} B=${bIds.length}`
            + ` merged=${whitelist.length} user=${ids.user_id} team=${ids.team_id}`,
        );

        if (whitelist.length === 0) {
          // Short-circuit: no visible skill IDs → 0 matches guaranteed. Skip upstream.
          return new Response(
            JSON.stringify({ code: 0, message: "ok", request_id: `bridge-${(deps.now ?? Date.now)()}`, data: { items: [] } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        // Stash the whitelist Set + fixed slice size so the response handler
        // can filter/slice without re-consulting meta.
        //
        // 2026-08-10: Hard-whitelist inbound. LLM only supplies `query` —
        // top_k / mode / scope / any other field is dropped. Rationale:
        // less LLM-side decision surface, more consistent behavior across
        // sessions. If results feel thin, the fix is to refine the query,
        // not to raise top_k. See skill-tools-injector.ts (body: {"query": ...}).
        searchVisibleIds = new Set(whitelist);
        searchOriginalTopK = DEFAULT_SEARCH_TOPK;

        const query = typeof inboundBody.query === "string" ? inboundBody.query : "";
        outbound = {
          query,
          team_id: ids.team_id,
          agent_id: ids.agent_id,
          user_id: ids.user_id,
          scope: "team",
          // Overfetch to plugin's hard cap so response-side filtering has room.
          // Plugin remains unaware of proxy's ACL concerns — it just sees a
          // large-but-legal top_k. See PLUGIN_SEARCH_HARD_TOPK doc for why this
          // is safe.
          top_k: PLUGIN_SEARCH_HARD_TOPK,
        };
      }

      // ── Version pinning: inject pinned version for read/write ops ──
      // Read (get/files_read): inject `version` → plugin returns pinned version's content
      // Write (update/patch/files_write/files_remove): inject `expected_version` → optimistic lock
      // First-access is not pinned yet → falls through to head; lazy-pin captures the version afterwards.
      if (pinRepoInline && (READ_VERSION_OPS.has(sub) || WRITE_LOCK_OPS.has(sub))) {
        const skillId = typeof inboundBody.skill_id === "string" ? inboundBody.skill_id : undefined;
        if (skillId) {
          const pinRepo = pinRepoInline;
          const pinned = await pinRepo.getVersion(ids.space_id ?? "", ids.user_id, ids.agent_source, sessionKey, skillId);
          if (pinned !== null && pinned !== undefined) {
            if (READ_VERSION_OPS.has(sub)) {
              outbound.version = pinned;
            } else {
              outbound.expected_version = pinned;
            }
          }
          // else: first access → walk head, response side will lazy-pin.
        }
      }
    }

    const upstreamSub = upstreamSubpathOverride ?? sub;
    const upstreamUrl = `${config.coreSkill.endpoint.replace(/\/$/, "")}/v3/skill/${upstreamSub}`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${config.coreSkill.serviceToken}`,
      // Prefer session-derived tenant; fall back to config for legacy sessions.
      "x-wamf-service-id": ids.space_id || config.coreSkill.serviceId,
      "Content-Type": "application/json",
    };

    const outboundBody = JSON.stringify(outbound);
    const callStart = (deps.now ?? Date.now)();
    let resp: Response;
    try {
      resp = await fetcher(upstreamUrl, {
        method: "POST",
        headers,
        body: outboundBody,
        signal: AbortSignal.timeout(Math.max(5000, config.coreSkill.timeoutMs * 4)),
      });
    } catch (err) {
      console.warn(
        `${TAG} upstream fetch failed sub=${sub} err=${(err as Error).message}`,
      );
      // Telemetry: an unresponsive upstream also counts as a call (plan section 5.1 "every one must be recorded")
      // Use ids.composite_key to keep session_key aligned with session_init_logs.
      const emitKey = ids.composite_key ?? sessionKey;
      emitBridgeToolCallTelemetry({
        sessionKey: emitKey,
        spaceId: ids.space_id,
        userId: ids.user_id,
        teamId: ids.team_id,
        agentId: ids.agent_id,
        agentSource: ids.agent_source || agentSourceFromSessionKey(emitKey),
        bridgeSource: "skill-bridge",
        executedEndpoint: sub,
        requestBody: outboundBody.slice(0, 512),
        upstreamStatus: 0,
        elapsedMs: (deps.now ?? Date.now)() - callStart,
      });
      return envelope(50301, `${TAG} upstream unavailable: ${(err as Error).message}`, 502);
    }

    const respText = await resp.text().catch(() => "");
    const elapsed = (deps.now ?? Date.now)() - t0;
    console.log(
      `${TAG} sub=${sub} status=${resp.status} elapsed=${elapsed}ms`,
    );

    // Telemetry: upstream responded (including 4xx/5xx), record the actual status and latency
    const emitKey = ids.composite_key ?? sessionKey;
    emitBridgeToolCallTelemetry({
      sessionKey: emitKey,
      spaceId: ids.space_id,
      userId: ids.user_id,
      teamId: ids.team_id,
      agentId: ids.agent_id,
      agentSource: ids.agent_source || agentSourceFromSessionKey(emitKey),
      bridgeSource: "skill-bridge",
      executedEndpoint: sub,
      requestBody: outboundBody.slice(0, 512),
      upstreamStatus: resp.status,
      elapsedMs: (deps.now ?? Date.now)() - callStart,
    });

    // This used to zero the proxy-side buffer counter on write operations / extract success,
    // to avoid repeatedly triggering automatic extract. The old path (SkillExtractTrigger + KvExtractStore)
    // has been deleted, so this logic is no longer needed.

    // ── Team-wide search: response-side visibility filter ──
    // We composed with meta above and stashed the visible skill_id set
    // (searchVisibleIds) + the caller's original top_k (searchOriginalTopK).
    // Filter data.items by the whitelist and slice back so plugin's overfetch
    // stays invisible to the caller. This runs BEFORE lazy-pin so pinning
    // only records versions the caller actually gets to see.
    let finalRespText = respText;
    if (
      isTeamWideSearch
      && searchVisibleIds
      && resp.status >= 200
      && resp.status < 300
    ) {
      finalRespText = filterTeamSearchResponse(respText, searchVisibleIds, searchOriginalTopK);
    }

    // ── Lazy-pin: extract version from response and record in pin repo ──
    // Only on 2xx success; failures don't advance the pin. Use the FILTERED
    // response so we don't pin versions of skills the caller can't see.
    if (pinRepoInline && resp.status >= 200 && resp.status < 300) {
      await tryLazyPin(sub, finalRespText, ids.space_id ?? "", ids.user_id, ids.agent_source, sessionKey, pinRepoInline).catch(() => {});
    }

    return new Response(finalRespText, {
      status: resp.status,
      headers: {
        "content-type": resp.headers.get("content-type") ?? "application/json",
      },
    });
  };
}

/**
 * Filter a plugin /v3/skill/search response envelope by a visibility whitelist,
 * then slice `data.items` back to `topK` so overfetching is invisible to the
 * caller.
 *
 * Behavior:
 *   - Non-JSON body or non-object envelope → returned verbatim (pass-through).
 *   - Envelope with `code !== 0` → verbatim; we never mask upstream errors
 *     as empty successes.
 *   - Missing / non-array `data.items` → verbatim; nothing to filter.
 *   - Item without a string `skill_id` → dropped (defensive; plugin always
 *     includes one).
 *
 * Pure function; unit-testable without a fetcher.
 */
function filterTeamSearchResponse(respText: string, visible: Set<string>, topK: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(respText);
  } catch {
    return respText;
  }
  if (!parsed || typeof parsed !== "object") return respText;
  const env = parsed as { code?: number; data?: unknown };
  if (env.code !== 0) return respText;                       // never mask upstream errors
  if (!env.data || typeof env.data !== "object") return respText;
  const data = env.data as { items?: unknown };
  if (!Array.isArray(data.items)) return respText;

  const filtered = (data.items as unknown[])
    .filter((it): it is Record<string, unknown> =>
      !!it && typeof it === "object" && typeof (it as Record<string, unknown>).skill_id === "string"
      && visible.has((it as Record<string, unknown>).skill_id as string),
    )
    .slice(0, Math.max(0, topK));

  data.items = filtered;
  return JSON.stringify(env);
}

/**
 * Lazy-pin: after a successful upstream response, extract the skill version
 * from the response envelope and record it in Redis (session-scoped).
 *
 * Read/discovery ops (search / get / files/read) use HSETNX semantics: only
 * the first-seen version for each skill_id is pinned. Later responses that
 * show a different head version do NOT overwrite — session stays consistent.
 *
 * Write ops (update / patch / files/write / files/remove) use overwrite
 * semantics: the response's new version becomes the pin. Since a successful
 * write already means "we won the optimistic lock at expected_version", the
 * new head is what subsequent reads/writes in this session should target.
 *
 * Delete does NOT lazy-pin — soft-delete doesn't advance the version, and
 * the skill is now archived (further ops will likely 404 or 40901 anyway).
 */
async function tryLazyPin(
  sub: string,
  respText: string,
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionKey: string,
  pinRepo: PinRepoLike,
): Promise<void> {
  let env: { code?: number; data?: unknown };
  try {
    env = JSON.parse(respText) as { code?: number; data?: unknown };
  } catch {
    return;
  }
  if (env.code !== 0 || !env.data) return;

  // Extract candidates: {skillId, version} pairs to consider pinning.
  // Field paths per plugin/src/gateway/skill-handlers.ts response shapes:
  //   search:    data.items[].skill_id + data.items[].version    (toSummary)
  //   get:       data.skill_id          + data.version           (toSummary flattened)
  //   files/read data.skill_id (nope!)  + data.version           (readFile returns {path, content, encoding, size_bytes, mime_type, version} — NO skill_id, so we need it from inbound)
  //   update/patch/files_write/files_remove: data.skill_id + data.version (toSummary)
  const data = env.data as Record<string, unknown>;

  if (sub === "search") {
    // search returns {items: [...]}. HSETNX-pin each hit's first-seen version.
    const items = Array.isArray(data.items) ? data.items : [];
    const pairs: Array<{ skillId: string; version: number }> = [];
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const rec = it as Record<string, unknown>;
      const id = rec.skill_id;
      const v = rec.version;
      if (typeof id === "string" && typeof v === "number") {
        pairs.push({ skillId: id, version: v });
      }
    }
    if (pairs.length > 0) {
      await pinRepo.pinMany(spaceId, userId, agentSource, sessionKey, pairs);
    }
    return;
  }

  if (sub === "get") {
    // get returns toSummary flat — skill_id and version at top level of data.
    const id = data.skill_id;
    const v = data.version;
    if (typeof id === "string" && typeof v === "number") {
      await pinRepo.pinMany(spaceId, userId, agentSource, sessionKey, [{ skillId: id, version: v }]);
    }
    return;
  }

  if (sub === "files/read") {
    // files/read returns {path, content, encoding, size_bytes, mime_type, version}
    // — NO skill_id. If pin already exists, skip; else we can't pin without id.
    // (Read-side is already best-effort; missing pin just means next call also
    // walks head. Acceptable.)
    return;
  }

  if (WRITE_LOCK_OPS.has(sub)) {
    // Write ops return toSummary — new head version at data.version.
    // OVERWRITE semantics: we just successfully wrote, so this session should
    // now target the new head for subsequent reads/writes.
    const id = data.skill_id;
    const v = data.version;
    if (typeof id === "string" && typeof v === "number") {
      await pinRepo.upsertVersion(spaceId, userId, agentSource, sessionKey, id, v);
    }
    return;
  }

  // Other subs (list / listing / versions / create / extract / delete):
  // do not participate in lazy-pin.
}
