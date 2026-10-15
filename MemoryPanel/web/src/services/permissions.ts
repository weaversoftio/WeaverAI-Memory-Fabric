/**
 * permissions.ts - the single authoritative implementation of global permission checks.
 *
 * Extracted from the original demoStore.ts. isGlobalAdmin is the only "global admin" check site-wide
 * (unrelated to the backend implementation of team/agent/task; a pure frontend auth state check).
 */

/**
 * Global admin check: an admin has all permissions and can see all content.
 *
 * The only authoritative source: `user.user_type === 'system_admin'` in the auth/verify response,
 * written by LoginGate into `AuthState.isAdmin` at login.
 *
 * The `username === 'admin'` string fallback is no longer kept - it is a leftover from the early demo stage
 * and would misjudge an ordinary user whose display_name / username happens to be "admin" as a global admin,
 * especially when "the user belongs to no team" or "the team has only themselves",
 * where roleInTeam returns null and the UI would render with admin logic (e.g. ResourcePage showing AdminResourceLock),
 * causing normal/member users to see the admin lock page.
 */
export function isGlobalAdmin(_currentUser: string, isAdminFlag?: boolean): boolean {
  return isAdminFlag === true;
}
