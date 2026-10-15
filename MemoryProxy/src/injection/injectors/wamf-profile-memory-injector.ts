import type { AgentContext, AnchorTarget, CacheStrategy, ContextBlock, InjectionHook, HookPriority, PrewarmInput } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { WamfClient } from "../../wamf/client.js";
import type { WamfMemoryConfig } from "../../wamf/types.js";
import { getWamfIdentity } from "../../wamf/identity.js";
import type { CoreSkillConfig } from "../../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { resolveFixedAssetCtxs, type FixedAssetCtx } from "./wamf-fixed-asset.js";

/**
 * L2/L3 injection (refactored following the official openclaw / hermes approach):
 *   - L3 (persona) -> inject the full content (stable and usually short, serves as the long-term profile)
 *   - L2 (scenarios) -> **inject only the Scene Navigation index (path list + summary)**,
 *     without pre-reading the full text. When the LLM needs details it calls the `wamf_read_scene` tool by path.
 *   - Also attach the memory-tools-guide text, telling the LLM how to use the tools + call limits.
 *
 * This way:
 *   1. First-turn token consumption drops sharply (L2 full text is often thousands of chars x N)
 *   2. The LLM fetches text on demand instead of having its context polluted by irrelevant scenes
 *
 * Cross-agent: "own + borrowed" are split into sections by agent; under each, L3 and the Scene index sit side by side.
 *
 * Degrades when the control plane is unreachable: only inject the current agent's L3 + Scene index.
 */
export class WamfProfileMemoryInjector implements InjectionHook {
  id = "wamf-profile-memory-injector";
  point = "system.suffix" as const;
  anchor: AnchorTarget = { slot: "memory", relation: "inside_append" };
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 10;
  description = "Inject WAMF L3 (persona) + L2 scene index (path-only, agent reads via tool)";
  /** L2/L3 profile snapshot is injected once after session registration, like skill listing. */
  cacheStrategy: CacheStrategy = "session_init";

  /**
   * @param baseConfig  starter WamfClient config; per-request `serviceId` will
   *   be overridden with `session.space_id` in `renderBlocksForContext`. This
   *   config's `serviceId` acts as a fallback when no `space_id` is present.
   * @param coreSkillCfg  kernel gateway config for MetadataClient (fixed-asset
   *   agent resolution).
   */
  constructor(
    private baseConfig: WamfMemoryConfig,
    private coreSkillCfg: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs"> | null = null,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const caps = ctx.metadata.custom?.assetCapabilities as { chat_memory?: boolean } | undefined;
    if (caps?.chat_memory === false) return [];
    return this.renderBlocksForContext(ctx);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    if (input.assetCapabilities?.chat_memory === false) return [];
    return this.renderBlocksForContext(createPrewarmAgentContext(input));
  }

  private async renderBlocksForContext(ctx: AgentContext): Promise<ContextBlock[]> {
    const identity = getWamfIdentity(ctx.metadata.custom);
    if (!identity) return [];

    const session = (ctx.metadata.custom as any)?.session as { user_key?: string; space_id?: string } | undefined;
    const userKey = session?.user_key;
    // spaceId comes from `/proxy/<spaceId>/...` in the URL path saved at session registration;
    // used as the kernel's `x-wamf-service-id` header for tenant routing. An empty string is rejected by the kernel (invalid_user_key)
    // - the caller already handles bypass at the session-init stage.
    const spaceId = session?.space_id ?? "";
    const mc = this.coreSkillCfg && userKey
      ? getMetadataClient(this.coreSkillCfg, spaceId, userKey)
      : null;
    const ctxs = await resolveFixedAssetCtxs(ctx, identity, mc);

    // Build a per-request WamfClient with the correct tenant. Falls back to
    // baseConfig.serviceId (config value) when spaceId is empty.
    const client = new WamfClient({
      ...this.baseConfig,
      serviceId: spaceId || this.baseConfig.serviceId,
    });

    // Fetch L3 + L2 index independently for each agent (L2 full text is not read)
    const groups = await Promise.all(ctxs.map((c) => loadAgentProfile(client, c)));

    // All empty -> still inject tools-guide (the LLM can actively search L1 / read L2)
    const hasAnything = groups.some((g) => g.l3 || g.l2Entries.length > 0);
    if (!hasAnything) {
      return [{
        type: "text",
        content: MEMORY_TOOLS_GUIDE,
        metadata: { source: this.id, agentCount: 0, l3Count: 0, l2Count: 0, mode: "tools-only" },
      }];
    }

    const lines: string[] = [
      "<wamf_profile_memory>",
      "Below is the long-term working memory WAMF maintains for the current agent (own + borrowed sections; L2 is given as an index only, read the full text with the tools when needed):",
    ];

    let l2TotalCount = 0;
    let l3Count = 0;
    for (const g of groups) {
      if (!g.l3 && g.l2Entries.length === 0) continue;
      const tag = g.ctx.isSelf ? "self" : "imported_from";
      lines.push(
        `<agent name=${JSON.stringify(g.ctx.agentName)} role=${JSON.stringify(tag)} agent_id=${JSON.stringify(g.ctx.agentId)}>`,
      );
      if (g.l3?.content) {
        l3Count++;
        lines.push("<l3_core_memory>", truncate(g.l3.content, 6000), "</l3_core_memory>");
      }
      if (g.l2Entries.length > 0) {
        lines.push("<l2_scene_index>");
        for (const e of g.l2Entries) {
          l2TotalCount++;
          // Index line: path + summary (if any); the body is fetched with the tool
          if (e.summary) {
            lines.push(`- \`${e.path}\` — ${truncate(e.summary, 200)}`);
          } else {
            lines.push(`- \`${e.path}\``);
          }
        }
        lines.push("</l2_scene_index>");
      }
      lines.push("</agent>");
    }

    lines.push("</wamf_profile_memory>");
    // Followed by a memory-tools-guide section telling the LLM how to use the three tools + call limits
    lines.push("");
    lines.push(MEMORY_TOOLS_GUIDE);

    return [
      {
        type: "text",
        content: lines.join("\n"),
        metadata: {
          source: this.id,
          agentCount: groups.length,
          l3Count,
          l2IndexCount: l2TotalCount,
          mode: "index+tools",
        },
      },
    ];
  }
}

