/**
 * Langfuse LLM trace reporting module (official SDK approach).
 *
 * Uses the official Langfuse SDK (@langfuse/tracing + @langfuse/otel) to report LLM calls.
 *
 * Core semantics: **one trace = one user input within a session (one turn)**.
 *   - A tool loop within the same turn (model -> tool -> model -> ...) produces multiple upstream requests;
 *     they share the same deterministic traceId, so Langfuse merges them under the same trace,
 *     and each LLM call is a generation observation under that trace.
 *   - The traceId is derived from `sessionKey + turnSeq` via SHA-256 (deterministic), byte-for-byte identical to the official
 *     `createTraceId(seed)` algorithm (taking the first 32 hex chars of SHA-256).
 *
 * Cross-request merging mechanism:
 *   The multiple requests of a turn are independent HTTP handler invocations with no shared async context.
 *   So `startObservation(..., { parentSpanContext: { traceId, ... } })` is used to explicitly attach
 *   each generation under the known deterministic traceId (internally the SDK goes through
 *   `trace.setSpanContext(context.active(), parentSpanContext)`).
 *
 * Design principles:
 *   - Fire-and-forget: spans are exported asynchronously in batches by LangfuseSpanProcessor
 *   - Graceful degradation (everything becomes a no-op) when config is missing / SDK initialization fails
 *   - Completely independent of Opik reporting (each uses its own traceId)
 */

import { createHash } from "node:crypto";
import { TraceFlags } from "@opentelemetry/api";
import { startObservation, LangfuseOtelSpanAttributes } from "@langfuse/tracing";
import type { ProxyConfig } from "./types.js";
import { log } from "./report/log.js";

// ============================
// Lifecycle
// ============================

let _enabled = false;
let _initCalled = false;
// OpenTelemetry NodeSDK instance (used to flush on graceful shutdown).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sdk: { shutdown: () => Promise<void> } | null = null;

/**
 * Initialize Langfuse reporting. Called once at server startup; later calls are no-ops.
 * Returns whether it was enabled successfully.
 */
export async function initLangfuse(config: ProxyConfig): Promise<boolean> {
  if (_initCalled) return _enabled;
  _initCalled = true;

  const lf = config.langfuse;
  if (!lf.enabled || !lf.host || !lf.publicKey || !lf.secretKey) {
    log.info("langfuse.disabled", { reason: "config not complete" });
    return false;
  }

  try {
    // BatchSpanProcessor's maxQueueSize can only be injected via the OTel env var (the Langfuse constructor does not pass it through).
    // Set it before SDK initialization, to ensure BatchSpanProcessor reads our value.
    if (lf.maxQueueSize && !process.env.OTEL_BSP_MAX_QUEUE_SIZE) {
      process.env.OTEL_BSP_MAX_QUEUE_SIZE = String(lf.maxQueueSize);
    }

    const [{ NodeSDK }, { LangfuseSpanProcessor }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@langfuse/otel"),
    ]);

    const baseUrl = lf.host.replace(/\/$/, "");
    const processor = new LangfuseSpanProcessor({
      publicKey: lf.publicKey,
      secretKey: lf.secretKey,
      baseUrl,
      flushAt: lf.flushAt || undefined,           // max spans per batch
      flushInterval: lf.flushInterval || undefined, // periodic flush interval (seconds)
    });

    const sdk = new NodeSDK({ spanProcessors: [processor] });
    sdk.start();
    _sdk = sdk;
    _enabled = true;

    log.info("langfuse.initialized", {
      baseUrl,
      flushAt: lf.flushAt,
      flushInterval: lf.flushInterval,
      maxQueueSize: lf.maxQueueSize,
    });
    return true;
  } catch (err: unknown) {
    log.warn("langfuse.init_failed", { error: String(err) });
    _enabled = false;
    return false;
  }
}

/**
 * Gracefully shut down Langfuse reporting, ensuring all pending spans have been flushed.
 */
