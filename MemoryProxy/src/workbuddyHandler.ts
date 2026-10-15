/**
 * WorkBuddy endpoint handler -- skeleton layer (helper functions + main handler stub).
 *
 * WorkBuddy uses the OpenAI Responses API (@openai/agents SDK), with a wire protocol identical to
 * Codex, and a system prompt XML structure similar to CodeBuddy. But this file is **deliberately fully decoupled from
 * codexHandler / codebuddyHandler** and does not import any sibling handler,
 * so changing WorkBuddy only touches this file and injection/agents/workbuddy/, leaving other clients unaffected.
 *
 * This round (step one of layered delivery): **only expose unit-test-friendly pure functions**
 *   - classifyWorkbuddyRequest: identify main vs auxiliary requests
 *   - extractWorkbuddySessionId: extract the session id from the header / body
 *   - detectWorkbuddyDefaultModeGate: identify the client Default mode gate signal
 *   - injectWorkbuddyAssets: append the `<wamf_injections>` wrapper to body.input[0].content[]
 *
 * The full `handleWorkbuddyEndpoint(c, config)` main handler (including auth / session-init /
 * mem-command / forward+langfuse tap) is left for the next round, when server routing is wired in --
 * that part needs to pull in many config/session dependencies, so it is isolated first to reduce the regression surface.
 */

import type { Context } from "hono";
import type { ProxyConfig } from "./types.js";
import { apiKeyToKeyId, extractBearerToken, uuidv7 } from "./opik.js";
import { createPipeline, writeLog } from "./logger.js";
import { extractSpaceIdFromPath } from "./credit-reporter.js";
import {
  getInstanceUpstreamConfigs,
  resolveUpstreamConfig,
  shouldOverride,
} from "./instance-upstream-cache.js";
import { joinUrl } from "./guard-adapter.js";
import { verifyUserKey } from "./auth.js";
import { resolveModelId } from "./pricing.js";
import { workbuddyAdapter } from "./agent-adapters/workbuddy.js";
import {
  buildWorkbuddyInjectionBlock,
  type WorkbuddyInjectionInput,
} from "./common/workbuddy-injection.js";
// WorkBuddy uses the Responses API, exactly the same wire as codex -- the popup skeleton directly reuses
// buildFormResponse + codexFormAnswersAsMessages of session/codex/form.ts,
// and the state machine reuses CB's handleSessionInit(agentSource="codex"). This way WorkBuddy
// itself does not need a separate form skeleton.
import {
  buildFormResponse as buildCodexFormResponse,
  codexFormAnswersAsMessages,
} from "./session/codex/form.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "./langfuse.js";

// ── WAMF L0 + Skill extraction imports ────────────────────────────────────────
import { WamfClient } from "./wamf/client.js";
import { deriveWamfIdentity } from "./wamf/identity.js";
import { recordWamfTurn } from "./wamf/recorder.js";
import { trackWrite, withL0Retry } from "./wamf/pending-writes.js";
import type { WamfIdentity, WamfMessage } from "./wamf/types.js";
import { triggerSkillExtractIfReady } from "./skill/handler-glue.js";
import { isExtractionAllowed, logExtractionSkipped } from "./extraction-gate.js";
import { INTERNAL_REQUEST_HEADERS } from "./internal-headers.js";

// ── Handler-level constants ──────────────────────────────────────────────────

const SKIP_REQUEST_HEADERS = new Set([
  ...INTERNAL_REQUEST_HEADERS,
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "x-wamf-user-key",
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
]);

// ── Types (exported for unit tests) ──────────────────────────────────────────

/**
 * WorkBuddy per-session state.
 * Semantically the same as CodexSessionState but a standalone type, to avoid type sharing across handlers.
 *
 * - status: "initialized" means the binding/onboarding flow is complete; "pending" means still waiting for
 *   the session-init form to be filled back
 * - bypassed: after the user explicitly chooses "Default mode" to bypass the binding flow, form injection is permanently skipped
 * - sessionInfo: metadata { userId, teamId, agentId, ... } attached after successful binding,
 *   passed through to the injection pipeline for context queries
 */
export interface WorkbuddySessionState {
  status: "initialized" | "pending";
  bypassed?: boolean;
  sessionInfo?: Record<string, unknown> | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Signature string of the WorkBuddy client's Default mode gate.
 * After the user chooses Default mode, the client outputs this prefix in function_call_output,
 * hinting "request_user_input is unavailable in Default mode" -- a hit is treated as
 * the user explicitly choosing to bypass the binding flow, and the session should be permanently bypassed.
 *
 * The WorkBuddy client's actual string **is pending packet-capture verification**; this round follows codex's gate string
 * ("request_user_input is unavailable in Default mode"), to be aligned during real-client
 * integration.
 * TODO(workbuddy-integration): confirm the WorkBuddy client's actual gate string by packet capture.
 */
const DEFAULT_GATE_PREFIX = "request_user_input is unavailable in Default mode";

// ── Request classification ───────────────────────────────────────────────────

/**
 * Classify a WorkBuddy request as main or auxiliary.
 *
 * Auxiliary requests are auxiliary calls the client initiates on its own (memory generation, trace summarization, compact,
 * etc.), which should not trigger the session-init form or injection and are forwarded straight upstream.
 *
 * Decision order (return auxiliary on any hit):
 *   1. an aux path fragment appears in the path (/compact, /trace_summarize, /realtime, /memories)
 *   2. a memgen marker appears in the header (x-openai-memgen-request=true, compatible with SDK convention)
 *   3. body.client_metadata.thread_source ∈ {system, memory_consolidation}
 *
 * An unknown thread_source is treated as main (leaning strict -- better to miss an aux than to wrongly treat user interaction as aux).
 */
export function classifyWorkbuddyRequest(
  body: Record<string, unknown>,
  path: string,
  headers: Record<string, string>,
): "main" | "auxiliary" {
  // (1) path-based aux decision
  const AUX_PATH_HINTS = ["/compact", "/trace_summarize", "/realtime", "/memories"];
  for (const hint of AUX_PATH_HINTS) {
    if (path.includes(hint)) return "auxiliary";
  }

  // (2) header memgen marker
  const memgen =
    headers["x-openai-memgen-request"] ??
    headers["X-OpenAI-Memgen-Request"] ??
    "";
  if (memgen === "true" || memgen === "1") return "auxiliary";

  // ③ body.client_metadata.thread_source
  const meta = body.client_metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const ts = meta.thread_source;
    if (ts === "system" || ts === "memory_consolidation") return "auxiliary";
  }

