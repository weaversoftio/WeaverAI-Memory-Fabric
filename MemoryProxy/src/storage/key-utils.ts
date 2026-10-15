/**
 * key-utils -- ProxyStorage key path generation & validation utilities.
 *
 * Directory scheme: <ttl|nottl>/<spaceId>/<userId>/<agentSource>/<sessionId>/<data-type>[/subpath]
 *
 * The spaceId layer isolates tenants: every key carries a spaceId segment so per-space data can be listed / purged by prefix.
 *
 * The validity of the four-segment isolation key is uniformly validated by this file; each Repo builds keys through `sessionDirOf` to generate
 * the prefix (always ending with `/`), then appends its own data-type segment. Before writing, the segments easily subject to injection
 * (spaceId / userId / agentSource / sessionId / hookId / skillId) are validated, to prevent
 * `../` path traversal, key collisions from empty segments, and illegal characters in agentSource breaking through the directory layers.
 */

const AGENT_SOURCE_RE = /^[a-z0-9-]+$/;

/**
 * Generic segment validation: non-empty + no `/` + no `..` substring.
 *
 * The `..` check rejects every case containing the substring ("..", "foo..bar", "..a" are all rejected), more conservative than rejecting only
 * the full ".." -- production sessionId / userId / hookId should in theory never contain two
 * consecutive dots, so the false-positive cost is very low and the injection-prevention value high.
 */
export function assertKeySegment(name: string, value: string): void {
  if (!value || value.includes("/") || value.includes("..")) {
    throw new Error(`invalid ${name}: ${value}`);
  }
}

/**
 * agentSource value-range validation: `^[a-z0-9-]+$`.
 *
 * Allows lowercase + digit + hyphen, consistent with the format of the first URL path segment
 * (what handler.ts / anthropicHandler.ts parse from the path is exactly this format).
 * Uppercase, underscore, dot and slash are always rejected.
 */
export function assertAgentSource(value: string): void {
  if (!AGENT_SOURCE_RE.test(value)) {
    throw new Error(`invalid agentSource: ${value}`);
  }
}

/**
 * Generate the session-level directory prefix: `<bucket>/<spaceId>/<userId>/<agentSource>/<sessionId>/`.
 *
 * The trailing slash is **kept**, so callers can just splice `${sessionDirOf(...)}<datatype>`;
 * directory-level operations (`listNames` / `delPrefix`) also use the return value directly as the prefix.
 *
 * The spaceId segment is fixed right after the bucket (after ttl/nottl), which is the key constraint that lets the lifecycle rule
 * match all spaces with a single prefix -- rules do not support wildcards in the middle of a path.
 */
export function sessionDirOf(
  bucket: "ttl" | "nottl",
  spaceId: string,
  userId: string,
  agentSource: string,
  sessionId: string,
): string {
  assertKeySegment("spaceId", spaceId);
  assertKeySegment("userId", userId);
  assertAgentSource(agentSource);
  assertKeySegment("sessionId", sessionId);
  return `${bucket}/${spaceId}/${userId}/${agentSource}/${sessionId}/`;
}

/**
 * 2-segment version: `<bucket>/<spaceId>/<sessionId>/`.
 *
 * For BindingRepo -- the bridge must be able to read identity back from just (spaceId, sessionId),
 * with userId/agentSource moved into JSON inner fields. See docs/design/2026-08-03-binding-flatten.md.
 * The old 4-segment `sessionDirOf` continues to serve SessionRepo (ttl inj-sess.json), unchanged.
 */
export function sessionBindingDirOf(
  bucket: "ttl" | "nottl",
  spaceId: string,
  sessionId: string,
): string {
  assertKeySegment("spaceId", spaceId);
  assertKeySegment("sessionId", sessionId);
  return `${bucket}/${spaceId}/${sessionId}/`;
}
