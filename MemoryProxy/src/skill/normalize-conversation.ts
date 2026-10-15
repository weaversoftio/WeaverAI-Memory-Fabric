/**
 * normalize-conversation.ts
 *
 * Convert the client's raw request messages[] + the assistantMessage returned by the upstream into
 * the 5-role normalized array needed by core `/v3/skill/conversation/add`:
 *   { role: "user" | "assistant" | "tool_call" | "tool_result" | "system",
 *     content: string,
 *     tool_call_id?: string,
 *     tool_name?: string }
 *
 * Explicitly branches by protocol:
 *   protocol="anthropic" → Anthropic Messages API (Claude Code, /v1/messages)
 *     - in user, content may be a blocks array, and tool_result hides in the blocks of role=user
 *     - in assistant, tool_use hides in content blocks
 *   protocol="openai"    → OpenAI Chat Completions (CodeBuddy, /v1/chat/completions)
 *     - tool_result is a separate role=tool message (only tool_call_id, no tool_name)
 *     - assistant.tool_calls is a separate array field
 *   protocol="responses" → OpenAI Responses API (Codex CLI, /responses)
 *     - the top-level field is `input[]` rather than `messages[]`, and items are distinguished by `type`:
 *         · type="message" role=user/assistant/developer → content[].input_text|output_text
 *         - type="function_call" -> a standalone top-level item, containing call_id / name / arguments
 *         - type="function_call_output" -> a standalone top-level item, containing call_id / output
 *         - type="reasoning" -> internal thinking, always discarded (aligned with anthropic thinking)
 *     - a developer message is equivalent to openai role=system, discarded (not in the skill corpus)
 *     - assistant-side tool calls are not embedded in message.content but are standalone items, so
 *       when "this round's assistantMessage" is pulled out it may contain several earlier function_call/function_call_output
 *       mixed with text -- the caller passing assistantMessage should only put "the assistant text segment of the response
 *       + the tool_use count override accumulated by this round's stream"; function_calls already in the existing input[]
 *       are still handled when normalizeConversation iterates.
 *
 * Key rules (corresponding to docs/design/2026-07-17-conversation-normalize.md):
 *   - when an Anthropic user is all tool_result blocks -> output role=tool_result, not user
 *   - when an Anthropic user mixes text + tool_result -> split into two (role=user, role=tool_result)
 *   - thinking block in an Anthropic assistant -> currently **fully discarded**
 *     TODO: later if thinking needs to be kept, add a `keepThinking: boolean` parameter,
 *     kept as role=assistant + a content prefix [thinking] xxx (aligned with Opik flatten)
 *   - Anthropic image block -> discarded (no value for skill extraction)
 *   - Anthropic assistant content array empty -> the whole message is discarded
 *   - OpenAI role=tool message -> tool_name stays undefined (the core schema was relaxed to optional)
 *
 * assistantMessage is this round's upstream response, already pulled out by the proxy and passed separately:
 *   - anthropic shape: { role: "assistant", content: <blocks array> }
 *   - openai shape:    { role: "assistant", content: string | null, tool_calls?: [...] }
 *
 * This module does not do "this round's slice" -- whether the caller sends the full history or this round's increment is decided by handler-glue; here only format normalization is done.
 *
 * Besides the normalizer, this file also exports two round-boundary decision helpers:
 *   - isFinalAnswer(asst, toolCallCountOverride?):
 *       decide whether this response is the agent's final reply (no tool_use / tool_calls)
 *   - findLastFinalAssistant(rawMessages, protocol):
 *       find the index of the last final assistant in messages[] (locating the round start)
 *
 * These two helpers are used by handler-glue to implement round-level triggering: push to core only on a final answer
 * and skip intermediate states, avoiding the core buffer accumulating explosively from "sending an increment on every HTTP request"
 * (10 tool_use or 40KB triggers an archive).
 */

import { resolveAgentAdapter } from "../agent-adapters/index.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type Protocol = "anthropic" | "openai" | "responses";

/** Output format, corresponding to core conversationMessageSchema. */
export interface NormalizedMessage {
  role: "user" | "assistant" | "tool_call" | "tool_result" | "system";
  content: string;
  tool_call_id?: string;
  tool_name?: string;
}

