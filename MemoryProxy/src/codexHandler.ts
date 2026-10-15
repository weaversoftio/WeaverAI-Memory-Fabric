/**
 * Codex Responses API handler.
 *
 * Handles `POST /v1/responses` + 3 aux endpoints (`/responses/compact`,
 * `/memories/trace_summarize`, `/realtime/calls`) for the Codex CLI client.
 *
 * Protocol: OpenAI Responses API — third independent path alongside
 * anthropicHandler (Anthropic Messages) and handler (OpenAI Chat Completions).
 *
 * Internal dispatch:
 *   /v1/responses               → main loop (session-init + injection + forward)
 *   /v1/responses/compact       → aux passthrough (no injection, credit only)
 *   /v1/memories/trace_summarize → aux passthrough
 *   /v1/realtime/calls          → aux passthrough
 *   other codex paths           → 404
 *
 * Session-init flow:
 *   1. Extract session_id from header/body
 *   2. Check sessionStore for binding
 *   3. If unbound → call handleSessionInit (reuses CB state machine with
 *      agentSource="codex", protocol="responses") → return request_user_input form
 *   4. Detect Default mode gate → permanent bypass
 *   5. If bound → inject assets via buildCodexInjectionBlock → forward
 *
 * See docs/2026-08-07-codex-integration-plan.md.
 */

import type { Context } from "hono";
import type { ProxyConfig } from "./types.js";
import { apiKeyToKeyId, extractBearerToken, uuidv7 } from "./opik.js";
import { createPipeline, writeLog } from "./logger.js";
import { extractSpaceIdFromPath } from "./credit-reporter.js";
import { joinUrl } from "./guard-adapter.js";
import { verifyUserKey } from "./auth.js";
import { resolveModelId } from "./pricing.js";
import { codexAdapter } from "./agent-adapters/codex.js";
import {
  DEFAULT_GATE_PREFIX,
  buildFormResponse as buildCodexFormResponse,
  codexFormAnswersAsMessages,
} from "./session/codex/form.js";
import { buildCodexInjectionBlock, type CodexInjectionInput } from "./common/codex-injection.js";
import { log } from "./report/log.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "./langfuse.js";
import { WamfClient } from "./wamf/client.js";
import { deriveWamfIdentity } from "./wamf/identity.js";
import { recordWamfTurn } from "./wamf/recorder.js";
import { trackWrite, withL0Retry } from "./wamf/pending-writes.js";
import type { WamfIdentity, WamfMessage } from "./wamf/types.js";
import { triggerSkillExtractIfReady } from "./skill/handler-glue.js";
import { isExtractionAllowed, logExtractionSkipped } from "./extraction-gate.js";
import {
  getInstanceUpstreamConfigs,
  resolveUpstreamConfig,
  shouldOverride,
} from "./instance-upstream-cache.js";
import { INTERNAL_REQUEST_HEADERS } from "./internal-headers.js";

// ── Constants ────────────────────────────────────────────────────────────────

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

// -- WAMF L0 helpers (aligned with the anthropicHandler / handler approach) ---------------------

/**
 * WAMF L0 client factory - same semantics as anthropicHandler.ts::createWamfClient.
 * spaceId takes priority over the config default serviceId, so that codex requests are reported to the correct
 * kernel instance under multi-tenancy. Returns null when config.wamf.memory.enabled=false.
 */
function createCodexWamfClient(config: ProxyConfig, spaceId?: string): WamfClient | null {
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
 * Extract the last real user text with role=user from codex `input[]` and assemble a WamfMessage.
 * The codex variant of wamf/recorder.ts::extractLatestUserMessage - the differences are in the
 * traversal criterion (type==="message" && role==="user") and the text source (content[].input_text).
 * Reuses codexAdapter.extractUserText, ensuring the same user question text as the langfuse traceInput in codexHandler
 * (docs/2026-08-07-codex-integration-plan.md section 9).
 */
function extractLatestCodexUserMessage(input: unknown): WamfMessage | null {
  if (!Array.isArray(input)) return null;
  const text = codexAdapter.extractUserText(input) ?? "";
  const trimmed = text.trim();
  if (!trimmed) return null;
  return { role: "user", content: trimmed };
}

// ── Codex session state (exported for unit tests) ────────────────────────────

export interface CodexSessionState {
  status: "initialized" | "pending";
  bypassed?: boolean;
  sessionInfo?: Record<string, unknown> | null;
}

// ── Aux detection (exported for unit tests) ──────────────────────────────────

/** Aux endpoint path suffixes — hardcoded in codex-rs/core/src/client.rs. */
const CODEX_AUX_PATH_SUFFIXES = new Set([
  "/responses/compact",
  "/memories/trace_summarize",
  "/realtime/calls",
]);

/** Known aux thread_source values. */
const CODEX_AUX_THREAD_SOURCES = new Set([
  "memory_consolidation",
  "system",
]);

/**
 * Classify a codex request as main or auxiliary.
 * Exported for unit tests.
 */
export function classifyCodexRequest(
  body: Record<string, unknown>,
  path: string,
  headers: Record<string, string>,
): "main" | "auxiliary" {
  // Signal 1: aux endpoint path suffix
  for (const suffix of CODEX_AUX_PATH_SUFFIXES) {
    if (path.endsWith(suffix)) return "auxiliary";
  }

  // Signal 2: x-openai-memgen-request header
  if (headers["x-openai-memgen-request"] === "true") return "auxiliary";

  // Signal 3: body.client_metadata.thread_source whitelist
  const meta = body.client_metadata as { thread_source?: string } | undefined;
  const ts = meta?.thread_source;
  if (typeof ts === "string" && CODEX_AUX_THREAD_SOURCES.has(ts)) return "auxiliary";

  return "main";
}

// ── Session ID extraction (exported for unit tests) ──────────────────────────

/**
 * Extract session_id from codex request.
 * Primary: `session-id` header. Fallback: `body.client_metadata.session_id`.
 */
export function extractCodexSessionId(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): string | null {
  if (headers["session-id"]) return headers["session-id"];
  const meta = body.client_metadata as { session_id?: string } | undefined;
  if (typeof meta?.session_id === "string") return meta.session_id;
  return null;
}

// ── Default mode gate detection (exported for unit tests) ────────────────────

/**
 * Scan codex input[] for the Default mode gate string in function_call_output.
 *
 * When the client is in Default mode, it intercepts `request_user_input` tool
 * calls and fabricates a `function_call_output.output` starting with
 * "request_user_input is unavailable in".
 *
 * This function is a historical utility; the actual interception logic is now internalized in the CB state machine
 * (the codex-only pre-checks section of session/codebuddy/init.ts). The export is kept
 * because codex-handler.test.ts has unit tests that use it directly to verify structure recognition.
 */
export function detectDefaultModeGate(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  // Only recognize the case where "the last item of input is the gate output": see the same-named comment in codebuddy/init.ts.
  const last = input[input.length - 1] as Record<string, unknown> | null | undefined;
  if (!last || typeof last !== "object") return false;
  if (last.type !== "function_call_output") return false;
  const output = last.output;
  return typeof output === "string" && output.startsWith(DEFAULT_GATE_PREFIX);
}

// ── Asset injection (exported for unit tests) ────────────────────────────────

/**
 * Inject `<wamf_injections>` wrapper into codex body.input[0].content[].
 *
 * Appends the injection block to the developer message (input[0]) content.
 * Defensive: if input[0] is not a message with an array content, returns
 * the body unchanged.
 *
 * Returns a shallow copy — original body is not mutated.
 */
export function injectCodexAssets(
  body: Record<string, unknown>,
  assets: CodexInjectionInput,
): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input) || input.length === 0) return body;

  const devMsg = input[0] as Record<string, unknown> | null;
  if (!devMsg || typeof devMsg !== "object") return body;
  if (devMsg.type !== "message") return body;

  const content = devMsg.content;
  if (!Array.isArray(content)) return body;

  const injectionBlock = buildCodexInjectionBlock(assets);

  // Shallow-copy chain: body → input → input[0] → content
  const newContent = [...content, injectionBlock];
  const newDevMsg = { ...devMsg, content: newContent };
  const newInput = [newDevMsg, ...input.slice(1)];
  return { ...body, input: newInput };
}