  return "main";
}

// ── Session ID extraction ────────────────────────────────────────────────────

/**
 * Extract the WorkBuddy session id from the request headers / body.
 *
 * Priority (same as codex):
 *   1. header `session-id` (the SDK default location)
 *   2. body.client_metadata.session_id (fallback)
 *
 * If both are missing -> null (the upper layer decides whether to reject or generate a new session).
 */
export function extractWorkbuddySessionId(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): string | null {
  const fromHeader = headers["session-id"] ?? headers["Session-Id"];
  if (typeof fromHeader === "string" && fromHeader.length > 0) return fromHeader;

  const meta = body.client_metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const sid = meta.session_id;
    if (typeof sid === "string" && sid.length > 0) return sid;
  }
  return null;
}

// ── Default mode gate detection ──────────────────────────────────────────────

/**
 * Identify the WorkBuddy client's Default mode gate signal.
 *
 * When the user declines the request_user_input form (choosing Default mode), the client carries
 * function_call_output.output ~=
 * "request_user_input is unavailable in Default mode" in the input[] of the next request. A hit means the user
 * explicitly wants to bypass the binding flow -> the session should be marked bypassed.
 *
 * Same structure as the codex version, with the string prefix defined independently (DEFAULT_GATE_PREFIX); when the client changes its wording in the future,
 * only this one constant needs changing.
 */
export function detectWorkbuddyDefaultModeGate(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type !== "function_call_output") continue;
    const output = it.output;
    if (typeof output === "string" && output.startsWith(DEFAULT_GATE_PREFIX)) {
      return true;
    }
  }
  return false;
}

// ── Asset injection ──────────────────────────────────────────────────────────

/**
 * Inject `<wamf_injections>` wrapper into WorkBuddy body.input[0].content[].
 *
 * Isomorphic to the codex logic: attach the full XML text produced by the pipeline to the end of the content array of the developer message
 * (input[0]).
 *
 * Defensive short-circuit:
 *   - no input or input is not an array -> return the original body
 *   - input[0] is not a message -> return the original body
 *   - input[0].content is not an array -> return the original body
 *   (The point of these defensive branches: on non-first frames input[0] may be a function_call or the like,
 *    and only in the first round is input[0] a developer/user message; wrongly injecting into the content of a function_call item
 *    causes an upstream 400 or semantic confusion.)
 *
 * Returns a shallow copy and does not modify the original body (body -> input -> input[0] -> content, shallow-copied along the whole chain).
 */
export function injectWorkbuddyAssets(
  body: Record<string, unknown>,
  assets: WorkbuddyInjectionInput,
): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input) || input.length === 0) return body;

  const devMsg = input[0] as Record<string, unknown> | null;
  if (!devMsg || typeof devMsg !== "object") return body;
  if (devMsg.type !== "message") return body;

  const content = devMsg.content;
  if (!Array.isArray(content)) return body;

  const injectionBlock = buildWorkbuddyInjectionBlock(assets);

  // Shallow-copy chain: body → input → input[0] → content
  const newContent = [...content, injectionBlock];
  const newDevMsg = { ...devMsg, content: newContent };
  const newInput = [newDevMsg, ...input.slice(1)];
  return { ...body, input: newInput };
}

// -- Human turn counting (langfuse telemetry helper) -------------------------

/**
 * Count the number of "human turns" in WorkBuddy input[].
 *
 * Used for the langfuse trace's turnSeq -- only user messages the client actively sent (role=user
 * and type=message) are counted; function_call / function_call_output produced by tool calls
 * / assistant feedback are not counted. This way multiple function_calls within the same round merge into the same
 * trace, convenient for observation.
 *
 * Same logic as codex's countHumanTurnsCodex; to keep "zero dependencies between handlers" it is
 * copied separately.
 */
export function countHumanTurnsWorkbuddy(input: unknown): number {
  if (!Array.isArray(input)) return 0;
  let count = 0;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type !== "message") continue;
    if (it.role !== "user") continue;
    count++;
  }
  return count;
}

// ── Workbuddy Archive Context (L0 write + Skill extract) ────────────────────

/**
 * WorkBuddy L0/Skill archive context, aligned with the design of codexHandler's CodexArchiveCtx:
 *   - when archiveCtx=null the forward/session bypass side skips the hook directly
 *   - failures are silent (internal warn), and never block the upstream response
 */
export interface WorkbuddyArchiveCtx {
  config: ProxyConfig;
  sessionKey: string;
  agentSource: string;
  sessionInfo: Record<string, unknown>;
  userId: string;
  /** Raw body.input[] (responses API input items) */
  input: unknown[];
  wamfClient: WamfClient | null;
  wamfIdentity: WamfIdentity | null;
  wamfUserMessage: WamfMessage | null;
  /**
   * Asset capability switches (chat_memory / skill / ...); used to gate the archive hook.
   * Aligned with codexHandler.CodexArchiveCtx.assetCapabilities.
   */
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
}

/**
 * Extract the latest user message from the responses API body.input[] for the L0 write.
 */
function extractLatestWorkbuddyUserMessage(input: unknown): WamfMessage | null {
  if (!Array.isArray(input)) return null;
  const text = workbuddyAdapter.extractUserText(input);
  if (!text) return null;
  return { role: "user", content: text };
}

function createWorkbuddyWamfClient(config: ProxyConfig): WamfClient | null {
  if (!config.wamf?.enabled || !config.wamf?.memory?.enabled || !config.wamf?.endpoint) return null;
  return new WamfClient({
    enabled: config.wamf.enabled,
    endpoint: config.wamf.endpoint,
    apiKey: config.wamf.apiKey,
    serviceId: config.wamf.serviceId,
    writeL0: config.wamf.memory.writeL0,
    recallL1: config.wamf.memory.recallL1,
    injectL2L3: config.wamf.memory.injectL2L3,
    l1Limit: config.wamf.memory.l1Limit,
    l2Limit: config.wamf.memory.l2Limit,
    timeoutMs: config.wamf.memory.timeoutMs,
  });
}

