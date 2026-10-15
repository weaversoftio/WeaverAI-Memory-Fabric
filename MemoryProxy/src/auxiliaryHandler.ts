/**
 * Auxiliary endpoint handler: lightweight pass-through handler.
 *
 * Handles whitelisted endpoints that need no routing decision:
 *  - `/v1/messages/count_tokens` (Anthropic)
 *  - `/v1/embeddings` (OpenAI)
 *  - `/v1/completions` (OpenAI legacy protocol)
 *
 * Differences from the main handlers (`handleAnthropicMessages` / `handleChatCompletions`):
 *  - **skips** the route analyzer and model routing (these endpoints have no conversational inference semantics)
 *  - **skips** opik/langfuse traces (these endpoints are not conversation turns; avoids observability noise)
 *  - **keeps** auth header (apiKey) injection, credit calculation, and JSONL/ClickHouse usage persistence
 *
 * All bodies of this handler are passed through as raw `ArrayBuffer`; only at the log/metadata level
 * does it try to parse JSON to extract the `model` field (falling back to "unknown" on failure). The response is also returned to the client as is
 * (non-stream: read fully then passed through; stream: `ReadableStream` piped directly).
 */

import type { Context } from "hono";
import { createPipeline, writeLog } from "./logger.js";
import { apiKeyToKeyId, extractBearerToken, uuidv7 } from "./opik.js";
import type { ProxyConfig } from "./types.js";
import {
  tryReportCreditFromPath,
  extractSpaceIdFromPath,
} from "./credit-reporter.js";
import { matchWhitelistEndpoint, type WhitelistEndpoint } from "./routes/whitelist.js";
import { joinUrl } from "./guard-adapter.js";
import { log } from "./report/log.js";
import { verifyUserKey } from "./auth.js";
import { matchSystemUserByUserId, hasSystemUsers } from "./systemUser.js";
import { handleSystemUserPassthrough } from "./systemUserPassthrough.js";
import {
  getInstanceUpstreamConfigs,
  resolveUpstreamConfig,
  shouldOverride,
} from "./instance-upstream-cache.js";
import { INTERNAL_REQUEST_HEADERS } from "./internal-headers.js";

/** Hop-by-hop headers and the host header: must not be passed through to upstream. */
const SKIP_REQUEST_HEADERS = new Set([
  ...INTERNAL_REQUEST_HEADERS,
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/** Response headers that should not be sent back to the client (avoids problems such as stream length mismatch). */
const SKIP_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
]);

/**
 * Build the request headers forwarded upstream.
 *
 * Difference from the main handlers: auxiliary endpoints involve no routing auth override; they only need to inject `upstream.apiKey`
 * according to the endpoint protocol:
 *  - `anthropic` -> `x-api-key` (and clear `authorization`)
 *  - `openai`    → `Authorization: Bearer`
 */
function buildAuxUpstreamHeaders(
  c: Context,
  config: ProxyConfig,
  entry: WhitelistEndpoint,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = v;
    }
  }
  headers["content-type"] = headers["content-type"] ?? "application/json";

  if (config.upstream.apiKey) {
    if (entry.protocol === "anthropic") {
      headers["x-api-key"] = config.upstream.apiKey;
      delete headers["authorization"];
    } else {
      headers["authorization"] = `Bearer ${config.upstream.apiKey}`;
      delete headers["x-api-key"];
    }
  }
  return headers;
}

/** Filter response headers (stripping length/encoding-related fields), returning a Headers object ready to send downstream. */
function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out.set(key, value);
    }
  });
  return out;
}

/**
 * Try to parse the `model` field from the request body for logging.
 * Returns "unknown" when the body is not JSON or has no model (does not throw).
 */
function extractModelId(bodyText: string): string {
  if (!bodyText) return "unknown";
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    if (typeof parsed.model === "string" && parsed.model) return parsed.model;
  } catch {
    // ignore — non-JSON body is allowed for passthrough
  }
  return "unknown";
}

/**
 * Extract the `usage` field from the response text (if present).
 *
 * Common shapes:
 *  - Anthropic count_tokens: the whole body is `{ input_tokens: N }` - used directly as usage
 *  - OpenAI embeddings: `{ data: [...], usage: { prompt_tokens, total_tokens } }`
 *  - Others: try reading the top-level `usage` field
 *  - Cannot parse: return `null`
 */
