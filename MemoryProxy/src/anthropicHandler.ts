/**
 * Anthropic Messages API handler.
 * Supports /v1/messages endpoint with streaming (SSE) and non-streaming modes.
 * Integrates with routing module, Opik observability, and JSONL logging.
 *
 * This handler uses ForwardTarget opaquely — no routing semantics
 * leak into the handler. All routing logic is encapsulated in the private module.
 */

import type { Context } from "hono";
import { createHash } from "node:crypto";
import { writeLog, createPipeline } from "./logger.js";
import {
  apiKeyToKeyId,
  opikCreateLlmSpan,
  opikCreateTrace,
  uuidv7,
} from "./opik.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "./langfuse.js";
import { countHumanTurns } from "./turnSeq.js";
import type { ProxyConfig } from "./types.js";
import {
  resolveForwardTarget,
  resolveSessionKey,
  resolveLatestUserQuery,
  reportAnalyzerTrace,
  type ForwardTarget,
} from "./guard-adapter.js";
import { hasCostGuardMarker, matchWhitelistEndpoint } from "./routes/whitelist.js";
import { writeRequestLog } from "./requestLog.js";
import { prepareUpstreamRequest, notifyUpstreamResponse } from "./request-prepare-adapter.js";
import { tryReportCreditFromPath, extractSpaceIdFromPath } from "./credit-reporter.js";
import {
  getInstanceUpstreamConfigs,
  resolveUpstreamConfig,
  shouldOverride,
} from "./instance-upstream-cache.js";
import { resolveModelId, isModelInPricing } from "./pricing.js";
import { inspectAndRecord } from "./identity.js";
import { writeFailedReportRaw } from "./clickhouse.js";
import { verifyUserKey } from "./auth.js";
import { matchSystemUserByUserId, hasSystemUsers } from "./systemUser.js";
import { handleSystemUserPassthrough } from "./systemUserPassthrough.js";
import { WamfClient } from "./wamf/client.js";
import { deriveWamfIdentity } from "./wamf/identity.js";
import { extractLatestUserMessage, recordWamfTurn } from "./wamf/recorder.js";
import { trackWrite, withL0Retry } from "./wamf/pending-writes.js";
import type { WamfIdentity, WamfMessage } from "./wamf/types.js";
import { triggerSkillExtractIfReady } from "./skill/handler-glue.js";
import { emitModelIntentTelemetry } from "./session/model-intent-telemetry.js";
import { isExtractionAllowed, logExtractionSkipped } from "./extraction-gate.js";
import type { CcRequestKind } from "./common/cc-request-classifier.js";
import { buildRequestDebugMetadata } from "./common/langfuse-debug.js";
import { resolveAgentAdapter } from "./agent-adapters/index.js";
import {
  enforceRateLimit,
  isRateLimitExceededError,
  recordInputTokenUsage,
} from "./rate-limit/guard.js";
import { INTERNAL_REQUEST_HEADERS } from "./internal-headers.js";

const SKIP_REQUEST_HEADERS = new Set([
  ...INTERNAL_REQUEST_HEADERS,
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  // Internal identity headers are only for proxy/session-init and must not be passed through to upstream model services.
  "x-wamf-user-key",
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
]);

/**
 * Build a per-request WamfClient. `spaceId` (extracted from the request path
 * `/{agent}/{spaceId}/...`) overrides `config.wamf.serviceId` so writes/recalls
 * land on the correct kernel tenant. Falls back to config when the request
 * carries no spaceId (older single-tenant deployments).
 */
function createWamfClient(config: ProxyConfig, spaceId?: string): WamfClient | null {
  if (!config.wamf.enabled || !config.wamf.memory.enabled || !config.wamf.endpoint) return null;
  return new WamfClient({
    enabled: config.wamf.enabled && config.wamf.memory.enabled,
    endpoint: config.wamf.endpoint,
    apiKey: config.wamf.apiKey,
    serviceId: spaceId || config.wamf.serviceId,
    writeL0: config.wamf.memory.writeL0,
    recallL1: config.wamf.memory.recallL1,
    injectL2L3: config.wamf.memory.injectL2L3,
    l1Limit: config.wamf.memory.l1Limit,
    l2Limit: config.wamf.memory.l2Limit,
    timeoutMs: config.wamf.memory.timeoutMs,
  });
}

/**
 * Normalize Anthropic top-level `system` field into a plain string for
 * observability. Anthropic accepts either a string or an array of content
 * blocks; here we join `text` blocks' text with "\n" and JSON-stringify
 * anything else. Returns "" when nothing textual is present.
 */
function stringifyAnthropicSystem(system: unknown): string {
  if (system === undefined || system === null) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const block of system) {
      const b = block as Record<string, unknown>;
      if (b && b.type === "text" && typeof b.text === "string" && b.text) {
        parts.push(b.text);
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(system);
}

/**
 * Build the `input` payload for Langfuse / Opik. Two modes:
 *
 * - Normal mode (default): calls `flattenAnthropicMessagesForOpik` — content
 *   arrays are stringified for compact display. Loses `cache_control` markers,
 *   `thinking` blocks with signatures, native `tool_use`/`tool_result` shape.
 *
 * - Debug mode (`langfuse.debug=true`): passes the raw Anthropic body straight
 *   through, preserving every native structure. Use when investigating cache
 *   markers, thinking-signature issues, or request classification. Costs 2-5x
 *   more upload bandwidth + Langfuse storage — leave off in production.
 */
export function buildLangfuseInput(
  messages: unknown[],
  system: unknown,
  debug: boolean,
): unknown {
  if (debug) {
    // Preserve original shape end-to-end. Prepend a synthetic system message
    // when it's non-empty so the display order matches other consumers.
    const out: unknown[] = [];
    if (system !== undefined && system !== null && system !== "") {
      out.push({ role: "system", content: system });
    }
    return out.concat(messages);
  }
  return flattenAnthropicMessagesForOpik(messages, system);
}

/**
 * Flatten Anthropic messages for Opik / Langfuse display.
 *
 * Anthropic puts the system prompt on `body.system` (not inside `messages`),
 * so callers should pass it explicitly — otherwise the reported input omits
 * the system prompt entirely. When provided and non-empty, a synthetic
 * `{role:"system", content}` message is prepended to the result.
 */
export function flattenAnthropicMessagesForOpik(
  messages: unknown[],
  system?: unknown,
): unknown[] {
  const result: unknown[] = [];
  const systemText = stringifyAnthropicSystem(system);
  if (systemText) {
    result.push({ role: "system", content: systemText });
  }
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;

    if (typeof content === "string") {
      result.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      result.push({ role, content: JSON.stringify(content) });
      continue;
    }

    if (role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_use") {
          toolCalls.push(b);
        } else if (b.type === "thinking" && b.thinking) {
          textParts.push(`[thinking] ${(b.thinking as string).slice(0, 200)}`);
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "assistant", content: textParts.join("\n") });
      }
      for (const tc of toolCalls) {
        const t = tc as Record<string, unknown>;
        const inputStr = typeof t.input === "string" ? t.input : JSON.stringify(t.input);
        result.push({
          role: "assistant",
          content: JSON.stringify({ tool_call_id: t.id, tool_name: t.name, input: inputStr }, null, 2),
        });
      }
    } else if (role === "user") {
      const textParts: string[] = [];
      const toolResults: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_result") {
          toolResults.push(b);
        } else {
          textParts.push(JSON.stringify(b));
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }
      for (const tr of toolResults) {
        const t = tr as Record<string, unknown>;
        let resultContent: string;
        if (typeof t.content === "string") {
          resultContent = t.content;
        } else if (Array.isArray(t.content)) {
          resultContent = (t.content as Record<string, unknown>[])
            .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");
        } else {
          resultContent = JSON.stringify(t.content);
        }
        result.push({
          role: "tool",
          content: JSON.stringify({ tool_call_id: t.tool_use_id, is_error: t.is_error ?? false, result: resultContent }, null, 2),
        });
      }
    } else {
      const merged = content.map((b: unknown) => {
        const block = b as Record<string, unknown>;
        if (block.type === "text") return block.text as string;
        return JSON.stringify(block);
      }).join("\n");
      result.push({ role, content: merged });
    }
  }
  return result;
}

/** Extract Anthropic API key from request headers (x-api-key or Authorization Bearer). */
function extractApiKey(c: Context): string {
  const xApiKey = c.req.header("x-api-key");
  if (xApiKey) return xApiKey;

  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return "";
}

/**
 * Heuristically decide whether a `thinking` block carries a valid native
 * Anthropic/Bedrock signature.
 */
function hasValidThinkingSignature(block: Record<string, unknown>): boolean {
  const sig = block.signature;
  if (typeof sig !== "string" || sig.length < 40) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sig)) {
    return false;
  }
  return /^[A-Za-z0-9+/=]+$/.test(sig);
}

/**
 * Sanitize `thinking` blocks across all assistant messages.
 *
 * Exported for unit testing.
 */
export function sanitizeThinkingBlocks(
  body: Record<string, unknown>,
): { body: Record<string, unknown>; removed: number } {
  const messages = body.messages;
  if (!Array.isArray(messages)) return { body, removed: 0 };

  let removed = 0;
  let changed = false;

  const newMessages = messages.map((msg) => {
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant" || !Array.isArray(m.content)) return msg;

    let msgChanged = false;
    const newContent = (m.content as unknown[]).filter((block) => {
      const b = block as Record<string, unknown>;
      const isThinking = b.type === "thinking" || b.type === "redacted_thinking";
      if (!isThinking) return true;
      if (hasValidThinkingSignature(b)) return true;
      removed += 1;
      msgChanged = true;
      return false;
    });

    if (!msgChanged) return msg;
    changed = true;
    return { ...m, content: newContent };
  });

  if (!changed) return { body, removed: 0 };
  return { body: { ...body, messages: newMessages }, removed };
}

/**
 * Build upstream body from original body + cost guard overrides.
 */
function buildUpstreamBody(
  body: Record<string, unknown>,
  target: ForwardTarget,
): { body: Record<string, unknown>; sanitizedCount: number } {
  let result = body;
  if (target.bodyOverrides) {
    result = { ...result, ...target.bodyOverrides };
  }
  const sanitized = sanitizeThinkingBlocks(result);
  return { body: sanitized.body, sanitizedCount: sanitized.removed };
}

/**
 * Build upstream headers from request headers + cost guard auth overrides.
 */
function buildUpstreamHeaders(
  c: Context,
  _config: ProxyConfig,
  target: ForwardTarget,
  sessionKey?: string,
  effectiveApiKey?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = v;
    }
  }
  headers["content-type"] = "application/json";

  // `effectiveApiKey` is pre-resolved by the caller according to the
  // per-agent fallback rule (see the resolveEffectiveApiKey call site).
  //   - non-empty string → inject as server-side key, drop client's own
  //   - empty/undefined  → passthrough: keep whatever the client sent
  // The cost-guard extension can still fully override via target.authHeaders.
  if (effectiveApiKey && !target.authHeaders) {
    headers["x-api-key"] = effectiveApiKey;
    delete headers["authorization"];
  }

  if (target.authHeaders) {
    for (const [k, v] of Object.entries(target.authHeaders)) {
      headers[k] = v;
      if (k === "x-api-key") delete headers["authorization"];
      if (k === "authorization") delete headers["x-api-key"];
    }
  }

  if (sessionKey) {
    headers["x-vertex-ai-session-id"] = sessionKey;
  }
  return headers;
}

