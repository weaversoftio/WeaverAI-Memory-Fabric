/**
 * Whitelist endpoint table: centrally manages the Anthropic/OpenAI endpoints that context-proxy supports forwarding.
 *
 * This table is the **single source of truth** for three pieces of logic: routing, URL joining, and handler dispatch:
 * - `server.ts` registers Hono routes from the table (exact matches go before the catch-all)
 * - `guard-adapter.ts:joinUrl` decides the upstream endpoint suffix from the table, rather than a hard-coded two-way branch
 * - `auxiliaryHandler.ts` decides from the table whether to pass through and whether the stream branch is needed
 *
 * To add an endpoint, just add one record to `WHITELIST_ENDPOINTS`, with no scattered changes.
 */

/** Whitelist endpoint metadata. */
export interface WhitelistEndpoint {
  /**
   * Suffix of the user request path (matched exactly after stripping the `/proxy/{spaceId}` prefix).
   * Example: `/v1/messages/count_tokens`
   */
  pathSuffix: string;
  /**
   * The endpoint part joined after `upstream.url` when forwarding to the upstream.
   * Example: `/messages/count_tokens` (joined after `https://tokenhub.../v1`)
   */
  upstreamEndpoint: string;
  /**
   * Protocol type: decides the auth header format (anthropic -> `x-api-key`, openai -> `Authorization: Bearer`),
   * consistent with the usage-parsing branches of credit-reporter.
   */
  protocol: "anthropic" | "openai";
  /** Whether the endpoint supports streaming responses (SSE). */
  supportsStream: boolean;
  /**
   * Whether it is a primary endpoint: primary endpoints are handled by the existing `handleAnthropicMessages` / `handleChatCompletions`
   * (including routing decisions); non-primary endpoints go through the lightweight `handleAuxiliaryEndpoint`
   * (skipping routing; only auth + forwarding + credit).
   */
  isPrimary: boolean;
}

/**
 * The list of currently supported whitelist endpoints.
 *
 * Order does not matter -- `matchWhitelistEndpoint` internally sorts by `pathSuffix` length **from longest to shortest**,
 * so that `/v1/messages/count_tokens` hits before `/v1/messages`.
 */
