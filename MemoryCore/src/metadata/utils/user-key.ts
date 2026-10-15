/**
 * user_key redaction and validity checks (multi-key model).
 */

/** Fixed user_key prefix, used to identify ownership and for secret scanning. */
export const USER_KEY_PREFIX = "sk-mem-";

/**
 * General sensitive-string redaction: first 8 characters + ellipsis, without exposing the full secret.
 * Used by api-trace to redact generic secrets such as password / token / authorization in logs.
 */
export function maskKeyValue(keyValue: string): string {
  if (!keyValue) return "";
  if (keyValue.length <= 8) return `${keyValue}…`;
  return `${keyValue.slice(0, 8)}…`;
}

/**
 * user_key list/detail display redaction: keep the `sk-mem-` prefix + `****` + the last 4 characters.
 * E.g. `sk-mem-<32 chars>...e5fG` -> `sk-mem-****e5fG`.
 */
export function maskUserKey(keyValue: string): string {
  if (!keyValue) return "";
  const prefix = keyValue.startsWith(USER_KEY_PREFIX) ? USER_KEY_PREFIX : "";
  const body = keyValue.slice(prefix.length);
  const tail = body.length >= 4 ? body.slice(-4) : body;
  return `${prefix}****${tail}`;
}

/** Whether an active key has expired (expires_at is an ISO string). */
export function isUserKeyExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= now;
}

export const DEFAULT_MAX_ACTIVE_USER_KEYS = 20;