/**
 * Forward request to upstream and handle retry if retryTarget is set.
 */
async function forwardWithRetry(
  target: ForwardTarget,
  upstreamHeaders: Record<string, string>,
  upstreamBody: Record<string, unknown>,
  originalBody: Record<string, unknown>,
  originalHeaders: Record<string, string>,
  pipe: ReturnType<typeof createPipeline>,
  forwardTimeoutMs: number,
  sessionKeyForDebug?: string,
  rateLimitContext?: { config: ProxyConfig; instanceId?: string },
): Promise<{ resp: Response; retried: boolean }> {
  let upstreamResp: Response | undefined;
  let forwardFailed = false;

  // ── Optional outbound body md5 debug log ───────────────────────────────
  // For long-run observation: a necessary condition for an Anthropic KV cache hit is that "all bytes from the body head -> before the cache_control
  // anchor are identical". So three md5 segments are computed separately:
  //   1. sysFullMd5    - md5(JSON.stringify(body.system))  full system serialization
  //   2. sysStrMd5     - md5(body.system flattened to a string)    text content only (for comparison)
  //   3. msgsPrefixMd5 - find the position N of the last message carrying cache_control in messages,
  //                      md5(JSON.stringify(messages[0..N])), i.e. the real cache prefix
  //   4. msgsAnchorIdx - the N above (helps locate the hit length)
  //
  // If any md5 changes, Anthropic will miss the cache.
  //
  // Enable: PROXY_DEBUG_DUMP_OUTBOUND_MD5=1 node ...
  if (process.env.PROXY_DEBUG_DUMP_OUTBOUND_MD5) {
    try {
      const sys = (upstreamBody as { system?: unknown }).system;
      // Anthropic system is usually a string (CC) or a blocks array (a few SDKs)
      const sysFullStr = sys === undefined ? "" : JSON.stringify(sys);
      const sysTextStr = typeof sys === "string"
        ? sys
        : Array.isArray(sys)
          ? sys.map((b) => (b as { text?: string }).text ?? "").join("\n")
          : "";

      const msgs = (upstreamBody as { messages?: Array<Record<string, unknown>> }).messages ?? [];
      // Find the position of the last message in messages whose "content carries cache_control"
      let anchorIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const content = msgs[i]?.content;
        if (Array.isArray(content)) {
          const hasCache = content.some((b) => b && typeof b === "object" && "cache_control" in (b as object));
          if (hasCache) { anchorIdx = i; break; }
        }
      }
      // cache prefix = serialization of all messages from the body head -> up to and including the anchor
      const prefixEnd = anchorIdx >= 0 ? anchorIdx + 1 : msgs.length;
      const msgsPrefixStr = JSON.stringify(msgs.slice(0, prefixEnd));

      const sysFullMd5 = createHash("md5").update(sysFullStr).digest("hex").slice(0, 12);
      const sysTextMd5 = createHash("md5").update(sysTextStr).digest("hex").slice(0, 12);
      const msgsPrefixMd5 = createHash("md5").update(msgsPrefixStr).digest("hex").slice(0, 12);

      // eslint-disable-next-line no-console
      console.log(
        `[outbound-md5] session=${sessionKeyForDebug ?? "?"} sysBytes=${sysFullStr.length} sysFullMd5=${sysFullMd5} sysTextMd5=${sysTextMd5} msgsCount=${msgs.length} msgsAnchorIdx=${anchorIdx} msgsPrefixBytes=${msgsPrefixStr.length} msgsPrefixMd5=${msgsPrefixMd5}`,
      );
    } catch (e) {
      // best-effort; must not crash the flow because of debug
      // eslint-disable-next-line no-console
      console.log(`[outbound-md5] session=${sessionKeyForDebug ?? "?"} <error: ${(e as Error).message}>`);
    }
  }

  if (rateLimitContext) {
    await enforceRateLimit({
      config: rateLimitContext.config,
      instanceId: rateLimitContext.instanceId,
      modelId: target.model,
      protocol: "anthropic",
    });
  }
  try {
    upstreamResp = await fetch(target.url, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(forwardTimeoutMs),
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      pipe.error("FORWARD", `Timeout after ${forwardTimeoutMs / 1000}s`);
    } else {
      pipe.error("FORWARD", err);
    }
    forwardFailed = true;
  }

  if (upstreamResp) {
    pipe.forwardDone(upstreamResp.status);
  }

  const shouldRetry = target.retryTarget &&
    (forwardFailed || (upstreamResp && upstreamResp.status >= 400 && upstreamResp.status < 500));

  if (shouldRetry && target.retryTarget) {
    const reason = forwardFailed ? "timeout/error" : `${upstreamResp!.status}`;
    pipe.info("RETRY", `Routed model failed (${reason}), retrying with ${target.retryTarget.model}`);

    const retryHeaders: Record<string, string> = { ...originalHeaders };
    retryHeaders["content-type"] = "application/json";
    if (sessionKeyForDebug) {
      retryHeaders["x-vertex-ai-session-id"] = sessionKeyForDebug;
    }

    try {
      if (rateLimitContext) {
        await enforceRateLimit({
          config: rateLimitContext.config,
          instanceId: rateLimitContext.instanceId,
          modelId: target.retryTarget.model,
          protocol: "anthropic",
        });
      }
      upstreamResp = await fetch(target.retryTarget.url, {
        method: "POST",
        headers: retryHeaders,
        body: JSON.stringify(originalBody),
        signal: AbortSignal.timeout(forwardTimeoutMs),
      });
      if (upstreamResp.ok) {
        pipe.info("RETRY_SUCCESS", `Retry returned ${upstreamResp.status}`);
      } else {
        pipe.error("RETRY_FAILED", `Retry returned ${upstreamResp.status}`);
      }
      return { resp: upstreamResp, retried: true };
    } catch (retryErr: unknown) {
      if (isRateLimitExceededError(retryErr)) throw retryErr;
      if (retryErr instanceof DOMException && retryErr.name === "TimeoutError") {
        pipe.error("RETRY_FORWARD", `Timeout after ${forwardTimeoutMs / 1000}s`);
      } else {
        pipe.error("RETRY_FORWARD", retryErr);
      }
      throw new Error("Upstream request failed");
    }
  }

  if (forwardFailed && !shouldRetry) {
    throw new Error("Upstream request failed");
  }

  if (!upstreamResp) {
    throw new Error("No upstream response available");
  }

  return { resp: upstreamResp, retried: false };
}