/** raw message shape - loose because the raw shapes of all three protocols must fit in. */
interface RawMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  /**
   * Discriminator field of codex Responses API input[]:
   *   "message" | "function_call" | "function_call_output" | "reasoning" | ...
   * anthropic/openai messages do not have this field.
   */
  type?: string;
  [k: string]: unknown;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Count the number of tool_use / tool_calls blocks in the assistant response, used for isFinalAnswer
 * / round boundary decisions. Cross-protocol compatible:
 *   - OpenAI: length of the top-level `tool_calls: [...]` array
 *   - Anthropic: the number of `type === "tool_use"` in content blocks
 * Any other shape is 0 (pure text or empty response).
 */
export function countToolCalls(assistantMessage: Record<string, unknown> | null | undefined): number {
  if (!assistantMessage) return 0;
  // OpenAI: top-level `tool_calls: [...]`
  const tc = assistantMessage.tool_calls;
  if (Array.isArray(tc)) return tc.length;
  // Anthropic: content blocks
  const content = assistantMessage.content;
  if (Array.isArray(content)) {
    let n = 0;
    for (const block of content) {
      const t = (block as Record<string, unknown>)?.type;
      if (t === "tool_use") n++;
      // Codex Responses API: the assistant "message" contains only output_text; function_call
      // is a sibling item and does not appear in assistant.content. So in the responses scenario
      // countToolCalls(assistantMessage) is always 0 -- the real tool call count is passed in via the stream
      // accumulator's toolCallCountOverride (consistent with the anthropic stream).
    }
    return n;
  }
  return 0;
}

/**
 * Decide whether this assistantMessage is the agent's final reply (round ended).
 *
 * Criterion: **no tool_use / tool_calls** -- having text does not matter, because a "text + tool_use mixed"
 * intermediate state may occur (the agent calls tools while talking). In that case the round
 * has not ended, the text part is kept in messages[] as history, and the next real final answer
 * slices it into that round together.
 *
 * Distinguishing the two protocols:
 *   - anthropic non-stream: look directly at whether asst.content blocks contain tool_use
 *   - anthropic stream:     content has been flattened to a string by the proxy (blocks info lost),
 *                           the caller must pass toolCallCountOverride
 *   - openai:               look at the length of asst.tool_calls[]
 *
 * Reuses countToolCalls of this file to handle protocol differences; here only the override priority is added.
 */
export function isFinalAnswer(
  asst: RawMessage | null | undefined,
  toolCallCountOverride?: number,
): boolean {
  if (!asst) return false;
  // Stream scenario: the override is the authoritative source; content has lost the blocks structure and cannot be relied on for the decision
  if (toolCallCountOverride !== undefined) {
    return toolCallCountOverride === 0;
  }
  return countToolCalls(asst as Record<string, unknown>) === 0;
}

/**
 * Find the index of the most recent assistant of the "final reply shape" in messages[] -- defined as
 * role=assistant with no tool_use / tool_calls in the response. Returning -1 means the history is all
 * intermediate states / has no assistant, and the caller should slice from index 0.
 *
 * Purpose: locate this round's start in handler-glue -- slicing from right
 * after the "previous final assistant" gives this round's complete conversation (user + intermediate tool_use/tool_result... +
 * this assistantMessage).
 *
 * Protocol differences:
 *   - anthropic: in the history messages assistant.content may be a string (pure text final)
 *                or a blocks array (mixed). As long as there is no tool_use in blocks it counts as final.
 *   - openai:    in the history messages assistant may have a tool_calls field. As long as
 *                tool_calls is empty / missing it counts as final.
 */
export function findLastFinalAssistant(
  rawMessages: RawMessage[],
  protocol: Protocol,
): number {
  if (protocol === "responses") {
    // In Codex `input[]` the assistant uses `{type:"message", role:"assistant"}`;
    // its tool calls are sibling items `{type:"function_call", ...}` rather than
    // embedded blocks. The rule to decide "this assistant is final": scan forward from this index,
    // and as long as no function_call (and its accompanying function_call_output) appears
    // before meeting the next role=user message, it is a final answer and this round ends.
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const m = rawMessages[i];
      if (!m || m.type !== "message" || m.role !== "assistant") continue;
      // Scan the tail to see whether there is a function_call
      let hasFnCall = false;
      for (let j = i + 1; j < rawMessages.length; j++) {
        const next = rawMessages[j];
        if (!next || typeof next !== "object") continue;
        if (next.type === "function_call") { hasFnCall = true; break; }
        if (next.type === "message" && next.role === "user") break;   // reached the next round
      }
      if (!hasFnCall) return i;
    }
    return -1;
  }
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const m = rawMessages[i];
    if (!m || m.role !== "assistant") continue;
    if (isFinalAnswer(m)) {
      // isFinalAnswer relies on countToolCalls for both protocols, covering:
      //   anthropic: content is a string -> tool_use=0 -> final
      //              content is blocks with no tool_use -> tool_use=0 -> final
      //   openai:    tool_calls=[] or missing -> tool_use=0 -> final
      // (the protocol parameter is kept for future extension to finer-grained decisions, currently unused)
      void protocol;
      return i;
    }
  }
  return -1;
}

