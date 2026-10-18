/**
 * WamfMemoryToolsInjector — inject a static `<wamf_memory_tools>` text block
 * that teaches the LLM to curl `<proxy>/memory-bridge/v3/*` for WAMF memory
 * read operations.
 *
 * Design is exactly the same shape as skill-tools-injector (see docs/design/2026-06-17-team-skill-proxy-runtime.md section 4):
 *
 *   Why static (NOT native tool defs):
 *     the agent host (IDE / Claude Code) does not recognize native tools; instead the LLM uses the existing Bash
 *     tool to curl a proxy path, and the proxy reverse-proxies to the wamf gateway, injecting
 *     IdFields + Bearer along the way, which rules out the LLM forging identity + keeps the token out of the prompt.
 *
 *   Tool set (**read-only**, statically injected into the system prompt, cache-friendly):
 *     - wamf_memory_search       L1 dual-path hybrid search (atomic/search)
 *     - wamf_atomic_query        L1 by type / time / pagination (atomic/query)
 *     - wamf_conversation_search L0 conversation hybrid search (conversation/search)
 *     - wamf_conversation_query  L0 fetch history by session (conversation/query)
 *     - wamf_scenario_ls         L2 list the scene_blocks path index
 *     - wamf_read_scene          L2 read full text by path
 *
 *   Design trade-offs:
 *     - L0/L1 are **no longer auto-recalled every turn** and injected into the user prompt (that would break the KV/prompt cache);
 *       instead static tools retrieve on demand; the system prompt stays stable -> prompt cache hits.
 *     - L3 (persona) is **injected directly** into system by wamf-profile-memory-injector, no tool needed.
 *     - The L2 index is also injected directly into system (`<l2_scene_index>`); the body is read on demand with read_scene.
 *
 *   Write operations (atomic/update / conversation/delete / scenario/write / scenario/rm / core/write)
 *   are not in the bridge allowlist; writes are controlled by the main-path injectors.
 *
 *   Injection point: `system.suffix` (unlike skill's `tools.append`, because we no longer use
 *   native tools). A note is appended at the end of the system prompt telling the LLM that these endpoints
 *   exist and how to call them.
 */