export const WHITELIST_ENDPOINTS: readonly WhitelistEndpoint[] = [
  // -- Primary endpoints (handled by the existing handler, including routing) ---------
  {
    pathSuffix: "/v1/messages",
    upstreamEndpoint: "/messages",
    protocol: "anthropic",
    supportsStream: true,
    isPrimary: true,
  },
  {
    pathSuffix: "/v1/chat/completions",
    upstreamEndpoint: "/chat/completions",
    protocol: "openai",
    supportsStream: true,
    isPrimary: true,
  },
  // -- Auxiliary endpoints (handled by handleAuxiliaryEndpoint, no routing) ---------
  {
    pathSuffix: "/v1/messages/count_tokens",
    upstreamEndpoint: "/messages/count_tokens",
    protocol: "anthropic",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/embeddings",
    upstreamEndpoint: "/embeddings",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/completions",
    upstreamEndpoint: "/completions",
    protocol: "openai",
    supportsStream: true,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/moderations",
    upstreamEndpoint: "/moderations",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  // -- Codex Responses API endpoints (handled by codexHandler) --------------
  // Primary endpoint: see codexHandler.ts; the upstream joining relies on this to prevent joinUrl from taking the fallback
  // to /chat/completions (the wrong protocol).
  //
  // The two groups of entries correspond to the two client styles where base_url carries /v1 or not; see the
  // codex route comment in server.ts. matchWhitelistEndpoint matches by pathSuffix length descending,
  // so /v1/responses hits before /responses, keeping the semantics clear.
  {
    pathSuffix: "/v1/responses",
    upstreamEndpoint: "/responses",
    protocol: "openai",
    supportsStream: true,
    isPrimary: true,
  },
  {
    pathSuffix: "/v1/responses/compact",
    upstreamEndpoint: "/responses/compact",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/memories/trace_summarize",
    upstreamEndpoint: "/memories/trace_summarize",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/realtime/calls",
    upstreamEndpoint: "/realtime/calls",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/responses",
    upstreamEndpoint: "/responses",
    protocol: "openai",
    supportsStream: true,
    isPrimary: true,
  },
  {
    pathSuffix: "/responses/compact",
    upstreamEndpoint: "/responses/compact",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/memories/trace_summarize",
    upstreamEndpoint: "/memories/trace_summarize",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/realtime/calls",
    upstreamEndpoint: "/realtime/calls",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
] as const;

/** Cache sorted by length descending, to avoid re-sorting on every match. */
const SORTED_BY_SUFFIX_LEN: readonly WhitelistEndpoint[] = [...WHITELIST_ENDPOINTS].sort(
  (a, b) => b.pathSuffix.length - a.pathSuffix.length,
);

/** `/proxy/{spaceId}` prefix regex: strips only one layer, to avoid mistakenly hitting the literal "proxy" in a path. */
const PROXY_PREFIX_RE = /^\/proxy\/[^/]+/;
/**
 * Agent prefix regex: matches the `/{agent}[/{spaceId}]/{v1|responses|...}` shape.
 *   - `/claude-code/v1/messages`              -> strips `/claude-code`
 *   - `/claude-code/{spaceId}/v1/messages`    -> strips `/claude-code/{spaceId}`
 *   - `/codex/{spaceId}/responses`            -> strips `/codex/{spaceId}` (the codex client
 *     does not assemble /v1/ itself like CC/CB; the source endpoint constant is just /responses, so when base_url
 *     has no /v1 what follows the prefix directly is /responses or /memories etc.)
 * The lookahead allows `/v1/`, `/responses`, `/responses/`, `/memories/`, `/realtime/`
 * right after, where `/v1/` must carry the trailing slash to avoid mis-hitting things like `/v1foo` that may appear in the future; codex endpoints such as responses
 * allow the trailing slash to be optional (e.g. `/responses` is a complete path).
 * The whitelist entries `/v1/messages` and `/responses` themselves will not be mistakenly stripped (because they do not match the agent
 * segment -- the agent segment is restricted to known names).
 */
const AGENT_PREFIX_RE = /^\/(claude-code|codebuddy|codex|cursor|anthropic|openai|pi)(?:\/[^/]+)?(?=\/v1\/|\/responses(?:\/|$)|\/memories\/|\/realtime\/)/i;

/**
 * `/cost-guard` marker regex: an independent segment located after `/{agent}/{spaceId}`.
 *
 * Semantics (reversed relative to the earlier `/direct` marker): **passthrough by default**,
 * and the primary handler goes through cost-guard routing only when the request path explicitly carries a `/cost-guard` segment.
 *
 * Hit conditions (both must hold):
 *   1. lookahead `(?=/)` -- the marker is an independent segment (with more content after it),
 *      not restricted to being immediately followed by `/v1/` or a bare tail. This decouples the marker from the tail the client assembles:
 *        - `/codebuddy/{spaceId}/cost-guard/chat/completions` (CB bare tail)
 *        - `/claude-code/{spaceId}/cost-guard/v1/messages` (CC with /v1)
 *      both are recognized as the marker. Word stems like `/cost-guarded/` `/cost-guarding/`
 *      `/pre-cost-guard/` are cut off because the lookahead requires `/cost-guard` to be immediately followed by `/`.
 *   2. lookbehind `(?<=(?:/[^/]+){2,})` -- there must be >= 2 non-empty segments before the marker,
 *      so the marker hits only in the structure `/{agent}/{spaceId}/cost-guard/...` or
 *      `/proxy/{spaceId}/cost-guard/...`; a spaceId that happens to be
 *      called "cost-guard" (three-segment structure `/agent/cost-guard/...`) does not misfire.
 *
 * See `hasCostGuardMarker` for letting the primary handler decide whether to **enable** the router;
 * `normalizeWhitelistRequestPath` strips it synchronously so whitelist matching keeps working.
 */
const COST_GUARD_MARKER_RE = /(?<=(?:\/[^/]+){2,})\/cost-guard(?=\/)/;

/**
 * `/analyse` marker: structure fully aligned with `/cost-guard` -- an independent segment located after `/{agent}/{spaceId}`;
 * a hit means "this request should take the internal asset reflection mode".
 *
 * Gated by `injection.assetReflection.markerOptIn`,
 * see `AssetReflectionInjector`. Unlike cost-guard, `/analyse` **does not register**
 * a dedicated hono route -- it is a fully transparent marker: the normal business path continues to handle it,
 * only that after the injector detects the marker it appends an extra reflection prompt to the end of the system prompt.
 *
 * `normalizeWhitelistRequestPath` strips this marker so whitelist suffix matching keeps working.
 */
const ANALYSE_MARKER_RE = /(?<=(?:\/[^/]+){2,})\/analyse(?=\/)/;

/**
 * Whether the request path carries the `/cost-guard` marker (an independent segment before `/v1/`).
 * When present, the primary handler goes through the full cost-guard routing; when absent (the default) it passes straight through to the default upstream.
 */
export function hasCostGuardMarker(requestPath: string): boolean {
  if (!requestPath) return false;
  const withoutQuery = requestPath.split("?", 1)[0] ?? "";
  return COST_GUARD_MARKER_RE.test(withoutQuery);
}

/**
 * Whether the request path carries the `/analyse` marker (same structure as `/cost-guard`).
 * On a hit, `AssetReflectionInjector` appends an `<asset_reflection>` block to the end of the system prompt.
 */
export function hasAnalyseMarker(requestPath: string): boolean {
  if (!requestPath) return false;
  const withoutQuery = requestPath.split("?", 1)[0] ?? "";
  return ANALYSE_MARKER_RE.test(withoutQuery);
}

/**
 * Normalize the request path for whitelist matching.
 *
 * 1. strip the query string
 * 2. strip the `/cost-guard` marker (if any, see `hasCostGuardMarker`)
 * 3. strip the `/analyse` marker (if any, see `hasAnalyseMarker`)
 * 4. strip the `/proxy/{spaceId}` prefix (if any)
 * 5. strip the `/{agent}/{spaceId}` prefix (e.g. `/claude-code/{spaceId}/v1/messages`)
 */
export function normalizeWhitelistRequestPath(requestPath: string): string {
  if (!requestPath) return "";
  const withoutQuery = requestPath.split("?", 1)[0] ?? "";
  // Order matters: strip `/cost-guard` / `/analyse` markers FIRST while the
  // surrounding `/{prefix}/{spaceId}` context is still intact — the markers'
  // lookbehind requires ≥ 2 leading segments. Then AGENT/PROXY prefixes see
  // the canonical `/v1/...` tail (their lookahead needs it) and remove themselves.
  const withoutCostGuard = withoutQuery.replace(COST_GUARD_MARKER_RE, "");
  const withoutAnalyse = withoutCostGuard.replace(ANALYSE_MARKER_RE, "");
  const withoutProxy = withoutAnalyse.replace(PROXY_PREFIX_RE, "");
  return withoutProxy.replace(AGENT_PREFIX_RE, "");
}

/**
 * Match a whitelist entry from the request path.
 *
 * Matching rules:
 * 1. `normalizeWhitelistRequestPath` normalizes the path (strips query / proxy prefix / agent+spaceId prefix)
 * 2. try exact suffix matches by `pathSuffix` length **from longest to shortest**
 *
 * @returns the matched whitelist entry, `null` if none
 */
export function matchWhitelistEndpoint(
  requestPath: string,
): WhitelistEndpoint | null {
  const normalized = normalizeWhitelistRequestPath(requestPath);
  if (!normalized) return null;

  for (const entry of SORTED_BY_SUFFIX_LEN) {
    if (normalized === entry.pathSuffix) return entry;
  }
  return null;
}