export function normalizeConversation(
  rawMessages: RawMessage[],
  protocol: Protocol,
  assistantMessage: RawMessage | null,
  agentSource: string = "claude-code",
): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  // Fallback: protocol=responses but agentSource defaults to claude-code (an old caller did not pass it)
  // -> force-switch to the codex adapter, otherwise extractUserText would use the wrong client rules and return null,
  // breaking the whole archive path.
  const effectiveAgentSource = protocol === "responses" && agentSource === "claude-code"
    ? "codex"
    : agentSource;
  const convertOne = (m: RawMessage): NormalizedMessage[] => {
    if (protocol === "anthropic") return convertAnthropicMessage(m, effectiveAgentSource);
    if (protocol === "openai") return convertOpenAIMessage(m, effectiveAgentSource);
    return convertCodexInputItem(m, effectiveAgentSource);
  };
  for (const m of rawMessages) {
    if (!m || typeof m !== "object") continue;
    for (const c of convertOne(m)) out.push(c);
  }
  if (assistantMessage) {
    // For the responses protocol, the upstream returns only assistant text (function_call is recognized
    // separately in the stream and has already entered input[] in the next request; archiving covers it by iterating rawMessages),
    // so only one role=assistant + text is added here -- reusing convertCodexInputItem
    // via the same path, keeping symmetry with the other two protocols.
    const asst: RawMessage = protocol === "responses"
      ? { type: "message", role: "assistant", ...assistantMessage }
      : { role: "assistant", ...assistantMessage };
    // Safeguard: explicitly set role=assistant in case the assistantMessage passed by the caller lacks role;
    // convertOne depends on effectiveAgentSource, and the protocol=responses fallback above already covers it.
    asst.role = "assistant";
    for (const c of convertOne(asst)) out.push(c);
  }
  return out;
}

// ─── Anthropic ─────────────────────────────────────────────────────────────

function convertAnthropicMessage(msg: RawMessage, agentSource: string): NormalizedMessage[] {
  const role = msg.role;
  const content = msg.content;

  // role=system: discard, do not send to core.
  // The client's fixed agent instruction (CodeBuddy 26KB / Claude Code is not small either) is irrelevant to
  // skill extraction, and counting it toward the 40KB bytes threshold would only mess up the archive rhythm. Handled uniformly across both protocols:
  //   - Anthropic: system is originally at the top level of body.system; appearing in messages is a minority scenario
  //   - OpenAI:    system is at messages[0], carried with every request
  // See the upstream normalize call site in handler-glue.ts for details.
  if (role === "system") {
    return [];
  }

  if (role === "assistant") {
    return convertAnthropicAssistant(content);
  }

  if (role === "user") {
    return convertAnthropicUser(content, agentSource);
  }

  // Any other role is dropped
  return [];
}

function convertAnthropicAssistant(content: unknown): NormalizedMessage[] {
  // content may be a string / array of blocks
  if (typeof content === "string") {
    return content.length > 0 ? [{ role: "assistant", content }] : [];
  }
  if (!Array.isArray(content)) {
    // Fallback: a structured object but not an array -> serialize
    return [{ role: "assistant", content: contentToString(content) }];
  }

  const out: NormalizedMessage[] = [];
  const textParts: string[] = [];
  const toolCalls: NormalizedMessage[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const t = b.type;

    if (t === "text") {
      const txt = b.text;
      if (typeof txt === "string" && txt.length > 0) textParts.push(txt);
    } else if (t === "tool_use") {
      // Convert to role=tool_call, tool_name from name, tool_call_id from id
      const id = typeof b.id === "string" ? b.id : "";
      const name = typeof b.name === "string" ? b.name : undefined;
      const inputStr = safeStringify(b.input);
      const tc: NormalizedMessage = {
        role: "tool_call",
        content: inputStr,
        tool_call_id: id,
      };
      if (name) tc.tool_name = name;
      toolCalls.push(tc);
    }
    // Any other block type (thinking / redacted_thinking / image / ...) is always discarded
  }

  if (textParts.length > 0) {
    out.push({ role: "assistant", content: textParts.join("\n") });
  }
  for (const tc of toolCalls) out.push(tc);
  return out;
}