function buildWorkbuddyArchiveCtx(args: {
  config: ProxyConfig;
  sessionInfo: Record<string, unknown> | null | undefined;
  injectionSkipped: boolean;
  input: unknown[];
  sessionKey: string;
  userId: string;
  callerUserKey?: string | null;
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
}): WorkbuddyArchiveCtx | null {
  const { sessionInfo, injectionSkipped } = args;
  if (injectionSkipped || !sessionInfo) return null;

  // When chat_memory=false the user explicitly turned memory off -> do not create wamfClient; skill archiving still proceeds.
  // Aligned with codexHandler.buildArchiveCtx (line 855-857).
  const wamfClient = args.assetCapabilities?.chat_memory === false
    ? null
    : createWorkbuddyWamfClient(args.config);
  const wamfIdentity = deriveWamfIdentity({
    sessionInfo,
    userId: args.userId || null,
    sessionKey: args.sessionKey,
    userKey: args.callerUserKey ?? null,
  });
  const wamfUserMessage = extractLatestWorkbuddyUserMessage(args.input);

  return {
    config: args.config,
    sessionKey: args.sessionKey,
    agentSource: "workbuddy",
    sessionInfo,
    userId: args.userId,
    input: args.input,
    wamfClient,
    wamfIdentity,
    wamfUserMessage,
    assetCapabilities: args.assetCapabilities,
  };
}

/**
 * After the stream ends, trigger the WAMF L0 write + skill extraction, aligned with codexHandler's
 * triggerCodexArchiveHooks logic. Failures are silent (already warned internally) and do not block downstream.
 *
 * @param ctx         archive context (valid when non-null)
 * @param assistantText assistant text accumulated by the stream accumulator
 */
async function triggerWorkbuddyArchiveHooks(
  ctx: WorkbuddyArchiveCtx,
  assistantText: string,
  toolCallCountOverride?: number,
): Promise<void> {
  // ── WAMF L0 write ──
  // Symmetric with codexHandler triggerCodexArchiveHooks:
  //   trackWrite hangs on the global in-flight set (index.ts flushPendingWrites as the fallback)
  //   withL0Retry 3 backoff retries shield against brief wamf kernel outages
  //   no await in the stream scenario, letting the archive hook return early
  //
  // Note: buildWorkbuddyArchiveCtx already sets wamfClient to null when chat_memory=false,
  // so there is no need to check assetCapabilities.chat_memory again here; when wamfClient is null it is naturally skipped.
  if (ctx.wamfClient && ctx.wamfIdentity && isExtractionAllowed(ctx.config, "wamf-memory")) {
    trackWrite(
      withL0Retry(() =>
        recordWamfTurn(ctx.wamfClient!, ctx.wamfIdentity, ctx.wamfUserMessage, assistantText || null),
      ).catch((err: unknown) => {
        console.warn("[workbuddy-wamf-l0] failed:", err instanceof Error ? err.message : String(err));
      }),
    );
  } else if (ctx.wamfClient) {
    logExtractionSkipped(ctx.config, "wamf-memory", ctx.sessionKey);
  }

  // ── Skill conversation/add trigger ──
  // Symmetric with codexHandler: return only after the archive write finishes, ensuring the next round on another node reads the latest buffer.
  // assistantMessage uses the stream accumulator's outputText to assemble a
  // Responses API format message (type:"message", role:"assistant",
  // content:[{type:"output_text", text}]) -- consistent with codexHandler.
  //
  // protocol must be passed as "responses": the comment in server.ts explicitly states that WorkBuddy and Codex share a protocol,
  // and the langfuse tag also uses "protocol:responses". If "openai" were wrongly passed, then during skill extraction
  // normalizeConversation would parse messages[] in the Chat Completions format,
  // misaligned with the actual body.input[] (Responses API).
  if (isExtractionAllowed(ctx.config, "skill")) {
    const assistantMessage = assistantText
      ? {
          type: "message" as const,
          role: "assistant" as const,
          content: [{ type: "output_text" as const, text: assistantText }],
        }
      : null;
    await triggerSkillExtractIfReady({
      config: ctx.config,
      sessionKey: ctx.sessionKey,
      agentSource: "workbuddy",
      sessionInfo: ctx.sessionInfo,
      inputMessages: ctx.input,
      assistantMessage,
      protocol: "responses",
      assetCapabilities: ctx.assetCapabilities,
      toolCallCountOverride,
    });
  } else {
    logExtractionSkipped(ctx.config, "skill", ctx.sessionKey);
  }
}

// ── Upstream helpers ─────────────────────────────────────────────────────────

/**
 * Structure the workbuddy request body into the `input` field of the langfuse observation.
 *
 * workbuddy uses the Responses API; the request body shape:
 *   - body.input:        Array<InputItem> (always present, user messages / tool outputs, etc.)
 *   - body.instructions: string           (optional, system-level instructions)
 *
 * Combination strategy (reduce langfuse UI nesting levels as much as possible):
 *   - with instructions -> return { input, instructions }
 *   - input only       -> return body.input directly
 *   - both missing         -> return undefined (the langfuse side writes no input field)
 */
function buildWorkbuddyLangfuseInput(body: Record<string, unknown>): unknown {
  const hasInput = Array.isArray(body.input);
  const hasInstructions =
    typeof body.instructions === "string" && (body.instructions as string).length > 0;
  if (!hasInput && !hasInstructions) return undefined;
  if (hasInput && hasInstructions) {
    return { input: body.input, instructions: body.instructions };
  }
  return hasInput ? body.input : { instructions: body.instructions };
}

function buildUpstreamHeaders(c: Context, config: ProxyConfig): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) h[k] = v;
  }
  if (config.upstream.apiKey) {
    h["authorization"] = `Bearer ${config.upstream.apiKey}`;
    delete h["x-api-key"];
  }
  return h;
}

function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((v, k) => {
    if (!SKIP_RESPONSE_HEADERS.has(k.toLowerCase())) out.set(k, v);
  });
  return out;
}

/**
 * Forward the request to upstream. On SSE responses with `lf != null`, tees
 * the stream and reports usage/text to langfuse (best-effort).
 */
