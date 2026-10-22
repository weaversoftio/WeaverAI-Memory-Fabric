/**
 * knowledge-bridge — reverse proxy for `<proxy>/knowledge-bridge/v3/tools/{list,call}`
 * → MemoryKnowledge (hub:8424).
 *
 * Why: Open Terminal / WeaverAI One sandboxes cannot reach the in-cluster
 * knowledge API (port 8424 is NetworkPolicy-locked to this release's pods, and
 * is not on the public HTTPRoute). Skills and chat memory already work because
 * they curl the public proxy. Code-graph / wiki tools used to tell the LLM to
 * curl `KNOWLEDGE_PUBLIC_BASE_URL` (ClusterIP) directly, which fails from the
 * sandbox as "repository index service unavailable".
 *
 * Same contract as skill-bridge / memory-bridge:
 *   1. Path must be /knowledge-bridge/v3/tools/{list|call}.
 *   2. Require bridge signature + initialized session.
 *   3. Stamp x-wamf-service-id from the session (LLM cannot forge tenant).
 *   4. POST to `${knowledge.toolsEndpoint}/v3/tools/{list|call}`.
 *   5. Pass through status + JSON body.
 */

import type { Context } from "hono";
import { getSessionStore } from "../session/store.js";
import type { BindingRepo } from "../db/binding-repo.js";
import type { ProxyConfig } from "../types.js";
import { emitBridgeToolCallTelemetry, emitBridgeRejectTelemetry, agentSourceFromSessionKey } from "../memory/bridge-telemetry.js";
import {
  BRIDGE_SIG_HEADER,
  authenticateBridgeRequest,
  decodeBridgeSessionToken,
} from "../bridge-signature.js";

const TAG = "[knowledge-bridge]";

const ALLOWED_SUBPATHS = new Set<string>([
  "tools/list",
  "tools/call",
]);

interface SessionIdFields {
  user_id: string;
  team_id: string;
  agent_id: string;
  session_id: string;
  task_id?: string;
  user_key?: string;
  space_id?: string;
  composite_key?: string;
}

function deriveSessionId(c: Context): string | null {
  const raw =
    c.req.header("x-conversation-id") ??
    c.req.header("x-session-id") ??
    c.req.header("x-chat-id") ??
    c.req.header("x-thread-id") ??
    c.req.header("x-claude-code-session-id") ??
    null;
  if (!raw || raw.length === 0) return null;
  return decodeBridgeSessionToken(raw);
}

function toIdFields(
  state: import("../session/types.js").SessionInitState | undefined,
  compositeKey: string,
): SessionIdFields | null {
  if (!state || state.status !== "initialized" || !state.sessionInfo) return null;
  const s = state.sessionInfo;
  if (!s.user_id || !s.team_id || !s.agent_id || !s.session_id) return null;
  return {
    user_id: s.user_id,
    team_id: s.team_id,
    agent_id: s.agent_id,
    session_id: s.session_id,
    task_id: s.task_id,
    user_key: s.user_key,
    space_id: s.space_id,
    composite_key: compositeKey,
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
    session_id: sessionId,
    task_id: binding.taskId,
    user_key: binding.userKey,
    space_id: spaceId,
    composite_key: `${agentSource}:${sessionId}`,
  };
}

function loadSessionIdsL1(sessionId: string): SessionIdFields | null {
  const candidates = sessionId.includes(":")
    ? [sessionId]
    : [sessionId, `codebuddy:${sessionId}`, `claude-code:${sessionId}`];
  for (const k of candidates) {
    const state = getSessionStore().get(k);
    if (state) {
      const fields = toIdFields(state, k);
      if (fields) return fields;
    }
  }
  return null;
}

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

function envelope(code: number, message: string, httpStatus = 200): Response {
  return new Response(
    JSON.stringify({ code, message, request_id: `knowledge-bridge-${Date.now()}` }),
    { status: httpStatus, headers: { "content-type": "application/json" } },
  );
}

function extractSubpath(path: string): string | null {
  const m = path.match(/^\/knowledge-bridge\/v3\/(.+)$/);
  if (!m) return null;
  return m[1].replace(/\/+$/, "");
}

function resolveToolsEndpoint(config: ProxyConfig): string {
  const raw = (config.knowledge.toolsEndpoint || "").trim();
  return raw.replace(/\/$/, "").replace(/\/v3$/i, "");
}

export interface KnowledgeBridgeDeps {
  fetcher?: typeof fetch;
  now?: () => number;
}

