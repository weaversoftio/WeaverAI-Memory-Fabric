/**
 * handler-glue.ts — bridges the per-turn lifecycle in handler.ts /
 * anthropicHandler.ts to core `/v3/skill/conversation/add`.
 *
 * The proxy only uses the **new path**: when each real-person conversation round ends (the agent gives a
 * final reply with no tool_use), push this round's conversation slice to core; core accumulates
 * until a threshold and decides on its own when to archive (into the skill extraction pipeline).
 *
 * History: there used to be an old path SkillExtractTrigger -> /v3/skill/extract, where the proxy
 * triggered an extraction every turn, relying on the proxy-side KvExtractStore to hold the buffer. It has been deleted,
 * see the commit history. The entry point for agents to proactively trigger extraction via skill-bridge (/v3/skill/extract)
 * has also been commented out -- the core side plans to provide a "manual archive"
 * endpoint, and the agent tool will then be pointed at that endpoint again.
 *
 * Trigger timing: **round-level** -- push to core only when the agent gives a final reply (no tool_use /
 * tool_calls). Intermediate states (the agent is calling tools and the client will come back with
 * tool_result to continue the round) are skipped, and sent together once the round really ends.
 *
 * Why not turn-level (send on every HTTP request):
 *   From the proxy's view one HTTP request is a "turn", but one real-person
 *   question in Claude Code / CodeBuddy triggers N HTTP requests (the tool-use loop). If sent every turn, the core buffer
 *   would fill extremely fast -- by default 10 tool_use would trigger an archive, and a few rounds of conversation in production
 *   could produce 30+ archives. Round-level triggering guarantees "1 real Q&A = 1 add",
 *   with clear semantics and ~N times fewer RPCs. See
 *   docs/design/2026-07-17-conversation-normalize.md.
 */

import type { ProxyConfig } from "../types.js";
import type { AssetCapabilityFlags } from "../injection/types.js";
import { getCoreSkillClient } from "./core-client.js";
import {
  countToolCalls,
  findLastFinalAssistant,
  isFinalAnswer,
  normalizeConversation,
} from "./normalize-conversation.js";

/** Loose message shape for internal use in this module */
interface IncomingMsg {
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
}

export interface TriggerInput {
  config: ProxyConfig;
  sessionKey: string;
  /** Client type (first URL path segment), used for the three-segment isolation key; defaults to `claude-code`. */
  agentSource: string;
  sessionInfo: Record<string, unknown> | null | undefined;
  inputMessages: unknown[] | undefined;
  assistantMessage: Record<string, unknown> | null | undefined;
  /**
   * Protocol the request goes through -- decides the parsing rules for messages/assistantMessage.
   *   "anthropic" -> anthropicHandler.ts (/v1/messages), content may be a blocks array,
   *                 tool_result hides in role=user, tool_use hides in role=assistant
   *   "openai"    -> handler.ts (/v1/chat/completions), content is generally a string,
   *                 tool_result is a separate role=tool message, tool_calls is a separate assistant field
   *   "responses" -> codexHandler.ts (/responses), the top level is input[] rather than messages[],
   *                 items are distinguished by type: message / function_call / function_call_output /
   *                 reasoning (see the top of normalize-conversation.ts)
   *
   * The proxy already knows exactly which protocol each request uses via the route whitelist (see routes/whitelist.ts),
   * so it is passed in explicitly by the caller (handler.ts / anthropicHandler.ts / codexHandler.ts) with no inference.
   */
  protocol: "anthropic" | "openai" | "responses";
  /** Per-user asset capability flags; skill=false disables extraction collection. */
  assetCapabilities?: AssetCapabilityFlags;
  /** Optional override (e.g. SSE accumulators contain the truth in streaming mode). */
  toolCallCountOverride?: number;
}

