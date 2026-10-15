/**
 * WorkBuddy desktop client adapter.
 *
 * Recon basis (2026-08-10, packet-capture evidence from reverse engineering the workbuddy Mac client 5.3.11):
 *
 * # Client architecture
 *   - Electron GUI (WorkBuddy desktop AI agent; product page www.codebuddy.example.com/work/)
 *   - The desktop shell talks to the local `@genie/agent-cli` via ACP over HTTP (local 127.0.0.1 sidecar);
 *     the actual remote LLM requests are sent by the sidecar (`cli/dist/codebuddy.js`)
 *   - Underlying library: `@openai/agents 0.5.2` (OpenAI's official Agents SDK)
 *
 * # Wire protocol
 *   - Protocol = **OpenAI Responses API** (not Chat Completions)
 *   - endpoint suffixes: `/responses` (main), `/responses/compact`,
 *     `/realtime/calls`, `/memories/trace_summarize`
 *   - stream goes over SSE / WebSocket (`ensureResponsesWebSocketPath` exists, but HTTP is also supported)
 *   - Base URL can be overridden via `OPENAI_BASE_URL` / `OPENAI_ENDPOINT` ->
 *     **connecting to the proxy only needs an env-var redirect; no need to patch the client binary**
 *   - Auth: `Authorization: Bearer <token>` (token from env vars
 *     `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_API_KEY`) + a separate `X-User-Id` header
 *
 * # Unique header set (hits from packet-capture grep)
 *   - `X-Agent-Intent` / `X-Agent-Purpose`
 *   - `X-User-Id` (URL-encoded)
 *   - `X-Codebuddy-Run-Timeout` (note: the header key keeps the codebuddy prefix;
 *     it is a legacy inherited by the sidecar from the codebuddy CLI)
 *
 * # System prompt structure (`resources/templates/workbuddy-prompt.tpl` packet-capture evidence)
 *   - The nunjucks template is rendered by the client; **what the proxy receives is the rendered finished text**
 *   - Sections by XML tag: `<content_policy>` / `<agent_skills>` / `<expert_management>`
 *     / `<mcp_configuration>` / `<response_language>` / `<binary_context>`
 *   - user message wrapper: `<user_query>...</user_query>`
 *   - 4 memory placeholders (this adapter does not do injection; the injection profile layer handles it):
 *       * `{{ WorkbuddyMemory_1 }}`
 *       * `{{ WorkingMemoryContent }}`
 *       * `{{ UserLocalMemoryContent }}`
 *       * `{{ UserMemoryContent }}`
 *   - Data directory variable: `{{ dataFolderName }}` -> `.workbuddy`
 *   - Product domain: `www.workbuddy.example.com/docs/workbuddy/Overview` (**independent of codebuddy**)
 *
 * # Two adaptation points
 *   - `classifyRequest`: **independently implements** the same three-layer aux signal decision (endpoint path whitelist +
 *     memgen header + client_metadata.thread_source) - keywords overlap with codex but zero dependency
 *   - `extractUserText`: from the responses API `body.input[]`, extract the last
 *     `content[].input_text` of `type=message && role=user` - independent implementation,
 *     does not import the codex module
 *
 * # Independence constraints (explicitly requested by the user)
 *   - zero imports of codebuddy / codex
 *   - the keyword sets happen to coincide with codex as a natural result of the "same upstream protocol", not considered coupling
 *   - any future change on the workbuddy side (new aux path, new header) evolves within this file
 *
 * See the packet-capture report: MemoryProxy/docs/workbuddy-recon/*.tpl + workbuddy-cli-product.json.
 */

import { extractUserQueryText } from "../common/user-query-extractor.js";
import type { AgentAdapter, RequestKind } from "./types.js";

// ── Aux detection constants ──────────────────────────────────────────────────

/**
 * Known aux endpoint path suffixes of the WorkBuddy client.
 *
 * Source: grep results from reverse engineering workbuddy Mac client 5.3.11 `cli/dist/codebuddy.js`:
 *   - `/responses/compact`         compaction/summary requests
 *   - `/memories/trace_summarize`  memory trace summarization
 *   - `/realtime/calls`            realtime session setup
 *
 * If workbuddy is later found to add an aux endpoint, append it here (do not modify the codex side).
 */
const WORKBUDDY_AUX_PATH_SUFFIXES: readonly string[] = [
  "/responses/compact",
  "/memories/trace_summarize",
  "/realtime/calls",
];

/**
 * Known aux values of body.client_metadata.thread_source for the WorkBuddy client.
 *
 * Packet capture has not confirmed whether workbuddy uses client_metadata; conservatively only the two
 * whitelist values known to codex are listed here (if the underlying SDK of workbuddy shares its origin with codex, they should in theory match).
 * Unknown is always main (strict rather than lenient).
 */
const WORKBUDDY_AUX_THREAD_SOURCES:ReadonlySet<string> = new Set([
  "memory_consolidation",
  "system",
]);

/**
 * Set of memgen request header keys specific to WorkBuddy.
 *
 * Packet-capture evidence shows the workbuddy sidecar inherits from the codebuddy CLI and still uses
 * `x-openai-memgen-request` to mark memory generation requests.
 * Listed independently, without importing codex constants.
 */