export async function shutdownLangfuse(): Promise<void> {
  if (_sdk) {
    try {
      await _sdk.shutdown();
    } catch (err: unknown) {
      log.warn("langfuse.shutdown_error", { error: String(err) });
    }
    _sdk = null;
  }
  _enabled = false;
  _initCalled = false;
}

// ============================
// Deterministic turn traceId
// ============================

/**
 * Derive a deterministic traceId (32 lowercase hex chars) from `sessionKey + turnSeq`.
 *
 * Same as the official `createTraceId(seed)` algorithm: the first 32 hex chars of SHA-256(seed).
 * Every request within the same turn uses the same (sessionKey, turnSeq) -> gets the same traceId ->
 * merged into the same trace in Langfuse.
 */
export function langfuseTurnTraceId(sessionKey: string, turnSeq: number): string {
  const seed = `${sessionKey}:${turnSeq}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

// ============================
// Reporting: generation observation
// ============================

/**
 * Langfuse turn-trace context - trace-level attributes shared by all generations
 * belonging to the same turn (one Langfuse trace). Built by the handler and passed to the reporting functions.
 */
export interface LangfuseTurnContext {
  /** Deterministic traceId of this turn (produced by langfuseTurnTraceId). */
  traceId: string;
  /** Turn sequence number (countHumanTurns) - also used for ClickHouse per-turn aggregation. */
  turnSeq: number;
  /** Trace name. */
  traceName: string;
  /** Trace userId (usually keyId). */
  userId: string;
  /** Trace sessionId (session isolation key; multiple turns can be aggregated by it). */
  sessionId: string;
  /**
   * Trace-level tags - only dimensions stable within the turn (protocol / stream / session),
   * excluding routing tags that vary per request, so tool-loop requests of the same turn don't overwrite each other (last-write-wins).
   */
  tags: string[];
  /**
   * Observation-level extra tags for this request - vary per request, written to the generation's
   * observation metadata rather than trace-level tags. Not populated by the host by default.
   */
  routeTags: string[];
  /**
   * The denoised latest user question - non-empty only on the first human-input request of the turn, "" when a tool loop continues.
   * Used as the trace-level input.
   */
  userQuery: string;
}

/** Reporting parameters of one LLM call (a generation attached under the given turn trace). */
export interface LangfuseGenerationReport {
  /** Deterministic traceId of the turn it belongs to (produced by langfuseTurnTraceId). */
  traceId: string;
  /** Observation name (usually the model name, or `[internal] <model>`). */
  name: string;
  /** Model name. */
  model: string;
  /** ISO 8601 start time. */
  startTime: string;
  /** ISO 8601 end time. */
  endTime: string;
  /** Generation input (messages array or string). */
  input?: unknown;
  /** Generation output (assistant message or string). */
  output?: unknown;
  /** Raw usage object (normalized into Langfuse usageDetails). */
  usage?: Record<string, unknown>;
  /** Observation level (default DEFAULT; pass ERROR on failure). */
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  /** Status message (generally used with ERROR, describing the failure reason). */
  statusMessage?: string;
  // -- Trace-level attributes (multiple calls of the same turn should pass the same values; last-write-wins) --
  /** Trace name. */
  traceName: string;
  /** Trace userId (usually keyId). */
  userId: string;
  /** Trace sessionId (session isolation key; Langfuse can aggregate multiple turns by it). */
  sessionId: string;
  /** Trace tags. */
  tags?: string[];
  /**
   * Trace-level input - passed only on the "first human input" request of the turn (the turn's original user question).
   * Tool-loop continuation requests should leave it empty, to avoid overwriting trace input with a request body containing tool_result.
   * Sub-steps such as internal routing should also leave it empty, to avoid polluting the trace-level input.
   */
  traceInput?: unknown;
  /**
   * Trace-level output - pass the final answer of the turn. Multiple calls within the same turn are last-write-wins,
   * so the output of the last call (the turn's closing one) becomes the trace output.
   */
  traceOutput?: unknown;
  /** Trace-level metadata. */
  traceMetadata?: Record<string, unknown>;
  /** Observation-level metadata. */
  observationMetadata?: Record<string, unknown>;
}

/**
 * Derive a valid phantom parent spanId (16 hex chars, non-zero).
 * Used to attach a generation under the deterministic traceId. The same traceId always yields the same spanId,
 * so all generations within a turn have a consistent parent (pointing to the same nonexistent root span,
 * and Langfuse therefore treats them all as top-level observations under the trace).
 */
function deriveParentSpanId(traceId: string): string {
  return traceId.slice(0, 16);
}

/**
 * Normalize raw LLM usage -> Langfuse usageDetails (Record<string, number>).
 *
 * Token accounting is consistent with ClickHouse's `buildClickHouseRow` (replicated independently here, no cross-module dependency),
 * covering the three usage formats Anthropic / OpenAI / DeepSeek:
 *   - Anthropic (TokenHub): `input_tokens` already excludes cache; total input = input + cache_read + cache_write,
 *     and the response has no `total_tokens`, so fall back to prompt + completion.
 *   - OpenAI / DeepSeek: `prompt_tokens` is the total input including cache, and usually `total_tokens` is also provided.
 *
 * Output follows Langfuse convention (sum of the parts = total, avoiding double counting with built-in cost calculation):
 *   - `input`: input that missed the cache (= total input - cache_read - cache_write), billed at the input unit price
 *   - `cache_read_input_tokens` / `cache_creation_input_tokens`: cache read / write
 *   - `output`: output
 *   - `total`: total tokens (= total input + output)
 *
 * Fix note: previously `total = input_tokens + output_tokens` missed the cache tokens for Anthropic
 * (cache is usually the vast majority), making Langfuse's total one to two orders of magnitude too small.
 *
 * Exported for unit testing.
 */
export function normalizeUsageDetails(usage: Record<string, unknown>): Record<string, number> {
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;

  const cacheRead =
    num(usage.prompt_cache_hit_tokens) ||
    num(usage.cache_read_input_tokens) ||
    num(promptDetails?.cached_tokens);
  const cacheWrite =
    num(usage.prompt_cache_write_tokens) ||
    num(usage.cache_creation_input_tokens);

  // Total input (including cache): OpenAI/DeepSeek take prompt_tokens;
  // Anthropic has no prompt_tokens, so use input_tokens (cache excluded) plus cache_read + cache_write.
  const inputTokens = num(usage.input_tokens);
  const promptTokens = num(usage.prompt_tokens) || inputTokens + cacheRead + cacheWrite;
  const outputTokens = num(usage.completion_tokens) || num(usage.output_tokens);
  // Total tokens: prefer the total_tokens given by upstream, otherwise prompt + completion (prompt already includes cache).
  const totalTokens = num(usage.total_tokens) || promptTokens + outputTokens;

  // Input that missed the cache (sum of parts = total, not double counted with cache_*).
  const uncachedInput = Math.max(promptTokens - cacheRead - cacheWrite, 0);

  const out: Record<string, number> = {
    input: uncachedInput,
    output: outputTokens,
    total: totalTokens,
  };
  if (cacheRead > 0) out.cache_read_input_tokens = cacheRead;
  if (cacheWrite > 0) out.cache_creation_input_tokens = cacheWrite;
  return out;
}

/** Take a numeric field (non-numeric counts as 0), consistent with ClickHouse's `num()`. */
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** Convert any value into a string that can be written to an OTel attribute. */
function asAttrString(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * Report one LLM call: create a generation observation under the given turn trace,
 * and write the trace-level attributes onto that span (the SDK uses them to set the fields of the trace it belongs to).
 *
 * Fails silently (debug log only), never affecting business requests.
 */
export function langfuseReportGeneration(report: LangfuseGenerationReport): void {
  if (!_enabled) return;

  try {
    const generation = startObservation(
      report.name,
      {
        model: report.model,
        input: report.input,
        output: report.output,
        usageDetails: report.usage ? normalizeUsageDetails(report.usage) : undefined,
        metadata: report.observationMetadata,
        level: report.level,
        statusMessage: report.statusMessage,
      },
      {
        asType: "generation",
        startTime: new Date(report.startTime),
        parentSpanContext: {
          traceId: report.traceId,
          spanId: deriveParentSpanId(report.traceId),
          traceFlags: TraceFlags.SAMPLED,
          isRemote: true,
        },
      },
    );

    // Trace-level attributes: write OTel attributes directly; the SDK propagates them to the trace they belong to.
    const span = generation.otelSpan;
    span.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, report.traceName);
    span.setAttribute(LangfuseOtelSpanAttributes.TRACE_USER_ID, report.userId);
    span.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, report.sessionId);
    if (report.tags && report.tags.length > 0) {
      span.setAttribute(LangfuseOtelSpanAttributes.TRACE_TAGS, JSON.stringify(report.tags));
    }
    // Trace-level input/output are decoupled from the observation level: written only when explicitly passed.
    // The first human-input request passes traceInput (the turn's original question); the closing request passes traceOutput.
    if (report.traceInput !== undefined) {
      span.setAttribute(LangfuseOtelSpanAttributes.TRACE_INPUT, asAttrString(report.traceInput));
    }
    if (report.traceOutput !== undefined) {
      span.setAttribute(LangfuseOtelSpanAttributes.TRACE_OUTPUT, asAttrString(report.traceOutput));
    }
    if (report.traceMetadata) {
      span.setAttribute(
        LangfuseOtelSpanAttributes.TRACE_METADATA,
        JSON.stringify(report.traceMetadata),
      );
    }

    generation.end(new Date(report.endTime));
  } catch (err: unknown) {
    log.debug("langfuse.report_error", { error: String(err) });
  }
}

/** Reporting parameters of one failed request (upstream error / forwarding failure). */
export interface LangfuseFailureReport {
  /** Turn context. */
  lf: LangfuseTurnContext;
  /** Observation name (usually the model name). */
  model: string;
  /** ISO 8601 start time. */
  startTime: string;
  /** ISO 8601 end time. */
  endTime: string;
  /** Input messages of this request (for troubleshooting). */
  input?: unknown;
  /** HTTP status code (may be omitted for forwarding exceptions). */
  status?: number;
  /** Failure description (e.g. an error body fragment or "timeout/error"). */
  statusMessage: string;
  /** Extra tags (e.g. ["error"]). */
  extraTags?: string[];
  /** Observation-level metadata. */
  observationMetadata?: Record<string, unknown>;
}

/**
 * Report one failed request: create an ERROR generation under the turn trace it belongs to.
 * Does not set trace-level input/output (a failure is not the turn's final result); only records the failure itself.
 */
export function langfuseReportFailure(report: LangfuseFailureReport): void {
  if (!_enabled) return;

  const { lf } = report;
  langfuseReportGeneration({
    traceId: lf.traceId,
    name: report.model,
    model: report.model,
    startTime: report.startTime,
    endTime: report.endTime,
    input: report.input,
    output: report.status !== undefined
      ? { error: true, status: report.status, message: report.statusMessage }
      : { error: true, message: report.statusMessage },
    level: "ERROR",
    statusMessage: report.statusMessage,
    traceName: lf.traceName,
    userId: lf.userId,
    sessionId: lf.sessionId,
    tags: report.extraTags && report.extraTags.length > 0 ? [...lf.tags, ...report.extraTags] : lf.tags,
    // The trace-level input still records the user question (so the original request is visible on a failed trace); output is not written.
    traceInput: lf.userQuery || undefined,
    observationMetadata: {
      ...report.observationMetadata,
      ...(lf.routeTags.length > 0 ? { route: lf.routeTags } : {}),
    },
  });
}
