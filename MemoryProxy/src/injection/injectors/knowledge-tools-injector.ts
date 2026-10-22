/**
 * Knowledge Tools Injector — injects a `<knowledge_tools>` block listing
 * team knowledge resources (wiki / code-graph) with a two-step self-discovery
 * flow (tools/list → tools/call) via the proxy knowledge-bridge.
 *
 * v7 progressive exposure: prompt only contains resource list + discovery
 * entry points. The LLM curls `<proxy>/knowledge-bridge/v3/tools/{list,call}`
 * (same pattern as skill-bridge / memory-bridge). The proxy injects session
 * identity and forwards to MemoryKnowledge. Direct ClusterIP curls are not
 * used — Open Terminal cannot reach hub:8424.
 *
 * Strategy:
 *   - cacheStrategy: "session_init" — knowledge list fetched once at prewarm,
 *     reused for all turns in the session.
 *   - **Per-agent** (design section 0.6): read meta agent-fixed-asset bindings (filtering out
 *     llm_wiki/code_graph) -> asset_ids (=knowledge_id) -> join entity_knowledge by id
 *     for rendering fields. Binding authority is in meta; if details are missing (not ready), nothing is injected.
 *   - Fallback: no caller user-key / no agent -> fall back to the full team list (transitional compatibility).
 *   - Failure / empty → 0 blocks (graceful degradation).
 *
 * See `docs/design/knowledge-injection-v7.md`.
 */

