/**
 * CodeBuddy Session Init — LastUser text extractor.
 *
 * This file used to have `stripInitArtifacts`, which stripped the
 * fake form dialogue after session_init completed (so the LLM would not see the form interaction). **That feature was removed** -- all
 * real user conversation (including the session_init form interaction) is now always kept, with no deletion.
 *
 * Only one export remains: `getLastUserMessageText`, used inside the session_init
 * state machine to read the text of the last user / tool message to parse the user's choice.
 *
 * -- CodeBuddy ask_followup_question write-back format --
 *
 * After the user clicks the form, the structure of the messages holding the Q&A in CodeBuddy's next request:
 *
 *   [N-2] role=assistant  tool_calls=[{id:"call_session_init_...", function:{name:"ask_followup_question"}}]
 *   [N-1] role=tool       tool_call_id=call_session_init_...  content=<multi_question_result JSON>
 *   [N]   role=user       content=<additional_data> or another ordinary user message
 *
 * multi_question_result JSON (actual packet-capture format):
 *   Empty-shell intermediate state (form just shown, user has not clicked yet):
 *     {"status":"success","success":true,"result":{"type":"multi_question_result",
 *      "questions":[{"id":"team","options":[...],"multiSelect":false}],
 *      "answers":{},
 *      "message":"Questions displayed. User response will be in <que"}}
 *
 *   Real answer (after the user clicks):
 *     {"status":"success","success":true,"result":{"type":"multi_question_result",
 *      "questions":[{"id":"team","answer":"Team name (last 8 chars of id)",...}],
 *      "answers":{"team":"Team name (last 8 chars of id)"}}}
 *
 * getLastUserMessageText currently scans only user messages and does not handle tool messages.
 * Team extraction relies on the extractor's substring fallback match happening to hit the team name in unrelated user text,
 * it is not exact parsing. For reliable extraction a tool-message parsing path would have to be added.
 */

import { containsFormTitle } from "./form.js";

interface RawMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  [key: string]: unknown;
}

interface AnthropicBlock {
  type?: unknown;
  text?: unknown;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get text from last user or tool message containing form answer data.
 *
 * CodeBuddy writes form responses as `role: "tool"` messages with
 * `tool_call_id` matching the session init `ask_followup_question`.
 * We look at BOTH user messages (for old XML `<question_answer>` format)
 * AND tool messages (for the actual `multi_question_result` / plain-text
 * answer format) — picking the LAST relevant one, whichever role it has.
 */
export function getLastUserMessageText(messages: RawMessage[]): string {
  // Sweep from end: the last message (user or tool) that relates to
  // session init is what we want. Tool messages are preferred because
  // CB writes "Yes, link team assets" etc. into tool_result content.
  let best = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i].role;
    if (role !== "user" && role !== "tool") continue;

    const text = getMessageText(messages[i]);
    if (!text) continue;

    // Tool messages linked to a session-init tool_call are always relevant.
    // Compatible with four prefixes: CB's `call_session_init_`, WB's `call_wb_session_init_`
    // (TOOLCALL_PREFIX = "call_wb_session_init_" in workbuddy/form.ts),
    // dsh's `call_dsh_session_init_` (TOOLCALL_PREFIX in dsh/form.ts),
    // opencode's `call_oc_session_init_` (TOOLCALL_PREFIX in opencode/form.ts).
    const tcid = (messages[i] as any).tool_call_id as string | undefined;
    if (role === "tool" && tcid && /call_(wb_|dsh_|oc_)?session_init_/.test(tcid)) {
      return text;
    }

    // User messages with form markers have highest priority for old format
    if (role === "user" && (text.includes("<question_answer") || containsFormTitle(text))) {
      return text;
    }

    // Remember the last user/tool text as fallback
    if (!best && role === "user") {
      best = text;
    }
  }
  return best;
}

function getMessageText(msg: RawMessage): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content as AnthropicBlock[]) {
      if (raw.type === "text" && typeof raw.text === "string") {
        parts.push(raw.text);
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(content ?? "");
}