async function forwardToUpstream(
  c: Context,
  config: ProxyConfig,
  body: Record<string, unknown>,
  traceId: string,
  startTime: string,
  keyId: string,
  modelId: string,
  pipe: ReturnType<typeof createPipeline>,
  lf: LangfuseTurnContext | null,
  archiveCtx: WorkbuddyArchiveCtx | null = null,
): Promise<Response> {
  // ── Per-agent upstream override ──
  // Aligned with codexHandler: support config.upstream.agents?.workbuddy specifying its own URL/apiKey,
  // falling back to the global config.upstream.{url,apiKey} when unconfigured.
  const perAgent = (config.upstream as unknown as {
    agents?: { workbuddy?: { url?: string; apiKey?: string } };
  }).agents?.workbuddy;
  const upstreamBase = ((perAgent?.url ?? config.upstream.url ?? "") as string).replace(/\/$/, "");
  const upstreamPath = c.req.path.replace(/^\/workbuddy\/[^/]+/, "");
  let upstreamUrl = joinUrl(upstreamBase, upstreamPath);

  const headers = buildUpstreamHeaders(c, config);
  // If per-agent specifies its own apiKey, override the globally injected authorization
  if (perAgent?.apiKey) {
    headers["authorization"] = `Bearer ${perAgent.apiKey}`;
    delete headers["x-api-key"];
  }

  // ── Instance upstream config override ──
  {
    const spaceId = extractSpaceIdFromPath(c.req.path) ?? "";
    const instanceConfigs = await getInstanceUpstreamConfigs(config.coreSkill, spaceId);
    const convCfg = resolveUpstreamConfig(instanceConfigs, "workbuddy", "conversation");
    if (shouldOverride(convCfg)) {
      upstreamUrl = joinUrl(convCfg.base_url, upstreamPath);
      if (convCfg.mode === "custom_unified" && convCfg.api_key) {
        headers["authorization"] = `Bearer ${convCfg.api_key}`;
        delete headers["x-api-key"];
      }
      if (convCfg.model_id && typeof body.model === "string") {
        body.model = convCfg.model_id;
      }
    }
  }

  const bodyStr = JSON.stringify(body);

  // Structured telemetry: aligned with codex (three-stage forwardStart / forwardDone / info)
  pipe.forwardStart(upstreamUrl);

  // usage.log records the request (for operations / billing statistics), aligned with the codex writeLog usage
  try {
    writeLog(config, {
      timestamp: startTime,
      event: "request",
      modelId,
      keyId,
      sessionKey: keyId,
      upstreamUrl,
      stream: true,
    });
  } catch {
    /* logger best-effort */
  }

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: bodyStr,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pipe.info("WORKBUDDY_FORWARD_ERR", msg);
    // Network-layer failure -> langfuse failure report, so that it is visible in online visualization
    if (lf) {
      try {
        langfuseReportFailure({
          lf,
          model: modelId,
          startTime,
          endTime: new Date().toISOString(),
          input: buildWorkbuddyLangfuseInput(body),
          statusMessage: `fetch_failed: ${msg}`.slice(0, 500),
          extraTags: ["error"],
          observationMetadata: {
            stage: "forward",
            stream: true,
            upstreamUrl,
            keyId,
          },
        });
      } catch (lfErr: unknown) {
        pipe.error("LANGFUSE_SPAN", lfErr);
      }
    }
    return c.json({ error: `Upstream fetch failed: ${msg}` }, 502);
  }

  const respHeaders = filterResponseHeaders(upstreamResp.headers);
  const contentType = upstreamResp.headers.get("content-type") ?? "";
  const isSSE = contentType.includes("text/event-stream");

  pipe.forwardDone(upstreamResp.status);

  // Upstream 4xx/5xx -> langfuse failure report (the body has already been consumed by the upstream and is not re-read, to avoid breaking the stream)
  if (lf && upstreamResp.status >= 400) {
    try {
      langfuseReportFailure({
        lf,
        model: modelId,
        startTime,
        endTime: new Date().toISOString(),
        input: buildWorkbuddyLangfuseInput(body),
        status: upstreamResp.status,
        statusMessage: `upstream_${upstreamResp.status}`,
        extraTags: ["error"],
        observationMetadata: {
          stage: "upstream",
          stream: true,
          upstreamUrl,
          keyId,
          content_type: contentType,
        },
      });
    } catch (lfErr: unknown) {
      pipe.error("LANGFUSE_SPAN", lfErr);
    }
  }

  // Non-SSE or no langfuse ctx → passthrough
  if (!isSSE || !upstreamResp.body || !lf) {
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  }

  // SSE + langfuse: tee & tap
  const [passStream, tapStream] = upstreamResp.body.tee();
  void consumeWorkbuddyStream(tapStream, {
    startTime,
    modelId,
    keyId,
    traceId,
    lf,
    config,
    pipe,
    archiveCtx,
    inputBody: body,
    upstreamUrl,
  });

  return new Response(passStream, {
    status: upstreamResp.status,
    headers: respHeaders,
  });
}

/**
 * WorkBuddy tap context -- the parameter type of consumeWorkbuddyStream.
 */
interface WorkbuddyTapContext {
  startTime: string;
  modelId: string;
  keyId: string;
  traceId: string;
  lf: LangfuseTurnContext | null;
  config: ProxyConfig;
  pipe: ReturnType<typeof createPipeline>;
  archiveCtx: WorkbuddyArchiveCtx | null;
  /**
   * The final body forwarded upstream (including the injected input[]). Used in two places:
   *   1) langfuse observation.input (buildWorkbuddyLangfuseInput)
   *   2) fallback -- currently unused, but aligned with codex for easier later extension
   */
  inputBody: Record<string, unknown>;
  /** Upstream URL, written into observationMetadata for troubleshooting */
  upstreamUrl: string;
}

/**
 * Consume an SSE stream from upstream, extract text + usage, report to
 * langfuse, then trigger L0 write + skill extraction hooks.
 * Runs asynchronously without blocking the downstream response.
 *
 * Key mechanisms (aligned with codex but keeping workbuddy's existing try/finally style):
 *   - 5-minute fallback setTimeout: forcibly wrap up once when the client disconnects or the upstream hangs without releasing
 *   - toolUseCount accumulation: in the Responses API `response.output_item.done` +
 *     `item.type==="function_call"` counts as one tool call; passed through to skill archiving
 *     as the round boundary criterion
 *   - buildWorkbuddyLangfuseInput(inputBody): structures body.input + instructions
 *     into langfuse observation.input, convenient for troubleshooting
 */
