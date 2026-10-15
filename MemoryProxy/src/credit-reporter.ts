// Credit usage reporting to external service (e.g. WAMF MemoryPlus).
// On LLM response, POST {SpaceId, MemoryLevel, MemoryDelta, CreditDelta} to
// configured URL. SpaceId is extracted from request path /proxy/<spaceId>/...,
// MemoryLevel is fixed "proxy", MemoryDelta is 0, CreditDelta = computed credit.

import type { CreditPricingConfig, CreditReportConfig } from "./types.js";
import { getModelPricing, resolveTierPricing } from "./pricing.js";
import { log } from "./report/log.js";

export interface CreditReportRequest {
  SpaceId: string;
  MemoryLevel: string;
  MemoryDelta: number;
  CreditDelta: number;
}

export interface CreditReportResult {
  ok: boolean;
  status?: number;
  /** Service-level response (echoed back, even on logical error). */
  response?: unknown;
  /** Transport/timeout error message. */
  error?: string;
}

/** Fixed MemoryLevel value used by this proxy when reporting credit. */
export const PROXY_MEMORY_LEVEL = "proxy";

/** Maximum length of the value placed into the `x-credit-report-error` header. */
const MAX_ERROR_HEADER_LEN = 256;

/**
 * Detect usage schema protocol from upstream URL path.
 *
 * - `/v1/messages` (including sub-paths `/v1/messages/count_tokens`, `/v1/messages?...`) -> "anthropic"
 * - other paths (including `/v1/chat/completions` and unrecognized paths) -> "openai"
 *
 * Reason for choosing openai as the fallback default: the Anthropic branch assumes input_tokens already excludes cache;
 * if wrongly applied to OpenAI usage, the cache portion would be billed again at the high input price;
 * conversely the OpenAI branch does "subtract first, then compute", so even if misapplied to Anthropic usage it only degrades to the equivalent old logic,
 * the risk is asymmetric, hence openai is the fallback.
 *
 * Case-insensitive.
 */
export function detectUsageProtocol(upstreamUrl: string): "anthropic" | "openai" {
  const path = upstreamUrl.toLowerCase();
  // /v1/messages must be followed by / or ? or end of string, to avoid wrongly matching /v1/messages_admin
  if (/\/v1\/messages(\/|\?|$)/.test(path)) return "anthropic";
  return "openai";
}

/**
 * Extract SpaceId from a request path like `/proxy/<spaceId>/v1/messages`.
 *
 * Behaviour:
 * - Allows optional leading slash.
 * - Strips any `?query` suffix defensively (Hono's `c.req.path` normally has
 *   no query, but path can be provided by other code paths too).
 * - Rejects empty spaceId (`/proxy//...`), case mismatches (`/PROXY/...`),
 *   and similar-but-distinct prefixes (`/proxyfake/...`).
 *
 * @returns The spaceId string, or `null` when the path does not match the
 *   expected prefix. Callers should treat `null` as "do not report credit
 *   for this request".
 */
export function extractSpaceIdFromPath(path: string): string | null {
  // Defensive: drop query string if accidentally passed in.
  const safePath = path.split("?", 1)[0] ?? "";
  // /proxy/<spaceId>/...
  let match = /^\/?proxy\/([^/?]+)(?:\/|$)/.exec(safePath);
  if (match) return match[1] || null;
  // /<agent>/<spaceId>/...  (e.g. /claude-code/mem-example001/v1/messages)
  match = /^\/[^/]+\/([^/?]+)(?:\/|$)/.exec(safePath);
  if (match) {
    const agent = safePath.split("/").filter(Boolean)[0] ?? "";
    // Only capture spaceId when the first segment looks like an agent name
    if (/^(claude-code|codebuddy|codex|cursor|hermes|openclaw|workbuddy|dsh|opencode|pi)$/i.test(agent)) {
      return match[1] || null;
    }
  }
  return null;
}