function extractUsageFromResponse(
  respText: string,
  entry: WhitelistEndpoint,
): Record<string, unknown> | null {
  if (!respText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(respText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  // The Anthropic count_tokens response is just { input_tokens: N }, with no usage wrapper
  if (entry.pathSuffix === "/v1/messages/count_tokens") {
    if (typeof obj.input_tokens === "number") return obj;
    return null;
  }

  // OpenAI family (embeddings / completions): usage is in the top-level usage field
  if (obj.usage && typeof obj.usage === "object") {
    return obj.usage as Record<string, unknown>;
  }
  return null;
}

/**
 * Auxiliary endpoint handler.
 *
 * Request lifecycle:
 *  1. Match the current path against the whitelist table (defensive; normally the routing layer already guarantees a match)
 *  2. Extract apiKey -> keyId
 *  3. Read the raw body (unparsed), only extracting the `model` field for logging
 *  4. `joinUrl` builds the upstream URL
 *  5. Inject auth headers per protocol
 *  6. fetch upstream (no retry, simplified)
 *  7. Branch:
 *     - stream response -> pipe the body straight back to the client (usage is not parsed in this phase)
 *     - non-stream -> read fully -> extract usage -> credit calculation + JSONL persistence
 *  8. Pass the response status/headers/body through as is
 */
export async function handleAuxiliaryEndpoint(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();

  const entry = matchWhitelistEndpoint(c.req.path);
  if (!entry) {
    // Defensive: server.ts should guarantee that only whitelisted paths route to this handler.
    // Reaching here means config or routing is inconsistent; return 404 for quick diagnosis.
    return c.json({ error: "Unregistered endpoint" }, 404);
  }

  // 1. Auth (resolve the local keyId first, then verify with the auth service, symmetric with the main handlers)
  const apiKey =
    c.req.header("x-api-key") ??
    extractBearerToken(c.req.header("authorization") ?? c.req.header("Authorization") ?? "") ??
    "";

  let keyId = apiKey ? apiKeyToKeyId(apiKey) : "unknown";

  // Consistent with the main handlers: call the auth service to verify; return 401 if it fails.
  // spaceId comes from the request path /proxy/<spaceId>/...; it is "" when there is no path prefix.
  const spaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const { userId, rejected: userKeyRejected, rejectReason } =
    await verifyUserKey(apiKey, spaceId);
  if (userKeyRejected) {
    return c.json(
      { error: `Authentication failed: ${rejectReason ?? "unknown"}` },
      401,
    );
  }
  if (userId) keyId = userId;

  // ── System-user short-circuit ────────────────────────────────────────────
  // Auxiliary endpoints (count_tokens / embeddings / completions / moderations)
  // also bypass the standard aux flow for internal service accounts. Match
  // is by userId resolved from verifyUserKey; auth-disabled requests (userId
  // == "") never match. Body has NOT been read yet — passthrough owns the
  // byte stream end-to-end.
  if (hasSystemUsers()) {
    const sysMatch = matchSystemUserByUserId(userId);
    if (sysMatch) {
      return handleSystemUserPassthrough(c, config, sysMatch);
    }
  }

  // 2. Read the raw body (byte-level pass-through)
  const rawBody = await c.req.arrayBuffer();
  const bodyText = new TextDecoder().decode(rawBody);
  const modelId = extractModelId(bodyText);

  // 3. Build the upstream URL (reuse joinUrl, naturally consuming the whitelist table)
  let upstreamUrl = joinUrl(config.upstream.url, c.req.path);

  // 4. Build the upstream request headers (inject auth per endpoint protocol)
  const upstreamHeaders = buildAuxUpstreamHeaders(c, config, entry);

  // ── Instance upstream config override (aux requests follow conversation config) ──
  {
    const spaceId = extractSpaceIdFromPath(c.req.path) ?? "";
    const instanceConfigs = await getInstanceUpstreamConfigs(config.coreSkill, spaceId);
    const agentFromPath = c.req.path.split("/").filter(Boolean)[0] ?? undefined;
    const convCfg = resolveUpstreamConfig(instanceConfigs, agentFromPath, "conversation");
    if (shouldOverride(convCfg)) {
      upstreamUrl = joinUrl(convCfg.base_url, c.req.path);
      if (convCfg.mode === "custom_unified" && convCfg.api_key) {
        if (entry.protocol === "anthropic") {
          upstreamHeaders["x-api-key"] = convCfg.api_key;
          delete upstreamHeaders["authorization"];
        } else {
          upstreamHeaders["authorization"] = `Bearer ${convCfg.api_key}`;
          delete upstreamHeaders["x-api-key"];
        }
      }
      // custom_passthrough: keep client's original auth header
    }
  }

  // 5. Pipeline log (simplified: only emit key events)
  const pipe = createPipeline(config, traceId, modelId);
  pipe.info(
    "AUX_ENDPOINT",
    `${entry.pathSuffix} → ${entry.upstreamEndpoint} (${entry.protocol})`,
  );
  pipe.forwardStart();

  // 6. Forward (auxiliary endpoint simplified: no retry)
  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: rawBody,
    });
  } catch (err: unknown) {
    pipe.error("AUX_FORWARD", err instanceof Error ? err : new Error(String(err)));
    return c.json(
      { error: "Upstream request failed", detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
  pipe.forwardDone(upstreamResp.status);

  // 7. Branch: stream vs non-stream
  const contentType = upstreamResp.headers.get("content-type") ?? "";
  const isStream = contentType.includes("event-stream");

  if (isStream) {
    // Stream branch: pipe directly; this phase does not tap SSE to extract usage
    // (credit will be implemented when the client disconnects or when the tap logic is completed in phase two)
    log.debug("aux.stream.passthrough", { path: c.req.path, upstreamUrl });
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: filterResponseHeaders(upstreamResp.headers),
    });
  }

  // Non-stream: read the body fully -> extract usage -> credit
  const respBuf = await upstreamResp.arrayBuffer();
  const respText = new TextDecoder().decode(respBuf);
  const usage = extractUsageFromResponse(respText, entry);

  if (usage && upstreamResp.ok) {
    // credit reporting (auxiliary endpoints use the generic credit-reporter)
    try {
      await tryReportCreditFromPath(
        config.creditReport,
        c.req.path,
        usage,
        config.creditPricing,
        modelId,
        upstreamUrl,
        "usage",
      );
    } catch (err: unknown) {
      log.error(
        "aux.credit_report_failed",
        { path: c.req.path, upstreamUrl },
        err instanceof Error ? err : new Error(String(err)),
      );
    }

    // JSONL + ClickHouse usage persistence (reuses the main handler's path)
    writeLog(config, {
      timestamp: startTime,
      event: "usage",
      modelId,
      keyId,
      sessionKey: keyId, // auxiliary endpoints have no session concept; fall back to keyId
      upstreamUrl,
      stream: false,
      usage,
    });
  }

  pipe.responseDone(usage);

  // 8. Pass the response through as is
  return new Response(respBuf, {
    status: upstreamResp.status,
    headers: filterResponseHeaders(upstreamResp.headers),
  });
}
