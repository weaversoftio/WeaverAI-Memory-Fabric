import type { Hono } from 'hono';
import type { MetaAction } from '../../../api/meta-actions.js';
import {
  ALLOWED_PANEL_ACTIONS,
  isNotInScopeAction,
} from '../../../api/meta-actions.js';
import type { PanelDeps } from '../../../panel-deps.js';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import type { MetaCallContext } from '../../../kernel/types.js';
import { KNOWLEDGE_SERVICE_USERNAME } from '../../../startup/ensure-knowledge-llm-binding.js';
import { DEFAULT_SKILLS } from './default-skills.js';
import {
  extractListItems,
  isCallerSystemAdmin,
  isCallerTeamAdmin,
  resolveCallerUserId,
} from '../knowledge/common.js';
import {
  getAgentTemplate as readTemplateFile,
  saveAgentTemplate as writeTemplateFile,
  type AgentTemplateConfig,
} from '../../../state/agent-template-store.js';

/**
 * Hide the internal per-instance `knowledge-service` billing user from panel user
 * listings (design 009 §4.2). Mutates the envelope's paginated `items`/`total` in place.
 */
function hideKnowledgeServiceUser(data: unknown): void {
  if (!data || typeof data !== 'object') return;
  const d = data as { items?: Array<{ username?: string }>; total?: number };
  if (!Array.isArray(d.items)) return;
  const before = d.items.length;
  d.items = d.items.filter((u) => u.username !== KNOWLEDGE_SERVICE_USERNAME);
  const removed = before - d.items.length;
  if (removed > 0 && typeof d.total === 'number') {
    d.total = Math.max(0, d.total - removed);
  }
}

function readAction(path: string): string {
  const marker = '/meta/';
  const idx = path.indexOf(marker);
  if (idx < 0) return '';
  return path.slice(idx + marker.length);
}

// -- Duplicate name check on create --

interface DupCheckConfig {
  /** The list action used for the duplicate check. */
  listAction: string;
  /** Build the list request body from the create body (restricting the visible scope). */
  listBody: (body: Record<string, unknown>) => Record<string, unknown>;
  /** Name of the exact-match filter parameter added in the kernel. */
  filterParam: string;
  /** Extract the value to match from the create body. */
  matchValue: (body: Record<string, unknown>) => string | undefined;
  /** Entity name, used in the error message. */
  entityLabel: string;
}

const DUP_CHECK_MAP: Record<string, DupCheckConfig> = {
  'user/create': {
    listAction: 'user/list',
    listBody: () => ({}),
    filterParam: 'username',
    matchValue: (b) => (typeof b.username === 'string' ? b.username : undefined),
    entityLabel: 'user',
  },
  // Sibling of user/create: the duplicate check is exactly the same as user/create (first an exact list by username).
  // A duplicate user_key is backstopped by the kernel's duplicate_user_key(409); the Panel passes it through directly.
  'user/create-with-key': {
    listAction: 'user/list',
    listBody: () => ({}),
    filterParam: 'username',
    matchValue: (b) => (typeof b.username === 'string' ? b.username : undefined),
    entityLabel: 'user',
  },
  'team/create': {
    listAction: 'team/list',
    listBody: (b) => ({ user_id: b.owner_user_id }),
    filterParam: 'name',
    matchValue: (b) => (typeof b.name === 'string' ? b.name : undefined),
    entityLabel: 'team',
  },
  'agent/create': {
    listAction: 'agent/list',
    // The panel "delete" goes through agent/archive (status -> inactive), and the list only shows active;
    // the duplicate check must filter the same way, otherwise re-creating a same-named agent after archiving would be wrongly blocked with 409.
    listBody: (b) => ({ team_id: b.team_id, owner_user_id: b.owner_user_id, status: 'active' }),
    filterParam: 'name',
    matchValue: (b) => (typeof b.name === 'string' ? b.name : undefined),
    entityLabel: 'Agent',
  },
  'task/create': {
    listAction: 'task/list',
    // The panel deletes a Task via a physical task/delete; completed tasks are still visible in the workbench, so the duplicate check covers all statuses.
    listBody: (b) => ({ team_id: b.team_id, creator_user_id: b.creator_user_id }),
    filterParam: 'title',
    matchValue: (b) => (typeof b.title === 'string' ? b.title : undefined),
    entityLabel: 'Task',
  },
};

