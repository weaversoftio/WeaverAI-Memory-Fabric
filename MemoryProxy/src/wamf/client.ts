import type {
  WamfAgentCtx,
  WamfIdentity,
  WamfL1Memory,
  WamfL2Entry,
  WamfL2File,
  WamfL3Core,
  WamfMemoryConfig,
  WamfMessage,
} from "./types.js";
import { log } from "../report/log.js";

interface WamfEnvelope<T = unknown> {
  code?: number;
  message?: string;
  data?: T;
}

const WAMF_MESSAGE_CONTENT_MAX_CHARS = 8192;
const WAMF_CONVERSATION_MAX_MESSAGES = 100;

/**
 * Split messages to fit the gateway schema without losing content or breaking
 * UTF-16 surrogate pairs. The gateway validates string.length, so this limit
 * intentionally uses JavaScript code units rather than UTF-8 bytes.
 */
function chunkConversationMessages(messages: WamfMessage[]): WamfMessage[] {
  return messages.flatMap((message) => {
    if (message.content.length <= WAMF_MESSAGE_CONTENT_MAX_CHARS) return [message];

    const chunks: WamfMessage[] = [];
    let start = 0;
    while (start < message.content.length) {
      let end = Math.min(start + WAMF_MESSAGE_CONTENT_MAX_CHARS, message.content.length);
      if (
        end < message.content.length
        && isHighSurrogate(message.content.charCodeAt(end - 1))
        && isLowSurrogate(message.content.charCodeAt(end))
      ) {
        end -= 1;
      }
      chunks.push({ role: message.role, content: message.content.slice(start, end) });
      start = end;
    }
    return chunks;
  });
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF;
}

// ── ACL types ─────────────────────────────────────────────────────────────
export type AclAction = "read" | "write" | "delete" | "grant";

export interface AclCheckParams {
  /**
   * The requester's user_key (the raw `sk-mem-...`).
   *
   * wamf `/v3/meta/*` routes require the `x-wamf-user-key` header to pass Layer 3
   * user authentication (otherwise 401 missing_user_key). The user_key passed in here will:
   *   1. be used as the `x-wamf-user-key` header for authentication ("who you are")
   *   2. be used by the wamf server to resolve user_id, for the checkAssetPermission decision
   *
   * So the body **no longer needs** user_id -- wamf resolves it itself from the header.
   */
  user_key: string;
  /** Target asset id, e.g. `chat_memory-{team}-{agent}`. */
  asset_id: string;
  action: AclAction;
  /** Optional: explicitly limit which agent the check applies to. */
  agent_id?: string;
}

export interface AclCheckResult {
  allowed: boolean;
  reason?: string;
}

export class WamfClient {
  constructor(private config: WamfMemoryConfig) {}

  isEnabled(): boolean {
    return this.config.enabled && !!this.config.endpoint;
  }

  async addConversation(identity: WamfIdentity, messages: WamfMessage[]): Promise<void> {
    if (!this.isEnabled() || !this.config.writeL0 || messages.length === 0) return;

    const chunkedMessages = chunkConversationMessages(messages);
    log.info("wamf-recorder:write-l0", {
      team: identity.teamId,
      agent: identity.agentId,
      user: identity.userId,
      session: identity.sessionId,
      task: identity.taskId,
      msgs: messages.length,
      chunks: chunkedMessages.length,
      userLen: (messages[0]?.content ?? "").length,
    });

    for (let offset = 0; offset < chunkedMessages.length; offset += WAMF_CONVERSATION_MAX_MESSAGES) {
      const batch = chunkedMessages.slice(offset, offset + WAMF_CONVERSATION_MAX_MESSAGES);
      await this.postForCtx(
        "/v3/conversation/add",
        { teamId: identity.teamId, userId: identity.userId, agentId: identity.agentId },
        {
          team_id: identity.teamId,
          user_id: identity.userId,
          agent_id: identity.agentId,
          session_id: identity.sessionId,
          task_id: identity.taskId,
          messages: batch,
        },
        identity.sessionId,
        identity.taskId,
        { includeSession: true, includeTask: true },
      );
    }
  }

  async searchL1(identity: WamfIdentity, query: string): Promise<WamfL1Memory[]> {
    return this.searchL1ForCtx(
      { teamId: identity.teamId, userId: identity.userId, agentId: identity.agentId },
      query,
      identity.sessionId,
      identity.taskId,
    );
  }

