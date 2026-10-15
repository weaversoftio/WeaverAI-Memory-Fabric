import type { WamfClient } from "./client.js";
import type { WamfIdentity, WamfMessage } from "./types.js";
import { extractUserQueryText } from "../common/user-query-extractor.js";

/**
 * Extract the "real user question" from the last user message and write it to L0.
 *
 * Background: in the user messages of coding agents such as CodeBuddy / Claude Code / DSH, besides the real question there is
 * a lot of harness context (<additional_data>, current_time, <system_reminder>,
 * DSH's `Current runtime context.` snapshot, etc.). Writing the whole message to L0 as is would pollute memory
 * with this noise, which differs every turn and has very low retrieval value. So only the real question is kept here.
 *
 * The extraction algorithm is implemented in `common/user-query-extractor.ts` (shared by wamf / mem-command /
 * the codebuddy adapter to avoid semantic drift); this module only does the steps
 * "take the last user message -> extract the query text -> assemble WamfMessage".
 */

// Keep the re-export so that changing downstream import paths (including unit tests) does not cause a big one-off change.
export { extractUserQueryText };

export function extractLatestUserMessage(messages: unknown[]): WamfMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role !== "user") continue;
    // Take only the real user_query, to avoid writing harness context into L0
    const content = extractUserQueryText(extractContentText(msg.content));
    if (content.trim()) return { role: "user", content };
  }
  return null;
}

export async function recordWamfTurn(client: WamfClient, identity: WamfIdentity | null, userMessage: WamfMessage | null, assistantContent: string | null | undefined): Promise<void> {
  if (!identity || !userMessage) return;
  const messages: WamfMessage[] = [userMessage];
  if (assistantContent?.trim()) {
    messages.push({ role: "assistant", content: assistantContent });
  }
  await client.addConversation(identity, messages);
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") return p.text;
      if (typeof p.content === "string") return p.content;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}