/**
 * Do a "check first, then write" duplicate check for create-type actions.
 * Returns null if there is no duplicate; otherwise returns the error message.
 */
async function checkDuplicate(
  action: string,
  body: Record<string, unknown>,
  ctx: MetaCallContext,
  deps: PanelDeps,
): Promise<string | null> {
  const config = DUP_CHECK_MAP[action];
  if (!config) return null;

  const targetValue = config.matchValue(body);
  if (!targetValue) return null;

  const listBody = {
    ...config.listBody(body),
    [config.filterParam]: targetValue,
    limit: 1,
  };

  try {
    const envelope = await deps.metaKernel.invoke(config.listAction, listBody, ctx);
    if (envelope.code === 0) {
      // Rely on an exact same-name match among the returned items; some kernel versions may not support name filtering yet,
      // so a non-empty items list must not be misjudged as a duplicate.
      const data = envelope.data as { items?: unknown[] } | undefined;
      if (Array.isArray(data?.items)) {
        const duplicated = data.items.some((item) => {
          if (!item || typeof item !== 'object') return false;
          const value = (item as Record<string, unknown>)[config.filterParam];
          return typeof value === 'string' && value === targetValue;
        });
        if (duplicated) {
          return `A ${config.entityLabel} named "${targetValue}" already exists. Please choose another name and try again.`;
        }
      }
    }
  } catch {
    // If the duplicate check fails, let it through: better to allow a duplicate than wrongly block a normal create
  }
  return null;
}

// -- Route registration --

export function registerMetaProxyRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/meta/*', validatePanelMetaHeaders(deps), async (c) => {
    const action = readAction(c.req.path);
    if (!action) {
      return respondControlError(c, 404, 'UNKNOWN_META_ACTION');
    }

    if (isNotInScopeAction(action)) {
      return respondControlError(c, 501, 'NOT_IN_SCOPE');
    }

    if (!ALLOWED_PANEL_ACTIONS.has(action as MetaAction)) {
      return respondControlError(c, 404, 'UNKNOWN_META_ACTION');
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const panelMeta = c.get('panelMeta');
    const ctx: MetaCallContext = {
      instanceId: panelMeta.instanceId,
      gatewayEndpoint: panelMeta.gatewayEndpoint,
      gatewayApiKey: panelMeta.gatewayApiKey,
      userKey: panelMeta.userKey,
      reqId: c.get('reqId'),
    };

    // create-type actions: check for duplicates first
    const duplicateMsg = await checkDuplicate(action, body, ctx, deps);
    if (duplicateMsg) {
      return respondControlError(c, 409, duplicateMsg);
    }

    // -- Default Agent template read/write: the Panel reads/writes the local file directly (not forwarded to the kernel) --
    if (action === 'agent/set-default-template') {
      const teamIdForAuth = typeof body.team_id === 'string' ? body.team_id : '';
      const allowed =
        (await isCallerSystemAdmin(deps, ctx)) ||
        (await isCallerTeamAdmin(deps, ctx, teamIdForAuth));
      if (!allowed) {
        return respondControlError(c, 403, 'permission_denied');
      }
      const teamId = typeof body.team_id === 'string' ? body.team_id : '';
      const template = body.template;
      if (!teamId || !template || typeof template !== 'object') {
        return respondControlError(c, 400, 'INVALID_PARAM');
      }
      writeTemplateFile(deps.config.agentTemplateDir, ctx.instanceId, teamId, template as AgentTemplateConfig);
      return respondEnvelope(c, { code: 0, message: 'ok', request_id: ctx.reqId ?? '', data: { ok: true } });
    }
    if (action === 'agent/get-default-template') {
      const teamId = typeof body.team_id === 'string' ? body.team_id : '';
      const template = teamId ? readTemplateFile(deps.config.agentTemplateDir, ctx.instanceId, teamId) : null;
      return respondEnvelope(c, { code: 0, message: 'ok', request_id: ctx.reqId ?? '', data: template ?? {} });
    }

    const envelope = await deps.metaKernel.invoke(action, body, ctx);

    // After team-member/add succeeds, copy the template assets for the default Agent (best-effort, async, does not block the response)
    if (action === 'team-member/add' && envelope.code === 0) {
      void cloneDefaultAgentForNewMember(body, ctx, deps);
    }

    if (action === 'user/list' && envelope.code === 0) {
      hideKnowledgeServiceUser(envelope.data);
    }
    // After switching to private: the backend no longer actively prunes other agents' bindings.
    // Under the kernel permission model the caller can only set agents it owns; across owners it gets 403.
    // Leaving stale bindings is harmless too: injection / memory-bridge / the panel detail page filter out canBindAsset=false items on the read side by calling
    // apply_visibility_filter=true.
    return respondEnvelope(c, envelope);
  });
}

// -- After team-member/add succeeds: copy template assets for the default Agent (best-effort) --

// Default Agent preset fields (aligned with the kernel DEFAULT_AGENT_*, used to create default-agent when there is no template)
const DEFAULT_AGENT_NAME = 'default-agent';
const DEFAULT_AGENT_DESCRIPTION = 'Default assistant for general development tasks and day-to-day collaboration.';
const DEFAULT_AGENT_PROMPT = '';
const DEFAULT_AGENT_METADATA_JSON = JSON.stringify({
  ui: { role_prompt: '', rules_prompt: '' },
});

/**
 * With a template -> create a same-named Agent (owner = new user) -> copy the template assets (skill fork / code_graph, wiki allocate);
 * without a template -> create default-agent-{username} -> import preset Skills.
 */
