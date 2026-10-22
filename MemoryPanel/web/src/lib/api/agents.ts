/**
 * api/agents.ts - Agent management (meta/agent/* + meta/agent-fixed-asset/*).
 */
import { getPanelSession } from '../panelSession';
import { metaPost, metaListAll, getCurrentUser, request, ApiError } from './base';
import type { MetaEnvelope, Agent, AssetType, AssetStatus, FixedAssetBinding } from './types';

// ========================= Default Agent template =========================

export interface AgentTemplateAssetIds {
  /** Team skill ID (skl-xxx) */
  skills?: string[];
  /** Team code graph ID (code-xxx) */
  code_graphs?: string[];
  /** Team wiki ID (wiki-xxx) */
  wikis?: string[];
}

/**
 * Default Agent template config (the template structure of agent/get-default-template / set-default-template).
 * Note:
 *   - asset_ids is a snapshot of team asset IDs; only public assets with visibility=team may be selected;
 *   - overwrite-style write: set must send back the complete template at once;
 *   - metadata_json is a JSON string; ui.role_prompt / ui.rules_prompt store the split prompts.
 */
export interface AgentTemplateConfig {
  name: string;
  description?: string | null;
  prompt?: string | null;
  /** 'private' (default for per-user default agents) | 'team' | 'restricted' */
  visibility?: string;
  metadata_json?: string;
  asset_ids?: AgentTemplateAssetIds;
}