export function createKnowledgeBridgeHandler(
  config: ProxyConfig,
  deps: KnowledgeBridgeDeps = {},
): (c: Context) => Promise<Response> {
  const fetcher = deps.fetcher ?? globalThis.fetch.bind(globalThis);

  return async (c: Context): Promise<Response> => {
    const t0 = (deps.now ?? Date.now)();

    const path = new URL(c.req.url).pathname;
    const sub = extractSubpath(path);
    if (!sub) {
      emitBridgeRejectTelemetry({
        sessionKey: "", bridgeSource: "knowledge-bridge",
        rejectReason: "unknown_path", httpStatus: 404,
      });
      return envelope(40401, `${TAG} unknown path ${path}`, 404);
    }
    if (!ALLOWED_SUBPATHS.has(sub)) {
      emitBridgeRejectTelemetry({
        sessionKey: "", bridgeSource: "knowledge-bridge",
        rejectReason: "subpath_forbidden", httpStatus: 403,
        executedEndpoint: sub,
      });
      return envelope(40301, `${TAG} subpath '${sub}' not allowed via bridge`, 403);
    }
    if (c.req.method !== "POST") {
      emitBridgeRejectTelemetry({
        sessionKey: "", bridgeSource: "knowledge-bridge",
        rejectReason: "method_not_allowed", httpStatus: 405,
        executedEndpoint: sub,
      });
      return envelope(40501, `${TAG} method ${c.req.method} not allowed`, 405);
    }

    const ct = c.req.header("content-type") ?? "";
    if (!ct.toLowerCase().includes("application/json")) {
      emitBridgeRejectTelemetry({
        sessionKey: "", bridgeSource: "knowledge-bridge",
        rejectReason: "content_type_invalid", httpStatus: 415,
        executedEndpoint: sub,
      });
      return envelope(41501, `${TAG} content-type must be application/json`, 415);
    }

    const headerSession = deriveSessionId(c);
    const spaceIdForAuth = c.req.header("x-wamf-service-id");
    const auth = authenticateBridgeRequest(
      c.req.header(BRIDGE_SIG_HEADER),
      headerSession ?? undefined,
      spaceIdForAuth,
    );
    if (!auth.ok || !auth.sessionId) {
      emitBridgeRejectTelemetry({
        sessionKey: headerSession ?? "", bridgeSource: "knowledge-bridge",
        rejectReason: "bridge_signature_invalid", httpStatus: 401,
        executedEndpoint: sub,
      });
      if (!headerSession && auth.reason === "missing_sig") {
        return envelope(40101, `${TAG} missing x-conversation-id (or x-session-id / x-chat-id / x-thread-id) header`, 401);
      }
      const hint =
        auth.reason === "redacted_session"
          ? `; x-conversation-id looks PII-redacted — use a v1 ${BRIDGE_SIG_HEADER} from the recipe (copy -H headers verbatim)`
          : `; use the curl recipe from the system prompt (copy -H headers verbatim)`;
      return envelope(40102, `${TAG} missing or invalid ${BRIDGE_SIG_HEADER}${hint}`, 401);
    }
    const sessionKey = auth.sessionId;
    const spaceId = c.req.header("x-wamf-service-id")
      ?? config.knowledge?.serviceId
      ?? config.coreSkill?.serviceId
      ?? "";
    const bindingRepo = getSessionStore().getBindingRepo() ?? null;

    let ids = loadSessionIdsL1(sessionKey);
    if (!ids && bindingRepo && spaceId) {
      console.log(`${TAG} session=${sessionKey} L1 miss → L2 binding lookup (space=${spaceId})`);
      ids = await loadSessionIdsL2(bindingRepo, spaceId, sessionKey);
    }
    if (!ids) {
      emitBridgeRejectTelemetry({
        sessionKey, bridgeSource: "knowledge-bridge",
        rejectReason: "session_not_initialized", httpStatus: 401,
        executedEndpoint: sub, spaceId,
      });
      return envelope(40101, `${TAG} session not initialized; cannot derive identity`, 401);
    }

    const toolsEndpoint = resolveToolsEndpoint(config);
    if (!toolsEndpoint) {
      emitBridgeRejectTelemetry({
        sessionKey, bridgeSource: "knowledge-bridge",
        rejectReason: "tools_endpoint_unconfigured", httpStatus: 503,
        executedEndpoint: sub, spaceId: ids.space_id,
      });
      return envelope(50302, `${TAG} knowledge.toolsEndpoint is not configured`, 503);
    }

    let inboundBody: Record<string, unknown> = {};
    try {
      const raw = await c.req.text();
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          inboundBody = parsed as Record<string, unknown>;
        } else {
          emitBridgeRejectTelemetry({
            sessionKey, bridgeSource: "knowledge-bridge",
            rejectReason: "body_not_object", httpStatus: 400,
            executedEndpoint: sub,
            spaceId: ids.space_id, userId: ids.user_id, teamId: ids.team_id,
            agentId: ids.agent_id, agentSource: agentSourceFromSessionKey(ids.composite_key ?? sessionKey),
          });
          return envelope(40001, `${TAG} body must be a JSON object`, 400);
        }
      }
    } catch (err) {
      emitBridgeRejectTelemetry({
        sessionKey, bridgeSource: "knowledge-bridge",
        rejectReason: "invalid_json_body", httpStatus: 400,
        executedEndpoint: sub,
        spaceId: ids.space_id, userId: ids.user_id, teamId: ids.team_id,
        agentId: ids.agent_id, agentSource: agentSourceFromSessionKey(ids.composite_key ?? sessionKey),
      });
      return envelope(40001, `${TAG} invalid JSON body: ${(err as Error).message}`, 400);
    }

    const knowledgeId = inboundBody.knowledge_id;
    if (typeof knowledgeId !== "string" || !knowledgeId.trim()) {
      emitBridgeRejectTelemetry({
        sessionKey, bridgeSource: "knowledge-bridge",
        rejectReason: "missing_knowledge_id", httpStatus: 400,
        executedEndpoint: sub,
        spaceId: ids.space_id, userId: ids.user_id, teamId: ids.team_id,
        agentId: ids.agent_id, agentSource: agentSourceFromSessionKey(ids.composite_key ?? sessionKey),
      });
      return envelope(40002, `${TAG} knowledge_id is required`, 400);
    }

    const upstreamServiceId =
      ids.space_id || config.knowledge?.serviceId || config.coreSkill.serviceId;
    const upstreamUrl = `${toolsEndpoint}/v3/${sub}`;
    const outboundBody = JSON.stringify(inboundBody);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-wamf-service-id": upstreamServiceId,
      "x-wamf-user-id": ids.user_id,
      "x-wamf-team-id": ids.team_id,
      "x-wamf-agent-id": ids.agent_id,
      "x-conversation-id": ids.session_id,
    };
    const token = config.knowledge.serviceToken;
    if (token) headers.Authorization = `Bearer ${token}`;

    const callStart = (deps.now ?? Date.now)();
    let status = 0;
    let text = "";
    let contentType = "application/json";
    try {
      const resp = await fetcher(upstreamUrl, {
        method: "POST",
        headers,
        body: outboundBody,
        signal: AbortSignal.timeout(Math.max(30_000, config.knowledge.timeoutMs * 4)),
      });
      status = resp.status;
      text = await resp.text().catch(() => "");
      contentType = resp.headers.get("content-type") ?? "application/json";
    } catch (err) {
      console.warn(`${TAG} upstream fetch failed sub=${sub} err=${(err as Error).message}`);
      emitBridgeToolCallTelemetry({
        sessionKey: ids.composite_key ?? sessionKey,
        spaceId: ids.space_id,
        userId: ids.user_id,
        teamId: ids.team_id,
        agentId: ids.agent_id,
        agentSource: agentSourceFromSessionKey(ids.composite_key ?? sessionKey),
        bridgeSource: "knowledge-bridge",
        executedEndpoint: sub,
        requestBody: outboundBody.slice(0, 512),
        upstreamStatus: 0,
        elapsedMs: (deps.now ?? Date.now)() - callStart,
      });
      return envelope(50301, `${TAG} upstream unavailable: ${(err as Error).message}`, 502);
    }

    emitBridgeToolCallTelemetry({
      sessionKey: ids.composite_key ?? sessionKey,
      spaceId: ids.space_id,
      userId: ids.user_id,
      teamId: ids.team_id,
      agentId: ids.agent_id,
      agentSource: agentSourceFromSessionKey(ids.composite_key ?? sessionKey),
      bridgeSource: "knowledge-bridge",
      executedEndpoint: sub,
      requestBody: outboundBody.slice(0, 512),
      upstreamStatus: status,
      elapsedMs: (deps.now ?? Date.now)() - callStart,
    });

    const elapsed = (deps.now ?? Date.now)() - t0;
    console.log(`${TAG} sub=${sub} status=${status} elapsed=${elapsed}ms knowledge_id=${knowledgeId}`);

    return new Response(text, {
      status,
      headers: { "content-type": contentType },
    });
  };
}
