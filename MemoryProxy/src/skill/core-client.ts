/**
 * CoreSkillClient — minimal HTTP client for the openclaw-plugin skill gateway.
 *
 * Scope: only the endpoints the proxy itself calls.
 *   - POST /v3/skill/search              -> SkillInjector RAG retrieval.
 *   - POST /v3/skill/listing             → SkillInjector owner-agent listing.
 *   - POST /v3/skill/conversation/add    -> handler-glue new path, pushed at the end of each real-person conversation round.
 *   - Other methods such as POST /v3/skill/extract are kept in the class for agents to pass through
 *     via the skill-bridge reverse proxy (the agent hits it directly via curl, not triggered proactively by the proxy).
 *
 * The other /v3/skill/* endpoints are NOT wrapped here on purpose — the LLM
 * curls them directly via the /skill-bridge reverse proxy, so wrapping them
 * would just be dead code. See `docs/design/2026-06-17-team-skill-proxy-runtime.md`.
 *
 * Auth: `Authorization: Bearer <serviceToken>` + `x-wamf-service-id`.
 * Error model: throws plain `Error` on !ok or non-zero envelope code; callers
 * (injectors / trigger) wrap in try/catch and degrade silently.
 *
 * Test injection: pass a custom `fetcher` to the constructor.
 *
 * Singleton: `getCoreSkillClient(config)` keys on (endpoint, serviceToken,
 *   serviceId, timeoutMs); changing any field rebuilds. Test override via
 *   `setCoreSkillClient(...)`.
 */

import type { CoreSkillConfig } from "../types.js";

type Fetcher = typeof fetch;

const TAG = "[core-skill-client]";

/**
 * Identity fields.
 *
 * Important: `user_id` is **optional** -- the `user_id` column on the skill table is only for audit
 * ("who was the caller of the last write"), not ownership. A skill's ownership dimension is decided by the schema's
 * unique index `(team_id, owner_agent_id, name)`, unrelated to user_id.
 *
 * Therefore read paths (search / list) **should not** pass a user_id filter, otherwise all skills
 * "not written by the current caller" are knocked out (including skills shared within the same team / the same agent).
 * Only write paths (extract / save / update) need user_id, for auditing.
 *
 * The plugin-side store already has "filter by whatever is passed" semantics (`if (opts.user_id) WHERE user_id=?`),
 * so making the field optional here lets the read path naturally skip that filter.
 */
export interface IdFields {
  /** Optional -- audit only. Read paths should not pass it, otherwise team-shared skills are filtered out. */
  user_id?: string;
  team_id: string;
  agent_id?: string;
  task_id?: string;
}

export interface SkillSummary {
  skill_id: string;
  name: string;
  description: string;
  version: number;
  is_head?: boolean;
  status?: "active" | "archived";
  owner_user_id?: string;
  owner_agent_id?: string;
  team_id?: string;
  task_id?: string;
  created_at_ms?: number;
  updated_at_ms?: number;
}

export interface SearchHit extends SkillSummary {
  score: number;
  snippet?: string;
}

export interface SearchSkillsInput extends IdFields {
  query: string;
  top_k?: number;                        // 1..50, default 10
  mode?: "bm25" | "embedding" | "hybrid"; // default 'hybrid'
}

export interface SearchSkillsResult {
  items: SearchHit[];
}

export interface ExtractMessage {
  role: "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  timestamp?: string;                    // ISO 8601
}

/**
 * Shape of a single message in the `/v3/skill/conversation/add` request body.
 *
 * Compared with `ExtractMessage`:
 *   - the `system` role is allowed (aligned with the 5 roles in design section 11.1)
 *   - `tool_call` / `tool_result` must carry `tool_name` + `tool_call_id`
 *   - `timestamp` may be a number (ms epoch) or an ISO 8601 string
 */
export interface ConversationTurnMessage {
  role: "user" | "assistant" | "tool_call" | "tool_result" | "system";
  content: string;
  tool_name?: string;
  tool_call_id?: string;
  timestamp?: number | string;
}

export interface ExtractSkillInput extends IdFields {
  session_id?: string;
  messages: ExtractMessage[];
  mode?: "sync" | "async";               // default 'async'
  options?: {
    max_iterations?: number;
    dedupe?: boolean;
    review_kind?: "skill_only" | "memory_only" | "combined";
  };
}

export interface ExtractAsyncResult {
  task_id: string;
}

/**
 * `/v3/skill/conversation/add` input.
 *
 * Hard constraints:
 *   - session_id / space_id / user_id / team_id / agent_id are all required
 *   - ID fields must not contain `|` (Core rejects it with 400)
 *   - messages are this round's increment (user + intermediate tool_call/tool_result + assistant summary),
 *     history is not re-sent (Core does not dedupe; re-sending would duplicate the buffer)
 *   - the same session must be strictly serial (the next round is sent only after the previous round's 200)
 *
 * See `2026-07-15-skill-trigger-in-core-design.md` sections 11.1 & 13 for details.
 */
