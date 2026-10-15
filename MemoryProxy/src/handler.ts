/** Core request handler: intercept → forward → parse usage → log. */

import type { Context } from "hono";
import { createHash } from "node:crypto";
import { writeLog, createPipeline } from "./logger.js";
import {
  apiKeyToKeyId,
  extractBearerToken,
  opikCreateLlmSpan,
  opikCreateTrace,
  opikUpdateTrace,
  uuidv7,
} from "./opik.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "./langfuse.js";
import {
  buildLangfuseInputChat,
  buildRequestDebugMetadata,
} from "./common/langfuse-debug.js";
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
import { opencodeAdapter } from "./agent-adapters/opencode.js";
import { trackWrite, withL0Retry } from "./wamf/pending-writes.js";
import type { WamfIdentity, WamfMessage } from "./wamf/types.js";
import { triggerSkillExtractIfReady } from "./skill/handler-glue.js";
import { emitModelIntentTelemetry } from "./session/model-intent-telemetry.js";
import { isExtractionAllowed, logExtractionSkipped } from "./extraction-gate.js";
import {
  enforceRateLimit,
  isRateLimitExceededError,
  recordInputTokenUsage,
} from "./rate-limit/guard.js";
import { INTERNAL_REQUEST_HEADERS } from "./internal-headers.js";

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
 * Flatten messages into Opik-friendly chat messages (no truncation).
 */
export function flattenMessagesForOpik(messages: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;

    if (typeof content === "string") {
      result.push(msg);
      continue;
    }

    if (!Array.isArray(content)) {
      if (role === "assistant" && Array.isArray(m.tool_calls)) {
        if (typeof content === "string" && content) {
          result.push({ role: "assistant", content });
        }
        for (const tc of m.tool_calls as unknown[]) {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          let argsStr = "";
          if (fn?.arguments) {
            argsStr = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
          }
          result.push({
            role: "assistant",
            content: JSON.stringify({ tool_call_id: t.id, tool_name: fn?.name ?? "unknown", arguments: argsStr }, null, 2),
          });
        }
        continue;
      }
      result.push(msg);
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
          textParts.push(`[thinking] ${b.thinking as string}`);
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
      const topLevelToolCalls = m.tool_calls;
      if (Array.isArray(topLevelToolCalls)) {
        for (const tc of topLevelToolCalls) {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          let argsStr = "";
          if (fn?.arguments) {
            argsStr = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
          }
          result.push({
            role: "assistant",
            content: JSON.stringify({ tool_call_id: t.id, tool_name: fn?.name ?? "unknown", arguments: argsStr }, null, 2),
          });
        }
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

/** Debug dump file names come from client headers: keep them inside the dump dir. */
function debugFileSafe(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "nosid";
}

/** Debug dumps must never write credentials to disk. */
function redactDebugHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = /^(authorization|x-api-key|x-wamf-user-key|x-wamf-user-token|cookie|proxy-authorization|x-bridge-sig)$/i.test(k) ? "[redacted]" : v;
  }
  return out;
}

const SKIP_REQUEST_HEADERS = new Set([
  ...INTERNAL_REQUEST_HEADERS,
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
]);

/** Extract usage object from a block of OpenAI SSE text. */
export function extractSseUsage(sseText: string): Record<string, unknown> | null {
  let lastUsage: Record<string, unknown> | null = null;

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;

    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      if (evt.usage && typeof evt.usage === "object") {
        lastUsage = evt.usage as Record<string, unknown>;
      }
    } catch {
      // ignore malformed SSE lines
    }
  }

  return lastUsage;
}

/**
 * Build upstream body from original body + cost guard overrides.
 * The host does NOT branch on routing — it just applies overrides if present.
 */
function buildUpstreamBody(
  body: Record<string, unknown>,
  target: ForwardTarget,
): Record<string, unknown> {
  let upstreamBody = body;
  if (target.bodyOverrides) {
    upstreamBody = { ...body, ...target.bodyOverrides };
  }
  return upstreamBody;
}

