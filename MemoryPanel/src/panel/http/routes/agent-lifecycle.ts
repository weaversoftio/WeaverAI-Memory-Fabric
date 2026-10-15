/**
 * /api/v1/agent/delete-cascade -- when deleting an agent, first cascade-clean the skills under that agent.
 *
 * Background (and the division of labor with the kernel's archiveAgent):
 *   - The kernel archiveAgent (metadata-service.ts) also archives the agent's own
 *     chat_memory asset in the same call + clears the bindings by which other agents borrow this memory; it ignores skills entirely.
 *   - Result: calling meta/agent/archive directly leaves dirty data: active
 *     skills with owner_agent_id = the deleted agent (the frontend filters by status only, so they seem gone but remain in the table).
 *
 * Approach of this route (business cascade is closed off in the control layer, the kernel is unchanged):
 *   1. auth/verify to look up the caller
 *   2. agent/get to fetch the agent, strictly check owner_user_id === caller (admin deletion on behalf of others is not allowed in this phase)
 *   3. skill/list, fully paginated by owner_agent_id + active
 *   4. skill/delete one by one -- abort immediately on any failure, return 500 + the deleted list + the failed skill_id
 *      + the kernel error message; agent/archive is not called then, and the caller must fix and retry
 *   5. after all skills are archived successfully, call meta/agent/archive
 *      -- the kernel also clears chat_memory in the same archive call (this part is unchanged)
 *
 * Why admin deletion on behalf of others is not done: the kernel skill/delete requires the caller to be the owner of the owner_agent;
 * admin deletion would need impersonation or the control layer obtaining the owner's user_key, which is out of scope for this phase.
 *
 * Frontend counterpart: agentsApi.delete must switch from meta/agent/archive to this route; to skip the cascade and use
 * the old logic (e.g. migration tools), keep calling /api/v1/meta/agent/archive directly (an escape hatch is retained).
 */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import type { MetaEnvelope } from '../../kernel/envelope.js';
import type { MetaCallContext } from '../../kernel/types.js';
import {
  buildCtx,
  extractListItems,
  okEnvelope,
  readJson,
  resolveCallerUserId,
  str,
} from './knowledge/common.js';

/** One page of skill/list is 100 entries -- aligned with the pagination step of knowledge fetchAllMetaListItems. */
const SKILL_LIST_PAGE = 100;

interface AgentRaw {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  status?: string;
  name?: string;
}

interface SkillRow {
  skill_id: string;
  version: number;
  owner_agent_id?: string;
}

/** Fetch all active skills under the agent via skill/list pagination. */
async function listAgentSkills(
  deps: PanelDeps,
  ctx: MetaCallContext,
  callerId: string,
  teamId: string,
  agentId: string,
): Promise<{ ok: true; items: SkillRow[] } | { ok: false; envelope: MetaEnvelope<unknown> }> {
  const all: SkillRow[] = [];
  let offset = 0;
  for (;;) {
    const env = await deps.skillKernel.invoke(
      'list',
      {
        user_id: callerId,
        team_id: teamId,
        agent_id: agentId,
        filters: { status: ['active'] },
        pagination: { limit: SKILL_LIST_PAGE, offset },
      },
      ctx,
    );
    if (env.code !== 0) return { ok: false, envelope: env };
    const batch = extractListItems<SkillRow>(env);
    all.push(...batch);
    const total = (env.data as { total?: number } | null)?.total ?? all.length;
    if (batch.length === 0 || all.length >= total) break;
    offset += SKILL_LIST_PAGE;
  }
  return { ok: true, items: all };
}

export function registerAgentLifecycleRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  api.post('/agent/delete-cascade', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const agentId = str(body, 'agent_id');
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');

    // 1. caller
    const callerId = await resolveCallerUserId(deps, ctx);
    if (!callerId) return respondControlError(c, 401, 'INVALID_USER_KEY');

    // 2. Strict check of agent + owner
    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
      return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    }
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw;
    if (agent.owner_user_id !== callerId) {
      return respondControlError(c, 403, 'NOT_YOUR_AGENT');
    }

    // 3. skill list
    const listRes = await listAgentSkills(deps, ctx, callerId, agent.team_id, agent.agent_id);
    if (!listRes.ok) return respondEnvelope(c, listRes.envelope);
    const skills = listRes.items;

    // 4. skill/delete one by one -- abort immediately on any failure; the agent is not archived
    const deletedIds: string[] = [];
    for (const s of skills) {
      const delEnv = await deps.skillKernel.invoke(
        'delete',
        {
          user_id: callerId,
          team_id: agent.team_id,
          agent_id: agent.agent_id,
          skill_id: s.skill_id,
          expected_version: s.version,
        },
        ctx,
      );
      if (delEnv.code !== 0) {
        return respondEnvelope(c, {
          code: 500,
          message: 'SKILL_DELETE_FAILED',
          request_id: c.get('reqId') ?? '',
          data: {
            failed_skill_id: s.skill_id,
            kernel_code: delEnv.code,
            kernel_message: delEnv.message,
            deleted_skill_ids: deletedIds,
          },
        });
      }
      deletedIds.push(s.skill_id);
    }

    // 5. agent/archive -- the kernel still clears chat_memory along the way
    const archiveEnv = await deps.metaKernel.invoke('agent/archive', { agent_id: agentId }, ctx);
    if (archiveEnv.code !== 0) return respondEnvelope(c, archiveEnv);

    return respondEnvelope(
      c,
      okEnvelope(c, {
        archived: true,
        agent_id: agentId,
        deleted_skill_count: deletedIds.length,
        deleted_skill_ids: deletedIds,
      }),
    );
  });
}