/** Main handler for POST /v1/messages (Anthropic Messages API). */
export async function handleAnthropicMessages(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const startTime = new Date().toISOString();
  const traceId = uuidv7();

  // ── Early auth ──────────────────────────────────────────────────────────
  // Verify BEFORE parsing the body so a rejected caller never triggers body
  // parsing or the alias-gate. `earlyVerify.userId` is reused later for
  // both the systemUser short-circuit and the normal pipeline.
  const earlyApiKey = extractApiKey(c);
  const earlySpaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const earlyVerify = await verifyUserKey(earlyApiKey, earlySpaceId);
  if (earlyVerify.rejected) {
    return c.json({ type: "error", error: { type: "authentication_error", message: `Authentication failed: ${earlyVerify.rejectReason ?? "unknown"}` } }, 401);
  }

  // ── Parse body ──────────────────────────────────────────────────────────
  // Body is parsed BEFORE the systemUser short-circuit so the alias-gate and
  // `resolveModelId` fire uniformly for internal AND external callers. The
  // parsed object is later handed to `handleSystemUserPassthrough` (which
  // serialises it) so we never double-read `c.req`.
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // ── CC request classification (feature-gated, per-agent) ─────────────────
  // Classify the request through agentAdapter - each client has its own rules:
  //   - claude-code: three-way split by cache_control marker + tools/thinking
  //   - codebuddy / unknown: always main (not adapted, equivalent to the status quo)
  //
  // When ccRequestRouting.enabled is off, it is forced to main and takes the old path fully equivalent to the status quo.
  // See docs/design/2026-07-30-cc-request-routing-plan.md
  const _pathPartsEarly = c.req.path.split("/").filter(Boolean);
  const _agentFromPathEarly = _pathPartsEarly[0]
    && !["v1", "proxy", "skill-bridge", "memory-bridge"].includes(_pathPartsEarly[0])
    ? _pathPartsEarly[0] : undefined;
  const agentAdapter = resolveAgentAdapter(_agentFromPathEarly ?? "claude-code");
  const ccRoutingEnabled = config.ccRequestRouting?.enabled === true;
  const requestKind: CcRequestKind = ccRoutingEnabled ? agentAdapter.classifyRequest(body) : "main";

  // ── Model gate: reject requests whose `model` is not a registered display name ──
  // When a price list is configured, the client `model` must match the `modelName` of some entry (display name,
  // case-insensitive). The real model_id is an internal detail and not a client entry point. An unmatched model is rejected
  // with 400, to avoid a request being forwarded successfully but unbilled for lack of pricing. Skipped when the price list is empty (backward compatible).
  //
  // Internal/external users are treated alike - internal callers must also request by
  // `modelName`, ensuring upstream ids and billing/observability keys align
  // across all traffic.
  const requestedModel = typeof body.model === "string" ? body.model : "unknown";

  // ── Early instance config fetch (needed before pricing gate) ──────────
  // Custom upstream (Option 2/3) may use models not in our pricing table,
  // and should NOT have their model alias-resolved to our internal IDs.
  //
  // The alias-skip gate depends on WHO is calling:
  //   - external caller → look at `type=conversation` (client's chat traffic)
  //   - systemUser (memory/knowledge/skill extraction) → look at
  //     `type=extraction` (client's memory-extraction upstream)
  // A conversation-typed row is unrelated to internal extraction traffic,
  // and vice versa. Prior code keyed off `conversation` unconditionally,
  // which regressed alias resolution for internal callers whenever the
  // instance carried any Option-2/3 conversation config.
  const _earlyInstanceConfigs = await getInstanceUpstreamConfigs(config.coreSkill, earlySpaceId);
  const _earlyConvCfg = resolveUpstreamConfig(_earlyInstanceConfigs, _agentFromPathEarly, "conversation");
  const _earlyExtractCfg = resolveUpstreamConfig(_earlyInstanceConfigs, _agentFromPathEarly, "extraction");
  const _earlySysMatch = hasSystemUsers() ? matchSystemUserByUserId(earlyVerify.userId) : null;
  const _isCustomUpstream = _earlySysMatch !== null
    ? shouldOverride(_earlyExtractCfg)
    : shouldOverride(_earlyConvCfg);

  if (!_isCustomUpstream && !isModelInPricing(config.creditPricing, requestedModel)) {
    return c.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Model '${requestedModel}' is not a registered display name in the credit pricing table`,
        },
      },
      400,
    );
  }

  // ── Model alias: rewrite client-facing modelName → real model_id ──────────
  // Only for official mode (our upstream). Custom upstream keeps the original
  // model name — "LLM-A1" may be a valid model on the user's own service.
  let modelId = _isCustomUpstream ? requestedModel : resolveModelId(config.creditPricing, requestedModel);
  const modelAliasApplied = !_isCustomUpstream && typeof body.model === "string" && modelId !== requestedModel;
  if (modelAliasApplied) body.model = modelId;

  // ── System-user short-circuit ────────────────────────────────────────────
  // Internal service accounts (see `systemUsers` config) bypass the entire
  // pipeline: no session-init, no injection, no routing. Matching key is
  // the userId resolved by verifyUserKey — NOT the raw apiKey. Auth-disabled
  // requests (userId == "") never match, so the short-circuit is inert unless
  // auth is on.
  //
  // We hand the already-parsed+alias-resolved `body` to the passthrough so
  // upstream sees the canonical model_id, aligning internal traffic with
  // external.
  if (hasSystemUsers()) {
    const sysMatch = matchSystemUserByUserId(earlyVerify.userId);
    if (sysMatch) {
      return handleSystemUserPassthrough(c, config, sysMatch, body);
    }
  }

  let messages = Array.isArray(body.messages) ? body.messages : [];
  const isStream = body.stream === true;
  let hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  // ── Resolve agent source from URL path (e.g. /claude-code/v1/messages) ──
  const pathParts = c.req.path.split("/").filter(Boolean);
  const agentFromPath = pathParts[0] && !["v1", "proxy", "skill-bridge", "memory-bridge"].includes(pathParts[0])
    ? pathParts[0] : undefined;
  const agentSource = agentFromPath ?? "claude-code";

  // ── Identity inspection ──────────────────────────────────────────────────
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    reqHeaders[k] = v;
  }
  inspectAndRecord("POST", c.req.path, reqHeaders, body as Record<string, unknown>, agentSource);

  // ── Resolve apiKey → project name ──────────────────────────────────────
  const apiKey = extractApiKey(c);
  let keyId = apiKey ? apiKeyToKeyId(apiKey) : "unknown";

  // ── Lowercased headers for agent profile detection + session key ──────────
  const lcHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    lcHeaders[k.toLowerCase()] = v;
  }

// ── Session key: prefer conversation header, fallback to agent profile ───────────
  const { resolveConversationId } = await import("./session/session-key.js");
  const conversationId = resolveConversationId(c);
  const sessionKey = conversationId ?? resolveSessionKey(config, lcHeaders, c.req.path, body, keyId);

  // ── Auth verification (user_key → user_id) ──────────────────────────────────────
  // Reuse the early verify result — it ran before body parse to decide the
  // system-user short-circuit; running verify again here would double the
  // network round-trip for every request.
  const spaceId = earlySpaceId;
  const userId = earlyVerify.userId
    || c.req.header("x-user-id")
    || c.req.header("x-cb-user-id")
    || c.req.header("x-wamf-user-token")
    || "";
  if (userId) keyId = userId;

  // The sk-mem key (used for WAMF ACL / MetadataClient's x-wamf-user-key) is the entry apiKey.
  const callerUserKey = apiKey || null;

  // Activate Redis storage early — must run BEFORE session init.
  if (config.redis?.enabled) {
    const { getInjectionPipeline } = await import("./injection/index.js");
    getInjectionPipeline(config);
  }

  // ── mem:session-reset pre-hook ──
  let _isSessionResetFlow = false;
  if (requestKind === "main") {
    const { isSessionResetCommand } = await import("./mem-command/pre-intercept.js");
    if (isSessionResetCommand(body as Record<string, unknown>, agentSource)) {
      const { parseMemCommand } = await import("./mem-command/index.js");
      const memCmd = parseMemCommand(body as Record<string, unknown>, agentSource);
      if (memCmd) {
        const { getSessionStore } = await import("./session/store.js");
        const store = getSessionStore();
        const compositeKey = `${agentSource}:${sessionKey}`;
        store.bind(compositeKey, { userId: userId || "anonymous", agentSource, sessionId: sessionKey, spaceId });

        // -- Force-archive the old agent's skill buffer (best-effort) --
        const oldState = store.get(compositeKey);
        if (oldState?.status === "initialized" && oldState.sessionInfo && config.coreSkill?.endpoint) {
          const si = oldState.sessionInfo as Record<string, string>;
          if (si.space_id && si.user_id && si.team_id && si.agent_id) {
            import("./skill/core-client.js").then(({ getCoreSkillClient }) => {
              const client = getCoreSkillClient(config.coreSkill!);
              client.forceArchive(
                {
                  space_id: si.space_id,
                  user_id: si.user_id,
                  team_id: si.team_id,
                  agent_id: si.agent_id,
                  session_id: sessionKey,
                  task_id: si.task_id || undefined,
                  reason: "session-reset",
                },
                { serviceId: si.space_id },
              ).then((res) => {
                console.log(`[session-reset] force-archive old buffer: status=${res.status} session=${sessionKey} agent=${si.agent_id}`);
              }).catch((err) => {
                console.warn(`[session-reset] force-archive failed (best-effort): ${err instanceof Error ? err.message : String(err)}`);
              });
            }).catch(() => {});
          }
        }

        const resetEpoch = Date.now();
        await store.set(compositeKey, { status: "uninitialized", keyId: sessionKey, startedAt: resetEpoch, attemptCount: 0, userId: userId || "anonymous", resetEpoch, resetFlow: true });
        const bindingRepo = store.getBindingRepo();
        if (bindingRepo) await bindingRepo.deleteBinding(spaceId, sessionKey).catch(() => {});
        _isSessionResetFlow = true;
        console.log(`[mem-command:pre] session-reset session=${sessionKey} → falling through to pop form`);
      }
    }
  }

  // ── Session Init (before injection pipeline) ─────────────────────────────
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("./injection/types.js").AssetCapabilityFlags | undefined;
  let injectedSkipped = !conversationId;
  let sessionJustRegistered = false;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamName?: string; teamId: string; taskName?: string | null; bypassed?: boolean } | null = null;
  console.log(`[injection-debug] conversationId=${conversationId} sessionKey=${sessionKey} userId=${userId} agentSource=${agentSource} sessionInitEnabled=${config.sessionInit?.enabled} injectionEnabled=${config.injection?.enabled} injectors=${JSON.stringify(config.injection?.injectors)} injectedSkipped=${injectedSkipped}`);
  // CC routing: SIDEQUERY skips session-init entirely (an independent small request has no conversation concept).
  //          FORK may take L2b recovery to reuse the session MAIN already built, but does not enter the form interaction path
  //          (borrows MAIN's sessionInfo, see the kind === 'fork' branch guard below).
  const skipSessionInit = requestKind === "sidequery";
  if (config.sessionInit?.enabled && conversationId && !skipSessionInit) {
    try {
      const { getSessionStore, handleSessionInit, parsePresetIdentity } = await import("./session/index.js");
      const { getMetadataClient } = await import("./meta/client.js");
      const store = getSessionStore();
      const metadataClient = getMetadataClient(config.coreSkill, spaceId, apiKey);
      const presetIdentity = parsePresetIdentity(config.sessionInit, lcHeaders);

      // ── Session Recovery: try L2b binding before falling into session-init form ──
      const compositeKey = `${agentSource}:${sessionKey}`;
      // Identity for repo/binding writes. When userId is missing, fall back to the `anonymous`
      // composite key, ensuring key path segments are valid (see section 4.4 boundary handling).
      const identity = {
        userId: userId || "anonymous",
        agentSource,
        sessionId: sessionKey,
        spaceId,
      };
      const recovered = await store.getOrRecover(compositeKey, identity, {
        metadataClient,
        messages: body.messages as Array<Record<string, unknown>> ?? [],
        presetIdentity,
      });

      let initResult: Awaited<ReturnType<typeof handleSessionInit>>;
      // Only treat the session as "recovered" when it's in a terminal state
      // (initialized or bypassed). Pending / mid-form states MUST fall through
      // to handleSessionInit so the state machine can advance to the next form.
      const isTerminalState = recovered?.status === "initialized";
      // Record whether this turn actually went through the handleSessionInit state machine - used to precisely decide the
      // `sessionJustRegistered` semantics ("the session init state machine completed a terminal transition in this turn").
      // Covers two terminal states:
      //   - normal registration complete (justRegistered=true set by completeRegistration)
      //   - bypass (user chose "No", maxRetries, no-agent and other branches also carry justRegistered=true)
      // This way, in turn N when the user answers asset-confirm, the mem-command interception block can use the checkFirst
      // fallback to grab the first user message and recognize the very first mem: command (sessionInfo=null at that time
      // -> takes the "uninitialized" branch), instead of letting it fall through to the LLM and get a hallucinated answer.
      // Guard: the regular return of Case 3 (state already stable initialized+bypassed) does **not** carry
      // justRegistered, so later turns won't grab the first history message again; the L2b recovery branch borrows
      // justRegistered=true only to trigger downstream prewarm, unrelated to the state machine, and there
      // wentThroughSessionInitStateMachine=false filters it out naturally.
      let wentThroughSessionInitStateMachine = false;
      // The recovery hit source decides whether prewarm is needed (see the detailed note at the symmetric position in handler.ts).
      const needsPrewarm =
        recovered?.__recoverySource === "l2b" ||
        recovered?.__recoverySource === "history-scan";
      if (recovered && isTerminalState) {
        // Recovery hit: keep original messages, only re-inject <session_context>
        // so this turn's system prompt carries agent/task context again.
        // The user's conversation is always kept as is, including the session_init form interaction - nothing is deleted.
        // Anthropic protocol: system lives on body.system (not in messages),
        // so we hand systemAppend back through the initResult and let the
        // shared apply-block below merge it into body.system.
        const { buildSessionContextBlockWithToggles } = await import("./session/context-injector.js");
        const inMsgs = (body.messages as Array<Record<string, unknown>>) ?? [];
        const systemAppend = recovered.bypassed
          ? null
          : buildSessionContextBlockWithToggles(
              recovered.agentDetail ?? null,
              recovered.taskDetail ?? null,
              config.sessionInit,
              sessionKey,
            );
        initResult = {
          intercepted: false,
          messages: inMsgs as Record<string, unknown>[],
          systemAppend,
          sessionInfo: recovered.sessionInfo,
          agentDetail: recovered.agentDetail,
          taskDetail: recovered.taskDetail,
          bypassed: recovered.bypassed,
          justRegistered: needsPrewarm, // only triggers prewarm on L2b / history-scan recovery
        };
      } else if (requestKind === "fork") {
        // FORK borrows the session MAIN already built. An L2b miss means MAIN has not completed init yet - a rare case;
        // to be conservative the fork request takes a no-op path (no intercept, no change to messages), so upstream receives the request unchanged.
        // The worst result = MAIN's run can't get sessionInfo (equivalent to turning session-init off), never worse.
        console.log(`[session-init:cc:fork] session=${compositeKey} L2b miss on fork request → passthrough`);
        initResult = { intercepted: false, messages: body.messages as Record<string, unknown>[] };
      } else {
        wentThroughSessionInitStateMachine = true;
        initResult = await handleSessionInit(
          sessionKey,
          userId || null,
          body.messages as Array<Record<string, unknown>> ?? [],
          config.sessionInit,
          store,
          { stream: isStream, modelId: modelId as string, protocol: "anthropic" },
          agentSource,
          metadataClient,
          apiKey,
          spaceId,
          presetIdentity,
        );
      }

      if (initResult.intercepted && initResult.response) {
        return initResult.response;
      }

      console.log(`[injection-debug] initResult session=${sessionKey} intercepted=${initResult.intercepted} bypassed=${initResult.bypassed} justRegistered=${initResult.justRegistered} resetFlow=${initResult.resetFlow} hasSessionInfo=${!!initResult.sessionInfo} hasAgentDetail=${!!initResult.agentDetail}`);
      // sessionJustRegistered is used for mem-command's checkFirst fallback (the last step of session init,
      // the "pending_task_select -> initialized" turn, re-executes the user's very first mem: command).
      // **Key**: only the branch that really goes through the handleSessionInit state machine inherits justRegistered;
      // justRegistered=true on the L2b recovery branch is only a downstream prewarm rebuild signal, not a session
      // init process, so sessionJustRegistered is not set there - otherwise mem-command would permanently grab the first user message
      // of the conversation history and repeat the user's very first mem:help as an "unprocessed command" every turn.
      if (wentThroughSessionInitStateMachine && initResult.justRegistered) sessionJustRegistered = true;
      if (initResult.bypassed) {
        injectedSkipped = true;
        console.log(`[session-init] session=${sessionKey} bypassed → skipping all injection`);
        // In the reset flow the user chose "skip" -> a confirmation message must also be returned, without forwarding to the LLM
        if (initResult.resetFlow) {
          _resetFlowResult = { agentName: "", agentIdShort: "", teamId: "", bypassed: true };
        }
      }

      if (!initResult.bypassed && initResult.sessionInfo) {
        try {
          const { fetchAssetCapabilities } = await import("./wamf/capabilities.js");
          assetCapabilities = await fetchAssetCapabilities({
            endpoint: config.wamf.endpoint,
            apiKey: config.wamf.apiKey,
            serviceId: config.wamf.serviceId,
            serviceIdOverride: spaceId,
            userId: (initResult.sessionInfo as { user_id?: string }).user_id,
            userKey: callerUserKey,
            timeoutMs: config.wamf.memory.timeoutMs,
          });
          console.log(`[asset-capability] user=${(initResult.sessionInfo as { user_id?: string }).user_id ?? "-"} flags=${JSON.stringify(assetCapabilities)}`);
        } catch (err) {
          console.warn(`[asset-capability] resolve failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Prewarm pre-short-circuit: a turn hit by mem-command neither forwards upstream nor consumes
      // hook-cache; prewarming as usual would waste 2-3s + 3 network requests. See the detailed note at the
      // symmetric position in handler.ts. No short-circuit for fork/sidequery (only effective when requestKind === "main").
      let memCommandPending = false;
      if (requestKind === "main") {
        try {
          const { parseMemCommand } = await import("./mem-command/index.js");
          let peek = parseMemCommand(body as Record<string, unknown>, agentSource);
          if (!peek && sessionJustRegistered) {
            peek = parseMemCommand(body as Record<string, unknown>, agentSource, { checkFirst: true });
          }
          if (peek) {
            memCommandPending = true;
            console.log(`[hook-cache] prewarm skipped: mem-command pending (cmd=${peek.command}) session=${sessionKey}`);
          }
        } catch (err) {
          console.warn(
            "[mem-command] pre-prewarm peek failed (anthropic):",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Await prewarm so the first-turn pipeline always hits the cache.
      // A fire-and-forget void() here caused the bug where the pipeline
      // ran before the cache was populated, silently injecting zero
      // blocks for the entire first turn.
      if (
        !initResult.bypassed &&
        initResult.justRegistered &&
        initResult.sessionInfo &&
        !memCommandPending &&
        config.injection?.enabled &&
        (config.injection.injectors?.length ?? 0) > 0
      ) {
        try {
          const mod = await import("./injection/index.js");
          // When resetFlow=true, clearBefore is required: session-reset switched the agent,
          // so the old agent's skill/wiki/knowledge caches must be cleared before writing the new ones,
          // otherwise the old agent's injected content lingers.
          // Always clearBefore: on the first init the cache is empty so clear is a no-op;
          // on reset-flow clearing the old agent's cache is necessary. Unified semantics are safer.
          await mod.prewarmFromConfig(config, {
            keyId: sessionKey,
            userId: userId || "anonymous",
            agentSource,
            spaceId,
            sessionInfo: initResult.sessionInfo as import("./session/types.js").SessionInfo,
            agentDetail: initResult.agentDetail ?? null,
            taskDetail: initResult.taskDetail ?? null,
            assetCapabilities,
            // Pass through the caller's sk-mem key, used for WAMF ACL verification in the prewarm phase (x-wamf-user-key)
            callerUserKey: callerUserKey ?? undefined,
          }, { clearBefore: true });
        } catch (err) {
          console.warn(
            "[hook-cache] handler prewarm error (anthropic):",
            err instanceof Error ? err.message : String(err),
          );
          // Don't re-throw: the pipeline's resolveHookBlocks has its own
          // cache-miss → execute() fallback as a safety net (see pipeline.ts).
        }
      }

      if (initResult.messages) {
        body = { ...body, messages: initResult.messages };
        messages = initResult.messages as unknown[];
      }

      // Anthropic: apply the session-context block onto body.system. The init
      // module cannot see body.system (it's a handler-layer concern), so it
      // hands the pre-built block back through `systemAppend` and we merge it
      // here with the same append helper used by the direct-inject path.
      if (initResult.systemAppend) {
        const { appendBlockToAnthropicSystem } = await import("./session/context-injector.js");
        body = { ...body, system: appendBlockToAnthropicSystem(body.system, initResult.systemAppend) };
      }

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      // Legacy sessions persisted before space_id was tracked will hydrate
      // with an empty space_id. Restore it from the URL each request so
      // downstream skill / knowledge / injection paths route to the correct
      // kernel tenant instead of falling back to `context-proxy` (500).
      if (sessionInfo && !sessionInfo.space_id && spaceId) {
        sessionInfo.space_id = spaceId;
      }

      // Record resetFlow for the outer scope so the confirmation response can be returned outside the block
      if (initResult.resetFlow && initResult.justRegistered && !initResult.bypassed) {
        _resetFlowResult = {
          agentName: initResult.agentDetail?.name ?? "unknown",
          // The agentIdShort field name keeps the historical name, but here it **stores the full agent_id** (e.g. agt-1celthr7yn).
          // Previously slice(-8) truncated it to "elthr7yn", which users could not understand, symmetric with the team truncation problem.
          agentIdShort: (initResult.sessionInfo as Record<string, unknown>)?.agent_id
            ? String((initResult.sessionInfo as Record<string, unknown>).agent_id) : "",
          // teamName + full teamId: see the symmetric comment in handler.ts.
          teamName: initResult.teamName ?? undefined,
          teamId: (initResult.sessionInfo as Record<string, unknown>)?.team_id
            ? String((initResult.sessionInfo as Record<string, unknown>).team_id) : "",
          taskName: initResult.taskDetail?.name,
        };
      }
    } catch (err: unknown) {
      console.error("[session-init] Error in handleSessionInit (anthropic):", err instanceof Error ? err.message : String(err));
      sessionInfo = undefined;
      injectedSkipped = true;
    }
  }

  // -- mem:session-reset completion confirmation -------------------------------------------------
  // Interaction flow of session-reset: pre-hook changes state -> form pops up -> user answers the form ->
  // completeRegistration -> prewarm -> reach here. At this point the user's original message "mem:session-reset"
  // is still in body.messages; if not intercepted it would be forwarded to the LLM, producing uncontrolled output.
  // The command execution is already complete (new agent bound, cache refreshed) -> return the confirmation text, without going through the LLM.
  if (_resetFlowResult) {
    const { agentName, agentIdShort, teamName, teamId, taskName, bypassed } = _resetFlowResult;
    const teamLine = teamName
      ? `- **Team**: ${teamName}${teamId ? ` (${teamId})` : ""}`
      : teamId
        ? `- **Team**: ${teamId}`
        : null;
    const lines = bypassed
      ? ["✅ Team assets not linked", "", "No team assets (Skill / memory / Knowledge) will be injected into the rest of this conversation."]
      : [
          "✅ Team assets re-linked",
          "",
          `- **Agent**: ${agentName}${agentIdShort ? ` (${agentIdShort})` : ""}`,
          teamLine,
          taskName ? `- **Task**: ${taskName}` : "- **Task**: not linked",
          "",
          "The rest of this conversation uses the new Agent's Skills, memory and knowledge assets.",
        ].filter(Boolean);
    const text = (lines as string[]).join("\n");

    const { buildMemResponse } = await import("./mem-command/response-builder.js");
    const thinkingEnabled = !!(body as Record<string, unknown>).thinking;
    console.log(`[mem-command:session-reset] completed: bypassed=${!!bypassed} agent=${agentName} (${agentIdShort}) team=${teamName ?? "-"} (${teamId || "-"})`);
    return buildMemResponse(text, {
      protocol: "anthropic",
      stream: isStream,
      requestId: `mem-reset-${Date.now()}`,
      thinking: thinkingEnabled,
    });
  }

  // ── mem: command intercept ────────────────────────────────────────────────
  // Detected after session init completes and before the injection pipeline.
  // On a hit: execute the command -> write L0 -> trigger skill extract -> forge a response and return.
  // Skips injection (does not break the KV cache) and upstream forwarding (zero token consumption).
  // Command interception is always enabled; unknown commands get a fallback hint from KNOWN_COMMANDS inside executeMemCommand.
  //
  // parseMemCommand internally extracts the user input via agentAdapter.extractUserText according to client rules:
  //   - claude-code: take the last text block (skipping prefix metadata like <system-reminder>)
  //   - codebuddy / unknown: use the conservative "concatenate all text" logic
  //
  // CC routing: FORK/SIDEQUERY are requests constructed internally by the CC client; last_user won't start with `mem:`,
  //          and a forged response would break the assumption that the fork request depends on MAIN's cache. Skip interception.
  if (requestKind === "main") {
    const { parseMemCommand, executeMemCommand, buildMemResponse, extractSimpleMessages, truncateArgs } = await import("./mem-command/index.js");
    // Regular detection: the last user message
    let memCmd = parseMemCommand(body as Record<string, unknown>, agentSource);
    // When the session init state machine completes a terminal state (initialized or bypass) in this turn, the last
    // user message is the init interaction answer (e.g. "No"), so additionally check the first user message
    // - the user's original intent. In bypass scenarios sessionInfo=null takes the "uninitialized"
    // branch and returns the text, avoiding the first mem: command being swallowed into history and falling through to the LLM.
    if (!memCmd && sessionJustRegistered) {
      memCmd = parseMemCommand(body as Record<string, unknown>, agentSource, { checkFirst: true });
    }
    // session-reset was already handled in the pre-hook (state changed to uninitialized, then session-init pops up the form
    // -> user answers the form -> completeRegistration triggers _resetFlowResult to return the confirmation response).
    // checkFirst=true would match the original "mem:session-reset" in history; without skipping it would go through executeMemCommand
    // and run reset again, knocking the just-completed binding back to uninitialized, forming a "reset -> form -> reset -> form" infinite loop.
    if (memCmd?.command === "session-reset") memCmd = null;
    if (memCmd) {
      // bypass optimization: when the session is not initialized, commands are unavailable
      if (!sessionInfo || injectedSkipped) {
        const thinkingEnabled = !!(body as Record<string, unknown>).thinking;
        const errText = `⚠️ The session is not set up yet, so this command is unavailable. Finish session setup (choose a Team/Agent) and try again.`;
        const errResponse = buildMemResponse(errText, {
          protocol: "anthropic",
          stream: isStream,
          requestId: `mem-cmd-${Date.now()}`,
          thinking: thinkingEnabled,
        });
        console.log(`[mem-command] cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} blocked: session not initialized`);
        return errResponse;
      }
      // Detect whether the request enables extended thinking (Anthropic protocol)
      const thinkingEnabled = !!(body as Record<string, unknown>).thinking;
      const memResult = await executeMemCommand(memCmd, {
        sessionKey,
        agentSource,
        config,
        spaceId,
        userId,
        apiKey: apiKey || "",
        sessionInfo: sessionInfo as Record<string, unknown>,
        protocol: "anthropic",
        stream: isStream,
        args: memCmd.args,
        thinking: thinkingEnabled,
        // The task command family generates drafts from the recent conversation. Anthropic message content may be an array,
        // and extractSimpleMessages merges all text segments.
        bodyMessages: extractSimpleMessages((body as Record<string, unknown>).messages),
        // Option D: the taskDraft LLM follows the main model - reuse the client's model for this call + per-agent upstream + apiKey
        model: modelId,
        upstreamUrl:
          (agentFromPath ? config.upstream.agents?.[agentFromPath]?.url : undefined) ||
          config.upstream.url,
        // The Claude Code main path goes through the Anthropic Messages API
        upstreamProtocol: "anthropic",
      });

      // Step 20: L0 write - keep the conversation timeline complete.
      //   Synchronous await guarantees L0 is persisted before returning, avoiding loss when the response returns first and the process exits before flushing.
      //   Note: when only a mem command runs, this is the only persistence in the whole pipeline, unlike the main conversation path (which has SIGTERM
      //   trackWrite as a fallback + withL0Retry); here we must wait explicitly.
      const wamfClientForMem = createWamfClient(config, spaceId);
      const wamfIdentityForMem = deriveWamfIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
        userKey: callerUserKey,
      });
      if (wamfClientForMem && wamfIdentityForMem && isExtractionAllowed(config, "wamf-memory")) {
        const userMsg = { role: "user" as const, content: memCmd.rawMessage };
        try {
          await recordWamfTurn(wamfClientForMem, wamfIdentityForMem, userMsg, memResult.messageText);
        } catch (err: unknown) {
          console.error("[mem-command] L0 write error:", err);
        }
      }

      // Step 19: skill extract - conversation turn counting accumulates normally
      //   Bug: previously the access path `config.extraction?.skill?.enabled` was wrong
      //        (the extraction structure is { enabled, extractors: [...] } with no .skill),
      //        so mem commands **never** wrote to the skill buffer. Now uses isExtractionAllowed
      //        to align with the main conversation path.
      //   Bug: fire-and-forget without await made the response return first and the write get interrupted. Changed to a synchronous await
      //        so the buffer is persisted before the response is returned.
      if (isExtractionAllowed(config, "skill")) {
        try {
          const assistantMsg = { role: "assistant", content: [{ type: "text", text: memResult.messageText }] };
          await triggerSkillExtractIfReady({
            config,
            sessionKey,
            agentSource,
            sessionInfo: sessionInfo as Record<string, unknown>,
            inputMessages: messages as unknown[],
            assistantMessage: assistantMsg,
            protocol: "anthropic",
            assetCapabilities,
          });
        } catch (err: unknown) {
          console.warn("[mem-command] skill extract trigger error:", err instanceof Error ? err.message : String(err));
        }
      }

      // Step 18: observability
      console.log(`[mem-command] cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} success=${memResult.success}`);

      // Step 17: Langfuse - report the mem-command as a generation observation.
      //   mem command interception happens before the Langfuse context is built (lf is only declared at L1088), so here
      //   turnSeq -> traceId is computed inline, ensuring this turn has a complete trace in Langfuse.
      const memTurnSeq = countHumanTurns(messages, "anthropic");
      const memTraceId = langfuseTurnTraceId(sessionKey, memTurnSeq);
      langfuseReportGeneration({
        traceId: memTraceId,
        name: "memory-proxy",
        model: "memory-proxy",
        startTime,
        endTime: new Date().toISOString(),
        input: memCmd.rawMessage,
        output: memResult.messageText,
        usage: { input_tokens: 0, output_tokens: 0 },
        traceName: `memory-proxy / ${keyId}`,
        userId: keyId,
        sessionId: sessionKey,
        tags: [
          `agent_source:${agentSource}`,
          "protocol:anthropic",
          isStream ? "stream" : "non-stream",
          `session:${sessionKey}`,
          "mem-command",
        ],
        traceInput: memCmd.rawMessage,
        traceOutput: memResult.messageText,
      });

      return memResult.response;
    }
  }

  const wamfClient = assetCapabilities?.chat_memory === false ? null : createWamfClient(config, spaceId);
  const wamfIdentity = injectedSkipped
    ? null
    : deriveWamfIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
        userKey: callerUserKey,
      });
  const wamfUserMessage = extractLatestUserMessage(messages);

  // ── Context injection (before cost guard) ────────────────────────────────
  // CC routing:
  //   - SIDEQUERY: skips injection entirely (own short prompt, does not share the cache)
  //   - FORK: goes through the pipeline but readOnly=true (on a miss, no self-heal write to the cache, to avoid breaking the main conversation's cache)
  //   - MAIN: goes through the full pipeline (including self-heal)
  const skipInjection = requestKind === "sidequery";
  if (!injectedSkipped && !skipInjection && config.injection?.enabled && config.injection.injectors.length > 0) {
    try {
      console.log(`[injection-debug] entering injection pipeline session=${sessionKey} turnSeq=${countHumanTurns(messages, "anthropic")} injectors=${config.injection.injectors} kind=${requestKind}`);
      const injectionTurnSeq = countHumanTurns(messages, "anthropic");
      const { getInjectionPipeline } = await import("./injection/index.js");
      const pipeline = getInjectionPipeline(config);
      const injectedBody = await pipeline.process(body, {
        protocol: "anthropic",
        traceId,
        keyId,
        modelId: modelId as string,
        stream: isStream,
        agentSource,
        userId: userId || "anonymous",
        spaceId,
        sessionKey,
        turnSeq: injectionTurnSeq,
        // Pass through the original request path - AssetReflectionInjector uses it to detect the `/analyse` marker.
        // Other injectors do not depend on this field.
        requestPath: c.req.path,
        custom: sessionInfo ? { session: sessionInfo, userKey: callerUserKey ?? undefined, assetCapabilities } : undefined,
        readOnly: requestKind === "fork",
      });
      body = injectedBody;
      messages = Array.isArray(injectedBody.messages) ? injectedBody.messages : messages;
      hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    } catch (err: unknown) {
      console.error("[injection] anthropic pipeline error:", err instanceof Error ? err.message : String(err));
    }
  } else if (skipInjection) {
    console.log(`[injection-debug] skipping injection for kind=sidequery session=${sessionKey}`);
  }

  // ── Cost guard: resolve forward target (opaque — no routing logic here) ──
  // upstream.agents[agent] is a single map keyed by agent name (URL path
  // prefix); both url and apiKey may be overridden per agent. When there's
  // no entry, we fall through to the Anthropic-specific global (costGuard
  // .anthropicUpstream) and finally to upstream.url — exactly as before.
  const agentUpstreamEntry = agentFromPath ? config.upstream.agents?.[agentFromPath] : undefined;
  let effectiveApiKey = agentUpstreamEntry
    ? (agentUpstreamEntry.apiKey ?? "")
    : config.upstream.apiKey;
  const defaultUpstreamUrl =
    agentUpstreamEntry?.url ||
    config.costGuard.anthropicUpstream?.url ||
    config.upstream.url;
  // Normalize the request path to the canonical upstream endpoint so the
  // extension's URL joining matches the host whitelist behavior.
  const forwardEndpoint = matchWhitelistEndpoint(c.req.path)?.upstreamEndpoint ?? "/messages";
  // Isolation key is user-namespaced (`${user}:${session}`) so two users that
  // share the same client session id can't contaminate each other's state /
  // turn counting. ClickHouse keeps the raw session_key (it has its own
  // user_id column); this composite is internal to the extension only.
  const target: ForwardTarget = await resolveForwardTarget(config, {
    keyId: `${keyId}:${sessionKey}`,
    messages,
    protocol: "anthropic",
    hasTools,
    body,
    modelId,
    defaultUpstreamUrl,
    requestPath: forwardEndpoint,
    headers: lcHeaders,
    traceId,
    startTime,
    spaceId,
    // markerOptIn=false (default/prod): every request goes through the router
    //   regardless of the URL (`/cost-guard` routes are 404 in this mode).
    // markerOptIn=true (test env): only requests with the `/cost-guard`
    //   segment activate the router; bare paths passthrough.
    useGuard: config.costGuard.markerOptIn ? hasCostGuardMarker(c.req.path) : true,
    agentName: agentFromPath,
  });

  // ── Instance upstream config override ──────────────────────────────────
  let skipCreditReport = false;
  {
    const routedToCheapModel = target.routedFrom !== "";
    const convCfg = _earlyConvCfg;
    if (!routedToCheapModel && shouldOverride(convCfg)) {
      target.url = `${convCfg.base_url.replace(/\/+$/, "")}${forwardEndpoint}`;
      effectiveApiKey = convCfg.mode === "custom_unified"
        ? convCfg.api_key
        : apiKey; // custom_passthrough
      if (convCfg.model_id) {
        body.model = convCfg.model_id;
        modelId = convCfg.model_id;
      }
      skipCreditReport = true;
    }
  }

  // ── Create pipeline logger ──────────────────────────────────────────────
  const pipe = createPipeline(config, traceId, target.model);
  pipe.requestReceived(messages.length, isStream);
  if (target.logLine) pipe.info("COST_GUARD", target.logLine);
  if (target.logLineExtra) pipe.info("COST_GUARD_DETAIL", target.logLineExtra);
  if (ccRoutingEnabled) {
    console.log(`[cc-routing] session=${sessionKey} kind=${requestKind} msgs=${messages.length}`);
  }



  // ── Trace-level tags ──
  // agent_source identifies the client family (codebuddy / claude-code / codex / ...), used for
  // filtering traces by client in Langfuse; protocol only distinguishes the wire protocol, and the same wire
  // can map to multiple clients.
  const traceTags: string[] = [
    `agent_source:${agentSource}`,
    "protocol:anthropic",
    isStream ? "stream" : "non-stream",
    `session:${sessionKey}`,
  ];

  // ── Langfuse turn context: one trace = one turn (deterministic traceId) ──
  // Same (sessionKey, turnSeq) across a turn's tool-loop requests → same trace.
  // Prefer the extension's monotonic per-session turnSeq (survives context
  // compaction); fall back to the stateless count when it's not tracked
  // (extension disabled/unavailable, or no-tools auxiliary request).
  const turnSeq = target.turnSeq > 0 ? target.turnSeq : countHumanTurns(messages, "anthropic");
  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(sessionKey, turnSeq),
    turnSeq,
    traceName: `${target.model} / ${keyId}`,
    userId: keyId,
    sessionId: sessionKey,
    tags: traceTags,
    routeTags: target.tags,
    userQuery: resolveLatestUserQuery(config, lcHeaders, c.req.path, body, messages),
  };
  if (target.analyzerTrace) {
    reportAnalyzerTrace(config, target.analyzerTrace, {
      traceId,
      langfuseTraceId: lf.traceId,
      traceName: lf.traceName,
      traceTags: lf.tags,
      keyId: `${keyId}:${sessionKey}`,
      sessionKey,
      turnSeq,
      startTime,
      spaceId,
    });
  }

  // ── Langfuse debug metadata (only when config.langfuse.debug=true) ────────
  // Used to capture CB / CC client fingerprints; always returns {} when off, so production metadata is not polluted.
  // See common/langfuse-debug.ts.
  const langfuseDebug = config.langfuse.debug === true;
  const debugMetadata = buildRequestDebugMetadata({
    debug: langfuseDebug,
    body: body as Record<string, unknown>,
    headers: reqHeaders,
    agentSource,
    requestKind,
    spaceId,
    turnSeq,
    requestPath: c.req.path,
    protocol: "anthropic",
  });

  // ── Opik: create trace ───────────────────────────────────────────────────
  const forkTraceId = opikCreateTrace(config, {
    traceId,
    projectName: keyId,
    name: `${target.model} / ${keyId}`,
    startTime,
    input: { messages: flattenAnthropicMessagesForOpik(messages, body.system) },
    tags: [...traceTags, ...target.tags],
    forkProjectName: "request_log",
    forkMetadata: {
      keyId,
      modelId: target.model,
      stream: isStream,
      upstreamUrl: target.url,
    },
  });

  // ── Request debug log ────────────────────────────────────────────────────
  writeRequestLog(config, body);

  // ── Build upstream request ───────────────────────────────────────────────
  // Per-agent apiKey resolution — three cases:
  //   (a) no entry in agents map           -> global upstream.apiKey (fallback)
  //   (b) entry present, apiKey empty      → "" (passthrough, keep client key)
  //   (c) entry present, apiKey non-empty  → agent.apiKey (server-side key)
  // The presence of an entry (case b/c) is what cuts the global fallback —
  // effectiveApiKey already resolved above (before instance config override).
  const upstreamHeaders = buildUpstreamHeaders(c, config, target, sessionKey, effectiveApiKey);

  // Optional private preparation stage. It rewrites `body` / `messages` in
  // place, so it has to land after every host-side mutation (injection, agent
  // overrides) and before the upstream body is assembled below. The host does
  // not interpret the returned stats — see request-prepare-adapter.ts.
  const preparedStats = await prepareUpstreamRequest({
    config,
    protocol: "anthropic",
    body,
    messages,
    sessionKey,
    pipe,
    upstreamCall: {
      upstreamUrl: target.url,
      headers: upstreamHeaders,
      model: target.model,
      tools: body.tools,
      system: body.system,
      bodyOverrides: target.bodyOverrides ?? undefined,
    },
    userQuery: lf.userQuery,
    spaceId,
    lf,
    opikTraceId: traceId,
    opikKeyId: keyId,
  });

  const { body: upstreamBody, sanitizedCount } = buildUpstreamBody(body, target);
  if (sanitizedCount > 0) {
    pipe.info(
      "FORWARD",
      `stripped ${sanitizedCount} invalid thinking block(s) from history`,
    );
  }

  // Retry headers: preserve original client headers (x-request-id, user-agent,
  // etc.), then force the primary upstream's auth — retry always goes to the
  // default upstream (never the alternate route), so its apiKey must be applied
  // just like the first-attempt path. Without this, retry sends the
  // client's raw auth to tokenhub and gets 401.
  const originalHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      originalHeaders[k] = v;
    }
  }
  // Retry uses the same effective key as the primary path — same three
  // cases as above. When it resolves to "" (agent entry present but no
  // apiKey), retry also runs on the client's own key: preserves the
  // "passthrough on this agent" intent even across retries.
  if (effectiveApiKey) {
    originalHeaders["x-api-key"] = effectiveApiKey;
    delete originalHeaders["authorization"];
  }

  const retryBody = sanitizeThinkingBlocks(body).body;

  // ── Forward to upstream (with automatic retry if configured) ──────────────
  const forwardTimeoutMs = config.server.forwardTimeoutMs ?? 600_000;
  pipe.forwardStart();
  let upstreamResp: Response;
  let retried = false;

  try {
    const result = await forwardWithRetry(
      target, upstreamHeaders, upstreamBody,
      retryBody, originalHeaders,
      pipe, forwardTimeoutMs,
      sessionKey,
      { config, instanceId: spaceId || undefined },
    );
    upstreamResp = result.resp;
    retried = result.retried;
  } catch (err: unknown) {
    if (isRateLimitExceededError(err)) {
      pipe.info("RATE_LIMIT", "TPM/QPM exceeded");
      return err.response;
    }
    langfuseReportFailure({
      lf,
      model: target.model,
      startTime,
      endTime: new Date().toISOString(),
      input: buildLangfuseInput(messages, body.system, langfuseDebug),
      statusMessage: err instanceof Error ? err.message : "Upstream request failed",
      extraTags: ["error"],
      observationMetadata: { stage: "forward", ...debugMetadata },
    });
    return c.json({ error: "Upstream request failed" }, 502);
  }

  // Build response headers
  const respHeaders = new Headers();
  for (const [k, v] of upstreamResp.headers.entries()) {
    if (!SKIP_RESPONSE_HEADERS.has(k.toLowerCase())) {
      respHeaders.set(k, v);
    }
  }

  // Upstream request id from response header (tokenhub / Anthropic set
  // `x-request-id`). Used for cross-system tracing/audit.
  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";

  const effectiveModel = retried && target.retryTarget
    ? target.retryTarget.model
    : target.model;

  // A retry falls back to the model the client asked for, so the request ends
  // up costing what it would have cost unrouted — no saving to attribute.
  const routedFrom = retried ? "" : target.routedFrom;
  const { routedFrom: _ignoredRoutedFrom, ...routeLogMeta } = target.logMeta;
  const responseLogMeta = {
    ...routeLogMeta,
    ...(retried ? { retrySuccess: true } : {}),
  };

  // ── Streaming response (Anthropic SSE) ──────────────────────────────────
  if (isStream) {
    if (!upstreamResp.body) {
      pipe.streamDone(null);
      return new Response(null, { status: upstreamResp.status, headers: respHeaders });
    }

    // Log error body for 4xx
    if (!retried && upstreamResp.status >= 400 && upstreamResp.status < 500) {
      const [errStream, clientStream] = upstreamResp.body.tee();
      const errText = await new Response(errStream).text();
      pipe.error("UPSTREAM_4xx", `status=${upstreamResp.status} body=${errText.slice(0, 1000)}`);
      writeLog(config, {
        timestamp: new Date().toISOString(),
        event: "usage",
        modelId: target.model,
        keyId,
        sessionKey,
        upstreamUrl: target.url,
        stream: true,
        usage: { error: true, status: upstreamResp.status, body: errText.slice(0, 500) },
        ...responseLogMeta,
        routedFrom,
        spaceId,
        upstreamRequestId,
      });
      langfuseReportFailure({
        lf,
        model: effectiveModel,
        startTime,
        endTime: new Date().toISOString(),
        input: buildLangfuseInput(messages, body.system, langfuseDebug),
        status: upstreamResp.status,
        statusMessage: errText.slice(0, 500),
        extraTags: ["error"],
        observationMetadata: { stage: "upstream", stream: true, ...debugMetadata },
      });
      pipe.streamDone(null);
      return new Response(clientStream, { status: upstreamResp.status, headers: respHeaders });
    }

    const [rawClientStream, tapStream] = upstreamResp.body.tee();
    pipe.streamStart();

    // Background: consume tap stream for Anthropic SSE → extract usage
    consumeAnthropicStream(tapStream, {
      config,
      modelId: effectiveModel,
      keyId,
      sessionKey,
      upstreamUrl: target.url,
      requestPath: c.req.path,
      traceId,
      forkTraceId,
      startTime,
      inputMessages: messages,
      system: body.system,
      retried,
      logMeta: responseLogMeta,
      routedFrom,
      pipe,
      sessionKeyForSkill: sessionKey,
      agentSource,
      sessionInfo,
      wamfClient,
      wamfIdentity,
      wamfUserMessage,
      assetCapabilities,
      lf,
      spaceId,
      upstreamRequestId,
      requestKind,
      langfuseDebug,
      debugMetadata,
      preparedStats,
      skipCreditReport,
    });

    const clientStream = rawClientStream.pipeThrough(createSseThinkingFixStream(pipe));

    return new Response(clientStream, { status: upstreamResp.status, headers: respHeaders });
  }

  // ── Non-streaming response ───────────────────────────────────────────────
  let respText = await upstreamResp.text();
  const endTime = new Date().toISOString();

  let usage: Record<string, unknown> | null = null;
  let outputContent: string | null = null;
  let assistantMessage: Record<string, unknown> | null = null;
  try {
    const respJson = JSON.parse(respText) as Record<string, unknown>;
    if (respJson.usage && typeof respJson.usage === "object") {
      usage = respJson.usage as Record<string, unknown>;
    }
    const content = respJson.content;
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      let thinkingPatched = false;
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === "text") textParts.push(block.text as string);
        // Fix thinking blocks with missing/null `thinking` field.
        // Some models (e.g. DeepSeek) emit `type: "thinking"` blocks
        // without a valid `thinking` string, causing Claude Code to crash
        // with "undefined is not an object (evaluating 's.thinking.length')".
        if (block.type === "thinking") {
          if (block.thinking === undefined || block.thinking === null) {
            block.thinking = "";
            thinkingPatched = true;
          } else if (typeof block.thinking !== "string") {
            block.thinking = String(block.thinking);
            thinkingPatched = true;
          }
        }
      }
      if (thinkingPatched) {
        respText = JSON.stringify(respJson);
        pipe.info("NONSTREAM_THINKING_FIX", "patched thinking block(s) with missing 'thinking' field");
      }
      outputContent = textParts.join("\n");
      // Preserve full content array (incl. tool_use blocks) for skill trigger.
      assistantMessage = { role: "assistant", content };

      // Report the completed response to the extension (same signal the
      // streaming path emits). Fire-and-forget.
      void notifyUpstreamResponse(
        config,
        {
          protocol: "anthropic",
          sessionKey,
          model: effectiveModel,
          stream: false,
          turnSeq: lf.turnSeq,
          text: outputContent,
          toolCalls: (content as Record<string, unknown>[])
            .filter((b) => b?.type === "tool_use")
            .map((b) => ({
              id: (b.id as string) ?? "",
              name: (b.name as string) ?? "",
              arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? ""),
            }))
            .filter((tc) => tc.id && tc.arguments),
          usage: usage ?? {},
        },
        pipe,
      );

      // Internal usage instrumentation: record a model_intent for each tool_use block of a non-streaming response.
      try {
        const intents = (content as Record<string, unknown>[])
          .filter((b) => b?.type === "tool_use")
          .map((b) => {
            const name = (b.name as string) ?? "";
            const input = b.input;
            const argsStr = typeof input === "string" ? input : JSON.stringify(input ?? "");
            return { name, arguments: argsStr };
          })
          .filter((i) => i.name);
        if (intents.length > 0) {
          emitModelIntentTelemetry({
            // Align the compositeKey form with session_init_logs
            sessionKey: `${agentSource}:${sessionKey}`,
            turnSeq: lf.turnSeq,
            spaceId,
            userId: keyId,
            agentSource,
            intents,
          });
        }
      } catch {
        // Instrumentation must never block the business
      }
    }
  } catch {
    // non-JSON response
  }

  const logMeta = responseLogMeta;

  if (usage) {
    await recordInputTokenUsage({
      config,
      instanceId: spaceId || undefined,
      modelId: effectiveModel,
      usage,
      protocol: "anthropic",
    });
    writeLog(config, {
      timestamp: endTime,
      event: "usage",
      modelId: effectiveModel,
      keyId,
      sessionKey,
      turnSeq: lf.turnSeq,
      userInput: lf.userQuery || undefined,
      upstreamUrl: target.url,
      stream: false,
      usage,
      extensionStats: preparedStats ?? undefined,
      ...logMeta,
      routedFrom,
      spaceId,
      upstreamRequestId,
    });

    opikCreateLlmSpan(config, {
      traceId,
      projectName: keyId,
      name: effectiveModel,
      startTime,
      endTime,
      inputMessages: flattenAnthropicMessagesForOpik(messages, body.system),
      outputMessage: outputContent ? { role: "assistant", content: outputContent } : null,
      model: effectiveModel,
      usage,
      tags: retried ? ["retry"] : undefined,
      forkProjectName: "request_log",
      forkTraceId,
      forkMetadata: {
        keyId,
        modelId: effectiveModel,
        stream: false,
        upstreamUrl: target.url,
      },
    });

    // Langfuse: report this LLM call as a generation under the turn trace
    // When debug=true, output uses the native assistantMessage array (including tool_use / thinking /
    // native stop_reason); non-debug uses the original text concatenation to save storage.
    const langfuseOutput = langfuseDebug && assistantMessage
      ? assistantMessage
      : outputContent
      ? { role: "assistant", content: outputContent }
      : undefined;
    langfuseReportGeneration({
      traceId: lf.traceId,
      name: effectiveModel,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInput(messages, body.system, langfuseDebug),
      output: langfuseOutput,
      usage,
      traceName: lf.traceName,
      userId: lf.userId,
      sessionId: lf.sessionId,
      tags: lf.tags,
      traceInput: lf.userQuery || undefined,
      traceOutput: langfuseOutput,
      traceMetadata: { stream: false, retried, upstreamUrl: target.url, ...logMeta, ...debugMetadata },
      observationMetadata: { retried, ...logMeta, ...debugMetadata },
    });
  } else if (upstreamResp.status >= 400) {
    pipe.error("UPSTREAM_4xx", `status=${upstreamResp.status} body=${respText.slice(0, 1000)}`);
    langfuseReportFailure({
      lf,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInput(messages, body.system, langfuseDebug),
      status: upstreamResp.status,
      statusMessage: respText.slice(0, 500),
      extraTags: ["error"],
      observationMetadata: { stage: "upstream", stream: false, ...debugMetadata },
    });
  }

  pipe.responseDone(usage);

  // CC routing: FORK/SIDEQUERY are background spontaneous calls of the CC client, not real conversation turns,
  //          so skip skill/L0 side effects. Credit is still reported (token consumption is real).
  const isMainDialog = requestKind === "main";

  // Skill extract trigger — count tool_use blocks + buffer conversation.
  // Synchronous await: continue only after the store is persisted, ensuring the next turn reads the latest data across nodes.
  if (isMainDialog && isExtractionAllowed(config, "skill")) {
    await triggerSkillExtractIfReady({
      config,
      sessionKey,
      agentSource,
      sessionInfo,
      inputMessages: messages,
      assistantMessage,
      protocol: "anthropic",
      assetCapabilities,
    });
  } else if (isMainDialog) {
    logExtractionSkipped(config, "skill", sessionKey);
  } else {
    console.log(`[cc-routing] skip skill buffer for kind=${requestKind} session=${sessionKey}`);
  }

  // WAMF L0 write (non-streaming).
  //
  // Symmetric with the stream branch (1476-1481): write user_query + assistant reply into L0
  // short-term memory. **Previously only stream=true wrote**; non-stream requests (such as stream:false
  // commonly used by tools/test scripts) were silently lost. Missing this call meant CC non-stream scenarios
  // had no L0 memory writes at all.
  if (isMainDialog && wamfClient && isExtractionAllowed(config, "wamf-memory")) {
    recordWamfTurn(wamfClient, wamfIdentity, wamfUserMessage, outputContent)
      .catch((err: unknown) => pipe.error("WAMF_L0", err));
  } else if (isMainDialog && wamfClient) {
    logExtractionSkipped(config, "wamf-memory", sessionKey);
  } else if (!isMainDialog) {
    console.log(`[cc-routing] skip L0 write for kind=${requestKind} session=${sessionKey}`);
  }

  // Credit usage reporting (non-streaming).
  const creditOutcome = skipCreditReport
    ? { attempted: false, ok: false }
    : await tryReportCreditFromPath(
    config.creditReport,
    c.req.path,
    usage,
    config.creditPricing,
    effectiveModel,
    target.url,
    "usage",
  );
  if (creditOutcome.attempted && !creditOutcome.ok) {
    pipe.error("CREDIT_REPORT", creditOutcome.errorMessage ?? "unknown");
    if (creditOutcome.errorHeader) {
      respHeaders.set("x-credit-report-error", creditOutcome.errorHeader);
    }
    // Persist the failed report as a raw record for auditing / retry pipelines.
    writeFailedReportRaw(
      {
        timestamp: new Date().toISOString(),
        event: "usage",
        modelId: effectiveModel,
        keyId,
        sessionKey,
        upstreamUrl: target.url,
        stream: false,
        usage: usage === null ? undefined : usage,
        routedFrom,
        upstreamRequestId,
        pricingConfig: config.creditPricing,
      },
      creditOutcome.errorMessage ?? "unknown",
    );
  }

  return new Response(respText, { status: upstreamResp.status, headers: respHeaders });
}


