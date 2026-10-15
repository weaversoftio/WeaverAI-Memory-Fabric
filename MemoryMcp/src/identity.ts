/**
 * Works out whose memory a tool call targets.
 *
 * The user comes from their key. The agent comes from (in order):
 *   1. the tool call's own `agent_id` (+ optional `team_id`)
 *   2. the `X-Memory-Agent-Id` (+ `X-Memory-Team-Id`) header set in the client's MCP config
 *   3. the user's only agent, when they own exactly one
 * Otherwise the call fails with a message listing the agents to choose from.
 */
import { HubClient, HubError } from "./hub.js";

export interface AgentRef {
  teamId: string;
  teamName: string;
  agentId: string;
  agentName: string;
}

export interface Identity {
  userId: string;
  username: string;
  agents: AgentRef[];
}

export interface Target extends AgentRef {
  userId: string;
  /** chat_memory asset id: chat_memory-{team}-{agent} */
  blockId: string;
}

export interface TargetHint {
  agentId?: string;
  teamId?: string;
}

interface CacheEntry {
  at: number;
  identity: Identity;
}

const cache = new Map<string, CacheEntry>();

export function chatMemoryBlockId(teamId: string, agentId: string): string {
  return `chat_memory-${teamId}-${agentId}`;
}

export async function loadIdentity(hub: HubClient, cacheMs: number): Promise<Identity> {
  const key = `${hub.serviceId}\u0000${hub.userKey}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < cacheMs) return hit.identity;

  const verify = await hub.post<{ valid: boolean; user: { user_id: string; username: string } | null }>(
    "meta/auth/verify",
    { user_key: hub.userKey },
  );
  if (!verify?.valid || !verify.user) throw new HubError(401, "The memory key is not valid. Copy your sk-mem key from the panel's API Key page.");
  const { user_id: userId, username } = verify.user;

  const teams = await hub.post<{ items: Array<{ team_id: string; name: string }> }>("meta/team/list", {
    user_key: hub.userKey,
    limit: 100,
  });
  const agents: AgentRef[] = [];
  for (const team of teams.items ?? []) {
    const list = await hub.post<{ items: Array<{ agent_id: string; name: string; status?: string }> }>("meta/agent/list", {
      team_id: team.team_id,
      owner_user_id: userId,
      limit: 100,
    });
    for (const a of list.items ?? []) {
      if (a.status && a.status !== "active") continue;
      agents.push({ teamId: team.team_id, teamName: team.name, agentId: a.agent_id, agentName: a.name });
    }
  }

  const identity = { userId, username, agents };
  cache.set(key, { at: Date.now(), identity });
  return identity;
}

function describeAgents(agents: AgentRef[]): string {
  if (agents.length === 0) return "You don't own any agents yet. Create one in the WeaverAI Memory Fabric panel.";
  return agents.map((a) => `- ${a.agentName} (agent_id ${a.agentId}) in team ${a.teamName} (team_id ${a.teamId})`).join("\n");
}

export function resolveTarget(identity: Identity, hint: TargetHint, fallback: TargetHint): Target {
  // The tool call's own agent wins; the header default applies only when the call names none.
  const source = hint.agentId?.trim() ? hint : fallback;
  const agentId = source.agentId?.trim() || undefined;
  const teamId = source.teamId?.trim() || undefined;

  let ref: AgentRef | undefined;
  if (agentId) {
    ref = identity.agents.find((a) => a.agentId === agentId && (!teamId || a.teamId === teamId));
    if (!ref) {
      // Not one of the user's own agents (e.g. a borrowed one): needs an explicit team.
      if (!teamId) {
        throw new HubError(400, `Agent ${agentId} isn't one of your agents, so team_id is required too. Your agents:\n${describeAgents(identity.agents)}`);
      }
      ref = { teamId, teamName: teamId, agentId, agentName: agentId };
    }
  } else if (identity.agents.length === 1) {
    ref = identity.agents[0];
  } else {
    throw new HubError(
      400,
      `You own ${identity.agents.length} agents, so say which one: pass agent_id, or set the X-Memory-Agent-Id header in your MCP config.\n${describeAgents(identity.agents)}`,
    );
  }
  return { ...ref, userId: identity.userId, blockId: chatMemoryBlockId(ref.teamId, ref.agentId) };
}

/** Test hook. */
export function clearIdentityCache(): void {
  cache.clear();
}
