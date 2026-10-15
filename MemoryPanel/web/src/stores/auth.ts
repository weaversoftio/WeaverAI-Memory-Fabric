/**
 * Auth Store (zustand)
 *
 * Talks to the new panel Control (no Cookie, stateless proxy, see design doc 09 section 3.3).
 * Login credentials (instance_id + user_key) are cached in localStorage (lib/panelSession.ts);
 * "log out" / "session expired" both just clear the local cache - Control has no logout API and no server-side session table.
 *
 * Multi-tab sync: listen for localStorage changes via the storage event.
 *   - Another tab logs in -> this tab automatically restores the login state (checkSession)
 *   - Another tab logs out / 401 -> this tab automatically exits to LoginGate
 *
 * Three auth states:
 *   - null      detecting login state (the App calls checkSession on startup to read the localStorage cache)
 *   - undefined confirmed not logged in -> render LoginGate
 *   - AuthState logged in -> render the main UI
 */
import { create } from 'zustand';
import { readAuth, clearAuth, resumeSession, type AuthState } from '@/components/LoginGate';
import { authMethodsApi, onUnauthorized } from '@/lib/teamApi';
import { getPanelSession } from '@/lib/panelSession';
import { clearBackendCache, writeActiveTeamId } from '@/services';

const PANEL_SESSION_KEY = 'wamf-panel.session';

interface AuthStore {
  auth: AuthState | null | undefined;
  /** Written after a successful login (LoginGate's onLoggedIn callback) */
  setAuth: (auth: AuthState) => void;
  /** Log out: clear the local localStorage session and return to LoginGate (no backend call) */
  logout: () => Promise<void>;
  /** Read the localStorage cache on App startup; whatever the result, auth advances from null to a definite state */
  checkSession: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  auth: null,

  setAuth: (auth) => {
    set({ auth });
  },

  logout: async () => {
    // The new panel has no server-side session; logout just clears the local cache, with no (and no need for a) backend logout endpoint.
    // Clear the module-level backend cache (teams/agents/tasks) so a new user does not briefly see the previous user's lists after logging in.
    // Use clearBackendCache instead of invalidateBackendCache: the latter broadcasts an event that triggers the mounted pages'
    // refetch listeners, which would still issue requests with the old session Header and pull the old data back;
    // here we only clear the cache, so the new user's mounted components do a normal first fetch after login.
    clearBackendCache();
    // activeTeamId may point to a team only the old user had access to; clear it so the new user does not end up with a team they have no permission for.
    writeActiveTeamId(null);
    // SSO sessions live in an HttpOnly cookie: clearing local state alone would sign the user
    // straight back in, so hand off to the backend, which also ends the IdP session.
    const idp = getPanelSession()?.authMethod === 'idp';
    clearAuth();
    if (idp) {
      authMethodsApi.logoutIdp();
      return;
    }
    set({ auth: undefined });
  },

  checkSession: async () => {
    const cached = readAuth();
    if (cached) {
      set({ auth: cached });
      return;
    }
    const auth = await resumeSession();
    set({ auth: auth ?? undefined });
  },
}));

/**
 * Cross-tab sync: listen for the localStorage storage event.
 *
 * The storage event fires only when "another tab" modifies localStorage (this tab's own writes do not trigger it),
 * which is ideal for cross-tab state sync.
 *
 *   - Another tab logs in (writes wamf-panel.session) -> this tab restores the login state
 *   - Another tab logs out / 401 (deletes wamf-panel.session) -> this tab exits to LoginGate
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== PANEL_SESSION_KEY) return;

    if (e.newValue === null) {
      // Another tab logged out -> this tab exits in sync
      clearBackendCache();
      writeActiveTeamId(null);
      clearAuth();
      useAuthStore.setState({ auth: undefined });
    } else {
      // Another tab logged in -> this tab restores the login state
      void useAuthStore.getState().checkSession();
    }
  });
}

// When any meta request returns HTTP 401 (e.g. a Control validation error landing on that code), globally clear the session and return to the login page.
// In the new panel this is not the main logout trigger (active logout goes through logout()); it is only a safety net.
// Like logout(), clear the cache; otherwise after a 401 re-login the previous user's lists would still be briefly visible.
// It only needs to be registered once when the store module loads.
onUnauthorized(() => {
  clearBackendCache();
  writeActiveTeamId(null);
  clearAuth();
  useAuthStore.setState({ auth: undefined });
});
