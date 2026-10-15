/**
 * v3 metadata API auth middleware (v3.1).
 *
 * Layer 1 (gateway): `Authorization: Bearer <KERNEL_AUTH_TOKEN>` -- validated in checkAuthForV2 in server.ts.
 * Layer 3 (user identity): `x-wamf-user-key` -- parsed by this module into userId / isSystemAdmin.
 *
 * `/v3/meta/*` requires a user-key except for `auth/verify`.
 * For ops APIs without a user-key, see `/v3/internal/meta/*`.
 */

import type { IncomingHttpHeaders } from "node:http";
import type { MetadataService } from "../service/metadata-service.js";

export interface V3AuthContext {
  /** Raw user_key (from x-wamf-user-key). */
  token: string;
  /** Resolved user ID (when user_key is valid). */
  userId?: string;
  /** Legacy field: bootstrap isAdmin is no longer granted on /v3/meta/*. */
  isAdmin: boolean;
  /** The user_key corresponds to user_type === system_admin. */
  isSystemAdmin: boolean;
}

export interface V3AuthResult {
  ok: boolean;
  status?: number;
  reason?: string;
  ctx?: V3AuthContext;
}

/** Paths among public APIs that may omit x-wamf-user-key (Bearer + x-wamf-service-id still required). */
export const V3_NO_USER_KEY_ROUTES = new Set([
  "/v3/meta/auth/verify",
]);

/** Extract the user API key from the x-wamf-user-key header. */
export function extractUserKeyHeader(headers: IncomingHttpHeaders): string {
  const raw = headers["x-wamf-user-key"];
  const h = Array.isArray(raw) ? raw[0] : (raw ?? "");
  return h.trim();
}

/**
 * Resolve user_key -> user context. Callers should not pass an empty key (handled by the route layer for bootstrap).
 */
export async function authenticateV3(
  userKey: string,
  service: MetadataService,
): Promise<V3AuthResult> {
  if (!userKey) {
    return { ok: false, status: 401, reason: "missing_user_key" };
  }

  if (service.isConfiguredMemorySystemUserKey(userKey)) {
    return { ok: false, status: 401, reason: "invalid_user_key" };
  }

  const user = await service.verifyAuth(userKey);
  if (!user) {
    return { ok: false, status: 401, reason: "invalid_user_key" };
  }

  const isSystemAdmin = user.user_type === "system_admin";
  return {
    ok: true,
    ctx: { token: userKey, userId: user.user_id, isAdmin: false, isSystemAdmin },
  };
}