/** Compute CreditDelta from an LLM usage object using model-specific pricing.
 *
 * Only applies pricing-based calculation when upstreamUrl contains "tokenhub".
 * For non-TokenHub upstreams (e.g. copilot), returns 0.
 *
 * Uses `detectUsageProtocol(upstreamUrl)` to decide between the Anthropic and OpenAI branches:
 *
 * Anthropic branch (`/v1/messages`):
 *   - nonCacheInput = usage.input_tokens (TokenHub has already deducted the cache portion)
 *   - cacheRead = usage.cache_read_input_tokens
 *   - cacheWrite5m = usage.cache_creation.ephemeral_5m_input_tokens
 *   - cacheWrite1h = usage.cache_creation_input_tokens - ephemeral_5m_input_tokens
 *
 * OpenAI branch (`/v1/chat/completions` or other paths):
 *   - nonCacheInput = max(0, usage.prompt_tokens - cached_tokens) (prompt_tokens includes cache)
 *   - cacheRead = usage.cache_read_tokens ?? usage.prompt_tokens_details.cached_tokens
 *   - cacheWrite5m = 0 (OpenAI has no cache write concept)
 *   - cacheWrite1h = 0
 *
 * Credit formula (per 1K tokens):
 *   credit = (nonCacheInput / 1000) * pricing.input
 *          + (output / 1000) * pricing.output
 *          + (cacheRead / 1000) * pricing.cacheRead
 *          + (cacheWrite5m / 1000) * pricing.cacheWrite5m
 *          + (cacheWrite1h / 1000) * pricing.cacheWrite1h
 *
 * If upstream is not TokenHub, returns 0.
 * If upstream is TokenHub but model pricing is not found, returns 0
 *   (the raw usage goes to the raw table via the clickhouse-side `getRawUsageReason -> "unknown_model"`
 *   path for traceability, avoiding reporting token counts as credits and distorting billing).
 */
export function computeCreditDelta(
  usage: Record<string, unknown> | null | undefined,
  pricingConfig: CreditPricingConfig | null | undefined,
  modelId?: string,
  upstreamUrl?: string,
): number {
  if (!usage) return 0;

  // Only apply pricing-based calculation for TokenHub upstream
  const isTokenHub = upstreamUrl ? /tokenhub/i.test(upstreamUrl) : false;
  if (!isTokenHub) return 0;

  const protocol = detectUsageProtocol(upstreamUrl ?? "");

  // Common fields
  const output = numField(usage.completion_tokens) || numField(usage.output_tokens);

  // Extract the 5 token categories per protocol branch
  let nonCacheInput = 0;
  let cacheRead = 0;
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;

  if (protocol === "anthropic") {
    // Anthropic (TokenHub): input_tokens already excludes cache
    nonCacheInput = numField(usage.input_tokens);
    cacheRead = numField(usage.cache_read_input_tokens);
    const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
    const ephemeral5m = numField(cacheCreation?.ephemeral_5m_input_tokens);
    const totalCacheWrite = numField(usage.cache_creation_input_tokens);
    cacheWrite5m = ephemeral5m;
    cacheWrite1h = Math.max(0, totalCacheWrite - ephemeral5m);
  } else {
    // OpenAI: prompt_tokens includes cache, so cached_tokens must be subtracted
    const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    const promptTokens = numField(usage.prompt_tokens);
    cacheRead =
      numField(usage.cache_read_tokens) ||
      numField(promptDetails?.cached_tokens);
    nonCacheInput = Math.max(0, promptTokens - cacheRead);
    // The OpenAI protocol has no cache write concept on TokenHub's current models, so force 0
    // and ignore any cache_creation_* fields that may appear in usage (to avoid wrong billing).
    cacheWrite5m = 0;
    cacheWrite1h = 0;
  }

  // Look up pricing
  const pricing = getModelPricing(pricingConfig, modelId ?? null);

  let credit: number;
  let fallback: string | undefined;

  if (pricing) {
    // Tier criterion: nonCacheInput + cacheRead (i.e. total input context length)
    const totalInput = nonCacheInput + cacheRead;
    const effectivePricing = resolveTierPricing(pricing, totalInput);

    // Compute the Credit value (whole-tier pricing: all token types use the same tier's unit price)
    credit =
      (nonCacheInput / 1000) * effectivePricing.input +
      (output / 1000) * effectivePricing.output +
      (cacheRead / 1000) * effectivePricing.cacheRead +
      (cacheWrite5m / 1000) * effectivePricing.cacheWrite5m +
      (cacheWrite1h / 1000) * effectivePricing.cacheWrite1h;
  } else {
    // Unpriced model: do not report credit, to avoid billing token counts as credits.
    // The raw usage is traced in the raw table by the clickhouse-side `getRawUsageReason -> "unknown_model"`.
    credit = 0;
    fallback = "unknown_model";
  }

  log.debug("credit.compute", {
    protocol,
    model: modelId ?? "unknown",
    rawUsage: usage,
    nonCacheInput,
    output,
    cacheRead,
    cacheWrite5m,
    cacheWrite1h,
    credit,
    ...(fallback ? { fallback } : {}),
  });

  return credit;
}