async function cloneDefaultAgentForNewMember(
  body: Record<string, unknown>,
  ctx: MetaCallContext,
  deps: PanelDeps,
): Promise<void> {
  const userId = body.user_id as string | undefined;
  const teamId = body.team_id as string | undefined;
  if (!userId || !teamId) return;

  // 1. Read the local template file
  const template = readTemplateFile(deps.config.agentTemplateDir, ctx.instanceId, teamId);
  const hasTemplate = !!template?.name;

  // 2. Get username (to compose the default-agent name)
  const userEnv = await deps.metaKernel.invoke('user/get', { user_id: userId }, ctx);
  const user = userEnv.code === 0 ? (userEnv.data as { username?: string } | null) : null;
  const defaultAgentName = `${DEFAULT_AGENT_NAME}-${user?.username ?? userId}`;

  // 3. Decide the target Agent: same name with a template / default-agent without
  const agentName = hasTemplate ? template!.name : defaultAgentName;

  // 4. Idempotent duplicate check: if a same-named active agent exists, skip creating the agent itself
  const agentsEnv = await deps.metaKernel.invoke('agent/list', {
    team_id: teamId,
    owner_user_id: userId,
    limit: 50,
    offset: 0,
  }, ctx);
  const agents = agentsEnv.code === 0
    ? ((agentsEnv.data as { items?: Array<{ agent_id: string; name: string }> })?.items ?? [])
    : [];
  let defaultAgent = agents.find((a) => a.name === agentName);

  if (!defaultAgent) {
    // Create the agent itself (owner = new user; with a template use the template fields, without one use the default-agent preset fields)
    const createEnv = await deps.metaKernel.invoke('agent/create', {
      team_id: teamId,
      owner_user_id: userId,
      name: agentName,
      description: hasTemplate ? template!.description ?? null : DEFAULT_AGENT_DESCRIPTION,
      prompt: hasTemplate ? template!.prompt ?? '' : DEFAULT_AGENT_PROMPT,
      visibility: hasTemplate ? template!.visibility ?? 'team' : 'team',
      metadata_json: hasTemplate ? template!.metadata_json ?? '{}' : DEFAULT_AGENT_METADATA_JSON,
      status: 'active',
    }, ctx);
    if (createEnv.code !== 0) {
      deps.logger.warn('create default agent failed', {
        instanceId: ctx.instanceId, userId, teamId, agentName,
        code: createEnv.code, message: createEnv.message,
      });
      return;
    }
    defaultAgent = {
      agent_id: (createEnv.data as { agent_id: string }).agent_id,
      name: agentName,
    };
  }

  // 5. With a template -> copy assets; without -> import preset skills
  if (hasTemplate) {
    await cloneTemplateAssets(deps, ctx, userId, teamId, template!, defaultAgent.agent_id);
  } else {
    await importDefaultSkillsForNewMember(body, ctx, deps);
  }
}