function convertAnthropicUser(content: unknown, agentSource: string): NormalizedMessage[] {
  if (typeof content === "string") {
    return [{ role: "user", content }];
  }
  if (!Array.isArray(content)) {
    return [{ role: "user", content: contentToString(content) }];
  }

  const out: NormalizedMessage[] = [];
  const toolResults: NormalizedMessage[] = [];

  // Collect all tool_results (output separately as role=tool_result messages)
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_result") continue;
    const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
    // tool_result.content may be a string / array of {type:"text",text} / other
    const resultText = anthropicToolResultContentToString(b.content);
    toolResults.push({
      role: "tool_result",
      content: resultText,
      tool_call_id: id,
      // Note: an anthropic tool_result has no tool_name field, and the proxy does no reverse lookup either
      // (the core schema was relaxed to optional)
    });
  }

  // Text part: via agentAdapter extract "the text the user really typed" by client rules:
  //   - claude-code: take the last text block (skipping <system-reminder> prefix metadata)
  //   - codebuddy / unknown: take the conservative "concatenate all text" (equivalent to the old pre-refactor logic)
  const adapter = resolveAgentAdapter(agentSource);
  const userText = adapter.extractUserText(content);
  if (typeof userText === "string" && userText.length > 0) {
    out.push({ role: "user", content: userText });
  }
  for (const tr of toolResults) out.push(tr);
  return out;
}

function anthropicToolResultContentToString(rc: unknown): string {
  if (typeof rc === "string") return rc;
  if (Array.isArray(rc)) {
    const parts: string[] = [];
    for (const b of rc) {
      if (!b || typeof b !== "object") continue;
      const bb = b as Record<string, unknown>;
      if (bb.type === "text" && typeof bb.text === "string") {
        parts.push(bb.text);
      }
      // Ignore other block types such as image
    }
    return parts.join("\n");
  }
  return contentToString(rc);
}

// ─── OpenAI ────────────────────────────────────────────────────────────────

function convertOpenAIMessage(msg: RawMessage, agentSource: string): NormalizedMessage[] {
  const role = msg.role;
  const content = msg.content;

  // role=system: discard, do not send to core. Consistent with the anthropic branch; see the comment there for details.
  if (role === "system") {
    return [];
  }
  if (role === "user") {
    // Via the adapter extract "the text the user really typed" by client rules, symmetric with the anthropic side:
    //   - codebuddy: go through <user_query> extraction (stripping the CB pseudo-XML wrappers such as <user_info> / <additional_data> /
    //     <question_answer>); when it returns null this round does not enter the
    //     skill buffer (to avoid polluting the skill extraction corpus)
    //   - unknown / cursor etc.: go through the default fallback (concatenate all text, equivalent to the old pre-refactor logic)
    // See agent-adapters/codebuddy.ts + common/user-query-extractor.ts for details.
    const adapter = resolveAgentAdapter(agentSource);
    const userText = adapter.extractUserText(content);
    if (typeof userText === "string" && userText.length > 0) {
      return [{ role: "user", content: userText }];
    }
    return [];
  }
  if (role === "tool") {
    // openai role=tool → role=tool_result
    const id = typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
    return [{
      role: "tool_result",
      content: contentToString(content),
      tool_call_id: id,
      // tool_name not provided -- the core schema is already optional
    }];
  }
  if (role === "assistant") {
    return convertOpenAIAssistant(content, msg.tool_calls);
  }
  return [];
}

function convertOpenAIAssistant(content: unknown, toolCalls: unknown): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];

  // text part
  const contentStr = typeof content === "string" ? content : (content == null ? "" : contentToString(content));
  if (contentStr.length > 0) {
    out.push({ role: "assistant", content: contentStr });
  }

  // tool_calls (openai standard)
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const t = tc as Record<string, unknown>;
      const id = typeof t.id === "string" ? t.id : "";
      const fn = t.function as Record<string, unknown> | undefined;
      const name = fn && typeof fn.name === "string" ? fn.name : undefined;
      let argsStr = "";
      if (fn && fn.arguments !== undefined) {
        argsStr = typeof fn.arguments === "string" ? fn.arguments : safeStringify(fn.arguments);
      }
      const call: NormalizedMessage = {
        role: "tool_call",
        content: argsStr,
        tool_call_id: id,
      };
      if (name) call.tool_name = name;
      out.push(call);
    }
  }

  return out;
}