/**
 * Create a TransformStream that patches Anthropic SSE events in-band.
 */
function createSseThinkingFixStream(
  pipe: ReturnType<typeof createPipeline>,
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let sseBuf = "";
  let patchedCount = 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sseBuf += decoder.decode(chunk, { stream: true });

      const parts = sseBuf.split("\n\n");
      sseBuf = parts.pop() ?? "";

      for (const part of parts) {
        const lines = part.split("\n");
        let dataLine = "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            dataLine = line;
          }
        }

        if (!dataLine) {
          controller.enqueue(encoder.encode(part + "\n\n"));
          continue;
        }

        const dataStr = dataLine.slice(6);
        if (!dataStr || dataStr === "[DONE]") {
          controller.enqueue(encoder.encode(part + "\n\n"));
          continue;
        }

        try {
          const evt = JSON.parse(dataStr) as Record<string, unknown>;
          let patched = false;

          if (evt.type === "content_block_start") {
            const block = evt.content_block as Record<string, unknown> | undefined;
            if (block?.type === "thinking") {
              if (block.thinking === undefined || block.thinking === null) {
                block.thinking = "";
                patched = true;
              } else if (typeof block.thinking !== "string") {
                block.thinking = String(block.thinking);
                patched = true;
              }
            }
          }

          // Fix content_block_delta with type=thinking_delta but missing thinking field.
          // Claude Code does `contentBlock.thinking += delta.thinking` which would
          // produce "null" or "undefined" strings if delta.thinking is not a string.
          if (evt.type === "content_block_delta") {
            const delta = evt.delta as Record<string, unknown> | undefined;
            if (delta?.type === "thinking_delta") {
              if (delta.thinking === undefined || delta.thinking === null) {
                delta.thinking = "";
                patched = true;
              } else if (typeof delta.thinking !== "string") {
                delta.thinking = String(delta.thinking);
                patched = true;
              }
            }
          }

          if (patched) {
            patchedCount++;
            const newDataLine = "data: " + JSON.stringify(evt);
            const newLines = lines.map((l) =>
              l.startsWith("data: ") ? newDataLine : l,
            );
            controller.enqueue(encoder.encode(newLines.join("\n") + "\n\n"));
          } else {
            controller.enqueue(encoder.encode(part + "\n\n"));
          }
        } catch {
          controller.enqueue(encoder.encode(part + "\n\n"));
        }
      }
    },

    flush(controller) {
      if (sseBuf.trim()) {
        controller.enqueue(encoder.encode(sseBuf));
      }
      if (patchedCount > 0) {
        pipe.info("SSE_FIX", `patched ${patchedCount} thinking block(s) with missing 'thinking' field`);
      }
    },
  });
}

