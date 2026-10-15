/**
 * Codex CLI client adapter.
 *
 * Specialized implementation:
 *   - classifyRequest: strict whitelist to decide aux (endpoint path + memgen header +
 *     known thread_source values); anything unknown is main (strict rather than lenient)
 *   - extractUserText: from codex body.input[], extract and concatenate the content[].input_text of the last
 *     item with type=message && role=user
 *
 * See docs/2026-08-07-codex-integration-plan.md sections 1 / 9.
 */

import type { AgentAdapter, RequestKind } from "./types.js";

// ── Aux detection constants ──────────────────────────────────────────────────

/** Known aux endpoint path suffixes. Constants from the source codex-rs/core/src/client.rs. */
const CODEX_AUX_PATH_SUFFIXES = new Set([
  "/responses/compact",
  "/memories/trace_summarize",
  "/realtime/calls",
]);

/**
 * Known aux values of body.client_metadata.thread_source for codex clients.
 *
 * - "memory_consolidation": source ThreadSource::MemoryConsolidation
 * - "system": measured from the title-generation aux in packet capture section 7.4
 *
 * Unknown values are always treated as the main conversation (strict).
 */
const CODEX_AUX_THREAD_SOURCES = new Set([
  "memory_consolidation",
  "system",
]);

/**
 * Decide whether a codex request is aux (auxiliary request).
 *
 * Three signal layers in priority order:
 *   1. endpoint path suffix whitelist (strongest, hard-coded in the codex source)
 *   2. x-openai-memgen-request header (exclusive to memory consolidation)
 *   3. body.client_metadata.thread_source whitelist
 */
function isCodexAuxiliary(
  path: string | undefined,
  headers: Record<string, string> | undefined,
  body: Record<string, unknown>,
): boolean {
  // Signal 1: aux endpoint (path whitelist)
  if (path) {
    for (const suffix of CODEX_AUX_PATH_SUFFIXES) {
      if (path.endsWith(suffix)) return true;
    }
  }

  // Signal 2: x-openai-memgen-request: true
  if (headers?.["x-openai-memgen-request"] === "true") return true;

  // Signal 3: body.client_metadata.thread_source hits the whitelist
  const meta = body.client_metadata as { thread_source?: string } | undefined;
  const ts = meta?.thread_source;
  if (typeof ts === "string" && CODEX_AUX_THREAD_SOURCES.has(ts)) return true;

  return false;
}

// ── User text extraction ─────────────────────────────────────────────────────

/**
 * Extract the content[].input_text of the last item with type=message && role=user from codex input[].
 *
 * Codex input[] item type list (packet-capture draft section 7.2):
 *   - {type:"message", role, content:[{type:"input_text",text}]}
 *   - {type:"function_call", name, arguments}
 *   - {type:"function_call_output", output}
 *   - {type:"reasoning", encrypted_content}
 *
 * Only cares about the type=input_text parts in the content of type=message && role=user.
 */
function extractCodexUserText(input: unknown): string | null {
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

export const codexAdapter: AgentAdapter = {
  agentKind: "codex",

  classifyRequest(
    body: Record<string, unknown>,
    path?: string,
    headers?: Record<string, string>,
  ): RequestKind {
    return isCodexAuxiliary(path, headers, body) ? "auxiliary" : "main";
  },

  extractUserText(content: unknown): string | null {
    return extractCodexUserText(content);
  },
};
