/**
 * Claude Code request classification - based on the Anthropic body's `cache_control`
 * marker position + tools/thinking fallback, splits all requests the CC client sends to /v1/messages
 * three ways into main / fork / sidequery.
 *
 * Criteria (hard constraints from the source + packet-capture evidence):
 *   - MAIN main conversation: the cache_control marker is at messages[n-1] (including the msgs=1 boundary)
 *   - FORK reusing the cache (SUGGESTION/RECAP/COMPACT/...): the marker is at messages[n-2]
 *     source forkedAgent.ts + claude.ts:3242-3243 force skipCacheWrite=true, moving the
 *     marker to position n-2 to avoid miscounting cache write cost
 *   - SIDEQUERY independent requests (TITLE/verify_api_key/...): no marker + tools=[] +
 *     thinking.disabled; source sessionTitle.ts:434 + queryHaiku force caching off
 *
 * Fallback when a 3P provider disables caching: when the body has no marker at all, use the two hard constraints tools=[] && thinking.disabled
 * jointly to decide sidequery; otherwise default to main - degrading to the original one-size-fits-all logic, never worse.
 *
 * For the detailed design and packet-capture evidence see:
 *   docs/design/2026-07-30-cc-request-routing-plan.md
 */

export type CcRequestKind = "main" | "fork" | "sidequery";

/**
 * Decide the request type from the Anthropic request body.
 *
 * The input is the body already parsed by the handler (Record<string, unknown>); all field access goes through
 * defensive narrowing, and unknown/malformed bodies always fall back to "main" - ensuring that when classification fails the behavior is
 * equivalent to the original path.
 */
export function classifyCcRequest(body: Record<string, unknown>): CcRequestKind {
  const rawMsgs = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  // Filter out non-conversation messages (e.g. role:"system" injected by some CC
  // versions into the messages array). Only user/assistant participate in the
  // cache_control marker position logic that distinguishes main from fork.
  const msgs = rawMsgs.filter((m) => {
    const role = (m as { role?: string })?.role;
    return role === "user" || role === "assistant";
  });
  const n = msgs.length;
  const markerIdx = findLastCacheControlIndex(msgs);

  // Primary decision: cache_control marker position
  if (markerIdx >= 0) {
    // messages[n-2] -> FORK (forced by skipCacheWrite=true)
    if (markerIdx === n - 2) return "fork";
    // Other positions (including last=n-1) -> MAIN
    return "main";
  }

  // No marker: may be SIDEQUERY, or a MAIN of a 3P provider with caching disabled
  // Fallback signal: the SIDEQUERY hard constraint is tools=[] AND thinking.disabled hitting together
  //          use && rather than || to avoid misjudging main conversations where the user disables only tools or only thinking
  const toolsEmpty = !Array.isArray(body.tools) || (body.tools as unknown[]).length === 0;
  const thinking = body.thinking as { type?: string } | undefined;
  const thinkingOff = thinking?.type === "disabled";
  if (toolsEmpty && thinkingOff) return "sidequery";

  return "main";
}

/**
 * Find the index of the **last** message in the messages array that contains a cache_control marker.
 *
 * In the CC client cache_control sits at the content block level (not the message top level),
 * so scan whether any block in each message's content array contains a cache_control key.
 * Returns -1 if none match.
 */
export function findLastCacheControlIndex(msgs: unknown[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { content?: unknown };
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content as unknown[]) {
      if (b && typeof b === "object" && "cache_control" in (b as object)) return i;
    }
  }
  return -1;
}
