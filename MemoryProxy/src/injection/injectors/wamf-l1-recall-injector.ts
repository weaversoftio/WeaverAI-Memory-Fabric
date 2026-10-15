import type { AgentContext, ContextBlock, InjectionHook, HookPriority } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { getLastUserMessage, getMessageText } from "../context.js";
import type { WamfClient } from "../../wamf/client.js";
import { getWamfIdentity } from "../../wamf/identity.js";
import { extractUserQueryText } from "../../wamf/recorder.js";
import type { CoreSkillConfig } from "../../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { resolveFixedAssetCtxs } from "./wamf-fixed-asset.js";

/**
 * L1 recall ("own + borrowed" cross-agent merged top-K):
 *   1. Get the current (team, user, agent) identity from ctx (derived from ProxyConfig)
 *   2. Call the control plane /fixed-asset-agents to get [self, ...borrowed (up to 2)]
 *   3. Run /atomic/search concurrently for each ctx (query=last user message)
 *   4. Merge all hits -> sort by score descending -> take the top globalTopK
 *   5. Inject into user.before, each entry tagged [from <agent_name>]
 *
 * Degrades when the control plane is unreachable: only query the current agent's L1 (same behavior as before the refactor).
 */
export class WamfL1RecallInjector implements InjectionHook {
  id = "wamf-l1-recall-injector";
  point = "user.before" as const;
  priority: HookPriority = HOOK_PRIORITY.MEMORY;
  description = "Recall WAMF L1 memories from self + imported agents and prepend them to the current user turn";

  /**
   * @param sessionInitConfig used to call the control plane for fixed-asset-agents; if null,
   *        the injector degrades to "current agent only" mode, preserving backward compatibility.
   * @param perAgentLimit how many entries to recall from wamf per agent (default = client config)
   * @param globalTopK how many entries to keep after merging (default 5)
   */
  constructor(
    private client: WamfClient,
    private coreSkillCfg: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs"> | null = null,
    private perAgentLimit: number | undefined = undefined,
    private globalTopK = 5,
    /**
     * ACL-check client, usually the same WamfClient instance as `client`. When provided, each
     * fixed-asset ctx goes through acl/check(read) filtering. When null the old behavior is kept.
     */
    private aclClient: WamfClient | null = null,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const identity = getWamfIdentity(ctx.metadata.custom);
    if (!identity) return [];

    const lastUser = getLastUserMessage(ctx);
    if (!lastUser) return [];
    // Use the "clean real user_query" as the search term, not the whole raw message blob
    // (the latter contains noise such as <user_info>/<additional_data>/<question_answer>,
    //  which makes the FTS5/vector hit rate very low or even 0, so L1 recalls nothing).
    const query = extractUserQueryText(getMessageText(lastUser)).trim().slice(0, 2048);
    if (!query) return [];

    // Get the ctx list of self + up to 2 borrowed
    const session = (ctx.metadata.custom as any)?.session as { user_key?: string; space_id?: string } | undefined;
    const userKey = session?.user_key;
    // spaceId comes from `/proxy/<spaceId>/...` in the URL path saved at session registration;
    // used as the kernel's `x-wamf-service-id` header for tenant routing.
    const spaceId = session?.space_id ?? "";
    const mc = this.coreSkillCfg && userKey
      ? getMetadataClient(this.coreSkillCfg, spaceId, userKey)
      : null;
    const ctxs = await resolveFixedAssetCtxs(ctx, identity, mc);

    // Search L1 concurrently for each ctx
    const groups = await Promise.all(
      ctxs.map(async (c) => {
        const items = await this.client.searchL1ForCtx(
          { teamId: c.teamId, userId: c.userId, agentId: c.agentId, agentName: c.agentName },
          query,
          identity.sessionId,
          identity.taskId,
          this.perAgentLimit,
        );
        return items.map((m) => ({
          ...m,
          fromAgentId: c.agentId,
          fromAgentName: c.agentName,
        }));
      }),
    );
    // Merge all hits, sort by score descending (those without score go last)
    const merged = ([] as Array<(typeof groups)[number][number]>)
      .concat(...groups)
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
      .slice(0, this.globalTopK);

    if (merged.length === 0) return [];

    const lines: string[] = [
      "<wamf_recalled_l1_memories>",
      "Below are WAMF L1 memories relevant to the user's question in this turn (own + borrowed, sorted by relevance). Use them only to help answer this turn; do not treat them as permanent system rules:",
    ];
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i];
      const fromTag =
        m.fromAgentId === identity.agentId
          ? "self"
          : `from ${m.fromAgentName ?? m.fromAgentId}`;
      const score = typeof m.score === "number" ? ` score=${m.score.toFixed(3)}` : "";
      lines.push(`${i + 1}. [${m.type ?? "memory"}] [${fromTag}${score}] ${m.content}`);
    }
    lines.push("</wamf_recalled_l1_memories>");

    return [
      {
        type: "text",
        content: lines.join("\n"),
        metadata: {
          source: this.id,
          count: merged.length,
          sources: ctxs.map((c) => c.agentId),
        },
      },
    ];
  }
}