async function consumeWorkbuddyStream(
  stream: ReadableStream<Uint8Array>,
  ctx: WorkbuddyTapContext,
): Promise<void> {
  // aux passthrough: skip langfuse + archive hooks
  if (!ctx.lf) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let assistantText = "";
  let usage: Record<string, unknown> | undefined;
  let responseId: string | undefined;
  // Q: accumulate the number of function_calls within the current turn (round boundary criterion)
  let toolUseCount = 0;

  // P: 5-minute timeout fallback. An upstream or client disconnect may leave reader.read() hanging forever,
  // so setTimeout forces a cancel, avoiding a leaked tap coroutine. A flag is used rather than
  // throwing directly, because cancelling fetch's ReadableStream makes the main loop exit naturally.
  let streamCompleted = false;
  const timeoutHandle = setTimeout(() => {
    if (!streamCompleted) {
      ctx.pipe.error(
        "STREAM_TIMEOUT",
        new Error("Workbuddy stream reading exceeded 5 minutes"),
      );
      // Actively cancel the reader; the read loop will then receive done=true or an error and exit
      void reader.cancel().catch(() => {
        /* best-effort */
      });
    }
  }, 5 * 60 * 1000);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLines = frame
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6));
        if (dataLines.length === 0) continue;
        const payload = dataLines.join("\n");
        if (payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload) as Record<string, unknown>;
          const evtType = evt.type as string | undefined;
          if (evtType === "response.output_text.delta") {
            const delta = evt.delta;
            if (typeof delta === "string") assistantText += delta;
          }
          // Q: tool call counting (aligned with codex's criterion) -- +1 only on output_item.done
          // with item.type==="function_call"; do not put it in response.completed,
          // to avoid over- or under-counting.
          if (evtType === "response.output_item.done") {
            const item = evt.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") toolUseCount++;
            // The resp semantics in response.output_item.done are consistent with codex:
            // some upstreams emit usage/response.id together here (multiple
            // dones inside the stream); the completed branch below is the authoritative usage source.
            const resp = (evt.response ?? evt) as Record<string, unknown>;
            if (typeof resp?.id === "string") responseId = resp.id as string;
            if (resp?.usage && typeof resp.usage === "object") {
              usage = resp.usage as Record<string, unknown>;
            }
          }
          if (evtType === "response.completed") {
            const resp = (evt.response ?? evt) as Record<string, unknown>;
            if (typeof resp?.id === "string") responseId = resp.id as string;
            if (resp?.usage && typeof resp.usage === "object") {
              usage = resp.usage as Record<string, unknown>;
            }
          }
        } catch {
          /* ignore malformed frames */
        }
      }
    }
  } catch (err) {
    ctx.pipe.info("WORKBUDDY_STREAM_ERR", err instanceof Error ? err.message : String(err));
  } finally {
    streamCompleted = true;
    clearTimeout(timeoutHandle);
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }

  const endTime = new Date().toISOString();
  try {
    // R: report with the structured input (body.input + instructions), convenient for langfuse UI troubleshooting
    langfuseReportGeneration({
      traceId: ctx.lf.traceId,
      name: `workbuddy:${ctx.modelId}`,
      model: ctx.modelId,
      startTime: ctx.startTime,
      endTime,
      input: buildWorkbuddyLangfuseInput(ctx.inputBody),
      output: assistantText,
      usage: usage && Object.keys(usage).length > 0 ? usage : undefined,
      traceName: ctx.lf.traceName,
      userId: ctx.lf.userId,
      sessionId: ctx.lf.sessionId,
      tags: ctx.lf.tags,
      traceInput: ctx.lf.userQuery || undefined,
      traceOutput: assistantText,
      observationMetadata: {
        stream: true,
        response_id: responseId,
        keyId: ctx.keyId,
        upstreamUrl: ctx.upstreamUrl,
        tool_use_count: toolUseCount,
      },
    });
  } catch (err) {
    ctx.pipe.info(
      "WORKBUDDY_LANGFUSE_ERR",
      err instanceof Error ? err.message : String(err),
    );
  }

  // ── WAMF L0 write + Skill extraction ──
  // Aligned with codexHandler triggerCodexArchiveHooks: trigger archiving after the langfuse report.
  // archiveCtx=null (aux / uninitialized session / bypass) skips directly.
  // Q: toolUseCount is passed through to skill archiving as the round boundary criterion.
  if (ctx.archiveCtx && assistantText) {
    await triggerWorkbuddyArchiveHooks(ctx.archiveCtx, assistantText, toolUseCount).catch(
      (err: unknown) => {
        ctx.pipe.info(
          "WORKBUDDY_ARCHIVE_ERR",
          err instanceof Error ? err.message : String(err),
        );
      },
    );
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

/**
 * WorkBuddy endpoint handler.
 *
 * 10-stage flow (aligned with the codex/anthropic/openai handlers, convenient for side-by-side reading):
 *   1. Auth        - Bearer token / x-api-key signature verification
 *   2. Body- parse the JSON body
 *   3. Headers     - extract the lower-cased request header map
 *   4. Classify    - main vs auxiliary
 *   5. Aux         - short-circuit passthrough (no injection, no langfuse reporting)
 *   6. Session ID  - extract the session id from header/body, construct the langfuse turn ctx
 *   7. Session init- reuse the CB state machine (handleSessionInit, agentSource="codex")
 *                   + the codex form builder renders the Responses API SSE popup
 *   8. Mem command - / command interception (when the session is registered)
 *   9. Injection   - the generic injection pipeline, injecting into body.input[0].content[]
 *   10. Forward    - forward upstream + tap SSE to report to langfuse
 */
export async function handleWorkbuddyEndpoint(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();
  const path = c.req.path;

  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const rawAuth = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const rawXApiKey = c.req.header("x-api-key") ?? "";
  const apiKey =
    extractBearerToken(rawAuth) ??
    rawXApiKey ??
    "";
  const spaceId = extractSpaceIdFromPath(path) ?? "";
  const { userId, rejected: userKeyRejected, rejectReason } = await verifyUserKey(
    apiKey,
    spaceId,
  );
  if (userKeyRejected) {
    return c.json({ error: `Authentication failed: ${rejectReason ?? "unknown"}` }, 401);
  }
  const keyId = userId || (apiKey ? apiKeyToKeyId(apiKey) : "unknown");

  // ── 2. Read body ─────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // ── 3. Extract headers ───────────────────────────────────────────────────
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    headers[k.toLowerCase()] = v;
  }

  // ── 4. Classify request ──────────────────────────────────────────────────
  // When workbuddyRequestRouting.enabled is off, it is forcibly treated as main, taking the old path exactly equivalent to aux routing
  // not being enabled. An ops rollback insurance; enabled by default. Aligned with the semantics of CC's ccRequestRouting.enabled,
  // but with the opposite default (CC defaults to false for gradual rollout; WB defaults to true for conservative rollback).
  const wbRoutingEnabled = config.workbuddyRequestRouting?.enabled !== false;
  const requestKind = wbRoutingEnabled
    ? classifyWorkbuddyRequest(body, path, headers)
    : "main";
  const isAuxiliary = requestKind === "auxiliary";

  const requestedModel = typeof body.model === "string" ? body.model : "";
  const modelId = resolveModelId(config.creditPricing, requestedModel);
  const pipe = createPipeline(config, traceId, modelId);

  // ── 5. Aux passthrough ───────────────────────────────────────────────────
  if (isAuxiliary) {
    pipe.info("WORKBUDDY_AUX", `auxiliary request → passthrough (path=${path})`);
    return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, null, null);
  }

  // ── 6. Session ID + langfuse turn ctx ────────────────────────────────────
  const sessionId = extractWorkbuddySessionId(headers, body);
  const sessionKey = sessionId ?? `${keyId}:${traceId}`;
  const agentSource = "workbuddy";
  const isStream = body.stream !== false;
  const callerUserKey = apiKey || null;

  const turnSeq = countHumanTurnsWorkbuddy(body.input);
  const userQuery = workbuddyAdapter.extractUserText(body.input) ?? "";
  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(sessionKey, turnSeq),
    turnSeq,
    traceName: `${modelId} / ${keyId}`,
    userId: keyId,
    sessionId: sessionKey,
    tags: [
      `agent_source:${agentSource}`,
      "protocol:responses",
      isStream ? "stream" : "non-stream",
      `session:${sessionKey}`,
    ],
    routeTags: [],
    userQuery,
  };

  // ── 7. Session-init state machine (reuses CB with agentSource="codex") ───
  //
  // WorkBuddy and codex share the same Responses API wire, so the popup skeleton directly reuses buildFormResponse of codex/form.ts
  // + the CB state machine (handleSessionInit + agentSource="codex").
  // The agentSource passed here is "codex" rather than "workbuddy" -- because the state machine internally relies on source to decide:
  //   - whether to take the two-step pagination (codex-only)
  //   - Default gate string recognition
  //   - whether formData.{teamPage,agentPage,taskPage} is filled
  // All three are codex-client-specific behaviours, and so is WorkBuddy. The agent_source on the langfuse tag / log side
  // stays "workbuddy" and is unaffected.
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("./injection/types.js").AssetCapabilityFlags | undefined;
  let injectionSkipped = false;
  let cachedAgentDetail: unknown = null;
  let cachedTaskDetail: unknown = null;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamName?: string; teamIdShort: string; taskName?: string | null; bypassed?: boolean } | null = null;

  const input = Array.isArray(body.input) ? body.input : [];

  // ── mem:session-reset pre-hook ──
  {
    const { isSessionResetCommand } = await import("./mem-command/pre-intercept.js");
    if (isSessionResetCommand(body as Record<string, unknown>, agentSource)) {
      const { parseCommandFromText } = await import("./mem-command/index.js");
      const { workbuddyAdapter } = await import("./agent-adapters/workbuddy.js");
      const userText = workbuddyAdapter.extractUserText(input) ?? "";
      const memCmd = parseCommandFromText(userText);
      if (memCmd) {
        const { getSessionStore } = await import("./session/store.js");
        const store = getSessionStore();
        const compositeKey = `codex:${sessionKey}`;
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
        console.log(`[mem-command:pre] session-reset session=${sessionKey} → falling through to pop form`);
      }
    }
  }

  if (config.sessionInit?.enabled && sessionId) {
    try {
      const { getSessionStore, handleSessionInit, parsePresetIdentity } = await import(
        "./session/index.js"
      );
      const { getMetadataClient } = await import("./meta/client.js");
      const store = getSessionStore();
      // The kernel-side authenticated x-wamf-user-key directly uses the client's request bearer (aligned with codexHandler / anthropicHandler).
      // The bearer carried by WorkBuddy / Codex / Claude Code desktop clients is the user key, which the kernel can recognize;
      // no config.wamf.apiKey fallback is needed (otherwise the "local" in config would override the real user key, causing 401).
      const metadataClient = getMetadataClient(config.coreSkill, spaceId, apiKey);
      const presetIdentity = parsePresetIdentity(config.sessionInit, headers);

      const compositeKey = `codex:${sessionKey}`;
      const identity = {
        userId: userId || "anonymous",
        agentSource: "codex" as const,
        sessionId: sessionKey,
        spaceId,
      };
      const recovered = await store.getOrRecover(compositeKey, identity, {
        metadataClient,
        // Responses API clients do not use messages[]; passing empty lets the store take the header/no-message recovery path
        messages: [],
      });

      let initResult: Awaited<ReturnType<typeof handleSessionInit>>;
      const isTerminalState = recovered?.status === "initialized";
      // The Recovery hit source decides whether prewarm is needed (see the comment at the symmetric position in handler.ts for details).
      const needsPrewarm =
        recovered?.__recoverySource === "l2b" ||
        recovered?.__recoverySource === "history-scan";

      if (recovered && isTerminalState) {
        // Recovered from L2b/L2a — skip form, apply context
        const { buildSessionContextBlockWithToggles } = await import(
          "./session/context-injector.js"
        );
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
          messages: [],
          systemAppend,
          sessionInfo: recovered.sessionInfo,
          agentDetail: recovered.agentDetail,
          taskDetail: recovered.taskDetail,
          bypassed: recovered.bypassed,
          justRegistered: needsPrewarm,
        };
      } else {
        // Run the state machine — reuses CB's handleSessionInit with
        // agentSource="codex". CB parses picks from `messages[]`, but codex/workbuddy
        // clients send them as `function_call_output.output` items in body.input[].
        // We use codexFormAnswersAsMessages to synthesize the output into a minimal messages[]
        // for CB's extractor to recognize (the extractor only looks at the last user/tool message text).
        const synthesizedMessages = codexFormAnswersAsMessages(input);
        const rawOutputs = input
          .filter((it: any) => it?.type === "function_call_output")
          .map((it: any) => ({
            call_id: it.call_id,
            output_preview: String(it.output ?? "").slice(0, 200),
          }));
        if (rawOutputs.length > 0) {
          console.log(
            `[workbuddy-debug] session=${sessionKey} function_call_outputs=${JSON.stringify(rawOutputs)} synth_msgs=${JSON.stringify(synthesizedMessages).slice(0, 500)}`,
          );
        }
        initResult = await handleSessionInit(
          sessionKey,
          userId || null,
          synthesizedMessages,
          config.sessionInit,
          store,
          {
            stream: isStream,
            modelId: modelId as string,
            protocol: "responses" as any,
            // Hand the raw input[] to the CB state machine to recognize the Default gate and MORE paging
            codexAnswerInput: input,
          },
          "codex", // <- state machine source: reuse the codex branch
          metadataClient,
          apiKey,
          spaceId,
          presetIdentity,
        );
      }

      if (initResult.intercepted) {
        // CB state machine interrupted -> use the codex form builder to render it into a Responses API SSE popup
        if (initResult.formData) {
          return buildCodexFormResponse({
            teams: initResult.formData.teams,
            stage: initResult.formData.stage,
            selectedTeamId: initResult.formData.selectedTeamId,
            selectedAgentId: initResult.formData.selectedAgentId,
            retry: initResult.formData.retry,
            teamPage: initResult.formData.teamPage ?? 0,
            agentPage: initResult.formData.agentPage ?? 0,
            taskPage: initResult.formData.taskPage ?? 0,
            stream: isStream,
            modelId: initResult.formData.modelId ?? (modelId as string),
          });
        }
        // Defensive fallback
        if (initResult.response) return initResult.response;
      }

      // Default gate first hit -> return a Plan mode hint once; later requests of the same session have recovered.bypassed=true
      if ((initResult as any).bypassReason === "default-gate") {
        pipe.info("WORKBUDDY_GATE", "Default mode gate detected → notify user (first hit)");
        const { buildMemResponse } = await import("./mem-command/response-builder.js");
        // Gate in the reset scenario: swapped for targeted text, see the same-named section in codexHandler
        const gateText = (initResult as any).resetFlow
          ? "⚠️ mem:session-reset needs Plan mode.\n\n"
            + "The workbuddy client is not in Plan mode, so the asset selection form cannot open.\n"
            + "Switch to Plan mode, then run mem:session-reset again."
          : "Plan mode is not on, so this session runs without asset injection."
            + "To manage Skills / Tasks / Agents, switch to Plan mode and start a new session."
            + "This message is answered by the LLM directly.";
        return buildMemResponse(gateText, {
          protocol: "responses",
          stream: isStream,
          requestId: `workbuddy-gate-${Date.now()}`,
        });
      }

      if (initResult.bypassed) {
        injectionSkipped = true;
        console.log(
          `[workbuddy] session=${sessionKey} bypassed (reason=${(initResult as any).bypassReason ?? "unknown"}) → skipping injection`,
        );
        if (initResult.resetFlow) {
          _resetFlowResult = { agentName: "", agentIdShort: "", teamIdShort: "", bypassed: true };
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
        } catch (err) {
          console.warn(
            `[workbuddy] asset-capability resolve failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Prewarm pre-check short-circuit: turns where mem-command hits do not forward and do not consume the hook-cache;
      // prewarming as usual would waste 2-3s + 3 network requests. See the detailed note at the symmetric position in handler.ts.
      let memCommandPending = false;
      {
        try {
          const userTextPeek = workbuddyAdapter.extractUserText(input);
          if (userTextPeek) {
            const { parseCommandFromText } = await import("./mem-command/index.js");
            const peek = parseCommandFromText(userTextPeek);
            if (peek) {
              memCommandPending = true;
              console.log(`[workbuddy] prewarm skipped: mem-command pending (cmd=${peek.command}) session=${sessionKey}`);
            }
          }
        } catch (err) {
          console.warn(
            "[workbuddy] pre-prewarm peek failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

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
            callerUserKey: callerUserKey ?? undefined,
          }, { clearBefore: true });
        } catch (err) {
          console.warn(
            "[workbuddy] prewarm error:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      if (sessionInfo && !sessionInfo.space_id && spaceId) {
        sessionInfo.space_id = spaceId;
      }
      cachedAgentDetail = initResult.agentDetail ?? null;
      cachedTaskDetail = initResult.taskDetail ?? null;

      if (initResult.resetFlow && initResult.justRegistered && !initResult.bypassed) {
        _resetFlowResult = {
          agentName: initResult.agentDetail?.name ?? "unknown",
          // The agentIdShort field name keeps the historical one, but here **the full agent_id is stored** (e.g. agt-1celthr7yn).
          // Previously slice(-8) truncated to "elthr7yn", which users could not understand, symmetric with the team truncation problem.
          agentIdShort: (initResult.sessionInfo as Record<string, unknown>)?.agent_id
            ? String((initResult.sessionInfo as Record<string, unknown>).agent_id) : "",
          // teamName comes from the session-init return value (looked up from cachedTeams);
          // the teamIdShort field name keeps the historical one, but here **the full team_id is stored** (e.g. team-wyuyb7sion).
          // Previously slice(-8) kept only the last 8 chars, so users saw truncated strings like "uyb7sion", combined with
          // the often-empty teamName the fallback path displayed extremely incompletely. The team id itself is short, so full display is harmless.
          teamName: initResult.teamName ?? undefined,
          teamIdShort: (initResult.sessionInfo as Record<string, unknown>)?.team_id
            ? String((initResult.sessionInfo as Record<string, unknown>).team_id) : "",
          taskName: initResult.taskDetail?.name,
        };
      }
    } catch (err: unknown) {
      console.error(
        "[workbuddy] session-init error:",
        err instanceof Error ? err.message : String(err),
      );
      sessionInfo = undefined;
      injectionSkipped = true;
    }
  }

  // -- mem:session-reset completion confirmation ---------------------------------
  if (_resetFlowResult) {
    const { agentName, agentIdShort, teamName, teamIdShort, taskName, bypassed } = _resetFlowResult;
    // Team line assembly: prefer team_name (short-id); when team_name is not found at least show the short-id
    // as a fallback (better than dropping everything); if both are empty the whole line is omitted.
    const teamLine = teamName
      ? `- **Team**: ${teamName}${teamIdShort ? ` (${teamIdShort})` : ""}`
      : teamIdShort
        ? `- **Team**: ${teamIdShort}`
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
    console.log(`[mem-command:session-reset] completed: bypassed=${!!bypassed} agent=${agentName} (${agentIdShort}) team=${teamName ?? "-"} (${teamIdShort || "-"})`);
    return buildMemResponse(text, {
      protocol: "responses",
      stream: isStream,
      requestId: `mem-reset-${Date.now()}`,
    });
  }

  // ── 8. mem-command intercept ────────────────────────────────────────────
  {
    const userText = workbuddyAdapter.extractUserText(input);
    if (userText) {
      const { parseCommandFromText, executeMemCommand, buildMemResponse, extractSimpleMessages, truncateArgs } =
        await import("./mem-command/index.js");
      // WARNING: do not use parseMemCommand(body, "workbuddy") -- it only parses body.messages[] (the CC/CB shape),
      // while WorkBuddy uses the Responses API (body.input[]); passing it in always returns null -> the command silently passes through to the LLM.
      // Use parseCommandFromText(userText) to parse the user text directly instead. Aligned with codexHandler's approach.
      let memCmd = parseCommandFromText(userText);
      // session-reset has already been handled by the pre-hook; skip it to prevent duplicate execution
      if (memCmd?.command === "session-reset") memCmd = null;
      if (memCmd) {
        if (!sessionInfo || injectionSkipped) {
          const errText = `⚠️ The session is not set up yet, so this command is unavailable. Finish session setup (choose a Team/Agent) and try again.`;
          const errResponse = buildMemResponse(errText, {
            protocol: "responses",
            stream: isStream,
            requestId: `mem-cmd-${Date.now()}`,
          });
          console.log(
            `[workbuddy] mem-command cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} blocked: session not initialized`,
          );
          return errResponse;
        }
        pipe.info("WORKBUDDY_MEM_CMD", `mem command intercepted: ${memCmd.command}`);
        const memResult = await executeMemCommand(memCmd, {
          sessionKey,
          agentSource: "workbuddy",
          config,
          spaceId,
          userId: userId || "",
          apiKey: apiKey || "",
          sessionInfo: sessionInfo as Record<string, unknown>,
          // WARNING: WorkBuddy uses the Responses API, the same protocol as codex. Pass "responses";
          // executeMemCommand will internally render the command response with the corresponding responses SSE skeleton.
          protocol: "responses",
          stream: isStream,
          args: memCmd.args,
          // The task command family uses recent conversation to generate a draft. Responses API body.input[] structure:
          //   { type:"message", role, content:[{type:"input_text"|"output_text", text}] }
          // extractSimpleMessages already has built-in recognition of this shape, converting to the minimal {role, content} format.
          bodyMessages: extractSimpleMessages(input),
          // Plan D: the taskDraft LLM follows the main model -- workbuddy is a fixed agent, the upstream reuses the per-agent url
          model: modelId,
          upstreamUrl: config.upstream.agents?.["workbuddy"]?.url || config.upstream.url,
          // WARNING: the workbuddy client's main-path upstream goes through OpenAI chat/completions
          // (path ending: /workbuddy/<id>/chat/completions), which is unrelated to ctx.protocol="responses"
          // (that is only used to render the response SSE skeleton).
          upstreamProtocol: "openai",
        });

        // ── WAMF L0 write + Skill extraction (fire-and-forget) ──
        // Aligned with codexHandler's post-mem-command archive logic: the command execution result does not block the response,
        // and L0 write + skill extraction + langfuse reporting are triggered asynchronously.
        //
        // assistantText uses memResult.messageText (the command response the proxy gives the user), not
        // userText (the command the user typed) -- the L0 write writes the pairing of "what the user asked / what the system answered",
        // and using userText as assistant would invert the semantics.
        const memArchiveCtx = buildWorkbuddyArchiveCtx({
          config,
          sessionInfo,
          injectionSkipped,
          input,
          sessionKey,
          userId: userId || "",
          callerUserKey,
          assetCapabilities,
        });
        if (memArchiveCtx) {
          void triggerWorkbuddyArchiveHooks(memArchiveCtx, memResult.messageText ?? "").catch((err: unknown) => {
            pipe.info(
              "WORKBUDDY_MEM_ARCHIVE_ERR",
              err instanceof Error ? err.message : String(err),
            );
          });
        }

        // ── Langfuse report for mem-command ──
        const endTime = new Date().toISOString();
        try {
          langfuseReportGeneration({
            traceId: lf.traceId,
            name: `workbuddy:${modelId}:mem-${memCmd.command}`,
            model: modelId,
            startTime: startTime,
            endTime,
            input: userText ?? undefined,
            output: memResult.messageText ?? "OK",
            usage: undefined,
            traceName: lf.traceName,
            userId: lf.userId,
            sessionId: lf.sessionId,
            tags: [...lf.tags, `mem_cmd:${memCmd.command}`],
            traceInput: userText ?? undefined,
            traceOutput: memResult.messageText ?? "OK",
            observationMetadata: {
              mem_command: memCmd.command,
              protocol: "responses",
            },
          });
        } catch (err: unknown) {
          pipe.info(
            "WORKBUDDY_MEM_LANGFUSE_ERR",
            err instanceof Error ? err.message : String(err),
          );
        }

        console.log(
          `[workbuddy] mem-command cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} success=${memResult.success}`,
        );
        return memResult.response;
      }
    }
  }

  // -- 9. Asset injection (runs every round) -----------------------------------
  if (
    !injectionSkipped &&
    sessionInfo &&
    config.injection?.enabled &&
    (config.injection.injectors?.length ?? 0) > 0
  ) {
    try {
      const { getInjectionPipeline } = await import("./injection/index.js");
      const pipeline = getInjectionPipeline(config);
      const { buildSessionContextBlockWithToggles } = await import(
        "./session/context-injector.js"
      );
      const sessionContextBlock = buildSessionContextBlockWithToggles(
        cachedAgentDetail as import("./session/types.js").AgentDetail | null,
        cachedTaskDetail as import("./session/types.js").TaskDetail | null,
        config.sessionInit,
        sessionKey,
      );

      // Construct a synthetic OpenAI body for the generic pipeline to process
      const syntheticBody: Record<string, unknown> = {
        messages: [
          { role: "system", content: sessionContextBlock ?? "" },
          { role: "user", content: userQuery || "." },
        ],
        model: modelId,
      };
      const injectedBody = await pipeline.process(syntheticBody, {
        protocol: "openai",
        traceId,
        keyId,
        modelId: modelId as string,
        stream: isStream,
        agentSource,
        userId: userId || "anonymous",
        spaceId,
        sessionKey,
        turnSeq,
        requestPath: path,
        custom: {
          session: sessionInfo,
          userKey: callerUserKey ?? undefined,
          assetCapabilities,
        },
      });

      const injectedMessages = injectedBody.messages as
        | Array<Record<string, unknown>>
        | undefined;
      const sysMsg = injectedMessages?.[0];
      const injectedText = typeof sysMsg?.content === "string" ? sysMsg.content : "";

      if (injectedText.length > 0) {
        body = injectWorkbuddyAssets(body, { raw: injectedText });
      }
    } catch (err: unknown) {
      console.error(
        "[workbuddy] injection pipeline error:",
        err instanceof Error ? err.message : String(err),
      );
      // Degrade gracefully: forward without injection
    }
  }

  // ── 10. Forward ──────────────────────────────────────────────────────────
  const archiveCtx = buildWorkbuddyArchiveCtx({
    config,
    sessionInfo,
    injectionSkipped,
    input,
    sessionKey,
    userId: userId || "",
    callerUserKey,
    assetCapabilities,
  });
  return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, lf, archiveCtx);
}
