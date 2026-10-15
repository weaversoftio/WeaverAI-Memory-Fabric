/**
 * Bridge signature: proves a /memory-bridge or /skill-bridge call comes from a
 * curl recipe this proxy injected, not from someone who only learned the
 * session ID (session IDs show up in logs and in upstream request headers).
 *
 * The injectors put `x-bridge-sig: HMAC(secret, spaceId \n sessionId)` into
 * every curl recipe; the bridges recompute it from the request's
 * x-wamf-service-id and session headers and reject a missing or wrong one.
 *
 * The secret is derived from admin.apiKey when one is set, so every proxy
 * replica agrees and signatures survive restarts. Without an admin key it is
 * random per process: recipes injected before a restart then stop working
 * until the next session.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const BRIDGE_SIG_HEADER = "x-bridge-sig";

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

/** `spaceId` must be exactly what the recipe sends as x-wamf-service-id ("" when omitted). */
export function signBridgeSession(sessionId: string, spaceId: string | undefined): string {
  return createHmac("sha256", key()).update(`${spaceId ?? ""}\n${sessionId}`).digest("base64url");
}

export function verifyBridgeSession(
  sig: string | undefined,
  sessionId: string,
  spaceId: string | undefined,
): boolean {
  if (!sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(signBridgeSession(sessionId, spaceId));
  return a.length === b.length && timingSafeEqual(a, b);
}