// ── Upstream request helpers ─────────────────────────────────────────────────

function buildUpstreamHeaders(
  c: Context,
  config: ProxyConfig,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = v;
    }
  }
  // Codex uses OpenAI protocol: inject Bearer token
  if (config.upstream.apiKey) {
    headers["authorization"] = `Bearer ${config.upstream.apiKey}`;
    delete headers["x-api-key"];
  }
  return headers;
}

function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out.set(key, value);
    }
  });
  return out;
}

// ── Main handler ─────────────────────────────────────────────────────────────

/**
 * Codex endpoint handler.
 *
 * Routes internally:
 *   - aux endpoints → lightweight passthrough
 *   - main /v1/responses → full pipeline (session-init, injection, mem-command, forward)
 */
export async function handleCodexEndpoint(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();
  const path = c.req.path;

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const apiKey =
    extractBearerToken(c.req.header("authorization") ?? c.req.header("Authorization") ?? "") ??
    c.req.header("x-api-key") ??
    "";

  const spaceId = extractSpaceIdFromPath(path) ?? "";
  const { userId, rejected: userKeyRejected, rejectReason } =
    await verifyUserKey(apiKey, spaceId);
  if (userKeyRejected) {
    return c.json(
      { error: `Authentication failed: ${rejectReason ?? "unknown"}` },
      401,
    );
  }

  const keyId = userId || (apiKey ? apiKeyToKeyId(apiKey) : "unknown");

  // ── 2. Read body ───────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // ── 3. Extract headers as plain object ─────────────────────────────────────
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    headers[k.toLowerCase()] = v;
  }

  // ── DEBUG: dump request_user_input tool schema once so we can see codex's
  //           expected arguments shape and fix our fake form. Remove after fix.
  try {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const rui = tools.find(
      (t: any) => t?.type === "function" && t?.name === "request_user_input" ||
                  t?.function?.name === "request_user_input" ||
                  t?.name === "request_user_input",
    );
    if (rui) {
      console.log("[codex-debug] request_user_input tool schema:", JSON.stringify(rui));
    }
  } catch {}

  // ── 4. Classify request ────────────────────────────────────────────────────
  const requestKind = classifyCodexRequest(body, path, headers);
  const isAuxiliary = requestKind === "auxiliary";
  // The call signature is resolveModelId(creditPricingConfig, requestedModel) - previously
  // the body was mistakenly passed as the first argument (config omitted), so the return value was the whole body object. This bug
  // has existed since the very first frame of the codex P1 integration, and was not noticed because codex was not wired to langfuse - after wiring it,
  // the Langfuse trace name / observation name all got an empty-string prefix like " / usr-xxx".
  // Aligned with the call approach of handler.ts:482 / anthropicHandler.ts.
  const requestedModel = typeof body.model === "string" ? body.model : "";
  const modelId = resolveModelId(config.creditPricing, requestedModel);

  const pipe = createPipeline(config, traceId, modelId);

  // ── 5. Aux passthrough ─────────────────────────────────────────────────────
  if (isAuxiliary) {
    pipe.info("CODEX_AUX", `auxiliary request → passthrough (path=${path})`);
    // aux is not reported to langfuse (aligned with CC/CB - sidequery/fork-type aux are not real conversation turns)
    return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, null);
  }

  // ── 6. Session ID extraction ───────────────────────────────────────────────
  const sessionId = extractCodexSessionId(headers, body);
  const sessionKey = sessionId ?? `${keyId}:${traceId}`;
  const agentSource = "codex";
  const isStream = body.stream !== false;

  const callerUserKey = apiKey || null;

  // ── 6b. Langfuse turn context (one trace = one turn) ────────────────────────
  // The codex turn number is derived from the count of "human inputs" in body.input[] (same convention as CC/CB;
  // tool-loop requests within the same turn compute the same turnSeq -> the same trace). The user question
  // goes through the codex adapter's extractUserText - codex uses input[] rather than messages[], and
  // the generic resolveLatestUserQuery relies on the costGuard profile going through messages[], which does not fit here.
  const turnSeq = countHumanTurnsCodex(body.input);
  const userQuery = codexAdapter.extractUserText(body.input) ?? "";
  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(sessionKey, turnSeq),
    turnSeq,
    traceName: `${modelId} / ${keyId}`,
    userId: keyId,
    sessionId: sessionKey,
    // The agent_source tag marks the client family; protocol:responses distinguishes codex's wire.
    tags: [
      `agent_source:${agentSource}`,
      "protocol:responses",
      isStream ? "stream" : "non-stream",
      `session:${sessionKey}`,
    ],
    routeTags: [],
    userQuery,
  };

  // ── 7. Session-init state machine ──────────────────────────────────────────
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("./injection/types.js").AssetCapabilityFlags | undefined;
  let injectionSkipped = false;
  let sessionJustRegistered = false;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamName?: string; teamId: string; taskName?: string | null; bypassed?: boolean } | null = null;
  // Store the agent/task detail of initResult for the section 9 injection stage to build <session_context>.
  // handleSessionInit would originally push it into session_context via messages[0], but that
  // messages is the temporary synthesizedMessages we passed in and never returns to the codex body.
  // Here the detail is captured explicitly, so that when synthesizing the body below, buildSessionContextBlockWithToggles
  // builds the same block and pre-fills it in front of the synthesized system message.
  let cachedAgentDetail: unknown = null;
  let cachedTaskDetail: unknown = null;

  const input = Array.isArray(body.input) ? body.input : [];

  // ── mem:session-reset pre-hook ──
  {
    const { isSessionResetCommand } = await import("./mem-command/pre-intercept.js");
    if (isSessionResetCommand(body as Record<string, unknown>, agentSource)) {
      const { parseCommandFromText } = await import("./mem-command/index.js");
      const { codexAdapter } = await import("./agent-adapters/codex.js");
      const userText = codexAdapter.extractUserText(input) ?? "";
      const memCmd = parseCommandFromText(userText);
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
        console.log(`[mem-command:pre] session-reset session=${sessionKey} → falling through to pop form`);
      }
    }
  }

  // ── 7. Session-init state machine (reuses CB with agentSource="codex") ────
  //
  // The old 7a (independent Default gate interception) + 7b.1 (independent MORE interception) have been folded into the CB state machine
  // (the codex-only pre-checks section at the top of session/codebuddy/init.ts). codexHandler is only
  // responsible for passing body.input[] through to reqCtx.codexAnswerInput so the state machine recognizes gate/MORE itself.
  // On the first Default gate hit it gets initResult.bypassReason === "default-gate", and this
  // handler returns a Plan-mode hint once; later requests of the same session pass through in the bypass steady state.
  if (config.sessionInit?.enabled && sessionId) {
    try {
      const { getSessionStore, handleSessionInit, parsePresetIdentity } = await import("./session/index.js");
      const { getMetadataClient } = await import("./meta/client.js");
      const store = getSessionStore();
      const metadataClient = getMetadataClient(config.coreSkill, spaceId, apiKey);
      const presetIdentity = parsePresetIdentity(config.sessionInit, headers);

      const compositeKey = `${agentSource}:${sessionKey}`;
      const identity = {
        userId: userId || "anonymous",
        agentSource,
        sessionId: sessionKey,
        spaceId,
      };
      const recovered = await store.getOrRecover(compositeKey, identity, {
        metadataClient,
        // Codex doesn't use messages[] — pass empty for recovery.
        // History-scan fallback won't find form markers but will
        // produce a one-shot bypass for existing conversations.
        messages: [],
      });

      let initResult: Awaited<ReturnType<typeof handleSessionInit>>;
      const isTerminalState = recovered?.status === "initialized";
      // The recovery hit source decides whether prewarm is needed (see the symmetric position comment in handler.ts).
      const needsPrewarm =
        recovered?.__recoverySource === "l2b" ||
        recovered?.__recoverySource === "history-scan";

      if (recovered && isTerminalState) {
        // Recovered from L2b/L2a — skip form, apply context
        const { buildSessionContextBlockWithToggles } = await import("./session/context-injector.js");
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
        // Run the state machine — codex reuses CB's handleSessionInit
        // with agentSource="codex". CB parses answers from `messages[]`, but
        // codex clients send answers as `function_call_output.output` items in
        // `body.input[]`. We synthesize a minimal `messages[]` array from those
        // outputs so CB's extractors (which look at the last user/tool message
        // text) find the pick verbatim. See session/codex/form.ts::codexFormAnswersAsMessages.
        const synthesizedMessages = codexFormAnswersAsMessages(input);
        // DEBUG: dump function_call_output raw text so we can tell whether the
        // client shows the form to the user (real answer) vs auto-fills (model-
        // generated answer). Also dump the extracted answers.
        const rawOutputs = input
          .filter((it: any) => it?.type === "function_call_output")
          .map((it: any) => ({ call_id: it.call_id, output_preview: String(it.output ?? "").slice(0, 200) }));
        if (rawOutputs.length > 0) {
          console.log(`[codex-debug] session=${sessionKey} function_call_outputs=${JSON.stringify(rawOutputs)} synth_msgs=${JSON.stringify(synthesizedMessages).slice(0, 500)}`);
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
            // Hand the original input[] to the CB state machine, used to recognize the codex-client-specific
            // Default gate string and the MORE paging marker.
            codexAnswerInput: input,
          },
          agentSource,
          metadataClient,
          apiKey,
          spaceId,
          presetIdentity,
        );
      }

      if (initResult.intercepted) {
        // CB state machine intercepted -> re-render the formData (which already carries pageIndex) directly through
        // the codex builder into Responses API SSE. For the codex source, the CB state machine
        // internally puts the latest state.codexPageIndex into
        // formData.{teamPage,agentPage,taskPage}.
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
            // Override stream with the current request's stream flag — the CB
            // FormData carries the value from when the form was first built,
            // but codex clients pass a fresh stream setting each turn.
            stream: isStream,
            modelId: initResult.formData.modelId ?? (modelId as string),
          });
        }
        // Defensive fallback: no formData → intercept without a form response
        // (should be unreachable now that every CB intercepted return sets it).
        if (initResult.response) return initResult.response;
      }

      // -- Default gate first hit: the CB state machine has already landed the bypass state, and this handler
      //    returns a Plan-mode hint once; the next request has recovered.bypassed=true and takes the
      //    initialized branch to pass through directly, so the Plan hint is not repeated.
      if ((initResult as any).bypassReason === "default-gate") {
        pipe.info("CODEX_GATE", "Default mode gate detected → notify user (first hit)");
        const { buildMemResponse } = await import("./mem-command/response-builder.js");
        // The gate in the reset scenario: the user explicitly sent the mem:session-reset command,
        // but the codex client is not in Plan mode and cannot pop up a form -> the wording must clearly tell
        // "the reset command requires Plan mode" rather than a vague "asset feature not enabled".
        const gateText = (initResult as any).resetFlow
          ? "⚠️ mem:session-reset needs Plan mode.\n\n"
            + "The codex client is not in Plan mode, so the asset selection form cannot open.\n"
            + "Switch to Plan mode, then run mem:session-reset again."
          : "Plan mode is not on, so team asset features are off for this conversation (no Skill / Task / Agent)."
            + "To use them, switch to Plan mode and start a new session.";
        return buildMemResponse(gateText, {
          protocol: "responses",
          stream: isStream,
          requestId: `codex-gate-${Date.now()}`,
        });
      }

      if (initResult.justRegistered) sessionJustRegistered = true;
      if (initResult.bypassed) {
        injectionSkipped = true;
        console.log(`[codex] session=${sessionKey} bypassed → skipping all injection`);
        if (initResult.resetFlow) {
          _resetFlowResult = { agentName: "", agentIdShort: "", teamId: "", bypassed: true };
        }
      }

      if (!initResult.bypassed && initResult.sessionInfo) {
        // Fetch asset capabilities for this session
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
          console.warn(`[codex] asset-capability resolve failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Prewarm pre-short-circuit: a turn hit by mem-command neither forwards nor consumes hook-cache;
      // prewarming as usual would waste 2-3s + 3 network requests. See the detailed note at the symmetric position in handler.ts.
      let memCommandPending = false;
      {
        try {
          const userTextPeek = codexAdapter.extractUserText(input);
          if (userTextPeek) {
            const { parseCommandFromText } = await import("./mem-command/index.js");
            const peek = parseCommandFromText(userTextPeek);
            if (peek) {
              memCommandPending = true;
              console.log(`[codex] prewarm skipped: mem-command pending (cmd=${peek.command}) session=${sessionKey}`);
            }
          }
        } catch (err) {
          console.warn(
            "[codex] pre-prewarm peek failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Prewarm injection pipeline cache (same as anthropicHandler)
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
          console.warn("[codex] prewarm error:", err instanceof Error ? err.message : String(err));
        }
      }

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      if (sessionInfo && !sessionInfo.space_id && spaceId) {
        sessionInfo.space_id = spaceId;
      }
      // Cache the detail for section 9 below (building the <session_context> block) - written on both branches:
      // the initResult of the recovered branch is assembled by hand, and that of the walked-through branch comes from
      // handleSessionInit; the fields are all the agent/taskDetail in SessionInitResult.
      cachedAgentDetail = initResult.agentDetail ?? null;
      cachedTaskDetail = initResult.taskDetail ?? null;

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
      console.error("[codex] session-init error:", err instanceof Error ? err.message : String(err));
      sessionInfo = undefined;
      injectionSkipped = true;
    }
  }

  // -- mem:session-reset completion confirmation -------------------------------------------------
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
    console.log(`[mem-command:session-reset] completed: bypassed=${!!bypassed} agent=${agentName} (${agentIdShort}) team=${teamName ?? "-"} (${teamId || "-"})`);
    return buildMemResponse(text, {
      protocol: "responses",
      stream: isStream,
      requestId: `mem-reset-${Date.now()}`,
    });
  }

  // ── 8. mem-command intercept ────────────────────────────────────────────────
  // Position: after session-init, before injection (same as CC/CB).
  //
  // WARNING: do not use parseMemCommand(body, ...) - that function only parses body.messages[] (CC/CB
  // shape); the codex body uses input[], and it would return null immediately -> all mem commands would be silently passed through to the
  // LLM, and the model would fabricate fake replies like "Memory synced" (P0-1 QA report).
  // Use the already extracted userText directly with parseCommandFromText.
  {
    const userText = codexAdapter.extractUserText(input);
    if (userText) {
      const { parseCommandFromText, executeMemCommand, buildMemResponse, extractSimpleMessages, truncateArgs } =
        await import("./mem-command/index.js");
      let memCmd = parseCommandFromText(userText);
      // session-reset was already handled by the pre-hook; skip to prevent duplicate execution
      if (memCmd?.command === "session-reset") memCmd = null;
      if (memCmd) {
        // Session not initialized → command not available
        if (!sessionInfo || injectionSkipped) {
          const errText = `⚠️ The session is not set up yet, so this command is unavailable. Finish session setup (choose a Team/Agent) and try again.`;
          const errResponse = buildMemResponse(errText, {
            protocol: "responses",
            stream: isStream,
            requestId: `mem-cmd-${Date.now()}`,
          });
          console.log(`[codex] mem-command cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} blocked: session not initialized`);
          return errResponse;
        }
        pipe.info("CODEX_MEM_CMD", `mem command intercepted: ${memCmd.command}`);
        const memResult = await executeMemCommand(memCmd, {
          sessionKey,
          agentSource: "codex",
          config,
          spaceId,
          userId: userId || "",
          apiKey: apiKey || "",
          sessionInfo: sessionInfo as Record<string, unknown>,
          protocol: "responses",
          stream: isStream,
          args: memCmd.args,
          // The task command family generates drafts from the recent conversation. Structure of the Responses API body.input[]:
          //   { type:"message", role, content:[{type:"input_text"|"output_text", text}] }
          // extractSimpleMessages already recognizes this shape and converts it to the minimal {role, content} format.
          bodyMessages: extractSimpleMessages(input),
          // Option D: the taskDraft LLM follows the main model - codex has a fixed agent, and the upstream reuses the per-agent url
          model: modelId,
          upstreamUrl: config.upstream.agents?.["codex"]?.url || config.upstream.url,
          // The codex main path goes through the OpenAI Responses API
          upstreamProtocol: "responses",
        });

        // -- L0 write (synchronous await, aligned with the CC/CB mem command path) --
        //   The mem command is the only chance to persist in this turn; it cannot be fire-and-forget (trackWrite),
        //   and must explicitly wait for persistence before returning, to avoid loss when the process exits before flushing.
        const wamfClientForMem = createCodexWamfClient(config, spaceId);
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
            console.error("[codex] mem-command L0 write error:", err);
          }
        }

        // -- Skill extract (synchronous await, ensuring conversation turn counting accumulates normally) --
        if (isExtractionAllowed(config, "skill")) {
          try {
            const assistantMessage = {
              type: "message" as const,
              role: "assistant" as const,
              content: [{ type: "output_text" as const, text: memResult.messageText }],
            };
            await triggerSkillExtractIfReady({
              config,
              sessionKey,
              agentSource: "codex",
              sessionInfo: sessionInfo as Record<string, unknown>,
              inputMessages: input,
              assistantMessage,
              protocol: "responses",
              assetCapabilities,
            });
          } catch (err: unknown) {
            console.warn("[codex] mem-command skill extract trigger error:", err instanceof Error ? err.message : String(err));
          }
        }

        // -- Langfuse: report the mem-command generation --
        //   The lf of the codex handler was already constructed before the mem command block (line 366); reuse it directly.
        langfuseReportGeneration({
          traceId: lf.traceId,
          name: "memory-proxy",
          model: "memory-proxy",
          startTime,
          endTime: new Date().toISOString(),
          input: userText,
          output: memResult.messageText,
          usage: { input_tokens: 0, output_tokens: 0 },
          traceName: `memory-proxy / ${keyId}`,
          userId: lf.userId,
          sessionId: lf.sessionId,
          tags: [...lf.tags, "mem-command"],
          traceInput: userText,
          traceOutput: memResult.messageText,
        });

        console.log(`[codex] mem-command cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} success=${memResult.success}`);
        return memResult.response;
      }
    }
  }

  // ── 9. Asset injection (every turn, no caching) ────────────────────────────
  // Only inject when session is initialized and not bypassed.
  //
  // Strategy: run the existing injection pipeline on a synthetic OpenAI-shaped
  // body (with an empty system message). The pipeline appends text blocks to
  // the system message's content — we extract those appended blocks and
  // re-package them as `<wamf_injections>` for the codex body format.
  //
  // This reuses 100% of the existing pipeline infrastructure (hook cache,
  // prewarm, all injectors) without writing a third protocol adapter.
  if (!injectionSkipped && sessionInfo && config.injection?.enabled && (config.injection.injectors?.length ?? 0) > 0) {
    try {
      const { getInjectionPipeline } = await import("./injection/index.js");
      const pipeline = getInjectionPipeline(config);

      // -- session_context pre-fill ----------------------------------------------------
      // The CB init of handleSessionInit stuffs <session_context> ([Agent]+[Task] description)
      // into the messages[0] it holds internally (the temporary array we passed in), and this messages
      // is not returned to the codex handler; meanwhile initResult.systemAppend is only
      // filled on the CC branch and is always undefined on the CB branch. As a result the codex side only got the skill/memory/knowledge
      // segments, and **the agent/task description was not injected into the final body at all**.
      //
      // Fix: build the same block directly with buildSessionContextBlockWithToggles from the
      // agentDetail/taskDetail the handler side already saved, and pre-fill it into the system
      // message of the synthesized body; pipeline.process below continues appending
      // more injection content after the same system message, and in raw mode it is all extracted together -> the developer segment contains session_context.
      const { buildSessionContextBlockWithToggles } = await import("./session/context-injector.js");
      const sessionContextBlock = buildSessionContextBlockWithToggles(
        cachedAgentDetail as any,
        cachedTaskDetail as any,
        config.sessionInit,
        sessionKey,
      );

      // Build a synthetic OpenAI body that the pipeline can parse/serialize.
      // The pipeline's OpenAI adapter reads `body.messages` and injects
      // text into the system message. We use a single system message as
      // the injection target; all injected text ends up there.
      const syntheticBody: Record<string, unknown> = {
        messages: [
          { role: "system", content: sessionContextBlock ?? "" },
          { role: "user", content: "." },
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
        turnSeq: 0,
        requestPath: c.req.path,
        custom: { session: sessionInfo, userKey: callerUserKey ?? undefined, assetCapabilities },
      });

      // Extract injected content from the synthetic body's system message.
      // The pipeline appends to `messages[0].content` (system message).
      const injectedMessages = injectedBody.messages as Array<Record<string, unknown>> | undefined;
      const sysMsg = injectedMessages?.[0];
      const injectedText = typeof sysMsg?.content === "string" ? sysMsg.content : "";

      if (injectedText.length > 0) {
        // The injectedText produced by the pipeline is already **finished XML text** (containing
        // <skill_tools> / <available_skills> / <user_memory> /
        // multiple groups of internal tags such as <wamf_profile_memory> / <memory-tools-guide>),
        // byte-identical to what the CC / CB clients see in the system message.
        // Embedded as is into the inner layer of the <wamf_injections> wrapper in raw mode - no longer wrapped in
        // an inner <available_skills> tag, and the XML tags in the content are not escaped,
        // otherwise the model would see escaped characters (`&lt;user_memory&gt;`) and could not read the structure.
        body = injectCodexAssets(body, { raw: injectedText });
      }
    } catch (err: unknown) {
      console.error("[codex] injection pipeline error:", err instanceof Error ? err.message : String(err));
      // Degrade gracefully: forward without injection
    }
  }

  // ── 10. Build archive ctx (skill + wamf L0), forward, tap for hooks ──────
  //
  // Build ctx only in the steady state of main dialog + initialized + not bypassed - the injectionSkipped
  // scenario is aligned with the CC/CB "skip L0/skill" branch (when sessionInfo lacks the team/user/agent trio,
  // triggerSkillExtractIfReady itself returns early too, but deciding earlier saves one fanout).
  const archiveCtx = buildArchiveCtx({
    config,
    sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
    injectionSkipped,
    input,
    sessionKey,
    agentSource,
    spaceId,
    userId,
    callerUserKey,
    assetCapabilities,
  });

  // ── 11. Forward to upstream ────────────────────────────────────────────────
  return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, lf, archiveCtx);
}

// ── Archive context (skill/conversation/add + WAMF L0 write) ─────────────────

/**
 * Archive trigger context - packs all inputs the hooks need, built in handleCodexEndpoint and
 * passed all the way to the tail of completeStream in consumeCodexStream to trigger the skill/L0 hooks.
 *
 * Created only for main dialog + initialized session + not bypassed; otherwise archiveCtx=null,
 * and on seeing null the forward side skips the hooks (aligned with the isMainDialog branch of CC/CB).
 */
export interface CodexArchiveCtx {
  config: ProxyConfig;
  sessionKey: string;
  agentSource: string;
  sessionInfo: Record<string, unknown>;
  spaceId: string;
  /**
   * The original codex `input[]` - when archiving skills with protocol="responses", normalize-conversation
   * expands it internally via convertCodexInputItem.
   */
  input: unknown[];
  wamfClient: WamfClient | null;
  wamfIdentity: WamfIdentity | null;
  /** The latest user question extracted from `input[]` (extracted by extractLatestCodexUserMessage). */
  wamfUserMessage: WamfMessage | null;
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
}

function buildArchiveCtx(args: {
  config: ProxyConfig;
  sessionInfo: Record<string, unknown> | null | undefined;
  injectionSkipped: boolean;
  input: unknown[];
  sessionKey: string;
  agentSource: string;
  spaceId: string;
  userId: string;
  callerUserKey: string | null;
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
}): CodexArchiveCtx | null {
  const { sessionInfo, injectionSkipped } = args;
  if (injectionSkipped || !sessionInfo) return null;

  const wamfClient = args.assetCapabilities?.chat_memory === false
    ? null
    : createCodexWamfClient(args.config, args.spaceId);
  const wamfIdentity = deriveWamfIdentity({
    sessionInfo,
    userId: args.userId || null,
    sessionKey: args.sessionKey,
    userKey: args.callerUserKey,
  });
  const wamfUserMessage = extractLatestCodexUserMessage(args.input);

  return {
    config: args.config,
    sessionKey: args.sessionKey,
    agentSource: args.agentSource,
    sessionInfo,
    spaceId: args.spaceId,
    input: args.input,
    wamfClient,
    wamfIdentity,
    wamfUserMessage,
    assetCapabilities: args.assetCapabilities,
  };
}

/**
 * After the stream ends, trigger skill/conversation/add + WAMF L0 write, aligned with the
 * anthropicHandler.ts:1867-1948 section of CC/CB.
 *
 * Parameters:
 *   assistantText: assistant text accumulated by the SSE accumulator
 *   toolUseCount:  number of function_calls accumulated in the stream (round boundary criterion)
 *
 * Fails silently (errors already logged), never blocking the upstream response chain.
 */
async function triggerCodexArchiveHooks(
  ctx: CodexArchiveCtx,
  assistantText: string,
  toolUseCount: number,
): Promise<void> {
  // ── WAMF L0 write ──
  // Symmetric with the anthropicHandler stream branch (line 1867-1878):
  //   - trackWrite hangs on the global in-flight set (index.ts flushPendingWrites as a fallback for packet loss on SIGTERM)
  //   - withL0Retry with 3 backoff retries shields against wamf kernel blips
  //   - no await in the stream scenario, letting the archive hook return early
  if (ctx.wamfClient && ctx.wamfIdentity && isExtractionAllowed(ctx.config, "wamf-memory")) {
    trackWrite(
      withL0Retry(() =>
        recordWamfTurn(ctx.wamfClient!, ctx.wamfIdentity, ctx.wamfUserMessage, assistantText || null),
      ).catch((err: unknown) => {
        console.warn("[codex-wamf-l0] failed:", err instanceof Error ? err.message : String(err));
      }),
    );
  } else if (ctx.wamfClient) {
    logExtractionSkipped(ctx.config, "wamf-memory", ctx.sessionKey);
  }

  // ── Skill conversation/add trigger ──
  // Symmetric with the anthropicHandler stream branch (line 1928-1948): return after the archive write completes, ensuring
  // the next turn across nodes reads the latest buffer state; assistantMessage uses the stream accumulator's
  // outputText to build a codex message shape (type:"message", role:"assistant",
  // content:[{type:"output_text", text}]), and toolCallCountOverride is counted by the stream.
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
      agentSource: ctx.agentSource,
      sessionInfo: ctx.sessionInfo,
      inputMessages: ctx.input,
      assistantMessage,
      protocol: "responses",
      assetCapabilities: ctx.assetCapabilities,
      toolCallCountOverride: toolUseCount,
    });
  } else {
    logExtractionSkipped(ctx.config, "skill", ctx.sessionKey);
  }
}

// ── Forward helper ───────────────────────────────────────────────────────────

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
  archiveCtx: CodexArchiveCtx | null = null,
): Promise<Response> {
  // The per-agent upstream override (upstream.agents.codex.url) takes priority over the global url.
  // Aligned with the parsing approach of anthropicHandler.ts:1029. codex usually needs to point separately at a compatibility layer
  // that supports the Responses API - some OpenAI-compatible upstreams only implement
  // messages/chat_completions and do not support /responses, so overriding per agent is allowed here.
  const agentUpstreamEntry = config.upstream.agents?.["codex"];
  let upstreamBase = agentUpstreamEntry?.url || config.upstream.url;
  let upstreamUrl = joinUrl(upstreamBase, c.req.path);
  const upstreamHeaders = buildUpstreamHeaders(c, config);
  upstreamHeaders["content-type"] = "application/json";
  // Overriding apiKey is consistent with the per-agent policy: agentUpstreamEntry.apiKey takes priority,
  // otherwise the client Bearer is passed through.
  if (agentUpstreamEntry) {
    if (agentUpstreamEntry.apiKey) {
      upstreamHeaders["authorization"] = `Bearer ${agentUpstreamEntry.apiKey}`;
    }
    // else: keep the client key in c.req.header('authorization') passed through
  }

  // ── Instance upstream config override (codex has no cost-guard routing) ──
  {
    const spaceId = extractSpaceIdFromPath(c.req.path) ?? "";
    const instanceConfigs = await getInstanceUpstreamConfigs(config.coreSkill, spaceId);
    const convCfg = resolveUpstreamConfig(instanceConfigs, "codex", "conversation");
    if (shouldOverride(convCfg)) {
      upstreamUrl = joinUrl(convCfg.base_url, c.req.path);
      if (convCfg.mode === "custom_unified" && convCfg.api_key) {
        upstreamHeaders["authorization"] = `Bearer ${convCfg.api_key}`;
      }
      // custom_passthrough: keep client's original Authorization
      if (convCfg.model_id && typeof body.model === "string") {
        body.model = convCfg.model_id;
      }
    }
  }

  pipe.forwardStart(upstreamUrl);

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });
  } catch (err: unknown) {
    pipe.error("CODEX_FORWARD", err instanceof Error ? err : new Error(String(err)));
    // Report langfuse failure (forwarding exception - upstream returned no response body, only a local fetch error)
    if (lf) {
      try {
        langfuseReportFailure({
          lf,
          model: modelId,
          startTime,
          endTime: new Date().toISOString(),
          input: buildCodexLangfuseInput(body),
          statusMessage: `forward error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
          extraTags: ["error"],
          observationMetadata: { stage: "forward", stream: true, upstreamUrl },
        });
      } catch (lfErr: unknown) {
        pipe.error("LANGFUSE_SPAN", lfErr);
      }
    }
    return c.json(
      { error: "Upstream request failed", detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }

  pipe.forwardDone(upstreamResp.status);

  // Log usage
  writeLog(config, {
    timestamp: startTime,
    event: "request",
    modelId,
    keyId,
    sessionKey: keyId,
    upstreamUrl,
    stream: true,
    traceId,
  });

  // -- Upstream 4xx/5xx: copy the body text for langfuse error reporting; on success tap --
  // The codex Responses API only has SSE streaming responses, with no stream / non-stream distinction.
  if (upstreamResp.status >= 400) {
    // 4xx/5xx usually return a JSON error (very small); reading it fully into langfuse helps troubleshooting
    const errText = await upstreamResp.text();
    if (lf) {
      try {
        langfuseReportFailure({
          lf,
          model: modelId,
          startTime,
          endTime: new Date().toISOString(),
          input: buildCodexLangfuseInput(body),
          status: upstreamResp.status,
          statusMessage: errText.slice(0, 500),
          extraTags: ["error"],
          observationMetadata: { stage: "upstream", stream: true, upstreamUrl },
        });
      } catch (lfErr: unknown) {
        pipe.error("LANGFUSE_SPAN", lfErr);
      }
    }
    return new Response(errText, {
      status: upstreamResp.status,
      headers: filterResponseHeaders(upstreamResp.headers),
    });
  }

  // 2xx: aux scenarios (lf=null && archiveCtx=null) pass through directly without a tap; main dialog scenarios tap
  // a copy for langfuse reporting + skill/L0 archive hooks (P1-P2 gap fix).
  // Whenever either lf or archiveCtx is non-null, a tap stream must be tee'd.
  const needTap = Boolean(lf) || Boolean(archiveCtx);
  if (!needTap || !upstreamResp.body) {
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: filterResponseHeaders(upstreamResp.headers),
    });
  }

  const [rawClientStream, tapStream] = upstreamResp.body.tee();
  consumeCodexStream(tapStream, {
    lf,
    modelId,
    startTime,
    upstreamUrl,
    inputBody: body,
    pipe,
    archiveCtx,
  });

  return new Response(rawClientStream, {
    status: upstreamResp.status,
    headers: filterResponseHeaders(upstreamResp.headers),
  });
}

