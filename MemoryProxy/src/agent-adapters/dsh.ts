/**
 * deepseek-harness (dsh) client adapter.
 *
 * Packet-capture evidence (2026-08-14, 6 real packets via mitmproxy, see
 * `docs/dsh-recon/2026-08-14-dsh-capture-analysis.md`):
 *
 *   - Protocol: **standard OpenAI Chat Completions** (`POST /chat/completions` + SSE),
 *     same family as codebuddy; body/messages shape is 100% compatible (role: system/user/assistant/tool,
 *     tool_calls[] on assistant, separate role=tool messages carrying tool_call_id)
 *   - Client fingerprint (strong): `user-agent: deepseek-harness/*` (dsh attribution cannot be turned off)
 *     + `x-deepseek-harness-user-id` (anonymous UUID, constant) + `x-deepseek-harness-session-id`
 *     (session-<uuid>) + `x-deepseek-harness-compact:1` (only on compaction requests)
 *   - session_id is **only in the header**; the body has no fallback field (unlike codex's client_metadata);
 *     the proxy-side sid extraction depends 100% on the header
 *   - assistant echoes back `reasoning_content` (a dsh specialty, only echoed on tool_calls turns),
 *     the proxy just passes it through and it does not affect the messages parser
 *
 * # Distinguishing three request kinds (main / title / compaction)
 *
 * dsh main conversation / compaction / session-title all share the same `x-deepseek-harness-session-id`,
 * **only compaction has its own header** (compact:1), title has none - so they are distinguished by body features:
 *
 * | Category | header signal | body features |
 * |---|---|---|
 * | compaction | `x-deepseek-harness-compact: 1` | — |
 * | title-gen | none | tools missing + thinking.disabled + max_tokens<=128 + system starts with "Create a concise title..." |
 * | main | none | everything else |
 *
 * classifyRequest priority: **compact header > title body-shape > main**;
 * the title criterion must satisfy **all three together** to count as aux (a single feature is easily misjudged).
 *
 * # Two adaptation points
 *   - `classifyRequest`: three-signal decision (compact / title / main)
 *   - `extractUserText`: if content is a str, return it directly (dsh messages.content never uses blocks)
 *
 * # Differences from CB
 *   - The dsh main conversation stuffs 4 role=user messages into body.messages: real user input +
 *     `<system-reminder>` workspace instructions + a `runtime context` snapshot + the `<available_skills>` list
 *     - when the proxy extracts the last user's str content, taking "the first one from the back" is enough;
 *     the actual user input is usually in messages[1] (the first user message)
 *   - dsh user input itself **has no `<user_query>` wrapper like CB/workbuddy**, passed through directly
 */

import type { AgentAdapter, RequestKind } from "./types.js";

// ── Title-gen body-shape detection ───────────────────────────────────────────

/**
 * Fixed prefix of the system prompt of dsh session-title-llm requests.
 * Source: `packages/session/session-title-llm/src/index.ts:252-260` +
 * verified by packet capture `fixtures/121918-*-9d056d.req.json`.
 *
 * The full opening of the dsh-side prompt:
 *   "Create a concise title for an AI coding-assistant session from the supplied human messages."
 *
 * Only the prefix is used for matching, so the criterion doesn't break when upstream tweaks the prompt (punctuation / newlines).
 */
const DSH_TITLE_SYSTEM_PROMPT_PREFIX =
  "Create a concise title for an AI coding-assistant session";

/**
 * Upper bound of max_tokens for dsh title-gen requests. Packet capture shows `max_tokens=64`;
 * 128 leaves some slack so it doesn't drift after upstream tweaks.
 */
const DSH_TITLE_MAX_TOKENS_CEIL = 128;

/**
 * Decide whether a dsh request is title-gen (three body features together).
 *
 * All conditions must hold to count as aux. If any one fails, return false (avoid misjudging main).
 */
function isDshTitleGen(body: Record<string, unknown>): boolean {
  // Condition 1: tools missing or an empty array (main conversation always has 25+)
  const tools = body.tools;
  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (hasTools) return false;

  // Condition 2: thinking.type === "disabled"
  const thinking = body.thinking as { type?: string } | undefined;
  if (thinking?.type !== "disabled") return false;

  // Condition 3: max_tokens <= 128
  const maxTokens = body.max_tokens;
  if (typeof maxTokens !== "number" || maxTokens > DSH_TITLE_MAX_TOKENS_CEIL) return false;

  // Condition 4: the first system message's content starts with the title prompt prefix
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const first = messages[0] as { role?: string; content?: unknown } | undefined;
  if (!first || first.role !== "system" || typeof first.content !== "string") return false;
  if (!first.content.startsWith(DSH_TITLE_SYSTEM_PROMPT_PREFIX)) return false;

  return true;
}

// ── User text extraction ─────────────────────────────────────────────────────

/**
 * dsh messages.content is a str; return it directly.
 *
 * Packet-capture evidence (fixtures/*.req.json: many messages all role=user + content:str):
 * dsh never uses Anthropic-style content-blocks arrays; even tool_result is a separate
 * role=tool message (not nested in a user message).
 *
 * No CB-style `<user_query>` wrapper stripping - the dsh main conversation is plain user input +
 * separate `<system-reminder>` user messages, with no wrapper nesting.
 */
function extractDshUserText(content: unknown): string | null {
  if (typeof content !== "string") return null;
  return content.length > 0 ? content : null;
}

// ── Adapter export ───────────────────────────────────────────────────────────

export const dshAdapter: AgentAdapter = {
  agentKind: "dsh",

  classifyRequest(
    body: Record<string, unknown>,
    _path?: string,
    headers?: Record<string, string>,
  ): RequestKind {
    // Signal 1 (strongest): compact header - the dsh source hard-codes it in
    // `packages/llm/llm-deepseek/src/adapter.ts:290-293`, only added when
    // `purpose:'compaction'`, unambiguous
    if (headers?.["x-deepseek-harness-compact"] === "1") return "auxiliary";

    // Signal 2: title-gen body features, all three together (see isDshTitleGen)
    if (isDshTitleGen(body)) return "auxiliary";

    // Everything else is main
    return "main";
  },

  extractUserText(content: unknown): string | null {
    return extractDshUserText(content);
  },
};
