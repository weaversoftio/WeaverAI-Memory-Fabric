/**
 * Langfuse debug helpers - gated by `langfuse.debug=true`, used to stuff the native structure of the LLM request
 * + client fingerprint into the Langfuse report as much as possible, for **troubleshooting / client reverse engineering**.
 *
 * Current state breakdown (pitfalls before merging):
 *   1. On the Anthropic side `anthropicHandler.buildLangfuseInput` already has a debug branch, but
 *      it only keeps the native messages+system structure; output is still text concatenation (tool_use /
 *      thinking / stop_reason lost); metadata only has stream/retried/upstreamUrl.
 *   2. The 5 langfuse reports in the OpenAI-protocol handler.ts **do not read the debug flag at all**,
 *      hard-coded to flatten via flattenMessagesForOpik - CodeBuddy requests go exactly this path,
 *      so even with debug on, the native CB body can't be captured.
 *
 * This file supplies the **shared** parts - the OpenAI-protocol input builder + generic debug metadata.
 * The Anthropic-side input builder (`buildLangfuseInput`) is already inlined in anthropicHandler.ts,
 * and is not moved here to avoid a circular dependency. Output handling is branched by each handler on the debug flag.
 *
 * See the appendix of docs/design/2026-07-30-cc-request-routing-plan.md and the commit
 * message of this change.
 */

import type { CcRequestKind } from "./cc-request-classifier.js";
import { findLastCacheControlIndex } from "./cc-request-classifier.js";

// --- Whitelist and truncation limits ------------------------------------------------
// Request header prefixes: consistent with identity.ts:172, to avoid drift in how CB headers are understood across places.
const HEADER_PREFIX_WHITELIST = ["x-", "cb-", "codebuddy-"];
// Max characters a single tool description / string field is truncated to (prevents a single langfuse report from bloating).
const STRING_TRUNC = 200;
// Max number of tools to capture (the first N are enough to identify the client fingerprint).
const TOOLS_MAX = 8;

/**
 * langfuse input builder for OpenAI-protocol messages.
 *
 * - `debug=true`: returns the messages array as is (keeping the string/array content CodeBuddy may use,
 *   internal tags such as `<additional_data>` / `<question_answer>`, cache_control
 *   markers, native tool_use form, thinking blocks, etc.).
 * - `debug=false`: uses the fallback passed in by the caller (usually handler.ts:flattenMessagesForOpik),
 *   flattening content arrays into role+string form, saving langfuse storage cost by 2-5x.
 *
 * The parameter `fallback` is passed explicitly rather than imported, so the handler keeps its own flatten
 * implementation (reused by other call sites on the opik/opik-fork side); this file is not responsible for flatten semantics.
 */
export function buildLangfuseInputChat(
  messages: unknown[],
  debug: boolean,
  fallback: (m: unknown[]) => unknown[],
): unknown {
  if (debug) {
    // Return the original messages array directly - keeping the native role/content structure.
    return messages;
  }
  return fallback(messages);
}

// ─── Debug metadata ─────────────────────────────────────────────────────────

export interface RequestDebugMetadataInput {
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  agentSource?: string;
  requestKind?: CcRequestKind;
  spaceId?: string;
  turnSeq?: number;
  requestPath?: string;
  protocol?: "anthropic" | "openai";
  debug: boolean;
}

/**
 * Extract "client fingerprint + key request classification fields" from body / headers / routing context and stuff them into
 * Langfuse's observationMetadata / traceMetadata.
 *
 * When `debug=false` always returns an **empty object** (does not pollute production metadata).
 *
 * Extracted fields (all flat keys, convenient for display in the Langfuse UI):
 *   - `model` / `stream` / `max_tokens` / `temperature` / `top_p` / `top_k`
 *   - `thinking_type` / `stop_sequences_len` / `system_len` / `messages_len`
 *   - `tools_len` / `tools_summary` - name + desc of the first N tools, truncated to 200 chars
 *   - `cache_control_marker_idx` - position of the last cache_control marker in messages
 *     (the core signal for identifying CC fork/main/sidequery; see cc-request-classifier.ts)
 *   - `body_metadata` - Anthropic body.metadata (including user_id, etc.)
 *   - `body_extra_keys` - names of "non-standard fields" at the top level of the body (CB / cursor often sneak in extension fields)
 *   - `agent_source` / `request_kind` / `space_id` / `turn_seq` / `request_path`
 *   - `header_<name>` - client headers with whitelisted prefixes (x-* / cb-* / codebuddy-*)
 *
 * Tools/description are all truncated to prevent a single report from bloating. On extraction failure, the already-collected fields are silently returned
 * (debug data missing a field or two doesn't hinder troubleshooting, and must not throw and affect the business).
 */
