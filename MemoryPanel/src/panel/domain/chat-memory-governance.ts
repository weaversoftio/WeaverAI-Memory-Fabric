/**
 * chat-memory-governance.ts -- ownership/sharing data model specific to chat_memory assets.
 *
 * Not shared with skill / wiki / code: each asset type has a different ownership model, and forcing an abstraction would hijack later work.
 *
 * Data shape:
 *   Each Agent carries one ChatMemoryAgentRel (share switch + borrowed <= 2)
 *
 * Persistence:
 *   The backend schema does not yet have real chat_memory_rel fields; during the demo phase it is tucked into the
 *   "chat_memory" namespace of Agent.metadata_json, sharing the same contract with the frontend.
 *   Once the backend adds the fields, switch the implementation of readChatMemoryRel / writeChatMemoryRel to the real fields.
 */

/** Borrow limit -- specific to chat_memory. If other assets get a borrowing concept later, they define their own. */
export const MAX_IMPORTED_AGENTS = 2;

export interface ChatMemoryAgentRel {
  /** Whether one's own memory is visible to the whole team. For this phase the UI locks it to true ("show globally whenever there is any"). */
  memory_shared_with_team: boolean;
  /** Borrowed agent_ids (<= MAX_IMPORTED_AGENTS, must be in the same team, excluding self, deduplicated). */
  imported_agent_ids: string[];
}

export const DEFAULT_CHAT_MEMORY_REL: ChatMemoryAgentRel = {
  memory_shared_with_team: true,
  imported_agent_ids: [],
};

export type ValidateResult = { ok: true } | { ok: false; reason: string };

/** Validation rules for the self-borrowed ids; shared by frontend and backend. */
export function validateImportedAgents(
  selfId: string,
  ids: string[],
  teamAgents: Array<{ agent_id: string }>,
): ValidateResult {
  if (!Array.isArray(ids)) return { ok: false, reason: 'imported_agent_ids must be an array' };
  if (ids.length > MAX_IMPORTED_AGENTS) {
    return { ok: false, reason: `at most ${MAX_IMPORTED_AGENTS} agents can be borrowed from` };
  }
  const teamSet = new Set(teamAgents.map((a) => a.agent_id));
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || typeof id !== 'string') return { ok: false, reason: 'contains an invalid agent_id' };
    if (id === selfId) return { ok: false, reason: 'an agent cannot borrow its own memory' };
    if (!teamSet.has(id)) return { ok: false, reason: `agent_id "${id}" is not in the current team` };
    if (seen.has(id)) return { ok: false, reason: 'duplicate agent in the borrow list' };
    seen.add(id);
  }
  return { ok: true };
}

const METADATA_NS = 'chat_memory';

interface AgentLike {
  agent_id: string;
  metadata_json?: string;
}

/** Read chat_memory_rel from an Agent; return the default if missing. Never throws. */
export function readChatMemoryRel(agent: AgentLike): ChatMemoryAgentRel {
  if (!agent.metadata_json) return { ...DEFAULT_CHAT_MEMORY_REL };
  try {
    const meta = JSON.parse(agent.metadata_json) as Record<string, unknown>;
    const slot = meta?.[METADATA_NS];
    if (slot && typeof slot === 'object') {
      return normalizeRel(slot as Partial<ChatMemoryAgentRel>);
    }
  } catch {
    /* old value invalid, use the default */
  }
  return { ...DEFAULT_CHAT_MEMORY_REL };
}

/** Merge chat_memory_rel back into metadata_json and return the new JSON string (does not modify the input). */
export function writeChatMemoryRel(
  prevMetadataJson: string | undefined,
  rel: ChatMemoryAgentRel,
): string {
  let meta: Record<string, unknown> = {};
  if (prevMetadataJson) {
    try {
      const parsed = JSON.parse(prevMetadataJson);
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      /* discard */
    }
  }
  meta[METADATA_NS] = normalizeRel(rel);
  return JSON.stringify(meta);
}

function normalizeRel(input: Partial<ChatMemoryAgentRel>): ChatMemoryAgentRel {
  return {
    memory_shared_with_team:
      typeof input.memory_shared_with_team === 'boolean'
        ? input.memory_shared_with_team
        : DEFAULT_CHAT_MEMORY_REL.memory_shared_with_team,
    imported_agent_ids: Array.isArray(input.imported_agent_ids)
      ? Array.from(new Set(input.imported_agent_ids.filter((x) => typeof x === 'string'))).slice(
          0,
          MAX_IMPORTED_AGENTS,
        )
      : [],
  };
}
