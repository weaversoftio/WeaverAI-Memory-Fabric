import type { WamfIdentity } from "./types.js";

interface SessionInfoLike {
  session_id?: unknown;
  team_id?: unknown;
  user_id?: unknown;
  agent_id?: unknown;
  task_id?: unknown;
}

export interface WamfIdentitySource {
  sessionInfo?: Record<string, unknown> | null;
  /** User ID from auth/verify — replaces legacy codeBuddyUserId. */
  userId?: string | null;
  sessionKey?: string | null;
  /** Requester user_key (from Authorization: Bearer; used for ACL checks). */
  userKey?: string | null;
}

/**
 * Derive a fully-qualified WAMF identity from session state. Every required
 * field (team_id / user_id / agent_id / session_id) must come from the
 * session or auth layer — there is no fallback "team_default" / "u_default".
 * Missing any → return null and let the caller bypass memory injection.
 */
export function deriveWamfIdentity(source: WamfIdentitySource): WamfIdentity | null {
  const session = source.sessionInfo as SessionInfoLike | undefined;
  const teamId = pickString(session?.team_id);
  const userId = pickString(session?.user_id) ?? pickString(source.userId);
  const agentId = pickString(session?.agent_id);
  const sessionId = pickString(session?.session_id) ?? pickString(source.sessionKey);
  const taskId = pickString(session?.task_id);
  const userKey = pickString(source.userKey);
  if (!teamId || !userId || !agentId || !sessionId) return null;
  return { teamId, userId, agentId, sessionId, taskId, userKey };
}

export function getWamfIdentity(custom: Record<string, unknown> | undefined): WamfIdentity | null {
  const userKey = pickString(custom?.userKey);
  return deriveWamfIdentity({
    sessionInfo: custom?.session as Record<string, unknown> | null | undefined,
    userKey,
  });
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}