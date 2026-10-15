/**
 * chat_memory asset ID generation rules.
 *
 * Convention: each (team, agent) combination corresponds to **one** stable chat_memory asset, and asset_id
 * is concatenated from team_id and agent_id:
 *
 *     chat_memory-{team_id}-{agent_id}
 *
 * This deterministic ID makes the write path automatically idempotent -- for the same (team, agent), no matter how many requests,
 * the computed asset_id is the same, and the store layer's primary-key constraint naturally blocks duplicate inserts.
 *
 * Forward concatenation needs no reverse parsing. `/v3/chat-memory/clear` needs to locate (team, agent) from asset_id
 * to clear content, but **does no string splitting** -- team_id / agent_id
 * may both contain `-`, and splitting would be ambiguous. Reverse lookup uniformly goes through `resolveChatMemoryAgentId`:
 * take the asset's known team_id + candidate agent_id, concatenate forward and compare; a hit confirms it.
 */

/** chat_memory asset ID prefix. */
export const CHAT_MEMORY_ASSET_PREFIX = "chat_memory-";

/** Stably generate the chat_memory asset ID corresponding to a (team, agent). */
export function buildChatMemoryAssetId(teamId: string, agentId: string): string {
  return `${CHAT_MEMORY_ASSET_PREFIX}${teamId}-${agentId}`;
}

/**
 * Find, among the candidate agent list, the agent_id matching assetId.
 *
 * Uses forward concatenation and comparison rather than splitting strings, so it remains correct when team_id / agent_id contain `-`.
 *
 * @param assetId    chat_memory asset ID
 * @param teamId     team_id on the asset record (authoritative value, not guessed from assetId)
 * @param agentIds   candidate agent_id list under that team
 * @returns          the matching agent_id; undefined if no match
 */
export function resolveChatMemoryAgentId(
  assetId: string,
  teamId: string,
  agentIds: Iterable<string>,
): string | undefined {
  for (const agentId of agentIds) {
    if (buildChatMemoryAssetId(teamId, agentId) === assetId) return agentId;
  }
  return undefined;
}
