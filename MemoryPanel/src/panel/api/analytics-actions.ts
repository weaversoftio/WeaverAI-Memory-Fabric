/**
 * Kernel /v3/analytics/* query-plane action list (Core: 16 entries).
 *
 * Reference doc: iwiki 4036925405 "Team Memory Observability Analytics Query API".
 * The data source is four tables in the MemoryCore-side ClickHouse (database: context_proxy):
 * usage_logs / usage_raw / session_init_logs / tool_call_logs.
 *
 * Differences from /v3/meta/* and /v3/skill/*:
 *   - the method is not uniform: config / spaces are GET, the other 14 are POST (wrong method -> 405);
 *   - everything except config requires system_admin (checked by the kernel's authenticateV3); ordinary members get 403;
 *   - when CH is not configured, everything except config returns 503 (config returns configured:false);
 *   - filter dimensions are space_id / user_id (team_id is not supported), and the time window is days or from/to.
 *
 * This phase only wires up the "metrics + trace" query plane; watermark / detail-fetch are kept in the list
 * (reused later by the recall incremental pipeline) and the page does not call them directly.
 */

/** GET-type actions -- the kernel declares them as GET; they must be forwarded with GET, otherwise 405. */
export const ANALYTICS_GET_ACTIONS = new Set(['config', 'spaces']);

export const ANALYTICS_ACTIONS = [
  // Meta info
  'config',
  'spaces',
  // Session initialization / penetration rate
  'session-init/summary',
  'session-init/timeseries',
  'session-init/bypass-reasons',
  // Tool call behavior
  'tool-calls/endpoint-share',
  'tool-calls/top-bodies',
  'tool-calls/timeseries',
  'tool-calls/list',
  'tool-calls/watermark',
  'tool-calls/detail-fetch',
  // Token / Credit usage
  'usage/summary',
  'usage/timeseries',
  'usage/by-model',
  'usage/list',
  'usage-raw/list',
] as const;

export type AnalyticsAction = (typeof ANALYTICS_ACTIONS)[number];

export const ALLOWED_ANALYTICS_ACTIONS = new Set<string>(ANALYTICS_ACTIONS);

export function isAllowedAnalyticsAction(action: string): action is AnalyticsAction {
  return ALLOWED_ANALYTICS_ACTIONS.has(action);
}

/** Whether the action uses GET (otherwise POST). */
export function isAnalyticsGetAction(action: string): boolean {
  return ANALYTICS_GET_ACTIONS.has(action);
}