function numField(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** POST credit usage to the configured endpoint.
 *  Never throws — returns a structured result the caller can react to. */
export async function reportCreditUsage(
  config: CreditReportConfig,
  payload: CreditReportRequest,
): Promise<CreditReportResult> {
  const fetchOpts: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
  if (config.timeoutMs > 0) {
    fetchOpts.signal = AbortSignal.timeout(config.timeoutMs);
  }
  try {
    const resp = await fetch(config.url, fetchOpts);
    const text = await resp.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep as raw text
    }
    if (!resp.ok) {
      return { ok: false, status: resp.status, response: parsed, error: `HTTP ${resp.status}` };
    }
    // The MemoryPlus service returns {code, message, data} — non-zero code = logical failure.
    if (parsed && typeof parsed === "object" && "code" in (parsed as Record<string, unknown>)) {
      const code = (parsed as Record<string, unknown>).code;
      const message = (parsed as Record<string, unknown>).message;
      if (typeof code === "number" && code !== 0) {
        return {
          ok: false,
          status: resp.status,
          response: parsed,
          error: typeof message === "string" ? message : `code=${code}`,
        };
      }
    }
    return { ok: true, status: resp.status, response: parsed };
  } catch (err: unknown) {
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    return {
      ok: false,
      error: isTimeout
        ? `timeout after ${config.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}

/** Outcome of attempting to report credit, suitable for handler decision-making. */
export interface CreditReportOutcome {
  /** True when we actually issued a network request (path had spaceId and usage was non-empty). */
  attempted: boolean;
  /** True only when `attempted` is true and the report succeeded. */
  ok: boolean;
  /** Detailed error suitable for server-side logs (includes spaceId). */
  errorMessage?: string;
  /** Compact, header-safe error string suitable for `x-credit-report-error`. */
  errorHeader?: string;
  /** Raw report result (only present when attempted=true). */
  result?: CreditReportResult;
}

/**
 * Helper: extract spaceId from path, build payload, call reportCreditUsage,
 * and produce a `CreditReportOutcome` that handlers can map to logs + response
 * headers without duplicating the same 8 lines four times.
 *
 * Caller contract:
 * - If `outcome.attempted === false`: do nothing — request did not target the
 *   credit-reporting route or had no usage to report.
 * - If `outcome.attempted === true && outcome.ok === false`: log
 *   `outcome.errorMessage` and set response header
 *   `x-credit-report-error: outcome.errorHeader`.
 * - On success: nothing further needed.
 */
export async function tryReportCreditFromPath(
  config: CreditReportConfig,
  path: string,
  usage: Record<string, unknown> | null | undefined,
  pricingConfig: CreditPricingConfig | null | undefined,
  modelId?: string,
  upstreamUrl?: string,
  /**
   * Log event kind. When `"analyzer_usage"`, this function short-circuits and
   * never issues a credit report — extension telemetry events are
   * infrastructure consumption and must not be billed to the user's memory space.
   * Defaults to `"usage"` semantically when omitted (backward compatible).
   */
  event?: "usage" | "analyzer_usage",
): Promise<CreditReportOutcome> {
  // Defense-in-depth: extension telemetry events must never trigger a credit report.
  // Today the extension telemetry path (writeLog with event="analyzer_usage") does not
  // reach this function, but this guard ensures future refactors cannot
  // accidentally bill extension consumption to the caller's memory space.
  if (event === "analyzer_usage") {
    return { attempted: false, ok: false };
  }
  // No endpoint configured: reporting is off (no request, no x-credit-report-error header).
  if (!config.url) {
    return { attempted: false, ok: false };
  }

  const spaceId = extractSpaceIdFromPath(path);
  if (!spaceId || !usage || Object.keys(usage).length === 0) {
    return { attempted: false, ok: false };
  }
  const result = await reportCreditUsage(config, {
    SpaceId: spaceId,
    MemoryLevel: PROXY_MEMORY_LEVEL,
    MemoryDelta: 0,
    CreditDelta: computeCreditDelta(usage, pricingConfig, modelId, upstreamUrl),
  });
  if (result.ok) {
    return { attempted: true, ok: true, result };
  }
  const errorText = result.error ?? "unknown";
  const errorMessage =
    `spaceId=${spaceId} error=${errorText} resp=${JSON.stringify(result.response ?? null).slice(0, 200)}`;
  const errorHeader = sanitizeHeaderValue(`spaceId=${spaceId}; error=${errorText}`);
  return { attempted: true, ok: false, errorMessage, errorHeader, result };
}

/** Sanitize a string for use as an HTTP header value: strip CR/LF, cap length. */
function sanitizeHeaderValue(s: string): string {
  const cleaned = s.replace(/[\r\n]+/g, " ").trim();
  return cleaned.length > MAX_ERROR_HEADER_LEN
    ? cleaned.slice(0, MAX_ERROR_HEADER_LEN - 3) + "..."
    : cleaned;
}
