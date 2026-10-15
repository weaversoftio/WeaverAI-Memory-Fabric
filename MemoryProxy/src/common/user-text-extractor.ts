/**
 * Extractor for "the text the user actually typed" in User message content.
 *
 * Background: each Claude Code CLI user message's `content` is often a multi-block array,
 * with CC-internal environment metadata such as `<system-reminder>` first; only the last `type:"text"` block
 * is the user's real input. Other blocks such as tool_result / image / thinking are not typed by the user.
 *
 * Call sites (**only** called on the CC client path under the anthropic protocol):
 *   - `mem-command/parser.ts` - checks for the `mem:` command prefix
 *   - `skill/normalize-conversation.ts` (anthropic user branch) - only pushes the last piece of user text to the skill core
 *
 * CodeBuddy (openai protocol) keeps its existing logic untouched and does not reuse this helper.
 */

export function extractLastUserText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  // Scan from back to front for the first block with type:"text" whose text is a string
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i];
    if (!b || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (block.type !== "text") continue;
    if (typeof block.text !== "string") continue;
    return block.text;
  }
  return null;
}