// ── Stream processing helpers ────────────────────────────────────────────────

interface AnthropicTapContext {
  config: ProxyConfig;
  modelId: string;
  keyId: string;
  sessionKey: string;
  upstreamUrl: string;
  requestPath: string;
  traceId: string;
  forkTraceId: string;
  startTime: string;
  inputMessages: unknown[];
  /** Anthropic top-level `system` field (string or content-block array). */
  system: unknown;
  retried: boolean;
  logMeta: Record<string, unknown>;
  /** Requested model when the router forwarded elsewhere; "" otherwise. */
  routedFrom: string;
  pipe: ReturnType<typeof createPipeline>;
  /** For skill extract trigger. */
  sessionKeyForSkill: string;
  /** Client type (first segment of the URL path) - passed through to the extract trigger as one of the three isolation keys. */
  agentSource: string;
  sessionInfo: Record<string, unknown> | null | undefined;
  /** Wamf L0 write. */
  wamfClient: WamfClient | null;
  wamfIdentity: WamfIdentity | null;
  wamfUserMessage: WamfMessage | null;
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
  /** Langfuse turn-trace context (trace = one turn). */
  lf: LangfuseTurnContext;
  /** Space/tenant ID from request path. */
  spaceId?: string;
  /** Upstream response header `x-request-id` (empty when not returned). */
  upstreamRequestId?: string;
  /** CC request routing category, deciding whether skill/L0 side effects are triggered after the stream completes. */
  requestKind: CcRequestKind;
  /** Evaluated result of `config.langfuse.debug === true`, passed through to avoid re-reading config inside the stream. */
  langfuseDebug: boolean;
  /** Evaluated result of buildRequestDebugMetadata; {} when debug=false. */
  debugMetadata: Record<string, unknown>;
  /** Opaque counters from the request-preparation stage; null when it didn't run. */
  preparedStats: Record<string, unknown> | null;
  /** Instance upstream config: skip credit reporting for custom model. */
  skipCreditReport?: boolean;
}

