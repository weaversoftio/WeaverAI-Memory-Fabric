/**
 * useCurrentRole - get the role of the currently logged-in user
 *
 * Returns 'admin' | 'member' | 'reviewer' | null (null = not logged in).
 *
 * Role model (the single authoritative definition; do not change it back to "decide admin by the team member table"):
 *   - admin is a **global role**, unrelated to creating/joining any team (even with no team at all, it is always admin).
 *     An admin's duty is managing teams (creating teams, adding members), not managing concrete resources.
 *   - member is a **role within a team**, i.e. a member of some team, responsible for managing resources within the team (agent/skill/wiki/code/memory).
 *   - Therefore the order of checks must be: first check whether the user is a global admin; if not, then look up their member role in the active team.
 *     Doing it the other way around, "check the team member table first and treat not-found as no role", is wrong - it would cause an
 *     account with no team to be misjudged as non-admin (even null).
 */
import { useMemo } from 'react';
import { useTeams, roleInTeam, isGlobalAdmin } from '@/services';
import { useAuthStore } from '@/stores/auth';

export type TeamRole = 'admin' | 'member' | 'reviewer';

export function useCurrentRole(): TeamRole | null {
  const { auth } = useAuthStore();
  const { activeTeam } = useTeams();
  return useMemo(() => {
    if (!auth) return null;
    // Global admin: independent of team, always admin (does not depend on activeTeam / team.members lookup results)
    // isAdmin comes from auth/verify's user_type === 'system_admin' and is the single authoritative field.
    if (isGlobalAdmin(auth.user, auth.isAdmin)) return 'admin';
    // Non-admin: the role depends on their member record in the current active team (usually just 'member')
    return roleInTeam(activeTeam, auth.user_id);
  }, [activeTeam, auth]);
}