import type {
  AgentContext,
  AnchorTarget,
  AssetCapabilityFlags,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import {
  CoreKnowledgeClient,
  getCoreKnowledgeClient,
  type KnowledgeItem,
} from "../../knowledge/core-client.js";
import type { CoreSkillConfig } from "../../types.js";
import {
  BRIDGE_SIG_HEADER,
  encodeBridgeSessionToken,
  signBridgeSession,
} from "../../bridge-signature.js";

const TAG = "[knowledge-tools-injector]";

export interface KnowledgeToolsInjectorConfig {
  /** Core kernel config (same endpoint as skill — 8420). */
  coreSkill: CoreSkillConfig;
  /**
   * Public proxy base the LLM should curl (e.g. https://…-proxy… or
   * http://127.0.0.1:8096). Trailing slash trimmed.
   */
  proxyBaseUrl: string;
}

export interface KnowledgeTelemetryContext {
  sessionKey?: string;
  userId?: string;
  teamId?: string;
  agentId?: string;
  agentSource?: string;
  spaceId?: string;
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function renderHeader(name: string, value: string): string {
  return "  -H " + shellQuote(`${name}: ${value}`) + " \\";
}

function toCompositeSessionKey(sessionKey?: string, agentSource?: string): string | undefined {
  if (!sessionKey) return undefined;
  if (!agentSource) return sessionKey;
  const prefix = `${agentSource}:`;
  return sessionKey.startsWith(prefix) ? sessionKey : `${prefix}${sessionKey}`;
}

/**
 * Render the `<knowledge_tools>` block from a list of knowledge resources.
 * Pure function for ease of testing.
 *
 * Curl recipes hit the **proxy knowledge-bridge** (`{proxy}/knowledge-bridge/v3`),
 * not MemoryKnowledge ClusterIP. The proxy injects tenant + session identity;
 * `knowledge_id` in the body selects the resource.
 */
function filterResourcesByCapabilities(
  resources: KnowledgeItem[],
  caps: AssetCapabilityFlags | undefined,
): KnowledgeItem[] {
  if (!caps) return resources;
  return resources.filter((r) => {
    if (r.type === "wiki") return caps.llm_wiki !== false;
    if (r.type === "code-graph") return caps.code_graph !== false;
    return true;
  });
}

/**
 * Escape a value for use inside a double-quoted XML attribute. Resource names
 * and repo slugs are operator-supplied, so a stray `"` would otherwise break
 * the `<knowledge .../>` tag structure the agent parses.
 */
function xmlAttrEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Render `\n  name="escaped"`, or "" when the value is absent/blank. */
function attr(name: string, value: string | undefined | null): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return `\n  ${name}="${xmlAttrEscape(trimmed)}"`;
}

/**
 * Derive a repo slug (`<org>/.../<repo>`) from a clone URL, used as the anchor
 * hint the agent matches against the local workspace's git remote.
 *
 * Handles both `https://host/a/b/c.git` and `git@host:a/b/c.git`. Returns
 * undefined when the URL is absent or yields no usable path (e.g. wiki
 * resources, which have no repo).
 */
function deriveRepoSlug(repoUrl: string | undefined): string | undefined {
  if (!repoUrl) return undefined;
  const withoutScheme = repoUrl.replace(/^[a-z0-9+.-]+:\/\//i, "");
  // scp-like syntax (`git@host:org/repo.git`) — split on the first colon.
  const afterHost = withoutScheme.includes(":")
    ? withoutScheme.slice(withoutScheme.indexOf(":") + 1)
    : withoutScheme.slice(withoutScheme.indexOf("/") + 1);
  const slug = afterHost.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  return slug.length > 0 ? slug : undefined;
}

export function renderKnowledgeToolsBlock(
  resources: KnowledgeItem[],
  proxyBaseUrl: string,
  sessionId?: string,
  spaceId?: string,
): string | null {
  if (!resources || resources.length === 0) return null;

  const base = proxyBaseUrl.replace(/\/$/, "");
  const bridge = `${base}/knowledge-bridge/v3`;
  const sessionToken = sessionId ? encodeBridgeSessionToken(sessionId) : undefined;
  const sessionHeader = sessionToken ? ` -H 'x-conversation-id: ${sessionToken}'` : "";
  const tenantHeader = spaceId ? ` -H 'x-wamf-service-id: ${spaceId}'` : "";
  const sigHeader = sessionId ? ` -H '${BRIDGE_SIG_HEADER}: ${signBridgeSession(sessionId, spaceId)}'` : "";
  const authHeader = `${tenantHeader}${sessionHeader}${sigHeader}`;

  const requestHeaderLines = [
    renderHeader("content-type", "application/json"),
    ...(spaceId ? [renderHeader("x-wamf-service-id", spaceId)] : []),
    ...(sessionToken ? [renderHeader("x-conversation-id", sessionToken)] : []),
    ...(sessionId ? [renderHeader(BRIDGE_SIG_HEADER, signBridgeSession(sessionId, spaceId))] : []),
  ];

  const resourceTags = resources
    .map((r) => {
      // `match` is the repo slug (org/repo) so the agent can recognise the bound
      // index by name / git remote / user wording. It is a hint, not a gate:
      // if the user asks about this repo, call the index even when cwd is elsewhere.
      const matchAttr = attr("match", r.repo_slug ?? deriveRepoSlug(r.repo_url));
      const branchAttr = attr("branch", r.repo_url ? (r.branch ?? "main") : undefined);
      // A wiki's summary is a content overview generated by the LLM from page titles, and is the agent's only clue for deciding "whether to
      // look up this wiki", so it must be kept. A code-graph summary is just a count such as
      // "N files, M symbol nodes", which doesn't help the call decision, so it is not injected.
      const summaryAttr = r.type === "wiki" ? attr("about", r.summary) : "";
      return `<knowledge type="${r.type}" id="${r.knowledge_id}"\n  url="${bridge}"\n  name="${xmlAttrEscape(r.name)}"${matchAttr}${branchAttr}${summaryAttr} />`;
    })
    .join("\n\n");

  return [
    "<knowledge_tools>",
    "**Team knowledge resources**: code-graph is a pre-built index of a repository (symbols / call graph / structure); wiki is engineering design documentation. Each has its own criteria, below.",
    "These are **not local tools**. Call them with curl against the proxy knowledge-bridge (copy the -H headers from the recipe verbatim).",
    "",
    "## code-graph: when to call it",
    "**Call it whenever the user's question is about a bound repo** (by name, slug, URL, \"the code graph\", or \"what code do I have in X\"), even if the current workspace is a different project or has no git remote.",
    "If the workspace git remote matches the resource's match attribute, prefer this index for structure / symbols / impact instead of local search.",
    "",
    "Typical cases:",
    "- summarizing what a bound repository contains, getting to know a project, finding entry points",
    "- locating a symbol, a file, or where a concept is implemented",
    "- following call chains, dependencies, data flow",
    "- assessing the impact of a change, refactoring scope, whether something can be safely deleted",
    "- finding related implementations during review or when debugging",
    "",
    "**Do not use it** when you need the **exact current content** of files in the **current** workspace (uncommitted edits, code you just changed). The index is a branch snapshot. You can still use it for the bound repo's snapshot.",
    "",
    "## wiki: when to call it",
    "wiki is design documentation, **not tied to the workspace, so no anchor match is needed** (having no match attribute is normal and does not mean it doesn't fit). Judge relevance by the about attribute.",
    "Use it for \"why was it designed this way / background and trade-offs / how the team defines a concept / past decisions and pitfalls / the design intent of this module\" — those answers aren't in the code.",
    "How the code is written → code-graph; what some code says right now → read the source.",
    "",
    "## Intent → first call",
    "Architecture / getting to know a project / what is in this repo → explore (returns the source along the way in one call); where is X → search; just one symbol's definition → node; who calls X / what X calls → callers / callees; impact of changing X → search, then impact; why it was designed this way → wiki search, then read_page.",
    "Combination: refactoring assessment = search → callers → impact.",
    "The source returned by explore / node is verbatim; **no need to Read the same place again** (except the case above where you need the latest workspace content).",
    "",
    "## Bound resources",
    resourceTags,
    "",
    "## How to call",
    `Call template: curl -sSk -X POST <bridge>/<action> -H 'content-type: application/json'${authHeader} -d '{...}'`,
    `where <bridge> = ${bridge}`,
    "The target resource is set by knowledge_id in the body; **don't** put knowledge_id into the URL path.",
    "Copy the -H headers from this recipe verbatim (including the wamf1.* x-conversation-id). Never substitute another chat UUID — that breaks x-bridge-sig.",
    "Never curl the knowledge ClusterIP / hub:8424 / a github.com URL — those are not reachable from this sandbox. Always use the knowledge-bridge URL above.",
    "",
    "### Step 1: get the tool list (once per resource, on **first** use)",
    `curl -sSk -X POST ${bridge}/tools/list \\`,
    ...requestHeaderLines,
    "  -d '{\"knowledge_id\":\"<knowledge id>\"}'",
    "",
    "Returns: {code, message, data:{knowledge_id, type, name, summary, status, tools:[{name, description, params}, ...]}}",
    "Remember the returned tool names / params and **reuse them in this session**; don't call list again for the same resource (only if you've forgotten).",
    "",
    "### Step 2: run a tool",
    `curl -sSk -X POST ${bridge}/tools/call \\`,
    ...requestHeaderLines,
    "  -d '{\"knowledge_id\":\"<knowledge id>\", \"tool_name\":\"<name from Step 1>\", \"params\":{...}}'",
    "",
    "Returns: {code, message, data}; code=0 means success.",
    "",
    "## Conventions",
    "- tool_name must be **exactly** the name returned by tools/list, without a prefix. params must be a JSON object; pass {} when there are no parameters.",
    "- To find files use explore / search (query accepts file names directly, e.g. \"session-manager.ts\"); use files only for a one-off overview of the directory structure, at most once per resource per session.",
    "- For wiki, search first, then read_page on a hit; don't list every page.",
    "- Several resources can be called in parallel; no need to wait in sequence. Give up after the same call fails twice in a row and fall back to local search.",
    "- Every response is {code, message, data}; code=0 means success.",
    "</knowledge_tools>\n",
  ].join("\n");
}

/**
 * Knowledge tools injector.
 *
 * Anchor: lands in the `knowledge` semantic slot, co-located just AFTER the
 * memory region on each profile — CodeBuddy's <memories> tag / Claude Code's
 * # Memory section. Knowledge tools (wiki + code-graph) are a "cloud reference"
 * pairing naturally with memory, not with executable skills, so we deliberately
 * avoid sharing the `skills` slot.
 * Priority: HOOK_PRIORITY.WIKI (300).
 */
export class KnowledgeToolsInjector implements InjectionHook {
  id = "knowledge-tools-injector";
  point = "system.before_tools" as const;
  anchor: AnchorTarget = { slot: "knowledge", relation: "after" };
  priority: HookPriority = HOOK_PRIORITY.WIKI;
  description = "Inject the <knowledge_tools> block with team knowledge resources.";
  cacheStrategy: CacheStrategy = "session_init";

  constructor(
    private config: KnowledgeToolsInjectorConfig,
    /** Optional override (tests). */
    private clientOverride?: CoreKnowledgeClient,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const ids = this.resolveSession(ctx);
    if (!ids.teamId) return [];
    return this.fetchBlocks(
      ids.teamId,
      ids.agentId,
      ids.userKey,
      ids.spaceId,
      ids.sessionId,
      ids.assetCapabilities,
      "execute",
      {
        sessionKey: toCompositeSessionKey(ctx.metadata.sessionKey, ctx.metadata.agentSource),
        userId: ids.userId ?? undefined,
        teamId: ids.teamId,
        agentId: ids.agentId ?? undefined,
        agentSource: ctx.metadata.agentSource,
        spaceId: ids.spaceId ?? undefined,
      },
    );
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    const teamId = input.sessionInfo.team_id;
    if (!teamId) return [];
    return this.fetchBlocks(
      teamId,
      input.sessionInfo.agent_id ?? null,
      input.callerUserKey ?? null,
      input.sessionInfo.space_id ?? null,
      input.sessionInfo.session_id ?? null,
      input.assetCapabilities,
      "prewarm",
      {
        sessionKey: toCompositeSessionKey(input.keyId, input.agentSource),
        userId: input.sessionInfo.user_id || input.userId,
        teamId,
        agentId: input.sessionInfo.agent_id,
        agentSource: input.agentSource,
        spaceId: input.sessionInfo.space_id,
      },
    );
  }

  private resolveSession(ctx: AgentContext): {
    teamId: string | null;
    agentId: string | null;
    userId: string | null;
    userKey: string | null;
    spaceId: string | null;
    sessionId: string | null;
    assetCapabilities?: AssetCapabilityFlags;
  } {
    const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
    const session = custom?.session as Record<string, unknown> | undefined;
    const teamId = typeof session?.team_id === "string" && session.team_id.length > 0 ? session.team_id : null;
    const agentId = typeof session?.agent_id === "string" && session.agent_id.length > 0 ? session.agent_id : null;
    const userId = typeof session?.user_id === "string" && session.user_id.length > 0 ? session.user_id : null;
    const userKey = typeof custom?.userKey === "string" && custom.userKey.length > 0 ? custom.userKey : null;
    const spaceId = typeof session?.space_id === "string" && session.space_id.length > 0 ? session.space_id : null;
    const sessionId = typeof session?.session_id === "string" && session.session_id.length > 0 ? session.session_id : null;
    const assetCapabilities = custom?.assetCapabilities as AssetCapabilityFlags | undefined;
    return { teamId, agentId, userId, userKey, spaceId, sessionId, assetCapabilities };
  }

  private async fetchBlocks(
    teamId: string,
    agentId: string | null,
    userKey: string | null,
    spaceId: string | null,
    sessionId: string | null,
    assetCapabilities: AssetCapabilityFlags | undefined,
    phase: "prewarm" | "execute",
    telemetryContext: KnowledgeTelemetryContext,
  ): Promise<ContextBlock[]> {
    try {
      const client = this.clientOverride ?? getCoreKnowledgeClient(this.config.coreSkill);

      console.log(`${TAG} ${phase} team=${teamId} agent=${agentId ?? "(none)"} userKey=${userKey ? "(set)" : "(none)"} space=${spaceId ?? "(none)"} session=${telemetryContext.sessionKey ?? "(none)"}`);

      // Per-agent (preferred): meta binding -> asset_ids -> join details by id.
      // serviceId passes spaceId through (same as SkillInjector: `/{agent}/{spaceId}/...`).
      let resources: KnowledgeItem[];
      let scope: string;
      if (agentId && userKey) {
        const ids = await client.listAgentKnowledgeIds(agentId, userKey, { serviceId: spaceId ?? undefined });
        console.log(`${TAG} ${phase} per-agent path: listAgentKnowledgeIds → ${ids.length} ids [${ids.join(",")}]`);
        resources = ids.length > 0 ? await client.listKnowledgeByIds(teamId, ids, { serviceId: spaceId ?? undefined }) : [];
        console.log(`${TAG} ${phase} per-agent path: listKnowledgeByIds → ${resources.length} resources`);
        scope = `agent:${agentId}`;
      } else {
        // Fallback: no caller identity -> full team.
        // Pass space_id as the kernel tenant routing header (same as SkillInjector).
        resources = await client.listKnowledge(teamId, { serviceId: spaceId ?? undefined });
        console.log(`${TAG} ${phase} fallback path: listKnowledge → ${resources.length} resources`);
        scope = `team:${teamId}`;
      }

      resources = filterResourcesByCapabilities(resources, assetCapabilities);
      const content = renderKnowledgeToolsBlock(
        resources,
        this.config.proxyBaseUrl,
        sessionId ?? undefined,
        spaceId || this.config.coreSkill.serviceId,
      );
      if (!content) return [];
      return [{
        type: "text",
        content,
        metadata: {
          source: this.id,
          cacheKey: `knowledge-tools-injector:${scope}`,
        },
      }];
    } catch (err) {
      console.warn(`${TAG} ${phase} failed: ${(err as Error).message}`);
      return [];
    }
  }
}