export const agentsApi = {
  /**
   * List the agents under a team.
   *
   * @param teamId team ID
   * @param params.owner_user_id Optional: return only agents owned by this user ("agent private visibility" scenario,
   *   e.g. the fixed-asset tab of the Skill panel); omit to return all of the team. `agent/list` supports the
   *   `team_id + owner_user_id` combined filter.
   */
  list: (teamId: string, params?: { owner_user_id?: string }) =>
    metaListAll<Agent>('agent/list', {
      team_id: teamId,
      status: 'active',
      owner_user_id: params?.owner_user_id,
    }),

  /** Agent details */
  get: (agentId: string) => metaPost<Agent>('agent/get', { agent_id: agentId }),

  /** Create an agent */
  create: async (
    teamId: string,
    data: { name: string; description?: string; prompt?: string; visibility?: string }
  ) => {
    const me = await getCurrentUser();
    return metaPost<Agent>('agent/create', {
      team_id: teamId,
      owner_user_id: me.user_id,
      name: data.name,
      description: data.description,
      prompt: data.prompt,
      visibility: data.visibility ?? 'team',
    });
  },

  /**
   * Update an agent.
   *
   * `metadata_json` is a fallback channel for frontend-defined relations: display fields not yet in the backend schema
   * (UI-only fields such as icon / accent / linked user) can be serialized into a custom namespace here.
   */
  update: (
    agentId: string,
    data: {
      name?: string;
      description?: string;
      prompt?: string;
      visibility?: string;
      status?: string;
      metadata_json?: string;
    }
  ) => metaPost<Agent>('agent/update', { agent_id: agentId, ...data }),

  /**
   * Delete an agent: goes through the business route /api/v1/agent/delete-cascade.
   *
   * The route first runs skill/delete on all active skills with owner_agent_id = the current agent,
   * and only after all succeed calls meta/agent/archive; if any skill deletion fails it aborts and the agent is not archived,
   * throwing SKILL_DELETE_FAILED for the caller to show the user (the error data carries the deleted skill_ids
   * and the failed skill_id). On archive the backend also cleans up the chat_memory asset along the way.
   */
  delete: async (agentId: string) => {
    const session = getPanelSession();
    if (!session) {
      throw new ApiError(401, 'Unauthorized', 'no active panel session');
    }
    const envelope = await request<MetaEnvelope<{
      archived: boolean;
      agent_id: string;
      deleted_skill_count: number;
      deleted_skill_ids: string[];
    }>>('POST', '/api/v1/agent/delete-cascade', { agent_id: agentId }, {
      'X-Wamf-Service-Id': session.instanceId,
      'X-Wamf-User-Key': session.userKey,
    });
    if (envelope.code !== 0) {
      throw new ApiError(200, envelope.message, '', {
        code: envelope.code,
        requestId: envelope.request_id,
        rawMessage: envelope.message,
      });
    }
  },

  /** Get the aggregated asset view of an agent (binding + asset details).
   *  Uses metaListAll to page through everything (list-with-detail defaults to limit 20, so many bound assets would be truncated).
   *
   *  applyVisibilityFilter: default true (hides privatized bindings, for normal display).
   *  When the owner manages their own assets, pass false - otherwise the owner's own private skill
   *  would be filtered out by the endpoint, so the fixed tab cannot get its visibility and the share/private toggle disappears. */
  getAssets: async (agentId: string, applyVisibilityFilter = true) => {
    const items = await metaListAll<{
      asset_id: string;
      asset_type: AssetType;
      name: string;
      description?: string;
      status: AssetStatus;
      visibility: string;
      injection_mode: FixedAssetBinding['injection_mode'];
      priority: number;
      created_at: string;
    }>('agent-fixed-asset/list-with-detail', {
      agent_id: agentId,
      apply_visibility_filter: applyVisibilityFilter,
      touch_usage: false,
    });
    return items.map((item) => ({
      asset_id: item.asset_id,
      asset_type: item.asset_type,
      name: item.name,
      description: item.description,
      status: item.status,
      visibility: item.visibility,
      injection_mode: item.injection_mode ?? 'direct',
      priority: item.priority,
      created_at: item.created_at,
    }));
  },

  /** Get the agent's fixed-asset bindings (binding fields only) */
  getFixedAssets: async (agentId: string) => {
    const rows = await metaListAll<{
      asset_id: string;
      asset_type: AssetType;
      injection_mode?: FixedAssetBinding['injection_mode'];
      priority: number;
    }>('agent-fixed-asset/list', { agent_id: agentId });
    return rows.map((r) => ({
      asset_id: r.asset_id,
      asset_type: r.asset_type,
      injection_mode: r.injection_mode,
      priority: r.priority,
    }));
  },

  /** Set the agent's fixed assets in full */
  setFixedAssets: async (agentId: string, bindings: FixedAssetBinding[]) => {
    const me = await getCurrentUser();
    await metaPost<{ ok: boolean }>('agent-fixed-asset/set', {
      agent_id: agentId,
      bindings: bindings.map((b) => ({
        asset_id: b.asset_id,
        asset_type: b.asset_type,
        injection_mode: b.injection_mode ?? 'direct',
        priority: b.priority ?? 0,
        created_by: me.user_id,
      })),
    });
  },

  /**
   * Read the default Agent template of the current team (isolated by instance x team, no permission check).
   * When not configured the backend returns `{}`; callers check whether `data.name` exists to decide "not configured".
   */
  getDefaultTemplate: (teamId: string) =>
    metaPost<AgentTemplateConfig>('agent/get-default-template', { team_id: teamId }),

  /**
   * Configure/overwrite the default Agent template of the current team (system_admin only, otherwise 403 permission_denied).
   * Overwrite-style write: the complete template must be sent back at once.
   */
  setDefaultTemplate: (teamId: string, template: AgentTemplateConfig) =>
    metaPost<{ ok: boolean }>('agent/set-default-template', { team_id: teamId, template }),

  // ── Cross-team agent share ──

  /** List teams this agent has been shared to. */
  listShares: (agentId: string) =>
    metaListAll<AgentShare>('agent-share/list', { agent_id: agentId }),

  /** Grant another team access to use this agent (caller must be owner/home-team admin and a member of the target team). */
  grantShare: async (agentId: string, targetTeamId: string) => {
    const me = await getCurrentUser();
    return metaPost<AgentShare>('agent-share/grant', {
      agent_id: agentId,
      target_team_id: targetTeamId,
      granted_by: me.user_id,
    });
  },

  /** Revoke a cross-team share by share id. */
  revokeShare: (shareId: string) =>
    metaPost<{ ok: boolean }>('agent-share/revoke', { id: shareId }),
};

export interface AgentShare {
  id: string;
  agent_id: string;
  home_team_id: string;
  target_team_id: string;
  granted_by: string;
  created_at: string;
  updated_at: string;
}
