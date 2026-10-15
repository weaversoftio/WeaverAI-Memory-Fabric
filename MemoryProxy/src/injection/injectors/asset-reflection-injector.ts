/**
 * Asset Reflection Injector - for internal effectiveness evaluation; appends an
 * `<asset_reflection>` block at the end of the system prompt, guiding the agent to comment in its final answer on "which cloud
 * asset tools were called this round and whether each one helped".
 *
 * ## Gating
 * Fully aligned with the dual-gate pattern of `costGuard.markerOptIn`:
 *   1. `injection.assetReflection.markerOptIn=true` -> only then does the factory register this hook
 *      (otherwise the hook is not in getAll() on production pods at all, zero performance overhead);
 *   2. the request URL carries the `/analyse` marker -> only then does execute actually emit the block (otherwise returns [],
 *      the prompt is unchanged for requests without the marker).
 *
 * ## Tag set
 * Determined by `activeAssetTags` passed to the constructor - the factory computes a static list
 * based on which asset injectors are actually registered on this node:
 *   - skill-*         → `<skill_tools>` + `<available_skills>`
 *   - wamf-*          → `<wamf_memory_tools>`
 *   - knowledge-*     → `<knowledge_tools>`
 *
 * If none is registered (activeAssetTags empty) -> the hook never emits.
 */

import type {
  AgentContext,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { hasAnalyseMarker } from "../../routes/whitelist.js";

export interface AssetReflectionInjectorConfig {
  /** List of asset tag names actually enabled on this node (without angle brackets), e.g. `["skill_tools", "wamf_memory_tools"]`. */
  activeAssetTags: string[];
}

const TAG = "[asset-reflection-injector]";

/** Pure function: renders the `<asset_reflection>` section. An empty tag list returns an empty string, letting callers return early. */
export function renderAssetReflectionBlock(tags: string[]): string {
  if (tags.length === 0) return "";
  const tagList = tags.map((t) => `<${t}>`).join(" / ");
  return [
    "<asset_reflection>",
    "**Internal effectiveness review mode** — this system prompt contains the following cloud asset tool blocks:",
    `  ${tagList}`,
    "",
    "If you **actually called** any of these tools in this turn (via Bash curl or MCP),",
    "append a short review at the **end** of your final answer, in exactly this format:",
    "",
    "[Asset reflection]",
    "- <tag>::<tool_name>: one sentence on **whether the call helped** (what key information it gave / what detour it saved / or why it missed)",
    "- ... (one line per tool you called; several calls to the same tool can share one line describing the overall effect)",
    "",
    "Rules:",
    "- **Only review tools you actually called in this turn**; never list tools you did not call, and do not guess or fill in.",
    "- If you called none of these asset tools in this turn, still output:",
    "  [Asset reflection] No cloud asset tools were used in this turn.",
    "- Keep the review short and honest — if a tool did not help, say so; this measures integration effectiveness, it is not asking for praise.",
    "- This section is for internal evaluation only and is not a formal conclusion; separate it clearly from the main answer (e.g. a blank line + \"---\").",
    "</asset_reflection>",
  ].join("\n");
}

/**
 * AssetReflectionInjector - see the file header.
 *
 * point: `system.suffix` (attached at the very end of the system prompt, matching the internal evaluation semantics: read the body first, then the reflection requirements)
 * priority: `HOOK_PRIORITY.CUSTOM` (1000, runs last, so it does not affect any asset injector)
 * cacheStrategy: `none` (depends on the runtime URL marker, cannot be prewarmed)
 */
export class AssetReflectionInjector implements InjectionHook {
  id = "asset-reflection-injector";
  point = "system.suffix" as const;
  priority: HookPriority = HOOK_PRIORITY.CUSTOM;
  description = "Inject <asset_reflection> block into system prompt when URL has /analyse marker.";
  cacheStrategy: CacheStrategy = "none";

  constructor(private config: AssetReflectionInjectorConfig) {}

  execute(ctx: AgentContext): ContextBlock[] {
    if (this.config.activeAssetTags.length === 0) {
      // The factory already guarantees that an injector with empty tags is never registered; this is a defensive early return.
      return [];
    }
    const requestPath = ctx.metadata.requestPath ?? "";
    if (!hasAnalyseMarker(requestPath)) {
      // No marker - zero prompt change for ordinary requests, so the KV cache prefix is unaffected.
      return [];
    }
    const content = renderAssetReflectionBlock(this.config.activeAssetTags);
    if (!content) return [];
    if (process.env.PROXY_DEBUG_ASSET_REFLECTION) {
      console.log(`${TAG} emit for path=${requestPath} tags=[${this.config.activeAssetTags.join(",")}]`);
    }
    return [{
      type: "text",
      content,
      metadata: {
        source: this.id,
        // cache-strategy=none, but still give a stable cacheKey so the observer can dedupe.
        cacheKey: `asset-reflection-injector:${this.config.activeAssetTags.join(",")}`,
      },
    }];
  }
}
