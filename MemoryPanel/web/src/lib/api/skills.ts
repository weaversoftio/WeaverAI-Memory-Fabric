/**
 * api/skills.ts — Skill data plane (/api/v1/skill/*).
 *
 * Key differences from the meta path:
 *   - a skill has independent storage and a primary key skill_id (prefix skl-), readable within the team, writable by the owner agent;
 *   - identity fields (user_id / team_id / agent_id) go in the body, not in headers (auth headers
 *     are still X-Wamf-Service-Id + X-Wamf-User-Key, same as meta);
 *   - write operations (create/update/patch/delete/files.*) need agent_id (= owner),
 *     update/patch/delete/files.* also need expected_version for optimistic locking;
 *   - pagination uses the nested pagination.{limit,offset}.
 *
 * Semantics of "mount to Agent": the only mechanism that truly makes a skill belong to an agent is fork -- copy an
 * independent replica with owner_agent_id = the target agent (see skillApi.forkToAgent). acl/grant only change the
 * meta authorization layer and have no effect on the "pinned assets" tab or runtime injection (both keyed on owner_agent_id).
 */
import { getPanelSession } from '../panelSession';
import { request, getCurrentUser, ApiError, META_PAGE_SIZE } from './base';
import type { MetaEnvelope } from './types';

export interface SkillSummary {
  skill_id: string;
  name: string;
  description: string;
  version: number;
  is_head: boolean;
  status: 'active' | 'archived';
  owner_user_id: string;
  owner_agent_id: string;
  team_id: string;
  task_id: string;
  created_at_ms: number;
  updated_at_ms: number;
  metadata?: Record<string, unknown>;
}

export interface SkillManifestEntry {
  path: string;
  size_bytes: number;
  mime_type: string;
  is_executable: boolean;
}

export interface SkillDetail extends SkillSummary {
  content: string;
  manifest: SkillManifestEntry[];
  content_hash?: string;
  storage_dir?: string;
}

export interface SkillResourcePayload {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mime_type?: string;
  is_executable?: boolean;
}

export interface SkillFileContent {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  size_bytes: number;
  mime_type: string;
  version: number;
}

const SKILL_PREFIX = '/api/v1/skill';

/** Skill data-plane call: injects the two headers, POST body, parses the envelope (code!=0 throws ApiError). */
async function skillCall<T>(
  action: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<T> {
  const envelope = await request<MetaEnvelope<T>>('POST', `${SKILL_PREFIX}/${action}`, body, headers);
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  if (envelope.data === null || envelope.data === undefined) {
    throw new ApiError(200, envelope.message || 'empty skill response', '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message || 'empty skill response',
    });
  }
  return envelope.data;
}

async function skillPost<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const session = getPanelSession();
  if (!session) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  return skillCall<T>(action, body, {
    'X-Wamf-Service-Id': session.instanceId,
    'X-Wamf-User-Key': session.userKey,
  });
}

