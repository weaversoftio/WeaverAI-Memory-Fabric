/**
 * Kernel /v3/skill/* data-plane action list (14 entries, all POST).
 *
 * Reference doc: wamf-memory-openclaw-plugin/docs/skill-api-for-frontend.md
 *
 * Differences from /v3/meta/*:
 *   - the skill data plane has its own storage (skill_id prefix skl-); readable within the team, writable by the owner agent;
 *   - identity fields (user_id / team_id / agent_id / task_id) go in the body, not in Headers;
 *   - pagination uses nested pagination.{limit,offset}, not top-level limit/offset, so meta's
 *     sanitizeBody logic is not needed and the body is passed through as-is.
 */

/** Read operations (optional agent_id); used only for documentation here, passthrough does not distinguish them. */
export const SKILL_LIST_ACTIONS = new Set(['list', 'search', 'versions']);

export const SKILL_ACTIONS = [
  'create',
  'update',
  'patch',
  'delete',
  'get',
  'list',
  'search',
  'versions',
  'files/write',
  'files/remove',
  'files/read',
  'listing',
  'extract',
  'export',
  'conversation/add',
] as const;

export type SkillAction = (typeof SKILL_ACTIONS)[number];

export const ALLOWED_SKILL_ACTIONS = new Set<string>(SKILL_ACTIONS);

export function isAllowedSkillAction(action: string): action is SkillAction {
  return ALLOWED_SKILL_ACTIONS.has(action);
}
