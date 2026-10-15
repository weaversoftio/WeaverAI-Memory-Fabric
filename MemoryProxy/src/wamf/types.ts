/** WAMF memory integration configuration and shared types. */

export interface WamfMemoryConfig {
  enabled: boolean;
  /** WAMF Gateway base URL, e.g. http://127.0.0.1:8420 */
  endpoint: string;
  /** Bearer token passed to WAMF Gateway. */
  apiKey: string;
  /** x-wamf-service-id header value. */
  serviceId: string;

  writeL0: boolean;
  recallL1: boolean;
  injectL2L3: boolean;

  l1Limit: number;
  l2Limit: number;
  timeoutMs: number;
}

export interface WamfIdentity {
  teamId: string;
  userId: string;
  agentId: string;
  /** Conversation/session dimension for L0/L1 only. */
  sessionId: string;
  /** Task dimension for L0/L1 only. */
  taskId?: string;
  /**
   * Requester user_key (the raw `sk-mem-...`). Used for wamf `/v3/meta/*` routes'
   * Layer 3 user authentication (`x-wamf-user-key` header) -- required for the ACL check path.
   *
   * The data plane (`/v3/conversation/*`) uses the team/user/agent header triple and does not use this field.
   */
  userKey?: string;
}

/**
 * Per-agent context used when reading other agents' memories
 * (e.g. via the "imported" relation). team/user/agent identify the data
 * owner; sessionId/taskId stay on the *caller* (current request).
 *
 * Why the split: borrowing memories from agent B doesn't change which
 * conversation we're in — L0 captures into the caller's sessionId,
 * but L1 search and L2/L3 reads use B's owning triplet.
 */
export interface WamfAgentCtx {
  teamId: string;
  userId: string;
  agentId: string;
  /** Display name for prompt section headings ("from X"). */
  agentName?: string;
}

/** Result of L1 recall — keep `from` so proxy can label "[from X]" in prompt. */
export interface WamfL1Hit extends WamfL1Memory {
  fromAgentId: string;
  fromAgentName?: string;
}

export interface WamfMessage {
  role: "user" | "assistant";
  content: string;
}

export interface WamfL1Memory {
  id: string;
  type?: string;
  content: string;
  score?: number;
  updatedAt?: string;
}

export interface WamfL2Entry {
  path: string;
  summary?: string;
  updatedAt?: string;
}

export interface WamfL2File extends WamfL2Entry {
  content: string;
}

export interface WamfL3Core {
  content: string;
  updatedAt?: string;
}
