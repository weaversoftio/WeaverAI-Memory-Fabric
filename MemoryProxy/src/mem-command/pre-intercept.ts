/**
 * Pre-intercept decision for mem:session-reset.
 *
 * Background: all mem commands were originally recognized in each handler **after** the session-init section
 * (`anthropicHandler.ts:869-1000` / `handler.ts:922-1000` /
 * `codexHandler.ts:609-680` / `workbuddyHandler.ts:1111-1180`). This order
 * is reasonable for sync / create-skill - they depend on sessionInfo. But session-reset
 * must work in all four starting states **uninitialized / pending_* / initialized / bypassed**:
 *
 *
 *   - uninitialized: the state machine would treat "mem:session-reset" as "the user's first sentence";
 *     the asset_confirm branch that uses it as form reflection data does not apply, but at least a form would pop up first,
 *     and users seeing a form would be confused
 *   - pending_*: the state machine would treat it as "the user's answer to the form" and go through parseFormAnswer
 *     -> unrecognized -> session bypass, so the reset command is never intercepted
 *   - initialized / bypassed: the old mem-command interception section can recognize it, but after removing the "session not initialized,
 *     command unavailable" gate the behavior is the same. Using the pre-intercept for these two is also simpler
 *
 * Compromise: add a pre-intercept only for session-reset - leave other mem commands alone. This function
 * just decides "is this request session-reset"; the handler puts an if up front to decide whether to
 * short-circuit.
 */

import { parseCommandFromText } from "./parser.js";
import { resolveAgentAdapter } from "../agent-adapters/index.js";

/**
 * Decide whether the last user message in the request body is `mem:session-reset`.
 *
 * Compatible with both body.messages[] (CC/CB/dsh) and body.input[] (Codex/WB) shapes.
 * Internally uses the corresponding adapter's `extractUserText` to extract plain text, with the same text-extraction semantics as the existing mem-command
 * interception section.
 *
 * Never throws: any exception / missing field returns false, letting the original path continue.
 */
export function isSessionResetCommand(
  body: Record<string, unknown> | null | undefined,
  agentSource: string,
): boolean {
  if (!body) return false;

  try {
    const adapter = resolveAgentAdapter(agentSource);
    let text: string | null = null;

    // Codex / WorkBuddy use body.input[] (Responses API)
    if (Array.isArray((body as any).input)) {
      const input = (body as any).input as any[];
      if (input.length === 0) return false;
      // Only recognize the case where "the latest input item is a role=user message";
      // if the latest one is a function_call_output, we are in the middle of a form interaction,
      // and the codex client replays the whole history input including the earliest mem:session-reset -
      // in that case the pre-hook must not fire again, otherwise the state keeps getting reset to uninitialized in an infinite loop.
      const lastItem = input[input.length - 1] as Record<string, unknown> | null | undefined;
      if (!lastItem || typeof lastItem !== "object") return false;
      if (lastItem.type !== "message" || lastItem.role !== "user") return false;
      // Extract text directly from the last message; do not reuse extractUserText (it scans backwards)
      const content = lastItem.content;
      if (!Array.isArray(content)) return false;
      const texts: string[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown> | null | undefined;
        if (b && typeof b === "object" && b.type === "input_text" && typeof b.text === "string") {
          texts.push(b.text);
        }
      }
      text = texts.length > 0 ? texts.join("\n") : null;
    } else if (Array.isArray((body as any).messages)) {
      // CC/CB/dsh use body.messages[]
      const messages = (body as any).messages as any[];
      if (messages.length === 0) return false;
      // Last user
      const last = messages[messages.length - 1];
      if (!last || last.role !== "user") return false;
      text = adapter.extractUserText(last.content);
    } else {
      return false;
    }

    if (!text) return false;
    const parsed = parseCommandFromText(text);
    return parsed?.command === "session-reset";
  } catch {
    return false;
  }
}