/**
 * Build upstream headers from request headers + routing auth overrides.
 * If config.upstream.apiKey is set, it overrides the request's Authorization header
 * only for the default route (not alternate model route).
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

  // `effectiveApiKey` is pre-resolved by the caller — see the resolveEffective
  // block near the call site. Non-empty → inject as server-side Bearer;
  // empty/undefined → passthrough (client's own Authorization survives).
  // cost-guard's `target.authHeaders` still gets to override everything.
  if (effectiveApiKey && !target.authHeaders) {
    headers["authorization"] = `Bearer ${effectiveApiKey}`;
  }

  if (target.authHeaders) {
    for (const [k, v] of Object.entries(target.authHeaders)) {
      headers[k] = v;
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

  // ── Optional full-body dump (dev only) ───────────────────────────────
  // Enable: PROXY_DEBUG_DUMP_BODY=/tmp/proxy-outbound
  // Writes one file per forward, to help troubleshoot upstream 400s.
  if (process.env.PROXY_DEBUG_DUMP_BODY) {
    try {
      const fs = await import("node:fs");
      const dir = process.env.PROXY_DEBUG_DUMP_BODY;
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const fn = `${dir}/${ts}-${debugFileSafe(sessionKeyForDebug ?? "nosid")}.json`;
      fs.writeFileSync(fn, JSON.stringify({ url: target.url, headers: redactDebugHeaders(upstreamHeaders), body: upstreamBody }, null, 2));
      console.log(`[dump-body] wrote ${fn}`);
    } catch (e) {
      console.log(`[dump-body] error: ${(e as Error).message}`);
    }
  }

  // ── Optional outbound body md5 debug log (see anthropicHandler.ts) ─────
  // The openai protocol side has no cache_control concept; only two md5s are computed: sys + the whole messages array.
  if (process.env.PROXY_DEBUG_DUMP_OUTBOUND_MD5) {
    try {
      const msgs = (upstreamBody as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
      const sysMsg = msgs.find((m) => m.role === "system");
      const sysStr = typeof sysMsg?.content === "string"
        ? sysMsg.content
        : sysMsg?.content ? JSON.stringify(sysMsg.content) : "";
      const msgsFullStr = JSON.stringify(msgs);
      const sysMd5 = createHash("md5").update(sysStr).digest("hex").slice(0, 12);
      const msgsFullMd5 = createHash("md5").update(msgsFullStr).digest("hex").slice(0, 12);
      // eslint-disable-next-line no-console
      console.log(
        `[outbound-md5] session=${sessionKeyForDebug ?? "?"} protocol=openai sysBytes=${sysStr.length} sysMd5=${sysMd5} msgsCount=${msgs.length} msgsFullBytes=${msgsFullStr.length} msgsFullMd5=${msgsFullMd5}`,
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`[outbound-md5] session=${sessionKeyForDebug ?? "?"} <error: ${(e as Error).message}>`);
    }
  }

  const fetchOpts: RequestInit = {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(upstreamBody),
  };
  if (forwardTimeoutMs > 0) {
    fetchOpts.signal = AbortSignal.timeout(forwardTimeoutMs);
  }

  if (rateLimitContext) {
    await enforceRateLimit({
      config: rateLimitContext.config,
      instanceId: rateLimitContext.instanceId,
      modelId: target.model,
      protocol: "openai",
    });
  }
  try {
    upstreamResp = await fetch(target.url, fetchOpts);
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
    pipe.info("RETRY", `Routed model failed (${reason}), retryUrl=${target.retryTarget.url} model=${target.retryTarget.model}`);

    const retryBody = { ...originalBody, model: target.retryTarget.model };
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
          protocol: "openai",
        });
      }
      const retryFetchOpts: RequestInit = {
        method: "POST",
        headers: retryHeaders,
        body: JSON.stringify(retryBody),
      };
      if (forwardTimeoutMs > 0) {
        retryFetchOpts.signal = AbortSignal.timeout(forwardTimeoutMs);
      }
      upstreamResp = await fetch(target.retryTarget.url, retryFetchOpts);
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

/** Main handler for POST /v1/chat/completions (OpenAI compat). */
export async function handleChatCompletions(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const startTime = new Date().toISOString();
  const traceId = uuidv7();

  // ── Early auth ──────────────────────────────────────────────────────────
  // Verify BEFORE parsing the body so a rejected caller never triggers body
  // parsing or the alias-gate. `earlyVerify.userId` is reused later for
  // both the systemUser short-circuit and the normal pipeline.
  const earlyAuthHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const earlyApiKey = extractBearerToken(earlyAuthHeader);
  const earlySpaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const earlyVerify = await verifyUserKey(earlyApiKey, earlySpaceId);
  if (earlyVerify.rejected) {
    return c.json({ error: `Authentication failed: ${earlyVerify.rejectReason ?? "unknown"}` }, 401);
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

  // ── Optional inbound body dump (dev only) ─────────────────────────
  // Enable: PROXY_DEBUG_DUMP_INBOUND=/tmp/proxy-inbound
  // Writes one file per inbound request, to help troubleshoot whether the client carried a certain field when replaying.
  if (process.env.PROXY_DEBUG_DUMP_INBOUND) {
    try {
      const fs = await import("node:fs");
      const dir = process.env.PROXY_DEBUG_DUMP_INBOUND;
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const hdrs: Record<string, string> = {};
      for (const [k, v] of c.req.raw.headers.entries()) hdrs[k] = v;
      const sid = hdrs["x-deepseek-harness-session-id"] ?? hdrs["x-session-id"] ?? "nosid";
      const fn = `${dir}/${ts}-${debugFileSafe(sid)}.json`;
      fs.writeFileSync(fn, JSON.stringify({ path: c.req.path, headers: redactDebugHeaders(hdrs), body }, null, 2));
      console.log(`[dump-inbound] wrote ${fn}`);
    } catch (e) {
      console.log(`[dump-inbound] error: ${(e as Error).message}`);
    }
  }

  // -- DEBUG: dump tools/instructions/metadata (Phase 1 workbuddy research) --
  // Only enabled when sessionInit.debugVerboseLogging=true; off by default in production.
  if (config.sessionInit?.debugVerboseLogging) {
  try {
    const dbgPath = c.req.path;
    if (dbgPath.includes("/workbuddy/")) {
      // Keep only slim fields (do not dump the raw tools array, to avoid being truncated when too long)
      const dumpKeys = [
        "tool_choice",
        "toolset",
        "tool_config",
        "response_format",
        "metadata",
        "client_metadata",
      ];
      const dump: Record<string, unknown> = { path: dbgPath, model: body.model };
      for (const k of dumpKeys) {
        if (k in body) dump[k] = (body as Record<string, unknown>)[k];
      }
      const toolsField = (body as Record<string, unknown>).tools;
      if (Array.isArray(toolsField)) {
        dump.tools_summary = toolsField.map((t: unknown) => {
          const tt = t as Record<string, unknown>;
          const fn = (tt as any).function ?? {};
          const paramProps = fn.parameters?.properties;
          return {
            type: tt.type,
            name: (tt as any).name ?? fn.name,
            description:
              typeof (tt as any).description === "string"
                ? String((tt as any).description).slice(0, 400)
                : typeof fn.description === "string"
                  ? String(fn.description).slice(0, 400)
                  : undefined,
            param_keys: paramProps && typeof paramProps === "object"
              ? Object.keys(paramProps)
              : undefined,
          };
        });
      }
      // If messages[0] is system, dump it too (it may declare tool usage)
      const msgs = (body as Record<string, unknown>).messages;
      if (Array.isArray(msgs) && msgs.length > 0) {
        const first = msgs[0] as Record<string, unknown>;
        if (first?.role === "system") {
          const content = typeof first.content === "string"
            ? first.content
            : JSON.stringify(first.content);
          dump.system_head = content.slice(0, 2000);
          dump.system_length = content.length;
        }
        dump.messages_count = msgs.length;
      }
      console.log(
        `[wb-tools-dump] path=${dbgPath} tools_count=${Array.isArray(toolsField) ? toolsField.length : 0}`,
      );
      console.log(`[wb-tools-dump-json] ${JSON.stringify(dump).slice(0, 60000)}`);

      // Extra: separately dump the full schema of AskUserQuestion (key research for Phase 1)
      if (Array.isArray(toolsField)) {
        const askTool = toolsField.find((t: unknown) => {
          const tt = t as any;
          const name = tt?.name ?? tt?.function?.name;
          return name === "AskUserQuestion";
        });
        if (askTool) {
          console.log(
            `[wb-ask-user-schema] ${JSON.stringify(askTool).slice(0, 20000)}`,
          );
        }
      }
    }
  } catch (e) {
    console.log(`[wb-tools-dump] error: ${String(e)}`);
  }
  } // debugVerboseLogging gate

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
  // instance carried any Option-2/3 conversation config (fix: 64e989a0 →
  // this file's next revision).
  const _earlyAgent = c.req.path.split("/").filter(Boolean)[0] ?? undefined;
  const _earlyInstanceConfigs = await getInstanceUpstreamConfigs(config.coreSkill, earlySpaceId);
  const _earlyConvCfg = resolveUpstreamConfig(_earlyInstanceConfigs, _earlyAgent, "conversation");
  const _earlyExtractCfg = resolveUpstreamConfig(_earlyInstanceConfigs, _earlyAgent, "extraction");
  const _earlySysMatch = hasSystemUsers() ? matchSystemUserByUserId(earlyVerify.userId) : null;
  const _isCustomUpstream = _earlySysMatch !== null
    ? shouldOverride(_earlyExtractCfg)
    : shouldOverride(_earlyConvCfg);

  if (!_isCustomUpstream && !isModelInPricing(config.creditPricing, requestedModel)) {
    return c.json(
      {
        error: {
          message: `Model '${requestedModel}' is not a registered display name in the credit pricing table`,
          type: "invalid_request_error",
          code: "model_not_found",
        },
      },
      400,
    );
  }

  // ── Model alias: rewrite client-facing modelName → real model_id ──────────
  // Only for official mode. Custom upstream keeps the original model name.
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

  // [debug] Log last 3 message roles and content types to diagnose session-init issues
  if (config.sessionInit?.enabled && messages.length > 2) {
    const tail = messages.slice(-3);
    const summary = tail.map((m: any, idx: number) => {
      const role = m.role;
      const ct = m.content;
      const contentType = typeof ct === "string" ? `string(${ct.slice(0, 80)})` :
        Array.isArray(ct) ? `array[${ct.map((b: any) => b.type).join(",")}]` :
        ct === null ? "null" : typeof ct;
      const tcid = m.tool_call_id;
      const tcs = m.tool_calls ? `tool_calls[${m.tool_calls.map((t: any) => t.id).join(",")}]` : "";
      return `[${idx}]role=${role} content=${contentType} tool_call_id=${tcid} ${tcs}`;
    }).join(" | ");
    console.log(`[session-init-debug] raw-tail msgs=${messages.length} ${summary}`);
  }

  // ── Resolve agent source from URL path (e.g. /claude-code/v1/chat/completions) ──
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
  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const apiKey = extractBearerToken(authHeader);
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
  let userId = earlyVerify.userId
    || c.req.header("x-user-id")
    || c.req.header("x-cb-user-id")
    || c.req.header("x-wamf-user-token")
    || "";
  // DEBUG override: the tokenhub-uid sent by the client differs from the kernel-uid (common in local
  // integration); after configuring sessionInit.debugForceUserId, replace it with the real kernel user_id,
  // so the CB state machine can fetch assets through kernel /team/list and pop up the form normally.
  const debugForceUserId = config.sessionInit?.debugForceUserId;
  if (debugForceUserId) {
    console.log(
      `[handler] DEBUG override userId ${userId || "<empty>"} → ${debugForceUserId}`,
    );
    userId = debugForceUserId;
  }
  if (userId) keyId = userId;

  // Activate Redis storage early — must run BEFORE session init.
  if (config.redis?.enabled) {
    const { getInjectionPipeline } = await import("./injection/index.js");
    getInjectionPipeline(config);
  }

  // ── Request kind classification (auxiliary detection for OpenAI-chat clients) ──
  // dsh (deepseek-harness) carries the `x-deepseek-harness-compact: 1` header on compaction requests,
  // and title-gen is identified by three body features together. Such requests **must not** go through the session-init form,
  // nor trigger mem interception / L0 writes / skill extraction - they should be passed straight through upstream.
  // The codebuddy / claude-code client adapters' classifyRequest always returns "main", so behavior is unchanged.
  const { resolveAgentAdapter } = await import("./agent-adapters/index.js");
  const _adapter = resolveAgentAdapter(agentSource);
  const _requestKind = _adapter.classifyRequest(body as Record<string, unknown>, c.req.path, lcHeaders);
  const isAuxiliary = _requestKind === "auxiliary";
  if (isAuxiliary) {
    console.log(`[request-classify] session=${sessionKey} agent=${agentSource} → auxiliary (skip session-init/mem/injection/L0/skill)`);
  }

  // ── dsh (deepseek-harness) CLI headless / no-preset bypass ──────────────
  // When the dsh client is in a headless bundle or has no ask-user preset mounted, body.tools
  // does not contain the `ask_user_question` tool. If the proxy stuffs in a fake `ask_user_question` tool_call,
  // the dsh agent-loop validates it as an unknown tool and throws. In this case directly bypass
  // session-init instead of popping up a form - forcing a form in a no-UI scenario is pointless.
  //
  // Decision: agentSource=dsh and body.tools is non-empty and does not contain ask_user_question.
  // (An empty tools array means pure conversation/aux, no fallback needed; if tools contains ask_user_question
  // a preset has mounted the UI tool, so go through the form normally.)
  //
  // NOTE(opencode): the opencode CLI likewise does not support the virtual ask_followup_question tool,
  // but takes a separate header-driven session-init branch (see the opencode-specific block below),
  // so it does not need the headless bypass here - opencode can take plain-text mem command responses,
  // and also needs injection / L0 / skill extraction; it just cannot pop up a form.
  const _dshHeadless = agentSource === "dsh" && (() => {
    const tools = (body as { tools?: unknown }).tools;
    if (!Array.isArray(tools) || tools.length === 0) return false;
    return !tools.some((t) => {
      const fn = (t as { function?: { name?: string }; name?: string })?.function;
      const n = fn?.name ?? (t as { name?: string })?.name;
      return n === "ask_user_question";
    });
  })();
  if (_dshHeadless) {
    console.log(`[request-classify] session=${sessionKey} agent=dsh headless/no-preset (no ask_user_question tool) → bypass session-init, direct passthrough`);
  }

  // ── Client capabilities detection ─────────────────────────────────────────
  // Probe whether the client "can respond to a fake ask tool_call initiated by the proxy".
  //
  // Currently only workbuddy gets a substantive decision: the new workbuddy official tool set dropped
  // AskUserQuestion (only 20 tools remain); if the proxy keeps sending tool_calls the client would
  // accept them but not know how to render them -> stuck in pending. In this case it must degrade to text mode
  // (content chunk + markdown + plain-text parsing).
  //
  // All other clients (codebuddy / claude-code / dsh / codex / opencode / hermes /
  // openclaw) always have askUserQuestion=true, keeping existing behavior unchanged. The dsh headless scenario takes the
  // separate _dshHeadless bypass branch above and is not affected by this probe.
  const { detectClientCapabilities } = await import("./session/client-capabilities.js");
  const _capabilities = detectClientCapabilities(agentSource, body);
  if (agentSource === "workbuddy" && !_capabilities.askUserQuestion) {
    console.log(`[request-classify] session=${sessionKey} agent=workbuddy no-AskUserQuestion tool → text-mode session-init`);
  }

  // ── mem:session-reset pre-hook ──
  // hermes / openclaw pre-select identity via headers, and dsh headless has no ask_user_question tool -
  // none of the three has an interactive form UI to pop up, so after reset the session would be stuck forever in pending_asset_confirm.
  // Directly return the "not supported" text.
  const _headerOnlyAgents = new Set(["hermes", "openclaw"]);
  const _noFormAgent = _headerOnlyAgents.has(agentSource) || _dshHeadless;
  if (!isAuxiliary && _noFormAgent) {
    const { isSessionResetCommand } = await import("./mem-command/pre-intercept.js");
    if (isSessionResetCommand(body as Record<string, unknown>, agentSource)) {
      const { buildMemResponse } = await import("./mem-command/response-builder.js");
      console.log(`[mem-command:pre] session-reset unsupported for agent=${agentSource} dshHeadless=${_dshHeadless}`);
      const msg = _headerOnlyAgents.has(agentSource)
        ? `⚠️ mem:session-reset is not supported for the ${agentSource} client.\n\n`
          + `${agentSource} preselects its identity through the x-team-id / x-agent-id / x-task-id headers and has no interactive form.\n`
          + `Change those headers in the client configuration to switch Team / Agent / Task.`
        : "⚠️ mem:session-reset is not supported in dsh headless mode.\n\n"
          + "In headless / no-preset mode the dsh client has no ask_user_question tool, so the asset selection form cannot open.\n"
          + "Use it in a dsh environment with the ask_user_question preset.";
      return buildMemResponse(msg, {
        protocol: "openai",
        stream: isStream,
        requestId: `mem-reset-unsupported-${Date.now()}`,
      });
    }
  }
  if (!isAuxiliary && !_dshHeadless && !_headerOnlyAgents.has(agentSource)) {
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
        // Conversation fragments accumulated by the old agent before reset may not have reached the threshold yet; without a flush they would be lost permanently.
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
        console.log(`[mem-command:pre] session-reset session=${sessionKey} → falling through to pop form`);
      }
    }
  }

  // ── Session Init (before injection pipeline) ─────────────────────────────
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("./injection/types.js").AssetCapabilityFlags | undefined;
  let injectedSkipped = !conversationId || isAuxiliary || _dshHeadless;
  let sessionJustRegistered = false;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamName?: string; teamId: string; taskName?: string | null; bypassed?: boolean } | null = null;
  console.log(`[injection-debug] conversationId=${conversationId} sessionKey=${sessionKey} userId=${userId} agentSource=${agentSource} kind=${_requestKind} dshHeadless=${_dshHeadless} sessionInitEnabled=${config.sessionInit?.enabled} injectionEnabled=${config.injection?.enabled} injectors=${JSON.stringify(config.injection?.injectors)} injectedSkipped=${injectedSkipped} spaceId=${spaceId}`);
  if (config.sessionInit?.enabled && conversationId && !isAuxiliary && !_dshHeadless) {
    try {
      const { getSessionStore, handleSessionInit, parsePresetIdentity } = await import("./session/index.js");
      const { getMetadataClient } = await import("./meta/client.js");
      const store = getSessionStore();
      // kernel /v3/meta/* uses x-wamf-user-key auth and needs an sk-mem-* user key.
      // Priority: client Authorization bearer > config.wamf.apiKey.
      // Notes:
      //   - Real clients such as workbuddy / codebuddy pass a valid
      //     sk-mem-* user key (shaped like ck_ft1xxx.yyy) in Authorization, from which verifyUserKey can resolve the userId.
      //   - config.wamf.apiKey is often set to a placeholder (e.g. "local") in local/test environments;
      //     if it overrode the client's real key, the kernel would return 401 invalid_user_key,
      //     session-init would bypass directly, and the frontend form would never pop up.
      //   - Only when the client provides no apiKey (e.g. some internal scripts) does it fall back to config.
      // Aligned with the kernelUserKey logic in workbuddyHandler.ts (client first there as well).
      const kernelUserKey = apiKey || config.wamf?.apiKey || "";
      const metadataClient = getMetadataClient(config.coreSkill, spaceId, kernelUserKey);
      const presetIdentity = parsePresetIdentity(config.sessionInit, lcHeaders);

      // ── Session Recovery: try L2b binding before falling into session-init form ──
      const compositeKey = `${agentSource}:${sessionKey}`;
      // Identity for repo/binding writes. When userId is missing, fall back to the `anonymous`
      // composite key, ensuring key path segments are valid (`u=anonymous` uses a separate namespace, naturally isolated from
      // requests that have a userId). See section 4.4 boundary handling.
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
      // Record whether this turn actually went through the handleSessionInit state machine (see the comment at the symmetric position in
      // anthropicHandler). sessionJustRegistered = wentThrough && justRegistered, covering
      // both terminal transitions: normal registration + bypass (the bypass branch now also carries justRegistered=true), so that the
      // mem-command interception block can fish out the user's very first
      // mem: command via the checkFirst fallback in the turn of the bypass transition and return the "uninitialized" text, avoiding passing it through to the upstream LLM for a hallucinated answer.
      // justRegistered=true on the L2b recovery branch is only a prewarm signal; on the recovered branch
      // wentThroughSessionInitStateMachine=false filters it out naturally, so it does not enter sessionJustRegistered.
      let wentThroughSessionInitStateMachine = false;
      // The recovery hit source decides whether prewarm is needed:
      //   - l1 / l2a: this pod's memory + storage are both hot - hook-cache is probably there too, skip prewarm;
      //   - l2b / history-scan: cross-pod cold start / rebuilt from binding - hook-cache may have expired and needs a refill.
      // The previous unconditional `justRegistered: true` made every normal turn of an L1 hit terminal run the
      // skill/knowledge/wamf-memory network requests (~2s + 3 external calls), and the probability of
      // the first knowledge timeout was amplified repeatedly. Here it is decided precisely by recovery source.
      const needsPrewarm =
        recovered?.__recoverySource === "l2b" ||
        recovered?.__recoverySource === "history-scan";
      if (recovered && isTerminalState) {
        // Recovery hit: keep original messages, only re-inject <session_context>
        // so this turn's system message carries agent/task context again.
        // The user's conversation is always kept as is, including the session_init form interaction - nothing is deleted.
        const { injectSessionContextWithToggles } = await import("./session/context-injector.js");
        const inMsgs = (body.messages as Array<Record<string, unknown>>) ?? [];
        const outMsgs = recovered.bypassed
          ? inMsgs
          : injectSessionContextWithToggles(
              inMsgs,
              recovered.agentDetail ?? null,
              recovered.taskDetail ?? null,
              config.sessionInit,
              sessionKey,
            );
        initResult = {
          intercepted: false,
          messages: outMsgs as Record<string, unknown>[],
          sessionInfo: recovered.sessionInfo,
          agentDetail: recovered.agentDetail,
          taskDetail: recovered.taskDetail,
          bypassed: recovered.bypassed,
          justRegistered: needsPrewarm, // only triggers prewarm on L2b / history-scan recovery
        };
      } else {
        // opencode takes the generic else branch fully isomorphic to codebuddy (reusing handleSessionInit +
        // the ask_followup_question form). Verifies the real reaction of the opencode client to unknown tool_calls.
        wentThroughSessionInitStateMachine = true;
        // Detect whether the client's ask_followup_question schema declares the questions field as an array.
        // CB v1.106+ declares it as an array and does a type check; old versions have no schema or questions has no type declaration.
        let questionsAsArray = true; // default to the new version
        const clientTools = Array.isArray(body.tools) ? body.tools as unknown[] : [];
        const afqTool = clientTools.find((t: any) =>
          t?.function?.name === "ask_followup_question" || t?.name === "ask_followup_question"
        ) as Record<string, unknown> | undefined;
        if (afqTool) {
          const params = (afqTool as any).function?.parameters ?? (afqTool as any).parameters;
          const qType = params?.properties?.questions?.type;
          questionsAsArray = qType === "array";
        } else if (clientTools.length === 0) {
          // No tools definition (very old client or non-CB agent), conservatively use string
          questionsAsArray = false;
        }
        initResult = await handleSessionInit(
          sessionKey,
          userId || null,
          body.messages as Array<Record<string, unknown>> ?? [],
          config.sessionInit,
          store,
          { stream: isStream, modelId: modelId as string, protocol: "openai", questionsAsArray, capabilities: _capabilities },
          agentSource,
          metadataClient,
          kernelUserKey,
          spaceId,
          presetIdentity,
        );
      }

      // Case 1: Fake form returned → must not forward
      if (initResult.intercepted && initResult.response) {
        return initResult.response;
      }

      console.log(`[injection-debug] initResult session=${sessionKey} intercepted=${initResult.intercepted} bypassed=${initResult.bypassed} justRegistered=${initResult.justRegistered} resetFlow=${(initResult as any).resetFlow} hasSessionInfo=${!!initResult.sessionInfo} hasAgentDetail=${!!initResult.agentDetail}`);
      // See the symmetric position in anthropicHandler: only inherit when actually going through the sessionInit state machine.
      if (wentThroughSessionInitStateMachine && initResult.justRegistered) sessionJustRegistered = true;

      // Case 1.5: Bypass path → skip ALL injection hooks
      if (initResult.bypassed) {
        injectedSkipped = true;
        console.log(`[session-init] session=${sessionKey} bypassed → skipping all injection`);
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
            userKey: apiKey || null,
            timeoutMs: config.wamf.memory.timeoutMs,
          });
          console.log(`[asset-capability] user=${(initResult.sessionInfo as { user_id?: string }).user_id ?? "-"} flags=${JSON.stringify(assetCapabilities)}`);
        } catch (err) {
          console.warn(`[asset-capability] resolve failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Restore space_id from the URL BEFORE prewarm. Recovery paths and
      // legacy sessions can hydrate a SessionInfo whose `space_id` is empty;
      // prewarm calls (skill-injector, memory-injector) route to the correct
      // kernel tenant via this field, so a missing value at this point
      // silently poisons the prewarm cache with empty results.
      // See BUG-skill-injection-multinode.md §3.3(B).
      const { restoreSessionSpaceId } = await import("./session/restore-space-id.js");
      restoreSessionSpaceId(
        initResult.sessionInfo as Record<string, unknown> | null | undefined,
        spaceId,
      );

      // Prewarm pre-short-circuit: a turn hit by mem-command neither forwards upstream nor consumes
      // hook-cache; prewarming as usual would waste 2-3s + 3 network requests (the knowledge
      // 33% timeout would be amplified). Here a pure string parse is done first (<1ms, no side effects),
      // and on a hit memCommandPending is set so the prewarm branch short-circuits; the actual mem-command execution
      // still happens at the original position below, with L0 write / skill extract / langfuse all kept.
      //
      // fallback semantics: sessionJustRegistered is already settled here (see L786 above),
      // so the checkFirst scenario can safely reuse it.
      let memCommandPending = false;
      if (!isAuxiliary && !_dshHeadless) {
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
            "[mem-command] pre-prewarm peek failed:",
            err instanceof Error ? err.message : String(err),
          );
          // A peek failure does not block the main path; degrade to the original behavior (normal prewarm).
        }
      }

      // Case 2 success → await prewarm so the first-turn pipeline always
      // hits the cache. A fire-and-forget void() here caused the bug where
      // the pipeline ran before the cache was populated, silently injecting
      // zero blocks for the entire first turn.
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
          await mod.prewarmFromConfig(config, {
            keyId: sessionKey,
            userId: userId || "anonymous",
            agentSource,
            spaceId,
            sessionInfo: initResult.sessionInfo as import("./session/types.js").SessionInfo,
            agentDetail: initResult.agentDetail ?? null,
            taskDetail: initResult.taskDetail ?? null,
            assetCapabilities,
            callerUserKey: apiKey ?? undefined,
          }, { clearBefore: true });
        } catch (err) {
          console.warn(
            "[hook-cache] handler prewarm error:",
            err instanceof Error ? err.message : String(err),
          );
          // Don't re-throw: the pipeline's resolveHookBlocks has its own
          // cache-miss → execute() fallback as a safety net (see pipeline.ts).
        }
      }

      // Case 2: Messages were cleaned → update body
      if (initResult.messages) {
        body = { ...body, messages: initResult.messages };
        messages = initResult.messages as unknown[];
      }

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      // Belt-and-suspenders: also restore on the local `sessionInfo` alias.
      // In practice this is the same object reference as
      // `initResult.sessionInfo` (already restored above), but the second
      // call is a no-op and guards against future refactors that copy
      // the object between these two lines.
      restoreSessionSpaceId(sessionInfo, spaceId);

      // Record the resetFlow info for the outer scope, used to return the confirmation response after the session-init block ends
      if (initResult.resetFlow && initResult.justRegistered && !initResult.bypassed) {
        _resetFlowResult = {
          agentName: initResult.agentDetail?.name ?? "unknown",
          // The agentIdShort field name keeps the historical name, but here it **stores the full agent_id** (e.g. agt-1celthr7yn).
          // Previously slice(-8) kept only the last 8 chars and showed a truncated string like "elthr7yn", which users could not understand at all,
          // the same root as the team truncation problem. The agent id itself is short, so showing it in full is harmless and more readable.
          agentIdShort: (initResult.sessionInfo as Record<string, unknown>)?.agent_id
            ? String((initResult.sessionInfo as Record<string, unknown>).agent_id) : "",
          // teamName comes from session-init (cachedTeams[selected].team_name);
          // teamId stores the **full** team_id (e.g. team-wyuyb7sion) - previously slice(-8)
          // showed "uyb7sion", which users could not understand, and the fallback was even worse when teamName was empty.
          teamName: initResult.teamName ?? undefined,
          teamId: (initResult.sessionInfo as Record<string, unknown>)?.team_id
            ? String((initResult.sessionInfo as Record<string, unknown>).team_id) : "",
          taskName: initResult.taskDetail?.name,
        };
      }
    } catch (err: unknown) {
      console.error("[session-init] Error in handleSessionInit:", err instanceof Error ? err.message : String(err));
      sessionInfo = undefined;
      injectedSkipped = true;
    }
  }

  // -- mem:session-reset completion confirmation -------------------------------------------------
  if (_resetFlowResult) {
    const { agentName, agentIdShort, teamName, teamId, taskName, bypassed } = _resetFlowResult;
    // Team line assembly: prefer "team_name (team_id)"; when team_name was not found, at least fall back to the full team_id;
    // when both are empty omit the whole line. Avoids truncated strings like "Team: uyb7sion".
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
    console.log(`[mem-command:session-reset] completed: bypassed=${!!bypassed} agent=${agentName} (${agentIdShort}) team=${teamName ?? "-"} (${teamId || "-"})`);
    return buildMemResponse(text, {
      protocol: "openai",
      stream: isStream,
      requestId: `mem-reset-${Date.now()}`,
    });
  }

  // ── mem: command intercept ────────────────────────────────────────────────
  // Position aligned with anthropicHandler.ts:847 - after session init completes and before injection.
  // On a hit: execute the command -> write L0 -> trigger skill extract -> forge an OpenAI response and return, skipping
  // injection (does not break the KV cache) and upstream forwarding (zero token consumption). Command interception is always enabled;
  // unknown commands get a fallback hint from KNOWN_COMMANDS inside executeMemCommand.
  //
  // Pitfall solved: CodeBuddy hits this handler via the OpenAI protocol, and previously the mem-command intercept
  // was only hooked into anthropicHandler, so a CB user sending `mem:help` was passed straight through to the upstream LLM, which returned
  // a hallucinated "help text" (containing commands that do not exist at all, such as mem:atoms/mem:profile/mem:conversations).
  // Filled in after verification by this packet capture (langfuse trace d814929a...).
  //
  // Request classification: the OpenAI protocol does not do CC's fork/sidequery split (handler.ts is not wired to CC
  // routing); all requests are treated as main - consistent with the codebuddy adapter's classifyRequest.
  if (!isAuxiliary && !_dshHeadless) {
    const { parseMemCommand, executeMemCommand, buildMemResponse, extractSimpleMessages, truncateArgs } = await import("./mem-command/index.js");
    // Regular detection: the last user message
    let memCmd = parseMemCommand(body as Record<string, unknown>, agentSource);
    // When the Session init state machine completes a terminal state (initialized or bypass) in this turn, the last
    // user message is the init interaction answer (e.g. "No"), so additionally check the first user message
    // - the user's original intent. In bypass scenarios sessionInfo=null takes the "uninitialized" branch
    // and returns the text, avoiding the first mem: command being swallowed into history and falling through to the LLM.
    if (!memCmd && sessionJustRegistered) {
      memCmd = parseMemCommand(body as Record<string, unknown>, agentSource, { checkFirst: true });
    }
    // session-reset was already handled in the pre-hook; skip to prevent duplicate execution, see the same-named section in anthropicHandler
    if (memCmd?.command === "session-reset") memCmd = null;
    if (memCmd) {
      // When the session is not initialized, commands are unavailable (same hint as the anthropic side)
      if (!sessionInfo || injectedSkipped) {
        const errText = `⚠️ The session is not set up yet, so this command is unavailable. Finish session setup (choose a Team/Agent) and try again.`;
        const errResponse = buildMemResponse(errText, {
          protocol: "openai",
          stream: isStream,
          requestId: `mem-cmd-${Date.now()}`,
        });
        console.log(`[mem-command] cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} blocked: session not initialized`);
        return errResponse;
      }
      const memResult = await executeMemCommand(memCmd, {
        sessionKey,
        agentSource,
        config,
        spaceId,
        userId,
        apiKey: apiKey || "",
        sessionInfo: sessionInfo as Record<string, unknown>,
        protocol: "openai",
        stream: isStream,
        args: memCmd.args,
        // The task command family generates drafts from the recent conversation. For OpenAI/CC/CB protocols, take them directly from body.messages.
        bodyMessages: extractSimpleMessages(body.messages),
        // Option D: the taskDraft LLM follows the main model - reuse the client's model for this call + per-agent upstream + apiKey
        model: modelId,
        upstreamUrl:
          (agentFromPath ? config.upstream.agents?.[agentFromPath]?.url : undefined) ||
          config.upstream.url,
        // The CB/CodeBuddy main path goes through OpenAI chat/completions
        upstreamProtocol: "openai",
        // The OpenAI protocol has no extended thinking concept, always false
      });

      // L0 write - synchronous await guarantees persistence before returning (unlike the trackWrite/withL0Retry
      // fallback of the main conversation path; here the mem command is a "this once only" path and must wait explicitly).
      const wamfClientForMem = createWamfClient(config, spaceId);
      const wamfIdentityForMem = deriveWamfIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
      });
      if (wamfClientForMem && wamfIdentityForMem && isExtractionAllowed(config, "wamf-memory")) {
        const userMsg = { role: "user" as const, content: memCmd.rawMessage };
        try {
          await recordWamfTurn(wamfClientForMem, wamfIdentityForMem, userMsg, memResult.messageText);
        } catch (err: unknown) {
          console.error("[mem-command] L0 write error:", err);
        }
      }

      // Skill extract trigger - ensures conversation turn counting accumulates normally (symmetric with the anthropic side)
      if (isExtractionAllowed(config, "skill")) {
        try {
          // In the OpenAI protocol assistant content is a string; on the normalize-conversation side
          // convertOpenAIAssistant handles the string form as a fallback.
          const assistantMsg = { role: "assistant", content: memResult.messageText };
          await triggerSkillExtractIfReady({
            config,
            sessionKey,
            agentSource,
            sessionInfo: sessionInfo as Record<string, unknown>,
            inputMessages: messages as unknown[],
            assistantMessage: assistantMsg,
            protocol: "openai",
            assetCapabilities,
          });
        } catch (err: unknown) {
          console.warn("[mem-command] skill extract trigger error:", err instanceof Error ? err.message : String(err));
        }
      }

      console.log(`[mem-command] cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} success=${memResult.success}`);

      // Langfuse: report the mem-command (symmetric with anthropicHandler).
      //   lf is only constructed at L955, so turnSeq -> traceId is derived inline here.
      const memTurnSeq = countHumanTurns(messages, "openai");
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
          "protocol:openai",
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

  // aux requests (compaction/title) / dsh headless (no UI, no preset) do not write L0 - passed straight through
  const wamfClient = isAuxiliary || _dshHeadless || assetCapabilities?.chat_memory === false ? null : createWamfClient(config, spaceId);
  const wamfIdentity = injectedSkipped
    ? null
    : deriveWamfIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
      });
  // OpenCode places a fresh human turn at the end of messages. A tool-loop
  // continuation ends with a tool message and must not be counted as another
  // human input. Capture this before injection can prepend recalled memories.
  const lastInboundMessage = messages[messages.length - 1] as Record<string, unknown> | undefined;
  const opencodeUserQuery = agentSource === "opencode"
    ? (lastInboundMessage?.role === "user" && !isAuxiliary
        ? (opencodeAdapter.extractUserText(lastInboundMessage.content) ?? "")
        : "")
    : null;
  const wamfUserMessage: WamfMessage | null = agentSource === "opencode"
    ? (opencodeUserQuery ? { role: "user", content: opencodeUserQuery } : null)
    : extractLatestUserMessage(messages);

  // ── Context injection (before cost guard) ──────────────────────────────
  if (!injectedSkipped && config.injection?.enabled && config.injection.injectors.length > 0) {
    try {
      const injectionTurnSeq = countHumanTurns(messages, "openai");
      const { getInjectionPipeline } = await import("./injection/index.js");
      const pipeline = getInjectionPipeline(config);
      const injectedBody = await pipeline.process(body, {
        protocol: "openai",
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
        custom: sessionInfo
          ? {
              session: sessionInfo,
              assetCapabilities,
              userKey: apiKey || undefined,
            }
          : undefined,
      });
      body = injectedBody;
      messages = Array.isArray(injectedBody.messages) ? injectedBody.messages : messages;
    } catch (err: unknown) {
      // Injection failure is non-fatal — fall back to original body
    }
  }

  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  // ── Resolve forward target (opaque extension — no routing logic here) ──
  // upstream.agents[agent] is a single map keyed by agent name — same lookup
  // as anthropicHandler. Empty / missing entry → fall back to upstream.url,
  // preserving legacy behavior for configs that don't declare `agents:` at all.
  const agentUpstreamEntry = agentFromPath ? config.upstream.agents?.[agentFromPath] : undefined;
  // Per-agent apiKey resolution — three cases:
  //   (a) no entry in agents map           -> global upstream.apiKey (fallback)
  //   (b) entry present, apiKey empty      → "" (passthrough, keep client key)
  //   (c) entry present, apiKey non-empty  → agent.apiKey (server-side key)
  // Presence of an entry (case b/c) cuts the global fallback — that's what
  // lets one proxy serve mixed server-key / client-key agents at once.
  let effectiveApiKey = agentUpstreamEntry
    ? (agentUpstreamEntry.apiKey ?? "")
    : config.upstream.apiKey;
  // Normalize the request path to the canonical upstream endpoint so the
  // extension's URL joining matches the host whitelist behavior.
  const forwardEndpoint = matchWhitelistEndpoint(c.req.path)?.upstreamEndpoint ?? "/chat/completions";
  // Isolation key is user-namespaced (`${user}:${session}`) so two users that
  // share the same client session id can't contaminate each other's state /
  // turn counting. ClickHouse keeps the raw session_key (it has its own
  // user_id column); this composite is internal to the extension only.
  const target: ForwardTarget = await resolveForwardTarget(config, {
    keyId: `${keyId}:${sessionKey}`,
    messages,
    protocol: "openai",
    hasTools,
    body,
    modelId,
    defaultUpstreamUrl: agentUpstreamEntry?.url ?? config.upstream.url,
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
  // Reuse the early-fetched config (already cached, no extra RPC).
  let skipCreditReport = false;
  {
    const routedToCheapModel = target.routedFrom !== "";
    const convCfg = _earlyConvCfg;
    if (!routedToCheapModel && shouldOverride(convCfg)) {
      target.url = `${convCfg.base_url.replace(/\/+$/, "")}${forwardEndpoint}`;
      effectiveApiKey = convCfg.mode === "custom_unified"
        ? convCfg.api_key
        : apiKey; // custom_passthrough: use client's original bearer token
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

  // ── Trace-level tags ──
  // agent_source identifies the client family (codebuddy / claude-code / codex / ...), used for
  // filtering traces by client in Langfuse; protocol only distinguishes the wire protocol, and the same wire
  // can map to multiple clients.
  const traceTags: string[] = [
    `agent_source:${agentSource}`,
    "protocol:openai",
    isStream ? "stream" : "non-stream",
    `session:${sessionKey}`,
  ];

  // ── Langfuse turn context: one trace = one turn (deterministic traceId) ──
  // Same (sessionKey, turnSeq) across a turn's tool-loop requests → same trace.
  // Prefer the extension's monotonic per-session turnSeq (survives context
  // compaction); fall back to the stateless count when it's not tracked.
  const turnSeq = target.turnSeq > 0 ? target.turnSeq : countHumanTurns(messages, "openai");
  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(sessionKey, turnSeq),
    turnSeq,
    traceName: `${target.model} / ${keyId}`,
    userId: keyId,
    sessionId: sessionKey,
    tags: traceTags,
    routeTags: target.tags,
    userQuery: opencodeUserQuery ?? resolveLatestUserQuery(config, lcHeaders, c.req.path, body, messages),
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
  // CB / cursor / windsurf hit this handler via the OpenAI protocol; when debug is on, the request
  // structure + client fingerprint are put into the Langfuse observationMetadata for packet-capture analysis.
  // Off by default ({}), does not pollute production traces. See common/langfuse-debug.ts.
  const langfuseDebug = config.langfuse.debug === true;
  const debugMetadata = buildRequestDebugMetadata({
    debug: langfuseDebug,
    body: body as Record<string, unknown>,
    headers: reqHeaders,
    agentSource,
    // This handler does not do the CC client's fork/sidequery split (only anthropicHandler goes that way)
    spaceId,
    turnSeq,
    requestPath: c.req.path,
    protocol: "openai",
  });

  // ── Opik: create trace ───────────────────────────────────────────────────
  const forkTraceId = opikCreateTrace(config, {
    traceId,
    projectName: keyId,
    name: `${target.model} / ${keyId}`,
    startTime,
    input: { messages: flattenMessagesForOpik(messages) },
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
  const upstreamHeaders = buildUpstreamHeaders(c, config, target, sessionKey, effectiveApiKey);

  // Optional private preparation stage. It rewrites `body` / `messages` in
  // place, so it has to land after every host-side mutation (injection, agent
  // overrides) and before the upstream body is assembled below. The host does
  // not interpret the returned stats — see request-prepare-adapter.ts.
  const preparedStats = await prepareUpstreamRequest({
    config,
    protocol: "openai",
    body,
    messages,
    sessionKey,
    pipe,
    upstreamCall: {
      upstreamUrl: target.url,
      headers: upstreamHeaders,
      model: target.model,
      tools: body.tools,
      bodyOverrides: target.bodyOverrides ?? undefined,
    },
    userQuery: lf.userQuery,
    spaceId,
    lf,
    opikTraceId: traceId,
    opikKeyId: keyId,
  });

  const upstreamBody = buildUpstreamBody(body, target);
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
  // Retry uses the same effective key as the primary path — when it
  // resolves to "" (agent entry present but no apiKey), retry also runs
  // on the client's own key, preserving the passthrough intent.
  if (effectiveApiKey) {
    originalHeaders["authorization"] = `Bearer ${effectiveApiKey}`;
  }

  // Inject stream_options.include_usage for OpenAI compat
  if (isStream) {
    upstreamBody.stream_options = {
      ...(typeof upstreamBody.stream_options === "object" && upstreamBody.stream_options !== null
        ? (upstreamBody.stream_options as object)
        : {}),
      include_usage: true,
    };
  }

  // ── Forward to upstream (with automatic retry if configured) ──────────────
  const forwardTimeoutMs = config.server.forwardTimeoutMs ?? 600_000;
  // Pass target.url so the FORWARD log reflects the actual per-agent upstream
  // (otherwise it prints the global default and misleads triage).
  pipe.forwardStart(target.url);
  let upstreamResp: Response;
  let retried = false;

  try {
    const result = await forwardWithRetry(
      target, upstreamHeaders, upstreamBody,
      body, originalHeaders,
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
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      statusMessage: err instanceof Error ? err.message : "Upstream request failed",
      extraTags: ["error"],
      observationMetadata: { stage: "forward", ...debugMetadata },
    });
    return c.json({ error: "Upstream request failed" }, 502);
  }

  // Build response headers (strip hop-by-hop)
  const respHeaders = new Headers();
  for (const [k, v] of upstreamResp.headers.entries()) {
    if (!SKIP_RESPONSE_HEADERS.has(k.toLowerCase())) {
      respHeaders.set(k, v);
    }
  }

  // Upstream request id from response header (tokenhub / OpenAI-compatible
  // gateways set `x-request-id`). Used for cross-system tracing/audit.
  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";

  const effectiveModel = retried && target.retryTarget
    ? target.retryTarget.model
    : target.model;

  // A retry falls back to the model the client asked for, so the request ends
  // up costing what it would have cost unrouted — no saving to attribute.
  const routedFrom = retried ? "" : target.routedFrom;
  // `routedFrom` is also present in cost-guard's opaque logMeta. Keep the
  // normalized post-retry value authoritative so fallback requests never book
  // savings or carry stale route attribution.
  const { routedFrom: _ignoredRoutedFrom, ...routeLogMeta } = target.logMeta;
  const responseLogMeta = {
    ...routeLogMeta,
    ...(retried ? { retrySuccess: true } : {}),
  };

  // ── Streaming response ───────────────────────────────────────────────────
  if (isStream) {
    if (!upstreamResp.body) {
      pipe.streamDone(null);
      return new Response(null, { status: upstreamResp.status, headers: respHeaders });
    }

    // Log upstream error body for 4xx responses
    if (!retried && upstreamResp.status >= 400 && upstreamResp.status < 500) {
      const [errBodyStream, clientPassStream] = upstreamResp.body.tee();
      const errText = await new Response(errBodyStream).text();
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
        input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
        status: upstreamResp.status,
        statusMessage: errText.slice(0, 500),
        extraTags: ["error"],
        observationMetadata: { stage: "upstream", stream: true, ...debugMetadata },
      });
      pipe.streamDone(null);
      return new Response(clientPassStream, { status: upstreamResp.status, headers: respHeaders });
    }

    pipe.streamStart();

    const tapCtx: TapContext = {
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
      retried,
      logMeta: responseLogMeta,
      routedFrom,
      wamfClient,
      wamfIdentity,
      wamfUserMessage,
      assetCapabilities,
      pipe,
      sessionKeyForSkill: sessionKey,
      agentSource,
      isAuxiliary,
      isDshHeadless: _dshHeadless,
      sessionInfo,
      lf,
      spaceId,
      upstreamRequestId,
      langfuseDebug,
      debugMetadata,
      preparedStats,
      skipCreditReport,
    };
    const passthrough = createUsageTapTransform(tapCtx);
    const tappedStream = upstreamResp.body.pipeThrough(passthrough);

    return new Response(tappedStream, { status: upstreamResp.status, headers: respHeaders });
  }

  // ── Non-streaming response ───────────────────────────────────────────────
  const respText = await upstreamResp.text();
  const endTime = new Date().toISOString();

  let usage: Record<string, unknown> | null = null;
  let assistantMessage: Record<string, unknown> | null = null;
  try {
    const respJson = JSON.parse(respText) as Record<string, unknown>;
    if (respJson.usage && typeof respJson.usage === "object") {
      usage = respJson.usage as Record<string, unknown>;
    }
    const choices = respJson.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const msg = (choices[0] as Record<string, unknown>).message;
      if (msg && typeof msg === "object") {
        assistantMessage = msg as Record<string, unknown>;
      }
    }
  } catch {
    // non-JSON upstream response
  }

  const logMeta = responseLogMeta;

  // Report the completed response to the extension (same signal the streaming
  // path emits from its tap). Fire-and-forget.
  void notifyUpstreamResponse(
    config,
    {
      protocol: "openai",
      sessionKey,
      model: effectiveModel,
      stream: false,
      turnSeq: lf.turnSeq,
      text: typeof assistantMessage?.content === "string" ? assistantMessage.content : "",
      toolCalls: (Array.isArray(assistantMessage?.tool_calls) ? assistantMessage.tool_calls : [])
        .map((tc) => {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          const argsVal = fn?.arguments;
          return {
            id: (t.id as string) ?? "",
            name: (fn?.name as string) ?? "",
            arguments: typeof argsVal === "string" ? argsVal : JSON.stringify(argsVal ?? ""),
          };
        })
        .filter((tc) => tc.id && tc.arguments),
      usage: usage ?? {},
    },
    pipe,
  );

  // Internal usage instrumentation: record a model_intent for each tool_call in a non-streaming response.
  try {
    const toolCalls = assistantMessage?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const intents = toolCalls
        .map((tc) => {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          const name = (fn?.name as string) ?? "";
          const argsVal = fn?.arguments;
          const argsStr = typeof argsVal === "string" ? argsVal : JSON.stringify(argsVal ?? "");
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
    }
  } catch {
    // Instrumentation must never block the business
  }

  if (usage) {
    await recordInputTokenUsage({
      config,
      instanceId: spaceId || undefined,
      modelId: effectiveModel,
      usage,
      protocol: "openai",
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

    const outputMessages = assistantMessage ? [assistantMessage] : [];
    opikUpdateTrace(config, {
      traceId,
      projectName: keyId,
      endTime,
      output: outputMessages,
      usage,
    });
    if (forkTraceId && !config.opik.stripRequestLogContent) {
      opikUpdateTrace(config, {
        traceId: forkTraceId,
        projectName: "request_log",
        endTime,
        output: outputMessages,
        usage,
      });
    }

    opikCreateLlmSpan(config, {
      traceId,
      projectName: keyId,
      name: effectiveModel,
      startTime,
      endTime,
      inputMessages: flattenMessagesForOpik(messages),
      outputMessage: assistantMessage,
      model: effectiveModel,
      usage,
      tags: [
        "non-stream",
        ...(retried ? ["retry"] : []),
      ],
      forkProjectName: "request_log",
      forkTraceId,
      forkMetadata: {
        keyId,
        modelId: effectiveModel,
        stream: false,
        upstreamUrl: target.url,
      },
    });
  }

  // A successful completion still has a conversation and a trace when the
  // upstream omits usage. Only token accounting requires usage data.
  if (upstreamResp.ok) {
    if (!usage) pipe.info("USAGE_MISSING", "non-stream response had no usage object");
    if (wamfClient && isExtractionAllowed(config, "wamf-memory")) {
      await recordWamfTurn(wamfClient, wamfIdentity, wamfUserMessage, assistantContentForWamf(assistantMessage));
    } else if (wamfClient) {
      logExtractionSkipped(config, "wamf-memory", sessionKey);
    }

    // Langfuse: report this LLM call as a generation under the turn trace.
    langfuseReportGeneration({
      traceId: lf.traceId,
      name: effectiveModel,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      output: assistantMessage,
      usage: usage ?? undefined,
      traceName: lf.traceName,
      userId: lf.userId,
      sessionId: lf.sessionId,
      tags: lf.tags,
      traceInput: lf.userQuery || undefined,
      traceOutput: assistantMessage ?? undefined,
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
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      status: upstreamResp.status,
      statusMessage: respText.slice(0, 500),
      extraTags: ["error"],
      observationMetadata: { stage: "upstream", stream: false, ...debugMetadata },
    });
  }

  pipe.responseDone(usage);

  // Skill extract trigger — count tool calls + buffer conversation.
  // Synchronous await: continue only after the store is persisted, ensuring the next turn reads the latest data across nodes.
  // aux requests (compaction/title) / dsh headless do not trigger skill extraction - keeps the archive buffer semantics clean
  if (!isAuxiliary && !_dshHeadless && isExtractionAllowed(config, "skill")) {
    await triggerSkillExtractIfReady({
      config,
      sessionKey,
      agentSource,
      sessionInfo,
      inputMessages: messages,
      assistantMessage,
      protocol: "openai",
      assetCapabilities,
    });
  } else if (!isAuxiliary && !_dshHeadless) {
    logExtractionSkipped(config, "skill", sessionKey);
  }

  // Credit usage reporting (non-streaming). Failures are surfaced to the client
  // via the `x-credit-report-error` response header but never replace the
  // upstream LLM response body — the user-facing answer is preserved.
  // skipCreditReport: instance config custom model → user's expense, skip credit.
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


function assistantContentForWamf(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") return p.text;
      if (typeof p.content === "string") return p.content;
      return "";
    }).filter(Boolean).join("\n") || null;
  }
  return content == null ? null : JSON.stringify(content);
}

function outputMessageContent(message: Record<string, unknown> | null): string | null {
  return assistantContentForWamf(message);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

interface TapContext {
  config: ProxyConfig;
  modelId: string;
  keyId: string;
  sessionKey: string;
  upstreamUrl: string;
  traceId: string;
  forkTraceId: string;
  requestPath: string;
  startTime: string;
  inputMessages: unknown[];
  retried: boolean;
  logMeta: Record<string, unknown>;
  /** Requested model when the router forwarded elsewhere; "" otherwise. */
  routedFrom: string;
  wamfClient: WamfClient | null;
  wamfIdentity: WamfIdentity | null;
  wamfUserMessage: WamfMessage | null;
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
  pipe: ReturnType<typeof createPipeline>;
  /** For skill extract trigger; null when session_init is disabled. */
  sessionKeyForSkill: string;
  /** Client type (first segment of the URL path) - passed through to the extract trigger as one of the three isolation keys. */
  agentSource: string;
  /** True when this request was classified as auxiliary (compaction/title-gen) —
   * downstream L0/skill extract paths must skip to keep buffer semantics clean. */
  isAuxiliary: boolean;
  /** True when this dsh request came from CLI headless / no-preset (no ask_user_question
   * in tools) — behaves like aux for downstream side-effects. */
  isDshHeadless: boolean;
  sessionInfo: Record<string, unknown> | null | undefined;
  /** Langfuse turn-trace context (trace = one turn). */
  lf: LangfuseTurnContext;
  /** Space/tenant ID from request path. */
  spaceId?: string;
  /** Upstream response header `x-request-id` (empty when not returned). */
  upstreamRequestId?: string;
  /** Evaluated result of `config.langfuse.debug === true`. */
  langfuseDebug: boolean;
  /** Result of buildRequestDebugMetadata; {} when debug=false. */
  debugMetadata: Record<string, unknown>;
  /** Opaque counters from the request-preparation stage; null when it didn't run. */
  preparedStats: Record<string, unknown> | null;
  /** Instance upstream config: skip credit reporting for custom model. */
  skipCreditReport?: boolean;
}

/** Accumulated tool call state during SSE streaming. */
interface ToolCallAccumulator {
  id: string;
  type: string;
  functionName: string;
  functionArguments: string;
}

/** Result of extracting content + tool_calls from SSE text. */
interface SseExtractResult {
  content: string;
  toolCallDeltas: Array<{ index: number; id?: string; type?: string; functionName?: string; functionArguments?: string }>;
}

/** Extract assistant content and tool_call deltas from OpenAI SSE text. */
function extractSseContentAndTools(sseText: string): SseExtractResult {
  let content = "";
  const toolCallDeltas: SseExtractResult["toolCallDeltas"] = [];

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      const choices = evt.choices;
      if (Array.isArray(choices) && choices.length > 0) {
        const delta = (choices[0] as Record<string, unknown>).delta as Record<string, unknown> | undefined;
        if (typeof delta?.content === "string") {
          content += delta.content;
        }
        const tcArr = delta?.tool_calls;
        if (Array.isArray(tcArr)) {
          for (const tc of tcArr) {
            const t = tc as Record<string, unknown>;
            const idx = typeof t.index === "number" ? t.index : 0;
            const fn = t.function as Record<string, unknown> | undefined;
            toolCallDeltas.push({
              index: idx,
              id: typeof t.id === "string" ? t.id : undefined,
              type: typeof t.type === "string" ? t.type : undefined,
              functionName: typeof fn?.name === "string" ? fn.name : undefined,
              functionArguments: typeof fn?.arguments === "string" ? fn.arguments : undefined,
            });
          }
        }
      }
    } catch {
      // ignore malformed SSE lines
    }
  }
  return { content, toolCallDeltas };
}

/** Merge accumulated tool_call deltas into complete tool_call objects. */
function mergeToolCallDeltas(
  accumulators: Map<number, ToolCallAccumulator>,
  deltas: SseExtractResult["toolCallDeltas"],
): void {
  for (const d of deltas) {
    let acc = accumulators.get(d.index);
    if (!acc) {
      acc = { id: "", type: "function", functionName: "", functionArguments: "" };
      accumulators.set(d.index, acc);
    }
    if (d.id) acc.id = d.id;
    if (d.type) acc.type = d.type;
    if (d.functionName) acc.functionName += d.functionName;
    if (d.functionArguments) acc.functionArguments += d.functionArguments;
  }
}

/** Create a TransformStream that passes bytes through unchanged,
 *  while extracting usage/content/tool_calls from SSE events in-band.
 */
function createUsageTapTransform(ctx: TapContext): TransformStream<Uint8Array, Uint8Array> {
  const { config, modelId, keyId, sessionKey, upstreamUrl, traceId, forkTraceId, startTime, inputMessages, retried, logMeta, pipe, lf, spaceId, upstreamRequestId } = ctx;

  const decoder = new TextDecoder();
  let sseBuf = "";
  let lastUsage: Record<string, unknown> | null = null;
  let assistantContent = "";
  const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

  function processSseChunk(chunk: string): void {
    sseBuf += chunk;
    const parts = sseBuf.split("\n\n");
    sseBuf = parts.pop() ?? "";
    for (const part of parts) {
      const usage = extractSseUsage(part);
      if (usage) lastUsage = usage;
      const { content, toolCallDeltas } = extractSseContentAndTools(part);
      assistantContent += content;
      mergeToolCallDeltas(toolCallAccumulators, toolCallDeltas);
    }
  }

  async function finalize(): Promise<void> {
    if (sseBuf.trim()) {
      const usage = extractSseUsage(sseBuf);
      if (usage) lastUsage = usage;
      const { content, toolCallDeltas } = extractSseContentAndTools(sseBuf);
      assistantContent += content;
      mergeToolCallDeltas(toolCallAccumulators, toolCallDeltas);
    }

    const endTime = new Date().toISOString();

    let outputMessage: Record<string, unknown> | null = null;
    if (assistantContent || toolCallAccumulators.size > 0) {
      if (toolCallAccumulators.size > 0) {
        const toolCallEntries = Array.from(toolCallAccumulators.entries())
          .sort(([a], [b]) => a - b)
          .map(([, acc]) => JSON.stringify({ tool_call_id: acc.id, tool_name: acc.functionName, arguments: acc.functionArguments }, null, 2))
          .join("\n\n");
        const parts: string[] = [];
        if (assistantContent) parts.push(assistantContent);
        parts.push(toolCallEntries);
        outputMessage = { role: "assistant", content: parts.join("\n\n") };
      } else {
        outputMessage = { role: "assistant", content: assistantContent };
      }
    }

    // Report the completed response to the extension. Fire-and-forget; the
    // client has already been served by this point.
    void notifyUpstreamResponse(
      config,
      {
        protocol: "openai",
        sessionKey,
        model: modelId,
        stream: true,
        turnSeq: lf.turnSeq,
        text: assistantContent,
        toolCalls: Array.from(toolCallAccumulators.values())
          .filter((acc) => acc.id && acc.functionArguments)
          .map((acc) => ({
            id: acc.id,
            name: acc.functionName,
            arguments: acc.functionArguments,
          })),
        usage: lastUsage ?? {},
      },
      pipe,
    );

    // Internal usage instrumentation: one model_intent per tool_use intent (fan-out).
    // See docs/design/2026-08-03-internal-usage-telemetry-plan.md section 7.2 E.
    if (toolCallAccumulators.size > 0) {
      const intents = Array.from(toolCallAccumulators.values())
        .filter((acc) => acc.functionName)
        .map((acc) => ({ name: acc.functionName, arguments: acc.functionArguments }));
      emitModelIntentTelemetry({
        // Align the compositeKey form with session_init_logs
        sessionKey: `${ctx.agentSource}:${sessionKey}`,
        turnSeq: lf.turnSeq,
        spaceId: spaceId,
        userId: keyId,
        agentSource: ctx.agentSource,
        intents,
      });
    }

    if (lastUsage) {
      await recordInputTokenUsage({
        config,
        instanceId: spaceId || undefined,
        modelId,
        usage: lastUsage,
        protocol: "openai",
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
          usage: lastUsage,
          extensionStats: ctx.preparedStats ?? undefined,
          ...ctx.logMeta,
          routedFrom: ctx.routedFrom,
          spaceId,
          upstreamRequestId,
        });
      } catch (logErr: unknown) {
        pipe.error("LOG_WRITE", logErr);
      }

      try {
        const outputMessages = outputMessage ? [outputMessage] : [];
        opikUpdateTrace(config, {
          traceId,
          projectName: keyId,
          endTime,
          output: outputMessages,
          usage: lastUsage,
        });
        if (ctx.forkTraceId && !config.opik.stripRequestLogContent) {
          opikUpdateTrace(config, {
            traceId: ctx.forkTraceId,
            projectName: "request_log",
            endTime,
            output: outputMessages,
            usage: lastUsage,
          });
        }

        opikCreateLlmSpan(config, {
          traceId,
          projectName: keyId,
          name: modelId,
          startTime,
          endTime,
          inputMessages,
          outputMessage,
          model: modelId,
          usage: lastUsage,
          tags: [
            "stream",
            ...(retried ? ["retry"] : []),
          ],
          forkProjectName: "request_log",
          forkTraceId: ctx.forkTraceId,
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
    }

    if (!lastUsage) pipe.info("USAGE_MISSING", "stream completed without usage chunk");
    // Langfuse: report the completed turn even if the upstream omitted usage.
    // On the streaming path inputMessages stays as is (other downstream pipelines use the same reference);
    // when debug=true the accumulated tool_call count is put into metadata as a fallback.
    try {
      const streamDebugExtra = ctx.langfuseDebug
        ? {
            stream_tool_call_count: toolCallAccumulators.size,
            stream_assistant_content_len: assistantContent.length,
          }
        : {};
      langfuseReportGeneration({
        traceId: lf.traceId,
        name: modelId,
        model: modelId,
        startTime,
        endTime,
        input: buildLangfuseInputChat(inputMessages, ctx.langfuseDebug, flattenMessagesForOpik),
        output: outputMessage,
        usage: lastUsage ?? undefined,
        traceName: lf.traceName,
        userId: lf.userId,
        sessionId: lf.sessionId,
        tags: lf.tags,
        traceInput: lf.userQuery || undefined,
        traceOutput: outputMessage ?? undefined,
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

    if (ctx.wamfClient && isExtractionAllowed(ctx.config, "wamf-memory")) {
      // Streaming does not await (it would make closing the SSE stream feel slow); changed to trackWrite + retry:
      //   - trackWrite registers the in-flight promise in a global set; on SIGTERM index.ts
      //     flushPendingWrites waits or times out as a fallback, avoiding L0 loss during a pod rolling update.
      //   - withL0Retry handles wamf kernel blips / 5xx (3 backoff retries, ~3.5s total).
      trackWrite(
        withL0Retry(() => recordWamfTurn(
          ctx.wamfClient!, ctx.wamfIdentity, ctx.wamfUserMessage,
          outputMessageContent(outputMessage),
        )).catch((err: unknown) => pipe.error("WAMF_L0", err))
      );
    } else if (ctx.wamfClient) {
      logExtractionSkipped(ctx.config, "wamf-memory", ctx.sessionKeyForSkill);
    }

    pipe.streamDone(lastUsage);

    // Skill extract trigger — after stream finalization.
    // Synchronous await: continue only after the store is persisted, ensuring the next turn reads the latest data across nodes.
    // aux requests (compaction/title) / dsh headless skip skill triggering, keeping the archive buffer semantics clean.
    if (!ctx.isAuxiliary && !ctx.isDshHeadless && isExtractionAllowed(ctx.config, "skill")) {
      await triggerSkillExtractIfReady({
        config: ctx.config,
        sessionKey: ctx.sessionKeyForSkill,
        agentSource: ctx.agentSource,
        sessionInfo: ctx.sessionInfo,
        inputMessages: ctx.inputMessages,
        assistantMessage: outputMessage,
        protocol: "openai",
        assetCapabilities: ctx.assetCapabilities,
        toolCallCountOverride: toolCallAccumulators.size,
      });
    } else if (!ctx.isAuxiliary && !ctx.isDshHeadless) {
      logExtractionSkipped(ctx.config, "skill", ctx.sessionKeyForSkill);
    }

    // Credit usage reporting for streaming responses. The stream has already
    // been forwarded to the client; failures here are best-effort and can
    // only be observed via server logs (no way to retro-add response headers).
    // skipCreditReport: instance config custom model → user's expense, skip credit.
    (ctx.skipCreditReport
      ? Promise.resolve({ attempted: false, ok: false })
      : tryReportCreditFromPath(
          ctx.config.creditReport,
          ctx.requestPath,
          lastUsage,
          ctx.config.creditPricing,
          ctx.modelId,
          ctx.upstreamUrl,
          "usage",
        ))
      .then((outcome) => {
        if (outcome.attempted && !outcome.ok) {
          pipe.error("CREDIT_REPORT", `[stream] ${outcome.errorMessage ?? "unknown"}`);
          // Persist failed report as a raw record.
          writeFailedReportRaw(
            {
              timestamp: new Date().toISOString(),
              event: "usage",
              modelId: ctx.modelId,
              keyId: ctx.keyId,
              sessionKey: ctx.sessionKey,
              upstreamUrl: ctx.upstreamUrl,
              stream: true,
              usage: lastUsage === null ? undefined : lastUsage,
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

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      try {
        processSseChunk(decoder.decode(chunk, { stream: true }));
      } catch (err: unknown) {
        pipe.error("STREAM_TAP", err);
      }
    },
    async flush() {
      try {
        await finalize();
      } catch (err: unknown) {
        pipe.error("STREAM_FINALIZE", err);
      }
    },
  });
}