// ─── Codex Responses API (input[] items) ───────────────────────────────────

/**
 * Translate one item of codex `input[]` into 5-role NormalizedMessage[].
 *
 * Item type list (docs/2026-08-07-codex-integration-plan.md section 7.2 / agent-adapters/codex.ts):
 *   - {type:"message", role:"user"|"assistant"|"developer", content:[...]}
 *   - {type:"function_call", call_id, name, arguments}
 *   - {type:"function_call_output", call_id, output}
 *   - {type:"reasoning", encrypted_content}
 *
 * Mapping:
 *   message.developer         -> discard (equivalent to openai role=system, not in the skill corpus)
 *   message.user              -> role=user, content = the text the user really typed (via the codex adapter)
 *   message.assistant         -> role=assistant, content = output_text concatenated
 *   function_call             → role=tool_call, tool_call_id, tool_name, content=arguments
 *   function_call_output      → role=tool_result, tool_call_id, content=output
 *   reasoning                 -> discard (aligned with anthropic thinking; not in the skill corpus)
 *   any other unknown type              -> discard (lean strict not loose; even if codex adds a new item type in the future it will not be mistakenly collected)
 */
function convertCodexInputItem(item: RawMessage, agentSource: string): NormalizedMessage[] {
  const type = item.type;

  if (type === "message") {
    const role = item.role;
    // developer / system / any other role is always dropped
    if (role === "user") {
      return convertCodexUserMessage(item.content, agentSource);
    }
    if (role === "assistant") {
      return convertCodexAssistantMessage(item.content);
    }
    return [];
  }

  if (type === "function_call") {
    const id = typeof item.call_id === "string" ? item.call_id : "";
    const name = typeof item.name === "string" ? item.name : undefined;
    const argsRaw = item.arguments;
    const args = typeof argsRaw === "string" ? argsRaw : safeStringify(argsRaw);
    const call: NormalizedMessage = {
      role: "tool_call",
      content: args,
      tool_call_id: id,
    };
    if (name) call.tool_name = name;
    return [call];
  }

  if (type === "function_call_output") {
    const id = typeof item.call_id === "string" ? item.call_id : "";
    const outputRaw = item.output;
    const output = typeof outputRaw === "string" ? outputRaw : safeStringify(outputRaw);
    return [{
      role: "tool_result",
      content: output,
      tool_call_id: id,
    }];
  }

  // reasoning / anything else is always dropped
  return [];
}

/** In a codex user message content is [{type:"input_text",text}, ...] */
function convertCodexUserMessage(content: unknown, agentSource: string): NormalizedMessage[] {
  // Prefer reusing the codex agent adapter's extractUserText -- it is the same implementation as `extractCodexUserText(input)`
  // in codexHandler (agent-adapters/codex.ts:81),
  // with consistent semantics; any future upgrade of the extraction rules only needs to change that one place. Passing a single message here just wraps it in the
  // [message] array the adapter expects (it filters by role=user).
  //   Note: the adapter.extractUserText input is expected to be the full input[] array, but internally it only iterates
  //   item by item to pick the last user; passing a single one also hits.
  const singleItem = { type: "message", role: "user", content } as Record<string, unknown>;
  const adapter = resolveAgentAdapter(agentSource);
  const text = adapter.extractUserText([singleItem]);
  if (typeof text === "string" && text.length > 0) {
    return [{ role: "user", content: text }];
  }
  return [];
}

/** In a codex assistant message content is [{type:"output_text",text}, ...] */
function convertCodexAssistantMessage(content: unknown): NormalizedMessage[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ role: "assistant", content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    // codex assistant text uses output_text; fallback text in case codex uses another form
    if ((b.type === "output_text" || b.type === "text") && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  if (parts.length === 0) return [];
  return [{ role: "assistant", content: parts.join("\n") }];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return safeStringify(content);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    // e.g. BigInt / circular ref
    try {
      return String(v);
    } catch {
      return "";
    }
  }
}