export function buildRequestDebugMetadata(
  opts: RequestDebugMetadataInput,
): Record<string, unknown> {
  if (!opts.debug) return {};

  const out: Record<string, unknown> = {};
  try {
    const b = opts.body ?? {};

    // -- Common top-level body fields --
    if (typeof b.model === "string") out.model = b.model;
    if (typeof b.stream === "boolean") out.stream = b.stream;
    if (typeof b.max_tokens === "number") out.max_tokens = b.max_tokens;
    if (typeof b.temperature === "number") out.temperature = b.temperature;
    if (typeof b.top_p === "number") out.top_p = b.top_p;
    if (typeof b.top_k === "number") out.top_k = b.top_k;

    // Anthropic thinking block
    const thinking = b.thinking as { type?: unknown } | undefined;
    if (thinking && typeof thinking === "object" && typeof thinking.type === "string") {
      out.thinking_type = thinking.type;
    }

    // stop_sequences (OpenAI: `stop`; Anthropic: `stop_sequences`)
    const stopSeq = Array.isArray(b.stop_sequences)
      ? (b.stop_sequences as unknown[])
      : Array.isArray(b.stop)
      ? (b.stop as unknown[])
      : null;
    if (stopSeq) out.stop_sequences_len = stopSeq.length;

    // system prompt length (Anthropic has body.system; OpenAI puts it in messages[0].role='system')
    if (typeof b.system === "string") {
      out.system_len = b.system.length;
    } else if (Array.isArray(b.system)) {
      let total = 0;
      for (const blk of b.system as unknown[]) {
        const t = (blk as { text?: unknown })?.text;
        if (typeof t === "string") total += t.length;
      }
      out.system_len = total;
    }

    const msgs = Array.isArray(b.messages) ? (b.messages as unknown[]) : [];
    out.messages_len = msgs.length;

    // Tools array - name + desc (truncated) of the first N, enough as a fingerprint
    if (Array.isArray(b.tools)) {
      const tools = b.tools as unknown[];
      out.tools_len = tools.length;
      const summary: Array<{ name?: string; desc?: string }> = [];
      for (let i = 0; i < Math.min(tools.length, TOOLS_MAX); i++) {
        const t = tools[i] as Record<string, unknown> | undefined;
        if (!t) continue;
        // Anthropic: {name, description}; OpenAI: {function: {name, description}}
        const fn = (t.function as Record<string, unknown> | undefined) ?? t;
        const name = typeof fn.name === "string" ? fn.name : undefined;
        const descRaw = typeof fn.description === "string" ? fn.description : undefined;
        const entry: { name?: string; desc?: string } = {};
        if (name) entry.name = truncate(name, STRING_TRUNC);
        if (descRaw) entry.desc = truncate(descRaw, STRING_TRUNC);
        if (entry.name || entry.desc) summary.push(entry);
      }
      if (summary.length) out.tools_summary = summary;
    }

    // Cache control marker position - the core signal for CC request classification
    if (msgs.length > 0) {
      const idx = findLastCacheControlIndex(msgs);
      if (idx >= 0) out.cache_control_marker_idx = idx;
    }

    // Anthropic body.metadata (may contain client context such as user_id / session_id)
    if (b.metadata && typeof b.metadata === "object" && !Array.isArray(b.metadata)) {
      out.body_metadata = b.metadata as Record<string, unknown>;
    }

    // Non-standard top-level body fields (extension keys clients sneak in - to identify client fingerprints)
    const standardKeys = new Set([
      "model", "messages", "system", "tools", "tool_choice",
      "temperature", "top_p", "top_k", "max_tokens",
      "stream", "stream_options", "thinking",
      "stop", "stop_sequences", "metadata",
      "n", "user", "seed", "response_format", "presence_penalty", "frequency_penalty",
    ]);
    const extra = Object.keys(b).filter((k) => !standardKeys.has(k));
    if (extra.length) out.body_extra_keys = extra;

    // -- Routing context --
    if (opts.agentSource) out.agent_source = opts.agentSource;
    if (opts.requestKind) out.request_kind = opts.requestKind;
    if (opts.spaceId) out.space_id = opts.spaceId;
    if (typeof opts.turnSeq === "number") out.turn_seq = opts.turnSeq;
    if (opts.requestPath) out.request_path = opts.requestPath;
    if (opts.protocol) out.protocol = opts.protocol;

    // -- Request headers (whitelisted prefixes) --
    if (opts.headers) {
      for (const [rawK, v] of Object.entries(opts.headers)) {
        const k = rawK.toLowerCase();
        // Skip headers containing sensitive information
        if (k === "authorization" || k === "x-api-key" || k === "cookie") continue;
        if (!HEADER_PREFIX_WHITELIST.some((p) => k.startsWith(p))) continue;
        out[`header_${k}`] = truncate(String(v), STRING_TRUNC);
      }
    }
  } catch {
    // debug metadata is only auxiliary and must never affect the business; on exception, return the part already filled in
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
