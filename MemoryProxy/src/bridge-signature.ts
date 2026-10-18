/**
 * Bridge signature: proves a /memory-bridge or /skill-bridge call comes from a
 * curl recipe this proxy injected, not from someone who only learned the
 * session ID (session IDs show up in logs and in upstream request headers).
 *
 * Wire format (v1, self-contained):
 *   x-bridge-sig: v1.<base64url(sessionId)>.<hmac>
 *   hmac = HMAC-SHA256(secret, `${spaceId}\n${sessionId}`) as base64url
 *
 * Why self-contained: Open WebUI / gateway PII filters often rewrite
 * x-conversation-id (UUID / digit patterns → `[BR_PHONE_…_REDACTED]-…`) while
 * leaving the sig header intact. Embedding the session id inside the sig lets
 * the bridge recover identity even when conversation-id is mangled.
 *
 * Recipes also send x-conversation-id as opaque `wamf1.<base64url(sessionId)>`
 * so most filters never touch it. Legacy recipes that send a bare HMAC (no
 * `v1.` prefix) still verify when the conversation-id header is intact.
 *
 * The secret is derived from admin.apiKey when one is set, so every proxy
 * replica agrees and signatures survive restarts. Without an admin key it is
 * random per process: recipes injected before a restart then stop working
 * until the next session.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const BRIDGE_SIG_HEADER = "x-bridge-sig";

/** Opaque wire encoding for session ids embedded in curl recipes. */
export const BRIDGE_SESSION_TOKEN_PREFIX = "wamf1.";

/** Self-contained signature prefix: v1.<b64url(sessionId)>.<hmac>. */
export const BRIDGE_SIG_V1_PREFIX = "v1.";

let secret: Buffer | null = null;

/** Called once at startup with config.admin.apiKey (empty = random secret). */
export function initBridgeSecret(seed: string | undefined): void {
  secret = seed
    ? createHmac("sha256", "agent-memory-bridge-signature").update(seed).digest()
    : randomBytes(32);
}

function key(): Buffer {
  if (!secret) initBridgeSecret(undefined);
  return secret!;
}

/**
 * Encode a raw session id for curl recipes so PII redactors do not rewrite it.
 * Idempotent if already encoded.
 */
export function encodeBridgeSessionToken(sessionId: string): string {
  if (sessionId.startsWith(BRIDGE_SESSION_TOKEN_PREFIX)) return sessionId;
  return (
    BRIDGE_SESSION_TOKEN_PREFIX +
    Buffer.from(sessionId, "utf8").toString("base64url")
  );
}

/**
 * Decode a recipe token to the raw session id used for HMAC + session lookup.
 * Passthrough for legacy recipes that still send the raw id.
 */
export function decodeBridgeSessionToken(token: string): string {
  if (!token.startsWith(BRIDGE_SESSION_TOKEN_PREFIX)) return token;
  const payload = token.slice(BRIDGE_SESSION_TOKEN_PREFIX.length);
  if (!payload) return token;
  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    return decoded.length > 0 ? decoded : token;
  } catch {
    return token;
  }
}

/** True when a session header looks like an upstream PII redaction placeholder. */
export function looksLikeRedactedSessionId(sessionId: string): boolean {
  return /REDACTED|\[BR_[A-Z0-9_]+\]/i.test(sessionId);
}

function hmacSession(sessionId: string, spaceId: string | undefined): string {
  return createHmac("sha256", key())
    .update(`${spaceId ?? ""}\n${sessionId}`)
    .digest("base64url");
}

function safeEqualB64(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Build the v1 self-contained bridge proof for curl recipes.
 * Prefer this over the legacy bare-HMAC form.
 */
export function signBridgeSession(sessionId: string, spaceId: string | undefined): string {
  const sid = Buffer.from(sessionId, "utf8").toString("base64url");
  return `${BRIDGE_SIG_V1_PREFIX}${sid}.${hmacSession(sessionId, spaceId)}`;
}

/** Legacy bare HMAC (tests / older callers). Not used in new recipes. */
export function signBridgeSessionLegacyHmac(
  sessionId: string,
  spaceId: string | undefined,
): string {
  return hmacSession(sessionId, spaceId);
}

export interface BridgeAuthResult {
  ok: boolean;
  /** Raw session id when ok (decoded from v1 sig and/or conversation header). */
  sessionId?: string;
  reason?: "missing_sig" | "invalid_sig" | "redacted_session" | "session_mismatch";
}

/**
 * Verify bridge proof.
 *
 * - v1 sig: recover session id from the sig itself (survives conversation-id redaction).
 * - legacy bare HMAC: require a usable sessionIdHint from headers.
 * - When both v1 session and a non-redacted header session are present, they must match.
 */
export function authenticateBridgeRequest(
  sig: string | undefined,
  sessionIdHint: string | undefined,
  spaceId: string | undefined,
): BridgeAuthResult {
  if (!sig) return { ok: false, reason: "missing_sig" };

  if (sig.startsWith(BRIDGE_SIG_V1_PREFIX)) {
    const rest = sig.slice(BRIDGE_SIG_V1_PREFIX.length);
    const dot = rest.indexOf(".");
    if (dot <= 0 || dot === rest.length - 1) return { ok: false, reason: "invalid_sig" };
    const sidB64 = rest.slice(0, dot);
    const mac = rest.slice(dot + 1);
    let sessionId: string;
    try {
      sessionId = Buffer.from(sidB64, "base64url").toString("utf8");
    } catch {
      return { ok: false, reason: "invalid_sig" };
    }
    if (!sessionId) return { ok: false, reason: "invalid_sig" };
    if (!safeEqualB64(mac, hmacSession(sessionId, spaceId))) {
      return { ok: false, reason: "invalid_sig" };
    }
    if (
      sessionIdHint &&
      !looksLikeRedactedSessionId(sessionIdHint) &&
      sessionIdHint !== sessionId
    ) {
      // Header claims a different intact session than the signed one.
      return { ok: false, reason: "session_mismatch" };
    }
    return { ok: true, sessionId };
  }

  // Legacy bare HMAC — needs an intact session hint.
  if (!sessionIdHint) return { ok: false, reason: "missing_sig" };
  if (looksLikeRedactedSessionId(sessionIdHint)) {
    return { ok: false, reason: "redacted_session" };
  }
  if (!safeEqualB64(sig, hmacSession(sessionIdHint, spaceId))) {
    return { ok: false, reason: "invalid_sig" };
  }
  return { ok: true, sessionId: sessionIdHint };
}

/**
 * @deprecated Prefer authenticateBridgeRequest. Kept for call sites that only
 * need a boolean against a known session id (legacy HMAC or v1 for that id).
 */
export function verifyBridgeSession(
  sig: string | undefined,
  sessionId: string,
  spaceId: string | undefined,
): boolean {
  const result = authenticateBridgeRequest(sig, sessionId, spaceId);
  return result.ok && result.sessionId === sessionId;
}