const WORKBUDDY_MEMGEN_HEADER_KEYS: readonly string[] = [
  "x-openai-memgen-request",
];

/**
 * Decide whether a workbuddy request is aux (auxiliary request).
 *
 * Three signal layers in priority order:
 *   1. endpoint path suffix whitelist (strongest)
 *   2. memgen request header (exclusive to memory consolidation)
 *   3. body.client_metadata.thread_source whitelist
 */
function isWorkbuddyAuxiliary(
  path: string | undefined,
  headers: Record<string, string> | undefined,
  body: Record<string, unknown>,
): boolean {
  // Signal 1: aux endpoint (path whitelist)
  if (path) {
    for (const suffix of WORKBUDDY_AUX_PATH_SUFFIXES) {
      if (path.endsWith(suffix)) return true;
    }
  }

  // Signal 2: memgen request header
  if (headers) {
    for (const key of WORKBUDDY_MEMGEN_HEADER_KEYS) {
      if (headers[key] === "true") return true;
    }
  }

  // Signal 3: body.client_metadata.thread_source hits the whitelist
  const meta = body.client_metadata as { thread_source?: string } | undefined;
  const ts = meta?.thread_source;
  if (typeof ts === "string" && WORKBUDDY_AUX_THREAD_SOURCES.has(ts)) return true;

  return false;
}

// ── User text extraction ─────────────────────────────────────────────────────

/**
 * Extract from the workbuddy responses API `body.input[]` the concatenated text of the last
 * `content[].input_text` of `type=message && role=user`.
 *
 * Packet-capture evidence: workbuddy uses the @openai/agents SDK underneath, and the wire body structure is
 * fully identical to the OpenAI Responses API. Known input[] item types:
 *   - {type:"message", role:"user"|"assistant"|"developer"|"system",
 *      content:[{type:"input_text"|"output_text"|"input_image",...}]}
 *   - {type:"function_call", name, arguments}
 *   - {type:"function_call_output", output}
 *   - {type:"reasoning", encrypted_content, ...}
 *
 * Only cares about the type=input_text parts in the content of type=message && role=user.
 *
 * Note: implemented independently of codex (duplicated algorithm but zero coupling); if the workbuddy input[]
 * structure diverges in the future (e.g. a workbuddy-specific content type is added), it evolves within this file.
 */
function extractWorkbuddyUserText(input: unknown): string | null {
  if (!Array.isArray(input)) return null;

  // Search from back to front for the last message with role=user
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] as Record<string, unknown> | null | undefined;
    if (!item || typeof item !== "object") continue;
    if (item.type !== "message" || item.role !== "user") continue;

    const content = item.content;
    if (!Array.isArray(content)) continue;

    const texts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown> | null | undefined;
      if (!b || typeof b !== "object") continue;
      if (b.type === "input_text" && typeof b.text === "string") {
        texts.push(b.text);
      }
    }
    return texts.length > 0 ? texts.join("\n") : null;
  }

  return null;
}

// ── Adapter export ───────────────────────────────────────────────────────────

/**
 * Extract the user's real input - compatible with both forms:
 *
 * 1) **Responses API (`/v1/responses`)**: specific to the desktop client; content is an `input[]`
 *    array (`{type:"message", role:"user", content:[{type:"input_text", text}]}`),
 *    handled by the independent `extractWorkbuddyUserText` algorithm.
 *
 * 2) **Chat Completions (`/v1/chat/completions`)**: the workbuddy web version uses
 *    OpenAI ChatCompletions underneath (`claude-opus-4.7-1m` + OpenAI-compatible upstream),
 *    handled by the general main handler path. `message.content` is a string and carries the same
 *    `<system-reminder>` / `<user_query>` wrappers as CC/CB (verified in the 2026-08-12 logs).
 *    Directly reuses CB's `extractUserQueryText` - keeping the same stripping semantics as
 *    wamf L0 / mem-command.
 *
 * Fix background: on 2026-08-12 a user sent `mem:help` in the workbuddy web version; the request entered the proxy and went through
 * `/chat/completions` (handler.ts::handleChatCompletions), and parseMemCommand called
 * `workbuddyAdapter.extractUserText(content)`, but the original implementation only handled Array, and string
 * content returned null -> command recognition failed -> passed through to the LLM as a fallback. See develop_timestone/.
 */
export const workbuddyAdapter: AgentAdapter = {
  agentKind: "workbuddy",

  classifyRequest(
    body: Record<string, unknown>,
    path?: string,
    headers?: Record<string, string>,
  ): RequestKind {
    return isWorkbuddyAuxiliary(path, headers, body) ? "auxiliary" : "main";
  },

  extractUserText(content: unknown): string | null {
    // Web-version chat/completions: content is a string (may carry <user_query> / wrapper)
    if (typeof content === "string") {
      const extracted = extractUserQueryText(content);
      return extracted.length > 0 ? extracted : null;
    }
    // Desktop client /v1/responses: content is an input[] array
    return extractWorkbuddyUserText(content);
  },
};