export interface ConversationAddInput extends IdFields {
  session_id: string;
  space_id?: string;
  messages: ConversationTurnMessage[];
}

/**
 * Metadata when archiving is triggered; this field is absent when `status: "ok"`.
 */
export interface ConversationAddArchived {
  task_id: string;
  archived_at_ms: number;
  archive_key: string;
  reason: "tool_calls" | "bytes" | "compressed" | "oversize";
}

export interface ConversationAddResult {
  status: "ok" | "archived";
  archived?: ConversationAddArchived;
}

/** Input for /v3/skill/conversation/force-archive -- manual forced archiving. */
export interface ForceArchiveInput {
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  session_id: string;
  reason?: string;
  task_id?: string;
}

/** Response from /v3/skill/conversation/force-archive. */
export interface ForceArchiveResponse {
  status: "archived" | "empty";
  task_id?: string;
  archived_at_ms?: number;
  archive_key?: string;
  message?: string;
}

/**
 * Input for /v3/skill/list — owner-agent skill enumeration.
 *
 * Used by skill-bridge team-search to build the whitelist for the "agent's own full set" part
 * (see `docs/design/2026-08-10-skill-search-scope-fix.md` section 4).
 * limit goes up to the core schema cap of 1000, fetched all at once, no pagination.
 */
export interface ListSkillsInput extends IdFields {
  filters?: {
    owner_agent_id?: string;
    name_prefix?: string;
    status?: Array<"active" | "archived">;
  };
  pagination?: { limit?: number; offset?: number };
}

/** Result from /v3/skill/list. */
export interface ListSkillsResult {
  items: SkillSummary[];
  total: number;
}

/** Input for /v3/skill/listing — owner-agent skill injection. */
export interface ListingInput extends IdFields {
  /** Optional search query; when set, plugin uses FTS BM25 to match relevant skills. */
  query?: string;
  /** char budget for the rendered listing block. Default 8000 in plugin. */
  char_budget?: number;
}

/** Result from /v3/skill/listing. `listing` is the pre-rendered `<available_skills>` block. */
export interface ListingResult {
  mode: "full" | "search";
  listing: string;
  hits: Array<{ skill_id: string; version: number; name: string }>;
}

/** Core gateway envelope (mirrors `wamf-memory-plugin/src/gateway/v2-router.ts:145-150`). */
interface CoreEnvelope<T> {
  code: number;
  message?: string;
  request_id?: string;
  data?: T;
  error?: { code: number; message: string };
}

export interface CoreSkillRequestOptions {
  /** Per-call override; falls back to config.timeoutMs. */
  timeoutMs?: number;
  /**
   * Per-call override for `x-wamf-service-id`. Falls back to config.serviceId.
   *
   * Used by callers that know the real tenant/instance ID for this request
   * (e.g. SkillInjector reads it from `sessionInfo.space_id`, which was
   * extracted from the request URL path `/{agent}/{spaceId}/...`).
   *
   * Kernel routes tenants by this header — a static config value is wrong
   * whenever the caller has a per-request spaceId available.
   */
  serviceId?: string;
}

export class CoreSkillClient {
  private readonly endpoint: string;
  private readonly serviceToken: string;
  private readonly serviceId: string;
  private readonly defaultTimeoutMs: number;
  private readonly fetcher: Fetcher;

  constructor(
    config: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs">,
    fetcher: Fetcher = globalThis.fetch.bind(globalThis),
  ) {
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.serviceToken = config.serviceToken;
    this.serviceId = config.serviceId;
    this.defaultTimeoutMs = config.timeoutMs;
    this.fetcher = fetcher;
  }

  async searchSkills(
    input: SearchSkillsInput,
    opts: CoreSkillRequestOptions = {},
  ): Promise<SearchSkillsResult> {
    return this.post<SearchSkillsResult>("/v3/skill/search", input, opts);
  }

  async extractSkill(
    input: ExtractSkillInput,
    opts: CoreSkillRequestOptions = {},
  ): Promise<ExtractAsyncResult | { cached: boolean; cache_key: string; candidates: unknown[] }> {
    return this.post("/v3/skill/extract", input, opts);
  }

  /**
   * `POST /v3/skill/conversation/add` -- new path: incrementally push each round to core,
   * and core decides internally when to archive + extract. See section 21.2.
   *
   * **Synchronous wait**: this method internally `await`s fetch -> envelope parsing. The caller must
   * also `await` this method, guaranteeing the same session is strictly serial (a core premise on the Core side).
   */
  async addConversation(
    input: ConversationAddInput,
    opts: CoreSkillRequestOptions = {},
  ): Promise<ConversationAddResult> {
    return this.post<ConversationAddResult>("/v3/skill/conversation/add", input, opts);
  }