export async function triggerSkillExtractIfReady(input: TriggerInput): Promise<void> {
  try {
    const { config, sessionKey, sessionInfo, inputMessages, assistantMessage } = input;
    if (input.assetCapabilities?.skill === false) return;
    if (!sessionKey || !sessionInfo) return;

    const userId = sessionInfo.user_id as string | undefined;
    const teamId = sessionInfo.team_id as string | undefined;
    const agentId = sessionInfo.agent_id as string | undefined;
    if (!userId || !teamId || !agentId) return;

    if (!config.coreSkill?.endpoint || !config.coreSkill?.serviceToken) return;

    const spaceId = sessionInfo.space_id as string | undefined;
    if (!spaceId) {
      console.warn(
        `[skill-conversation-add] skipped: no space_id on sessionInfo session=${sessionKey}`,
      );
      return;
    }

    const msgs: IncomingMsg[] = Array.isArray(inputMessages)
      ? (inputMessages as IncomingMsg[])
      : [];
    const rawAsst = (assistantMessage as Record<string, unknown>) ?? {};
    const hasAsst = Boolean(rawAsst && (rawAsst.role || rawAsst.content || rawAsst.tool_calls));
    const rawMsgs = msgs as unknown[] as Array<Record<string, unknown>>;

    // -- round-level trigger gate --
    // Only a final answer continues; intermediate states containing tool_use / tool_calls return directly.
    // The decision relies on the number of tool_use / tool_calls in assistantMessage;
    // in the stream branch assistantMessage.content is flattened to a string and the blocks info is lost,
    // in which case input.toolCallCountOverride is authoritative (see anthropicHandler.ts:1592-1597).
    if (!isFinalAnswer(hasAsst ? rawAsst : null, input.toolCallCountOverride)) return;

    // -- this round's slice --
    // slice start = right after the previous "final assistant" = the start of this round's user input.
    // Not found (first round / history is all intermediate states) -> -1 + 1 = 0, naturally sends the whole thing, semantics correct.
    const lastFinal = findLastFinalAssistant(rawMsgs, input.protocol);
    const startIdx = lastFinal + 1;

    // Normalize into 5 roles by protocol branch -- expand anthropic content blocks / openai tool_calls,
    // recognize tool_use / tool_result and convert them into role=tool_call / role=tool_result respectively.
    // agentSource is used to extract user text by client-specific rules (see agent-adapters/)
    // See normalize-conversation.ts and docs/design/2026-07-17-conversation-normalize.md
    const turnMessages = normalizeConversation(
      rawMsgs.slice(startIdx),
      input.protocol,
      hasAsst ? rawAsst : null,
      input.agentSource,
    );
    if (turnMessages.length === 0) return;

    try {
      const client = getCoreSkillClient(config.coreSkill);
      const t0 = Date.now();
      const result = await client.addConversation(
        {
          session_id: sessionKey,
          space_id: spaceId,
          user_id: userId,
          team_id: teamId,
          agent_id: agentId,
          task_id: sessionInfo.task_id as string | undefined,
          messages: turnMessages,
        },
        // core uses x-wamf-service-id = the real kernel instance ID
        { serviceId: spaceId },
      );
      if (result.status === "archived" && result.archived) {
        console.log(
          `[skill-conversation-add] archived session=${sessionKey} task_id=${result.archived.task_id}` +
            ` reason=${result.archived.reason} took=${Date.now() - t0}ms` +
            ` round_msgs=${turnMessages.length} slice=${startIdx}/${rawMsgs.length}`,
        );
      } else {
        // status=ok: archive not triggered -- core has accumulated this round into the buffer, and will only archive
        // after the next round or a few more rounds reach the threshold.
        console.log(
          `[skill-conversation-add] appended session=${sessionKey}` +
            ` round_msgs=${turnMessages.length} slice=${startIdx}/${rawMsgs.length}` +
            ` took=${Date.now() - t0}ms`,
        );
      }
    } catch (err) {
      // A core failure does not affect the main response chain; look at the metrics before deciding whether to upgrade to error
      console.warn(
        "[skill-conversation-add] addConversation failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  } catch (err) {
    // Conservative: swallow any exception to avoid affecting the main response chain.
    console.warn(
      "[skill-extract-glue] triggerSkillExtractIfReady swallowed error:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Compatibility: some old code imports countToolCalls from handler-glue
export { countToolCalls };