/** Copy template assets: skill fork copies + code_graph/wiki allocate references. */
async function cloneTemplateAssets(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  teamId: string,
  template: AgentTemplateConfig,
  agentId: string,
): Promise<void> {
  // skills: fork independent copies
  for (const skillId of template.asset_ids?.skills ?? []) {
    try {
      await forkSkillToAgent(deps, ctx, userId, teamId, skillId, agentId);
    } catch (err) {
      deps.logger.warn('fork template skill failed', {
        instanceId: ctx.instanceId, skillId, agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // code_graph / wiki: allocate references
  const knowledgeIds: Array<{ assetId: string; assetType: string }> = [
    ...(template.asset_ids?.code_graphs ?? []).map((assetId) => ({ assetId, assetType: 'code_graph' })),
    ...(template.asset_ids?.wikis ?? []).map((assetId) => ({ assetId, assetType: 'llm_wiki' })),
  ];
  for (const k of knowledgeIds) {
    try {
      await allocateKnowledgeToAgent(deps, ctx, agentId, k.assetId, k.assetType);
    } catch (err) {
      deps.logger.warn('allocate template knowledge failed', {
        instanceId: ctx.instanceId, assetId: k.assetId, agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Fork a skill to the target agent (get -> files/read -> create), reusing the semantics of the frontend forkToAgent. */
async function forkSkillToAgent(
  deps: PanelDeps,
  ctx: MetaCallContext,
  userId: string,
  teamId: string,
  sourceSkillId: string,
  targetAgentId: string,
): Promise<void> {
  const getEnv = await deps.skillKernel.invoke('get', {
    user_id: userId,
    team_id: teamId,
    skill_id: sourceSkillId,
    include_content: true,
    include_manifest: true,
  }, ctx);
  if (getEnv.code !== 0) throw new Error(`skill get failed: ${getEnv.code}`);
  const detail = getEnv.data as {
    name: string;
    content: string;
    manifest?: Array<{ path: string; is_executable?: boolean }>;
  };

  const resources: Array<{
    path: string;
    content: string;
    encoding: string;
    mime_type?: string;
    is_executable?: boolean;
  }> = [];
  for (const entry of detail.manifest ?? []) {
    try {
      const fEnv = await deps.skillKernel.invoke('files/read', {
        user_id: userId,
        team_id: teamId,
        skill_id: sourceSkillId,
        path: entry.path,
      }, ctx);
      if (fEnv.code === 0) {
        const f = fEnv.data as { path: string; content: string; encoding: string; mime_type?: string };
        resources.push({
          path: f.path,
          content: f.content,
          encoding: f.encoding,
          mime_type: f.mime_type,
          is_executable: entry.is_executable,
        });
      }
    } catch {
      /* if reading a single resource fails, skip it */
    }
  }

  const createEnv = await deps.skillKernel.invoke('create', {
    user_id: userId,
    team_id: teamId,
    agent_id: targetAgentId,
    name: detail.name,
    content: detail.content,
    resources: resources.length ? resources : undefined,
    metadata: { forked_from: { skill_id: sourceSkillId, name: detail.name } },
  }, ctx);
  if (createEnv.code !== 0 && createEnv.code !== 42201) {
    throw new Error(`skill create failed: ${createEnv.code}`);
  }
}

/** Bind a knowledge asset (code_graph / wiki) reference to an agent (list -> append -> set). */
async function allocateKnowledgeToAgent(
  deps: PanelDeps,
  ctx: MetaCallContext,
  agentId: string,
  assetId: string,
  assetType: string,
): Promise<void> {
  const caller = await resolveCallerUserId(deps, ctx);
  const listEnv = await deps.metaKernel.invoke('agent-fixed-asset/list', { agent_id: agentId }, ctx);
  if (listEnv.code !== 0) return;
  const bindings = extractListItems<{
    asset_id: string;
    asset_type: string;
    injection_mode?: string;
    priority?: number;
    created_by?: string;
  }>(listEnv);
  if (bindings.some((b) => b.asset_id === assetId)) return; // already bound, skip idempotently

  const newBindings = [
    ...bindings.map((b) => ({
      asset_id: b.asset_id,
      asset_type: b.asset_type,
      injection_mode: b.injection_mode ?? 'summary',
      priority: b.priority ?? 50,
      created_by: b.created_by,
    })),
    { asset_id: assetId, asset_type: assetType, injection_mode: 'tool', priority: 50, created_by: caller },
  ];
  const setEnv = await deps.metaKernel.invoke('agent-fixed-asset/set', { agent_id: agentId, bindings: newBindings }, ctx);
  if (setEnv.code !== 0) {
    throw new Error(`agent-fixed-asset/set failed: ${setEnv.code}`);
  }
}

// -- After team-member/add succeeds: import preset Skills for default-agent --

async function importDefaultSkillsForNewMember(
  body: Record<string, unknown>,
  ctx: MetaCallContext,
  deps: PanelDeps,
): Promise<void> {
  try {
    const userId = body.user_id as string | undefined;
    const teamId = body.team_id as string | undefined;
    if (!userId || !teamId) return;

    // 1. Get user info (to get username for composing the agent name)
    const userEnv = await deps.metaKernel.invoke('user/get', { user_id: userId }, ctx);
    if (userEnv.code !== 0) return;
    const user = userEnv.data as { username?: string };
    const agentName = `default-agent-${user.username ?? userId}`;

    // 2. Look up default-agent
    const agentsEnv = await deps.metaKernel.invoke('agent/list', {
      team_id: teamId,
      owner_user_id: userId,
      limit: 50,
      offset: 0,
    }, ctx);
    if (agentsEnv.code !== 0) return;
    const agents = (agentsEnv.data as { items?: Array<{ agent_id: string; name: string }> })?.items ?? [];
    const defaultAgent = agents.find(a => a.name === agentName);
    if (!defaultAgent) {
      deps.logger.warn('default agent not found, skip skill import', {
        instanceId: ctx.instanceId, userId, teamId, agentName,
      });
      return;
    }

    // 3. Create preset Skills (relies on the kernel's unique name constraint for idempotency; 42201 is skipped directly)
    for (const skill of DEFAULT_SKILLS) {
      try {
        const createEnv = await deps.skillKernel.invoke('create', {
          user_id: userId,
          team_id: teamId,
          agent_id: defaultAgent.agent_id,
          name: skill.name,
          content: skill.content,
        }, ctx);
        if (createEnv.code === 0) {
          deps.logger.info(`default skill "${skill.name}" created`, {
            instanceId: ctx.instanceId,
            agentId: defaultAgent.agent_id,
          });
        } else if (createEnv.code !== 42201) {
          // 42201 = SKILL_NAME_DUPLICATE, ignore
          deps.logger.warn(`default skill "${skill.name}" create failed`, {
            instanceId: ctx.instanceId,
            code: createEnv.code,
            message: createEnv.message,
          });
        }
      } catch (err) {
        deps.logger.warn(`default skill "${skill.name}" create error`, {
          instanceId: ctx.instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    deps.logger.warn('import default skills for new member failed', {
      instanceId: ctx.instanceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