// ── Langfuse helpers ─────────────────────────────────────────────────────────

/**
 * Derive the turn number from codex `body.input[]` - count the message items with role=user.
 *
 * Aligned with turnSeq.ts::countHumanTurns (openai/anthropic): tool-loop requests within the same turn
 * (adding function_call_output items) do not add human messages, so they get the same
 * turnSeq and multiple requests merge into the same langfuse trace.
 */
export function countHumanTurnsCodex(input: unknown): number {
  if (!Array.isArray(input)) return 0;
  let count = 0;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type === "message" && it.role === "user") count++;
  }
  return count;
}

/**
 * Build the input sent to langfuse - codex's input[] is already a structured conversation history,
 * so pass it through as is (same purpose as anthropic's buildLangfuseInput: letting the
 * langfuse UI show clearly "what the input of this call was"). The instructions section is carried separately,
 * completing the context (codex's system prompt is in body.instructions rather than input).
 */
function buildCodexLangfuseInput(body: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = { input: body.input };
  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    out.instructions = body.instructions;
  }
  return out;
}

export interface CodexTapContext {
  /**
   * langfuse trace context; null means the aux scenario is not reported to langfuse but may still need
   * archiving (in theory aux carries no archiveCtx; when both are null the upstream tap simply does not start).
   */
  lf: LangfuseTurnContext | null;
  modelId: string;
  startTime: string;
  upstreamUrl: string;
  inputBody: Record<string, unknown>;
  pipe: ReturnType<typeof createPipeline>;
  /**
   * skill archive + WAMF L0 write hook context;
   * null means the current request needs no archive trigger (aux / session not initialized / bypass).
   */
  archiveCtx?: CodexArchiveCtx | null;
}