/**
 * Consume Anthropic SSE stream in background, extract usage, log + Opik.
 */
function consumeAnthropicStream(stream: ReadableStream<Uint8Array>, ctx: AnthropicTapContext): void {
  const { config, modelId, keyId, sessionKey, upstreamUrl, traceId, forkTraceId, startTime, inputMessages, system, retried, logMeta, pipe, lf, spaceId, upstreamRequestId } = ctx;

  (async () => {
    const decoder = new TextDecoder();
    let sseBuf = "";
    let usage: Record<string, unknown> = {};
    let outputText = "";
    let toolUseCount = 0;
    let streamCompleted = false;
    // For internal usage instrumentation: accumulate each tool_use block by index.
    // Anthropic SSE protocol:
    //   1. content_block_start(type=tool_use)  -> get index + name (input is an empty {} at this point)
    //   2. content_block_delta(type=input_json_delta) -> accumulate the partial_json string
    //   3. content_block_stop -> this block ends
    // The previous implementation only read the input in (1) (always empty) - now accumulate the partial_json of (2) by index.
    const toolUseAcc = new Map<number, { id: string; name: string; inputJson: string }>();

    const timeoutHandle = setTimeout(() => {
      if (!streamCompleted) {
        pipe.error("STREAM_TIMEOUT", "Anthropic stream reading exceeded 5 minutes");
        // completeStream is async; fire-and-forget here (it can no longer be awaited inside the timeout)
        void completeStream().catch((err) => pipe.error("STREAM_TIMEOUT_COMPLETE", err));
      }
    }, 5 * 60 * 1000);

    async function completeStream(): Promise<void> {
      if (streamCompleted) return;
      streamCompleted = true;
      clearTimeout(timeoutHandle);

      const endTime = new Date().toISOString();

      if (Object.keys(usage).length > 0) {
        await recordInputTokenUsage({
          config,
          instanceId: spaceId || undefined,
          modelId,
          usage,
          protocol: "anthropic",
        });
        try {
          writeLog(config, {
            timestamp: endTime,
            event: "usage",
            modelId,
            keyId,
            sessionKey,
            turnSeq: lf.turnSeq,
            userInput: lf.userQuery || undefined,
            upstreamUrl,
            stream: true,
            usage,
            extensionStats: ctx.preparedStats ?? undefined,
            routedFrom: ctx.routedFrom,
            spaceId,
            upstreamRequestId,
            ...logMeta,
          });
        } catch (logErr: unknown) {
          pipe.error("LOG_WRITE", logErr);
        }

        try {
          opikCreateLlmSpan(config, {
            traceId,
            projectName: keyId,
            name: modelId,
            startTime,
            endTime,
            inputMessages: flattenAnthropicMessagesForOpik(inputMessages, system),
            outputMessage: outputText ? { role: "assistant", content: outputText } : null,
            model: modelId,
            usage,
            tags: retried ? ["retry"] : undefined,
            forkProjectName: "request_log",
            forkTraceId,
            forkMetadata: {
              keyId,
              modelId,
              stream: true,
              upstreamUrl,
            },
          });
        } catch (opikErr: unknown) {
          pipe.error("OPIK_SPAN", opikErr);
        }

        // Langfuse: report this LLM call as a generation under the turn trace
        // The stream has no complete native assistant content array (tool_use blocks are fragmented
        // incremental events in the SSE); on debug, tool_use_count and stop_reason are put into metadata as a fallback.
        try {
          const streamDebugExtra = ctx.langfuseDebug
            ? {
                stream_tool_use_count: toolUseCount,
                stream_output_text_len: outputText.length,
              }
            : {};
          langfuseReportGeneration({
            traceId: lf.traceId,
            name: modelId,
            model: modelId,
            startTime,
            endTime,
            input: buildLangfuseInput(inputMessages, system, ctx.langfuseDebug),
            output: outputText ? { role: "assistant", content: outputText } : undefined,
            usage,
            traceName: lf.traceName,
            userId: lf.userId,
            sessionId: lf.sessionId,
            tags: lf.tags,
            traceInput: lf.userQuery || undefined,
            traceOutput: outputText ? { role: "assistant", content: outputText } : undefined,
            traceMetadata: {
              stream: true, retried, upstreamUrl, ...logMeta,
              ...ctx.debugMetadata, ...streamDebugExtra,
            },
            observationMetadata: {
              retried, ...logMeta,
              ...ctx.debugMetadata, ...streamDebugExtra,
            },
          });
        } catch (langfuseErr: unknown) {
          pipe.error("LANGFUSE_SPAN", langfuseErr);
        }
      }

      // CC routing: FORK/SIDEQUERY are not real conversation turns, skip L0/skill. Credit is still reported.
      const isMainDialog = ctx.requestKind === "main";

      // Wamf L0 write
      if (isMainDialog && ctx.wamfClient && isExtractionAllowed(ctx.config, "wamf-memory")) {
        // Streaming does not await (it would slow down closing the SSE stream); trackWrite + withL0Retry address the two loss lines:
        //   - trackWrite registers the in-flight promise in a global set; on SIGTERM index.ts
        //     flushPendingWrites as a fallback, avoiding L0 loss when the event loop exits without flushing during a pod rolling update.
        //   - withL0Retry retries with backoff 3 times (~3.5s), shielding wamf kernel blips / 5xx / network jitter.
        trackWrite(
          withL0Retry(() => recordWamfTurn(
            ctx.wamfClient!, ctx.wamfIdentity, ctx.wamfUserMessage,
            outputText || null,
          )).catch((err: unknown) => pipe.error("WAMF_L0", err))
        );
      } else if (isMainDialog && ctx.wamfClient) {
        logExtractionSkipped(ctx.config, "wamf-memory", ctx.sessionKeyForSkill);
      } else if (!isMainDialog) {
        console.log(`[cc-routing] skip L0 write (stream) for kind=${ctx.requestKind} session=${ctx.sessionKeyForSkill}`);
      }

      pipe.streamDone(Object.keys(usage).length > 0 ? usage : null);

      // Report the completed response to the extension. Fire-and-forget; the
      // client has already been served by this point.
      void notifyUpstreamResponse(
        ctx.config,
        {
          protocol: "anthropic",
          sessionKey: ctx.sessionKey,
          model: modelId,
          stream: true,
          turnSeq: lf.turnSeq,
          text: outputText,
          toolCalls: Array.from(toolUseAcc.values())
            .filter((v) => v.id && v.inputJson)
            .map((v) => ({ id: v.id, name: v.name, arguments: v.inputJson })),
          usage,
        },
        pipe,
      );

      // Internal usage instrumentation: each tool_use accumulated from the SSE stream emits one model_intent.
      // See docs/design/2026-08-03-internal-usage-telemetry-plan.md section 7.2 F.
      // session_key must use the same compositeKey (agentSource:sessionKey) as session_init_logs,
      // otherwise `session_key IN (init_sessions)` in the section 4.1 CTE will not match.
      if (toolUseAcc.size > 0) {
        // Output sorted by index (restoring the model's generation order); inputJson is the streamed accumulated partial_json
        const intents = Array.from(toolUseAcc.entries())
          .sort(([a], [b]) => a - b)
          .filter(([, v]) => v.name)
          .map(([, v]) => ({ name: v.name, arguments: v.inputJson || "{}" }));
        if (intents.length > 0) {
          emitModelIntentTelemetry({
            sessionKey: `${ctx.agentSource}:${ctx.sessionKey}`,
            turnSeq: ctx.lf.turnSeq,
            spaceId: ctx.spaceId,
            userId: ctx.keyId,
            agentSource: ctx.agentSource,
            intents,
          });
        }
      }

      // Skill extract trigger — after stream finalization.
      // Synchronous await: continue only after the store is persisted, ensuring the next turn reads the latest data across nodes.
      if (isMainDialog && isExtractionAllowed(ctx.config, "skill")) {
        await triggerSkillExtractIfReady({
          config: ctx.config,
          sessionKey: ctx.sessionKeyForSkill,
          agentSource: ctx.agentSource,
          sessionInfo: ctx.sessionInfo,
          inputMessages: ctx.inputMessages,
          assistantMessage: outputText
            ? { role: "assistant", content: outputText }
            : null,
          protocol: "anthropic",
          assetCapabilities: ctx.assetCapabilities,
          toolCallCountOverride: toolUseCount,
        });
      } else if (isMainDialog) {
        logExtractionSkipped(ctx.config, "skill", ctx.sessionKeyForSkill);
      } else {
        console.log(`[cc-routing] skip skill buffer (stream) for kind=${ctx.requestKind} session=${ctx.sessionKeyForSkill}`);
      }

      // Credit usage reporting for streaming responses.
      (ctx.skipCreditReport
        ? Promise.resolve({ attempted: false, ok: false })
        : tryReportCreditFromPath(
            ctx.config.creditReport,
            ctx.requestPath,
            usage,
            ctx.config.creditPricing,
            ctx.modelId,
            ctx.upstreamUrl,
            "usage",
          ))
        .then((outcome) => {
          if (outcome.attempted && !outcome.ok) {
            pipe.error("CREDIT_REPORT", `[stream] ${outcome.errorMessage ?? "unknown"}`);
            // Persist failed report as a raw record (reuses existing usage_raw table).
            writeFailedReportRaw(
              {
                timestamp: new Date().toISOString(),
                event: "usage",
                modelId: ctx.modelId,
                keyId: ctx.keyId,
                sessionKey: ctx.sessionKey,
                upstreamUrl: ctx.upstreamUrl,
                stream: true,
                usage,
                routedFrom: ctx.routedFrom,
                upstreamRequestId: ctx.upstreamRequestId,
                pricingConfig: ctx.config.creditPricing,
              },
              outcome.errorMessage ?? "unknown",
            );
          }
        })
        .catch((err: unknown) => pipe.error("CREDIT_REPORT", err));
    }

    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuf += decoder.decode(value, { stream: true });

        const parts = sseBuf.split("\n\n");
        sseBuf = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.split("\n");
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              dataStr = line.slice(6);
            } else if (line.startsWith("data:")) {
              dataStr = line.slice(5);
            }
          }

          if (!dataStr || dataStr === "[DONE]") continue;

          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            const evtType = evt.type as string;

            if (evtType === "message_start") {
              const message = evt.message as Record<string, unknown> | undefined;
              if (message?.usage) {
                Object.assign(usage, message.usage as Record<string, unknown>);
              }
            } else if (evtType === "message_delta") {
              if (evt.usage) {
                Object.assign(usage, evt.usage as Record<string, unknown>);
              }
            } else if (evtType === "content_block_delta") {
              const delta = evt.delta as Record<string, unknown> | undefined;
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                outputText += delta.text;
              } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                // Accumulate into the corresponding tool_use block (by index)
                try {
                  const idx = evt.index as number | undefined;
                  if (typeof idx === "number") {
                    const acc = toolUseAcc.get(idx);
                    if (acc) acc.inputJson += delta.partial_json;
                  }
                } catch {
                  // ignore - instrumentation-level problems do not block the main path
                }
              }
            } else if (evtType === "content_block_start") {
              const block = evt.content_block as Record<string, unknown> | undefined;
              if (block?.type === "tool_use") {
                toolUseCount++;
                try {
                  const name = (block.name as string) ?? "";
                  const idx = evt.index as number | undefined;
                  if (name && typeof idx === "number") {
                    toolUseAcc.set(idx, { id: (block.id as string) ?? "", name, inputJson: "" });
                  }
                } catch {
                  // ignore - accumulation failure does not affect the main path
                }
              }
            }
          } catch {
            // ignore malformed SSE data
          }
        }
      }

      // Drain remaining buffer
      if (sseBuf.trim()) {
        const lines = sseBuf.split("\n");
        let dataStr = "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            dataStr = line.slice(6);
          }
        }
        if (dataStr && dataStr !== "[DONE]") {
          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            if (evt.type === "message_delta" && evt.usage) {
              Object.assign(usage, evt.usage as Record<string, unknown>);
            }
          } catch {
            // ignore
          }
        }
      }
    } catch (err: unknown) {
      pipe.error("STREAM", err);
    }

    await completeStream();
  })().catch((err: unknown) => {
    pipe.error("STREAM_CONSUME", err);
  });
}