import type {
  AgentContext,
  AnchorTarget,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { getWamfIdentity } from "../../wamf/identity.js";
import {
  BRIDGE_SIG_HEADER,
  encodeBridgeSessionToken,
  signBridgeSession,
} from "../../bridge-signature.js";

export interface WamfMemoryToolsInjectorConfig {
  /**
   * Base URL the LLM should curl. Filled into every curl recipe.
   * E.g. `http://127.0.0.1:8096`. Trailing slash trimmed.
   */
  proxyBaseUrl: string;
}

/** Renders the whole `<wamf_memory_tools>` text; a pure function, easy to test. */
export function renderWamfMemoryToolsBlock(
  proxyBaseUrl: string,
  sessionId?: string,
  spaceId?: string,
): string {
  const base = proxyBaseUrl.replace(/\/$/, "");
  const bridge = `${base}/memory-bridge/v3`;
  // The gateway requires `x-wamf-service-id: <spaceId>` to let the request through; `x-conversation-id`
  // lets the proxy reuse the identity in the session (user_id / team_id / agent_id).
  // Session id is opaque-encoded so PII/phone redactors cannot mutate it and break x-bridge-sig.
  const sessionToken = sessionId ? encodeBridgeSessionToken(sessionId) : undefined;
  const sessionHeader = sessionToken ? ` -H 'x-conversation-id: ${sessionToken}'` : "";
  const tenantHeader = spaceId ? ` -H 'x-wamf-service-id: ${spaceId}'` : "";
  const sigHeader = sessionId ? ` -H '${BRIDGE_SIG_HEADER}: ${signBridgeSession(sessionId, spaceId)}'` : "";
  const authHeader = `${tenantHeader}${sessionHeader}${sigHeader}`;

  const lines: string[] = [
    "<wamf_memory_tools>",
    "**These are memory capabilities you can call yourself** (not documentation); use them through Bash + curl.",
    "These WAMF memory capabilities have the same priority as Claude Code's native Memory/MEMORY.md; when memory is involved, don't only check the local MEMORY.md.",
    "When the user asks about identity / history / preferences / past conclusions / project conventions, first query with the WAMF memory tools below, then answer based on the results.",
    "Never say \"I don't have that tool / it needs MCP / I can only check local memory\" — you have the WAMF memory tools; use the curl commands below.",
    "",
    "How to call: run curl in Bash against the proxy's memory-bridge paths. The proxy injects identity and auth automatically (team_id/user_id/agent_id); the body only needs the business fields. If the current Agent has several chat_memory bindings, the search endpoints search self + imported memories together by default and return source_agent_id/source_agent_name/source_agent_role in the results.",
    "",
    "Coverage:",
    "- L3 (long-term persona) and the L2 scenario index (`<l2_scene_index>`) are already injected into the system prompt; no lookup needed;",
    "- read the L2 full text with wamf_read_scene when needed;",
    "- L0/L1 (raw conversation / atomic memories) are **no longer recalled automatically every turn** (that would break the KV cache); search them with the tools when needed.",
    "",
    "  <tool name=\"wamf_memory_search\">",
    `    curl: ${bridge}/atomic/search`,
    `    body: {"query": "<text>", "limit": 5}`,
    "    use:  search L1 atomic memories (hybrid: dense vector + BM25), sorted by relevance. By default searches the current Agent's self + imported memories; source_agent_* in each item shows where it came from. Good for recalling user preferences, past conclusions, rules, etc.",
    "    returns: {code, data: {items: [...], searched_agents: [...]}} — hits are in data.items[].",
    "  </tool>",
    "",
    "  <tool name=\"wamf_atomic_query\">",
    `    curl: ${bridge}/atomic/query`,
    `    body: {"type": "?episodic|persona|instruction", "limit": 20, "offset": 0, "time_start": "?ISO", "time_end": "?ISO"}`,
    "    use:  fetch L1 memories by type / time window / page (no semantic search).",
    "  </tool>",
    "",
    "  <tool name=\"wamf_conversation_search\">",
    `    curl: ${bridge}/conversation/search`,
    `    body: {"query": "<text>", "limit": 5, "session_id": "?<sid>"}`,
    "    use:  search the L0 raw conversation (finer-grained than atomic_search: exact message text / quotes / timeline). By default searches the current Agent's self + imported memories; source_agent_* in each item shows where it came from.",
    "    returns: {code, data: {messages: [...], searched_agents: [...]}} — hits are in data.messages[] (note: different from atomic_search's data.items).",
    "  </tool>",
    "",
    "  <tool name=\"wamf_conversation_query\">",
    `    curl: ${bridge}/conversation/query`,
    `    body: {"session_id": "<sid>", "limit": 50, "offset": 0}`,
    "    use:  fetch L0 history messages in session order.",
    "  </tool>",
    "",
    "  <tool name=\"wamf_scenario_ls\">",
    `    curl: ${bridge}/scenario/ls`,
    `    body: {"path_prefix": "?optional prefix"}`,
    "    use:  list the L2 scene_blocks path index (with summaries, without full text). The index is usually injected into the system prompt already; use this only to refresh or filter by prefix.",
    "  </tool>",
    "",
    "  <tool name=\"wamf_read_scene\">",
    `    curl: ${bridge}/scenario/read`,
    `    body: {"path": "<scene path>", "agent_id": "?from <agent agent_id=...>; pass it when reading imported memories"}`,
    "    use:  read the full text of an L2 scenario file by path. Get the path from `<l2_scene_index>` or wamf_scenario_ls first — never make one up; for paths in an imported_from section, pass that section's agent_id.",
    "  </tool>",
    "",
    "## Call limits",
    "- These tools are read-only; changing L1/L2/L3 must go through the main pipeline (agent_id is assigned automatically).",
    "- Per turn, atomic_search + conversation_search **together ≤ 3 calls**;",
    "  query / ls / read_scene don't count toward the limit, but don't read the same path twice.",
    "- Retries: HTTP 5xx may be retried once; never retry HTTP 4xx.",
    "- Every curl must send: " +
      (spaceId ? `x-wamf-service-id: ${spaceId}, ` : "x-wamf-service-id (the current memory instance, see the example), ") +
      (sessionToken
        ? `x-conversation-id: ${sessionToken}, ${BRIDGE_SIG_HEADER}: ${signBridgeSession(sessionId!, spaceId)}`
        : "x-conversation-id (from the current session)") +
      "; Content-Type: application/json. Copy these -H headers verbatim from the recipe — never substitute another chat/session UUID.",
    "",
    "## Full example",
    "```bash",
    `curl -sfk -X POST ${bridge}/atomic/search \\`,
    `  -H 'Content-Type: application/json'${authHeader} \\`,
    `  -d '{"query": "preferred programming language of the user", "limit": 5}'`,
    "```",
    "</wamf_memory_tools>",
  ];

  return lines.join("\n");
}

export class WamfMemoryToolsInjector implements InjectionHook {
  id = "wamf-memory-tools-injector";
  point = "system.suffix" as const;
  anchor: AnchorTarget = { slot: "memory", relation: "before" };
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 5;
  description = "Inject <wamf_memory_tools> curl recipes block into system prompt";
  /** Static tool instructions are session-stable; render once at session_init. */
  cacheStrategy: CacheStrategy = "session_init";

  constructor(private cfg: WamfMemoryToolsInjectorConfig) {}

  execute(ctx: AgentContext): ContextBlock[] {
    const caps = ctx.metadata.custom?.assetCapabilities as { chat_memory?: boolean } | undefined;
    if (caps?.chat_memory === false) return [];
    // Identity not recognized -> do not inject (even if the LLM calls curl, the bridge would return 401)
    const identity = getWamfIdentity(ctx.metadata.custom);
    if (!identity) return [];
    const session = (ctx.metadata.custom as Record<string, unknown> | undefined)?.session as
      | Record<string, unknown>
      | undefined;
    const spaceId = typeof session?.space_id === "string" ? session.space_id : undefined;
    return this.renderBlocks(identity.sessionId, spaceId);
  }

  prewarm(input: PrewarmInput): ContextBlock[] {
    if (input.assetCapabilities?.chat_memory === false) return [];
    return this.renderBlocks(input.sessionInfo.session_id, input.sessionInfo.space_id);
  }

  private renderBlocks(sessionId: string, spaceId?: string): ContextBlock[] {
    return [{
      type: "text",
      content: renderWamfMemoryToolsBlock(this.cfg.proxyBaseUrl, sessionId, spaceId),
      metadata: {
        source: this.id,
        sessionId,
        cacheKey: "wamf-memory-tools-injector:tools",
      },
    }];
  }
}

/** @deprecated legacy API compatibility name */
export const WamfToolsInjector = WamfMemoryToolsInjector;