/**
 * Consume the codex Responses API SSE stream, extract usage + assistant output, report to langfuse.
 *
 * Key codex SSE frames (see docs/2026-08-05-codex-onboarding.md section 7.5.2/3):
 *   - response.output_text.delta:  {delta: "..."}                -> accumulate assistant text
 *   - response.function_call_arguments.delta: {delta: "..."}     -> accumulate tool_use arguments (for observation)
 *   - response.completed: {response: {usage, output, status, ...}} -> closing, take usage
 *
 * Fails silently - instrumentation never affects the business path.
 */
export function consumeCodexStream(stream: ReadableStream<Uint8Array>, ctx: CodexTapContext): void {
  const { lf, modelId, startTime, upstreamUrl, inputBody, pipe, archiveCtx } = ctx;

  (async () => {
    const decoder = new TextDecoder();
    let sseBuf = "";
    let usage: Record<string, unknown> = {};
    let outputText = "";
    let toolUseCount = 0;
    let stopReason: string | undefined;
    let streamCompleted = false;
    // 5-minute fallback: a client disconnect may leave the upstream stream stuck; on timeout here we also force a closing pass once.
    const timeoutHandle = setTimeout(() => {
      if (!streamCompleted) {
        pipe.error("STREAM_TIMEOUT", "Codex stream reading exceeded 5 minutes");
        void completeStream().catch((err) => pipe.error("STREAM_TIMEOUT_COMPLETE", err));
      }
    }, 5 * 60 * 1000);

    async function completeStream(): Promise<void> {
      if (streamCompleted) return;
      streamCompleted = true;
      clearTimeout(timeoutHandle);

      const endTime = new Date().toISOString();
      if (lf) {
        try {
          const output = outputText
            ? { role: "assistant", content: outputText }
            : toolUseCount > 0
              ? { role: "assistant", content: `[${toolUseCount} tool call(s)]` }
              : undefined;
          langfuseReportGeneration({
            traceId: lf.traceId,
            name: modelId,
            model: modelId,
            startTime,
            endTime,
            input: buildCodexLangfuseInput(inputBody),
            output,
            usage: Object.keys(usage).length > 0 ? usage : undefined,
            traceName: lf.traceName,
            userId: lf.userId,
            sessionId: lf.sessionId,
            tags: lf.tags,
            traceInput: lf.userQuery || undefined,
            traceOutput: output,
            traceMetadata: {
              stream: true,
              upstreamUrl,
              stop_reason: stopReason,
              tool_use_count: toolUseCount,
            },
            observationMetadata: {
              stream: true,
              stop_reason: stopReason,
              tool_use_count: toolUseCount,
            },
          });
        } catch (lfErr: unknown) {
          pipe.error("LANGFUSE_SPAN", lfErr);
        }
      }

      // -- Skill/conversation/add + WAMF L0 archive hooks --
      // Aligned with the stream branch of anthropicHandler.ts (line 1867-1948): after langfuse reporting,
      // trigger the skill archive + L0 write. Fails silently (already warned internally), does not block the client SSE.
      // archiveCtx=null (aux / uninitialized session / bypass) is skipped directly.
      if (archiveCtx) {
        try {
          await triggerCodexArchiveHooks(archiveCtx, outputText, toolUseCount);
        } catch (archiveErr: unknown) {
          pipe.error("CODEX_ARCHIVE", archiveErr instanceof Error ? archiveErr : new Error(String(archiveErr)));
        }
      }
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
            if (line.startsWith("data: ")) dataStr = line.slice(6);
            else if (line.startsWith("data:")) dataStr = line.slice(5);
          }
          if (!dataStr) continue;

          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            const evtType = evt.type as string | undefined;

            if (evtType === "response.output_text.delta") {
              const delta = evt.delta;
              if (typeof delta === "string") outputText += delta;
            } else if (evtType === "response.output_item.added") {
              const item = evt.item as Record<string, unknown> | undefined;
              if (item?.type === "function_call") toolUseCount++;
            } else if (evtType === "response.completed") {
              const resp = evt.response as Record<string, unknown> | undefined;
              if (resp?.usage) {
                Object.assign(usage, resp.usage as Record<string, unknown>);
              }
              stopReason = (resp?.status as string) ?? "completed";
            } else if (evtType === "response.incomplete") {
              // max_output_tokens / other interruptions (Responses API standard)
              const resp = evt.response as Record<string, unknown> | undefined;
              const details = resp?.incomplete_details as Record<string, unknown> | undefined;
              stopReason = `incomplete:${details?.reason ?? "unknown"}`;
              if (resp?.usage) Object.assign(usage, resp.usage as Record<string, unknown>);
            }
          } catch {
            // ignore malformed frames - instrumentation-level problems do not block
          }
        }
      }
    } catch (err: unknown) {
      pipe.error("CODEX_TAP", err instanceof Error ? err : new Error(String(err)));
    } finally {
      await completeStream();
    }
  })().catch((err: unknown) => pipe.error("CODEX_TAP_UNHANDLED", err));
}