function createPrewarmAgentContext(input: PrewarmInput): AgentContext {
  return {
    messages: [],
    tools: [],
    requestParams: {},
    metadata: {
      protocol: "anthropic",
      traceId: `prewarm:${input.keyId}`,
      keyId: input.keyId,
      modelId: "prewarm",
      stream: false,
      agentSource: "session-init",
      custom: { session: input.sessionInfo },
    },
  };
}

/** Memory usage guide: L0/L1 are retrieved on demand with tools (no more automatic recall), L3 is injected directly, the L2 index is injected directly. */
export const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## ⚠️ Important: this is not documentation, these are capabilities you can use

The wamf_memory_search / wamf_conversation_search etc. listed in \`<wamf_memory_tools>\` below
are **capabilities you can call yourself** (not reference documentation). They are used through **Bash + curl**
(see the full call instructions and URLs in the \`<wamf_memory_tools>\` section above).

**Never** answer with things like "I don't have that tool / it needs MCP / it needs a slash command".
**Do this instead**: when you decide memory is needed, run curl in Bash directly; the proxy injects identity and auth automatically.

## Memory rules (in these situations you must look it up before answering)

L3 (long-term persona) and the L2 scenario index are already injected into the system prompt. L0/L1 must be searched with the tools.

### Look up memory before answering when (any one triggers a tool call; the user may write in any language)

1. **The user refers to history / the past / earlier**: e.g. "I said before / I told you / last time / do you remember / we talked about / that thing from before"
   → use \`wamf_conversation_search\` (L0 raw messages, to find the exact message)
2. **The user's own identity / preferences / habits**: e.g. "what's my name / my name / I like / my team / I usually use / I don't like / I don't allow"
   → use \`wamf_memory_search\` (L1 atomic memories, for preferences/rules)
3. **The user asks you to recall / find**: e.g. "recall / remember / find / is there any record about X / look up what we did before"
   → call the tool directly; don't answer from thin air
4. **The answer depends heavily on past facts**: e.g. "how did we fix that bug / what was the plan last time / what did we agree on"
   → turn it into keywords, then \`wamf_memory_search\`

**Typical flow** (user: "what's my name"):
\`\`\`bash
# Step 1: look it up first
curl -sfk -X POST <bridge>/atomic/search \\
  -H 'Content-Type: application/json' -H 'x-conversation-id: <sid>' \\
  -d '{"query": "user name identity", "limit": 5}'
# Step 2: take the answer from items[].content, then reply
# If empty: tell the user plainly "I couldn't find that in memory — what's your name?" — don't pretend to know
\`\`\`

### No lookup needed when

- The user asks "who are you" / "fix my code" / "write a script" / general programming questions
- The current conversation (this turn's messages) already answers it
- The answer is already visible in the \`<l3_core_memory>\` section

### ⚠️ Call limits

- Per turn, \`wamf_memory_search\` + \`wamf_conversation_search\` **together ≤ 3 calls** (\`wamf_read_scene\` / \`wamf_scenario_ls\` / \`wamf_atomic_query\` don't count)
- When a search finds nothing, **say so clearly** ("I couldn't find X in memory"); don't make things up
- Don't read the same L2 path twice
</memory-tools-guide>`;

interface AgentProfileBundle {
  ctx: FixedAssetCtx;
  l3: { content: string } | null;
  /** L2 index: only path + optional summary, does **not** read the full text. */
  l2Entries: Array<{ path: string; summary?: string }>;
}

async function loadAgentProfile(client: WamfClient, c: FixedAssetCtx): Promise<AgentProfileBundle> {
  const wamfCtx = { teamId: c.teamId, userId: c.userId, agentId: c.agentId, agentName: c.agentName };
  const [l3, l2Entries] = await Promise.all([client.readL3ForCtx(wamfCtx), client.listL2ForCtx(wamfCtx)]);
  // L3 (persona) may embed a "Scene Navigation" scene index at its tail (a plugin-side read carries the navigation section).
  // We inject <l2_scene_index> separately, so this copy at the tail of persona must be stripped to avoid injecting the L2 index twice.
  const l3Stripped = l3 ? stripSceneNavigation(l3.content) : "";
  return {
    ctx: c,
    l3: l3Stripped.trim() ? { content: l3Stripped } : null,
    l2Entries: (l2Entries ?? []).map((e) => ({ path: e.path, summary: e.summary })),
  };
}

/**
 * Strip the "Scene Navigation (Scene Index)" section at the tail of persona.
 * Aligned with NAV_HEADER in the plugin-side scene-navigation.ts (matches with or without a leading `---`).
 */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf("## 🗺️ Scene Navigation");
  if (idx === -1) return personaContent;
  // Remove it together with the adjacent `---` separator and surrounding whitespace
  let cut = personaContent.slice(0, idx);
  cut = cut.replace(/\s*-{3,}\s*$/, "");
  return cut.trimEnd();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}
