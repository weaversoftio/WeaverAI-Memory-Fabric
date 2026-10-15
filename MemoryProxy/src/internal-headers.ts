/**
 * Inbound headers that only mean something to this proxy (identity, memory keys,
 * bridge signatures) or describe the client (cookies, forwarding chain). They are
 * never forwarded to an upstream model provider. Every handler adds these to its
 * hop-by-hop skip set.
 */
export const INTERNAL_REQUEST_HEADERS: readonly string[] = [
  "x-wamf-user-key",
  "x-wamf-user-token",
  "x-user-id",
  "x-cb-user-id",
  "x-bridge-sig",
  "cookie",
  "proxy-authorization",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];