  /**
   * Multi-agent variant: search L1 against a specific (team, user, agent)
   * triplet, while keeping the caller's session/task on the wire.
   *   - used for one of the agents in the "own + borrowed" recall
   *   - returns empty directly without a query (consistent with the original behaviour)
   */
  async searchL1ForCtx(
    ctx: WamfAgentCtx,
    query: string,
    sessionId: string,
    taskId?: string,
    limit?: number,
  ): Promise<WamfL1Memory[]> {
    if (!this.isEnabled() || !this.config.recallL1 || !query.trim()) return [];
    const data = await this.postForCtx<{ items?: Array<Record<string, unknown>> }>(
      "/v3/atomic/search",
      ctx,
      {
        team_id: ctx.teamId,
        user_id: ctx.userId,
        agent_id: ctx.agentId,
        session_id: sessionId,
        task_id: taskId,
        query: query.slice(0, 2048),
        limit: limit ?? this.config.l1Limit,
      },
      sessionId,
      taskId,
      { includeSession: true, includeTask: true },
    );
    return (data.items ?? [])
      .map((item) => ({
        id: String(item.id ?? ""),
        type: typeof item.type === "string" ? item.type : undefined,
        content: typeof item.content === "string" ? item.content : "",
        score: typeof item.score === "number" ? item.score : undefined,
        updatedAt: typeof item.updated_at === "string" ? item.updated_at : undefined,
      }))
      .filter((m) => m.id && m.content);
  }

  async listL2(identity: WamfIdentity): Promise<WamfL2Entry[]> {
    return this.listL2ForCtx({
      teamId: identity.teamId,
      userId: identity.userId,
      agentId: identity.agentId,
    });
  }

  async listL2ForCtx(ctx: WamfAgentCtx): Promise<WamfL2Entry[]> {
    if (!this.isEnabled() || !this.config.injectL2L3) return [];
    const data = await this.postForCtx<{ entries?: Array<Record<string, unknown>> }>(
      "/v3/scenario/ls",
      ctx,
      {
        team_id: ctx.teamId,
        agent_id: ctx.agentId,
        path_prefix: "",
      },
      "",
      undefined,
      { includeSession: false, includeTask: false },
    );
    return (data.entries ?? [])
      .map((entry) => ({
        path: String(entry.path ?? ""),
        summary: typeof entry.summary === "string" ? entry.summary : undefined,
        updatedAt: typeof entry.updated_at === "string" ? entry.updated_at : undefined,
      }))
      .filter((entry) => entry.path && !entry.path.endsWith("/"))
      .slice(0, this.config.l2Limit);
  }

  async readL2(identity: WamfIdentity, path: string): Promise<WamfL2File | null> {
    return this.readL2ForCtx(
      { teamId: identity.teamId, userId: identity.userId, agentId: identity.agentId },
      path,
    );
  }

  async readL2ForCtx(ctx: WamfAgentCtx, path: string): Promise<WamfL2File | null> {
    if (!this.isEnabled() || !this.config.injectL2L3 || !path) return null;
    const data = await this.postForCtx<Record<string, unknown> | null>(
      "/v3/scenario/read",
      ctx,
      {
        team_id: ctx.teamId,
        agent_id: ctx.agentId,
        path,
      },
      "",
      undefined,
      { includeSession: false, includeTask: false },
    );
    const content = typeof data?.content === "string" ? data.content : "";
    if (!content) return null;
    return {
      path,
      content,
      updatedAt: typeof data?.updated_at === "string" ? data.updated_at : undefined,
    };
  }

  async readL3(identity: WamfIdentity): Promise<WamfL3Core | null> {
    return this.readL3ForCtx({
      teamId: identity.teamId,
      userId: identity.userId,
      agentId: identity.agentId,
    });
  }

  async readL3ForCtx(ctx: WamfAgentCtx): Promise<WamfL3Core | null> {
    if (!this.isEnabled() || !this.config.injectL2L3) return null;
    const data = await this.postForCtx<Record<string, unknown> | null>(
      "/v3/core/read",
      ctx,
      {
        team_id: ctx.teamId,
        agent_id: ctx.agentId,
      },
      "",
      undefined,
      { includeSession: false, includeTask: false },
    );
    const content = typeof data?.content === "string" ? data.content : "";
    if (!content) return null;
    return { content, updatedAt: typeof data?.updated_at === "string" ? data.updated_at : undefined };
  }