export const skillApi = {
  /** List head skills under a team (fetches everything by pagination; optionally filter by owner agent / name prefix / status) */
  list: async (
    teamId: string,
    opts?: { ownerAgentId?: string; namePrefix?: string; status?: Array<'active' | 'archived'> }
  ): Promise<SkillSummary[]> => {
    const me = await getCurrentUser();
    const items: SkillSummary[] = [];
    let offset = 0;
    for (;;) {
      const page = await skillPost<{ items: SkillSummary[]; total: number }>('list', {
        user_id: me.user_id,
        team_id: teamId,
        filters: {
          owner_agent_id: opts?.ownerAgentId,
          name_prefix: opts?.namePrefix,
          status: opts?.status ?? ['active'],
        },
        pagination: { limit: META_PAGE_SIZE, offset },
      });
      items.push(...page.items);
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }
    return items;
  },

  /** List skills owned (owner) by an agent */
  listByAgent: (teamId: string, agentId: string): Promise<SkillSummary[]> =>
    skillApi.list(teamId, { ownerAgentId: agentId }),

  /** Get skill details (including the SKILL.md body + resource manifest) */
  get: async (teamId: string, skillId: string): Promise<SkillDetail> => {
    const me = await getCurrentUser();
    return skillPost<SkillDetail>('get', {
      user_id: me.user_id,
      team_id: teamId,
      skill_id: skillId,
      include_content: true,
      include_manifest: true,
    });
  },

  /** Read the content of a single resource file */
  filesRead: async (teamId: string, skillId: string, path: string): Promise<SkillFileContent> => {
    const me = await getCurrentUser();
    return skillPost<SkillFileContent>('files/read', {
      user_id: me.user_id,
      team_id: teamId,
      skill_id: skillId,
      path,
    });
  },

  /** Create a skill (agentId becomes owner_agent_id) */
  create: async (
    teamId: string,
    agentId: string,
    data: { name: string; content: string; resources?: SkillResourcePayload[]; metadata?: Record<string, unknown> }
  ): Promise<SkillSummary> => {
    const me = await getCurrentUser();
    return skillPost<SkillSummary>('create', {
      user_id: me.user_id,
      team_id: teamId,
      agent_id: agentId,
      name: data.name,
      content: data.content,
      resources: data.resources,
      metadata: data.metadata,
    });
  },

  /** Soft delete (archive); needs owner agent_id + expected_version for optimistic locking */
  delete: async (
    teamId: string,
    agentId: string,
    skillId: string,
    expectedVersion: number
  ): Promise<{ skill_id: string; archived: boolean }> => {
    const me = await getCurrentUser();
    return skillPost<{ skill_id: string; archived: boolean }>('delete', {
      user_id: me.user_id,
      team_id: teamId,
      agent_id: agentId,
      skill_id: skillId,
      expected_version: expectedVersion,
    });
  },

  /** Full update of the SKILL.md content; needs owner agent_id + expected_version */
  update: async (
    teamId: string,
    agentId: string,
    skillId: string,
    expectedVersion: number,
    content: string
  ): Promise<SkillSummary> => {
    const me = await getCurrentUser();
    return skillPost<SkillSummary>('update', {
      user_id: me.user_id,
      team_id: teamId,
      agent_id: agentId,
      skill_id: skillId,
      expected_version: expectedVersion,
      content,
    });
  },

  /** Team-wide skill search */
  search: async (
    teamId: string,
    query: string,
    opts?: { topK?: number; scope?: 'team' }
  ): Promise<Array<SkillSummary & { score: number; snippet: string }>> => {
    const me = await getCurrentUser();
    const res = await skillPost<{ items: Array<SkillSummary & { score: number; snippet: string }> }>('search', {
      user_id: me.user_id,
      team_id: teamId,
      query,
      top_k: opts?.topK ?? 10,
      scope: opts?.scope ?? 'team',
    });
    return res.items;
  },

  /**
   * Fork a skill to an Agent -- copy an independent replica with `owner_agent_id` = the target agent.
   *
   * Why fork instead of meta authorization (acl/grant):
   *   - the "pinned assets" tab (SkillsPanel) filters its display by `owner_agent_id`;
   *   - the agent's runtime injection of `<available_skills>` (/skill/listing) likewise filters by
   *     `owner_agent_id`.
   *   Both reads key on `owner_agent_id`, while acl/grant only change the meta authorization layer and have no effect on either.
   *   So the only mechanism that truly makes a skill belong to an agent is copying a replica with owner = that agent.
   *
   * Naming: the replica keeps the **source skill's original name**, with no suffix. The skill uniqueness constraint is
   * (team_id, owner_agent_id, name): the same team allows multiple same-named replicas (under different agents),
   * but a duplicate name under the same agent is rejected by the backend (42201) -- the error is thrown upward for the caller to surface.
   *
   * Implementation: getSkill (source body + manifest) -> filesRead (each resource; a single failure is skipped) ->
   *       create (name = original name, agent_id = target agent as owner).
   */
  forkToAgent: async (
    teamId: string,
    sourceSkillId: string,
    targetAgentId: string
  ): Promise<SkillSummary> => {
    const detail = await skillApi.get(teamId, sourceSkillId);
    const resources: SkillResourcePayload[] = [];
    for (const entry of detail.manifest ?? []) {
      try {
        const f = await skillApi.filesRead(teamId, sourceSkillId, entry.path);
        resources.push({
          path: f.path,
          content: f.content,
          encoding: f.encoding,
          mime_type: f.mime_type || undefined,
          is_executable: entry.is_executable || undefined,
        });
      } catch {
        /* A single resource read failure is skipped and does not block the main fork flow */
      }
    }
    return skillApi.create(teamId, targetAgentId, {
      name: detail.name,
      content: detail.content,
      resources: resources.length ? resources : undefined,
      // Lineage: record which source skill this was forked from, so the replica can be traced back to the source and duplicate forks avoided.
      metadata: { forked_from: { skill_id: sourceSkillId, name: detail.name } },
    });
  },
};
