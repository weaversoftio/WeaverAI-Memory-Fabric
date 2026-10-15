/**
 * Turn sequence counting -- stateless derivation on the host side.
 *
 * One trace = one turn (one user input). The tool loop within a turn produces multiple upstream
 * requests, which must compute the **same** turn sequence so they merge into the same trace in Langfuse.
 *
 * Since the host side has no per-request persistent state (the turn counter lives inside a private module and does not expose
 * a per-turn sequence), it is derived directly from the `messages` history: count the "human input rounds" in the
 * message sequence. The rules align with the private module's turn detection logic:
 *   - Anthropic: a user message containing a text block that is not a <system-reminder> is human input;
 *     a pure tool_result / pure system-reminder is a continuation of the tool loop.
 *   - OpenAI: role=user with non-<system-reminder> text is human input; role=tool is the tool loop.
 *
 * Therefore: a turn's first request and its subsequent tool-loop requests have the same "human round count", so turnSeq is consistent.
 * The next turn's request has one more human input -> turnSeq +1 -> new trace.
 *
 * Note: relies on the client sending the full history (both Claude Code and CodeBuddy do). If a client truncates history,
 * turnSeq may shift, but stays consistent within the same turn (only the absolute value drifts), which does not affect "same turn merges into one trace".
 */

/** Decide whether a single user message's content is human input (not a tool-loop continuation). */
function isHumanUserContent(content: unknown): boolean {
  if (typeof content === "string") {
    return !content.startsWith("<system-reminder>");
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b && typeof b === "object" && b.type === "text") {
        const text = (b.text as string) ?? "";
        if (!text.startsWith("<system-reminder>")) return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * Count the "human input rounds" in messages, used as the current turn sequence.
 *
 * Return value >= 1 (at least the current round); returns 0 for empty messages or when there is no human input.
 */
export function countHumanTurns(messages: unknown[], protocol: "openai" | "anthropic"): number {
  let count = 0;
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m?.role !== "user") continue;
    // OpenAI tool responses are role=tool (they never get here); user messages are judged by content.
    if (protocol === "openai" || protocol === "anthropic") {
      if (isHumanUserContent(m.content)) count += 1;
    }
  }
  return count;
}