  /**
   * `POST /v3/skill/conversation/force-archive` -- manually force-archive the current session buffer.
   * Skips the threshold check and calls trigger.archive() directly.
   */
  async forceArchive(
    input: ForceArchiveInput,
    opts: CoreSkillRequestOptions = {},
  ): Promise<ForceArchiveResponse> {
    return this.post<ForceArchiveResponse>("/v3/skill/conversation/force-archive", input, opts);
  }

  /**
   * `POST /v3/skill/list` -- enumerate the skill_id / metadata of the agent's own skills.
   *
   * skill-bridge team-search uses it to widen the whitelist: the agent's own skills (including private ones)
   * are also put into the retrieval pool, so that private skills beyond the session-init `<available_skills>` cap of 20
   * can never go unsearched. See
   * `docs/design/2026-08-10-skill-search-scope-fix.md`.
   *
   * Semantics: by default only head + active are returned. Owner attribution is decided by (team_id, agent_id).
   */
  async listSkills(
    input: ListSkillsInput,
    opts: CoreSkillRequestOptions = {},
  ): Promise<ListSkillsResult> {
    return this.post<ListSkillsResult>("/v3/skill/list", input, opts);
  }

  /**
   * Call /v3/skill/listing to get the agent's owned skills.
   * Without a query, the plugin routes to list-head (full listing when ≤ topK,
   * search when > topK). The response includes a pre-rendered `<available_skills>`
   * block that can be injected verbatim into the system prompt.
   */
  async listListing(
    input: ListingInput,
    opts: CoreSkillRequestOptions = {},
  ): Promise<ListingResult> {
    return this.post<ListingResult>("/v3/skill/listing", input, opts);
  }

  /**
   * The plugin-side Zod schema requires team_id and agent_id to be bound together:
   * either both passed (with values) or both omitted (undefined / empty).
   * If agent_id is empty but team_id has a value, it triggers "must both be provided or both be omitted".
   *
   * Fix strategy: when team_id has a value but agent_id is empty, fill "default" as the agent_id.
   * The plugin core layer itself also falls back to "default" for an undefined agent_id (see skill-core.ts).
   */
  private normalizeTeamAgent(body: Record<string, unknown>): void {
    const teamId = body.team_id;
    const agentId = body.agent_id;
    if (teamId && (agentId === undefined || agentId === '')) {
      body.agent_id = 'default';
    }
    // If both are empty, clean the keys (do not carry them to the plugin side)
    if (!body.team_id && !body.agent_id) {
      delete body.team_id;
      delete body.agent_id;
    }
  }

  /** Generic POST → unwraps the envelope. Public for tests / future endpoints. */
  async post<T>(
    path: string,
    body: unknown,
    opts: CoreSkillRequestOptions = {},
  ): Promise<T> {
    // Shallow-copy the body to keep normalizeTeamAgent's side effects from polluting the object passed in by the caller.
    // Previously mutating the body directly caused the caller's input object to be unexpectedly rewritten (e.g. agent_id
    // being filled with "default"), causing data confusion across calls or on retries.
    let normalizedBody: unknown = body;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      normalizedBody = { ...(body as Record<string, unknown>) };
      this.normalizeTeamAgent(normalizedBody as Record<string, unknown>);
    }
    const url = `${this.endpoint}${path.startsWith("/") ? path : "/" + path}`;
    const timeout = opts.timeoutMs ?? this.defaultTimeoutMs;

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.serviceToken}`,
      "x-wamf-service-id": opts.serviceId || this.serviceId,
      "Content-Type": "application/json",
    };

    let resp: Response;
    try {
      resp = await this.fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify(normalizedBody),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw new Error(`${TAG} ${path} fetch failed: ${(err as Error).message}`);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`${TAG} ${path} HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    let env: CoreEnvelope<T>;
    try {
      env = (await resp.json()) as CoreEnvelope<T>;
    } catch (err) {
      throw new Error(`${TAG} ${path} non-JSON response: ${(err as Error).message}`);
    }

    if (env.code !== 0) {
      const msg = env.error?.message ?? env.message ?? `code=${env.code}`;
      throw new Error(`${TAG} ${path} envelope error ${env.code}: ${msg}`);
    }

    return (env.data ?? ({} as T));
  }
}

// ── Singleton + test injection ──────────────────────────────────────────────

let _client: CoreSkillClient | null = null;
let _clientKey = "";
let _forced = false;

function configKey(c: CoreSkillConfig): string {
  return `${c.endpoint}::${c.serviceToken}::${c.serviceId}::${c.timeoutMs}`;
}

export function getCoreSkillClient(config: CoreSkillConfig): CoreSkillClient {
  if (_forced && _client) return _client;
  const key = configKey(config);
  if (!_client || _clientKey !== key) {
    _client = new CoreSkillClient(config);
    _clientKey = key;
  }
  return _client;
}

/** Test hook — pass null to clear. Sticky until cleared. */
export function setCoreSkillClient(client: CoreSkillClient | null): void {
  _client = client;
  _clientKey = "";
  _forced = client !== null;
}