  private async postForCtx<T>(
    path: string,
    ctx: WamfAgentCtx,
    body: Record<string, unknown>,
    sessionId: string,
    taskId: string | undefined,
    options: { includeSession: boolean; includeTask: boolean } = { includeSession: true, includeTask: true },
  ): Promise<T> {
    const base = this.config.endpoint.replace(/\/$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.config.apiKey || "local-proxy"}`,
        "x-wamf-service-id": this.config.serviceId || "default",
        "x-wamf-team-id": ctx.teamId,
        "x-wamf-user-id": ctx.userId,
        "x-wamf-agent-id": ctx.agentId,
      };
      if (options.includeSession && sessionId) headers["x-wamf-session-id"] = sessionId;
      if (options.includeTask && taskId) headers["x-wamf-task-id"] = taskId;

      const res = await fetch(`${base}${path}`, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify(stripUndefined(body)),
      });
      if (!res.ok) return {} as T;
      const envelope = await res.json() as WamfEnvelope<T>;
      if (typeof envelope.code === "number" && envelope.code !== 0) return {} as T;
      return (envelope.data ?? {}) as T;
    } catch {
      return {} as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── ACL check ──────────────────────────────────────────────────────────
  //
  // **Opposite semantics** from the memory data-plane calls (postForCtx):
  //   - postForCtx swallows network/HTTP/envelope errors and returns empty -- letting the injection path degrade silently
  //   - checkAcl network/HTTP/envelope errors must throw -- so the upper layer fails closed and rejects injection
  //     and logs an error (otherwise an ACL service outage would silently become "allow all", an authorization bypass)
  //
  // So this method does not reuse postForCtx and is implemented independently -- but it still reuses the same config
  // (endpoint / apiKey / serviceId / timeoutMs).

  /**
   * Check a user_id's permission on an asset.
   *
   * Throwing scenarios (fetch/timeout/HTTP non-2xx/envelope code!=0/data.allowed not boolean)
   * should be caught by the caller and handled as the business needs -- injection paths should use the checkAclOrDeny convenience function.
   */
  async checkAcl(params: AclCheckParams): Promise<AclCheckResult> {
    if (!this.isEnabled()) {
      // When wamf is not enabled, treat it as "pass", consistent with what other memory methods return when disabled.
      return { allowed: true, reason: "wamf_disabled" };
    }
    const base = this.config.endpoint.replace(/\/$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(`${base}/v3/meta/acl/check`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey || "local-proxy"}`,
          "x-wamf-service-id": this.config.serviceId || "default",
          // Layer 3 user authentication: wamf v3 meta routes require this header to pass, otherwise
          // 401 missing_user_key. The proxy side's current requester user_key is used directly as the
          // caller identity.
          "x-wamf-user-key": params.user_key,
        },
        body: JSON.stringify({
          // body user_key = the **target user whose permission is being checked** (here the same person as the caller -- in the proxy
          // scenario it is always checking oneself). The schema (userIdOrKeyFields.refine)
          // requires at least one of user_id or user_key -- we reuse the key from the header.
          user_key: params.user_key,
          asset_id: params.asset_id,
          action: params.action,
          agent_id: params.agent_id,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`acl/check http ${res.status}: ${body.slice(0, 200)}`);
      }
      const envelope = (await res.json()) as WamfEnvelope<AclCheckResult>;
      if (typeof envelope.code === "number" && envelope.code !== 0) {
        throw new Error(`acl/check envelope code=${envelope.code} msg=${envelope.message ?? ""}`);
      }
      const data = envelope.data;
      if (!data || typeof data.allowed !== "boolean") {
        throw new Error(`acl/check malformed response: ${JSON.stringify(data).slice(0, 200)}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Injection-path convenience function: wraps a try/catch + error log.
 *
 * Semantics:
 *   - allowed=true                  -> allow
 *   - allowed=false                 -> deny (normal; the caller decides whether to warn)
 *   - the underlying call throws    -> deny + error log (fail-closed)
 *
 * Use case: when filtering ctxs one by one in resolveFixedAssetCtxs, we do not want a single network error to
 * make the whole injection path throw; use this convenience function to turn the exception into a "deny" signal.
 */
export async function checkAclOrDeny(
  client: WamfClient,
  params: AclCheckParams,
): Promise<AclCheckResult> {
  try {
    return await client.checkAcl(params);
  } catch (err) {
    log.error(
      "[wamf-acl] check_failed",
      { user_key_masked: maskUserKey(params.user_key), asset_id: params.asset_id, action: params.action },
      err instanceof Error ? err : new Error(String(err)),
    );
    return { allowed: false, reason: "acl_check_error" };
  }
}

function stripUndefined(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

/** Redact when printing a sensitive userKey: keep only the first 6 and last 4 characters. */
function maskUserKey(key: string | undefined): string {
  if (!key) return "";
  if (key.length <= 12) return "***";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}
