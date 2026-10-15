/**
 * Panel Session - frontend session cache of the new panel (localStorage).
 *
 * Corresponds to docs/architecture/09-new-panel-control-backend-design.md section 3.3.2:
 * the new Panel Control is a stateless proxy and creates no Cookie/Session; the login credentials
 * (instance_id + user_key) are held by the frontend itself and cached in localStorage
 * (shared across tabs, not invalidated when a tab closes); every meta request reads them from here and injects Headers:
 *   - X-Wamf-Service-Id (= registry id = kernel x-wamf-service-id; early versions of the docs used
 *     the name `X-Metadata-Instance-Id`, which was renamed from meta-api.openapi.yaml v1.1.0,
 *     always follow the latest contract, otherwise Control reports 400 MISSING_INSTANCE_ID)
 *   - X-Wamf-User-Key (except auth/verify)
 *
 * It used sessionStorage (tab-level) before, which required logging in again in each new tab.
 * After switching to localStorage, the login state is shared across tabs, and logout syncs via the storage event.
 */
import type { PublicUser } from './teamApi';

export interface PanelSession {
  /** Auth source; the default value means a legacy user_key session. */
  authMethod?: 'user_key' | 'idp';
  /** = registry id = kernel x-wamf-service-id; determined when the login page selects an instance */
  instanceId: string;
  /** For display only (name in the instance list), not required */
  instanceName?: string;
  /** API key of a legacy user_key session; an IdP Session uses an empty string placeholder and never issues a real user_key. */
  userKey: string;
  /** auth/verify response data.user (optional, used for display + as the source of owner_user_id/creator_user_id) */
  user?: PublicUser;
}

const STORAGE_KEY = 'wamf-panel.session';

/** Read the current session; returns null if there is no session or parsing fails (no throw; callers treat it as not logged in) */
export function getPanelSession(): PanelSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PanelSession;
  } catch {
    return null;
  }
}

/** Write the session after a successful login (auth/verify returns valid===true) */
export function setPanelSession(session: PanelSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* Privacy mode / storage quota error: fail silently, without blocking the in-memory state for this session after login */
  }
}

/** Clear the session on logout / 401 fallback */
export function clearPanelSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
