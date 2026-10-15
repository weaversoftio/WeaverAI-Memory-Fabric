/**
 * RouteGuards - route-level permission guards
 *
 * - ResourceGuard: admin role accessing resource pages -> redirect to the workbench
 * - MemberManageGuard: member role accessing the member management page -> redirect to the workbench
 */
import { type ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentRole, type TeamRole } from '@/services/useCurrentRole';

/** Resource management page guard: not visible to admin */
export function ResourceGuard({ children }: { children: ReactNode }) {
  const role = useCurrentRole();
  const navigate = useNavigate();
  const blocked = role === 'admin';

  useEffect(() => {
    if (blocked) navigate('/', { replace: true });
  }, [blocked, navigate]);

  return blocked ? null : <>{children}</>;
}

/** Member management guard: not visible to reviewer (visible to admin / member).
 *  A member can view the member list and add existing members, but the buttons for creating/deleting members and creating/deleting Teams
 *  are narrowed by role inside TeamManagementPanel. */
export function MemberManageGuard({ children, allowedRoles }: {
  children: ReactNode;
  allowedRoles?: TeamRole[];
}) {
  const role = useCurrentRole();
  const navigate = useNavigate();
  const allowed = allowedRoles ?? ['admin', 'member'];
  const blocked = role !== null && !allowed.includes(role);

  useEffect(() => {
    if (blocked) navigate('/', { replace: true });
  }, [blocked, navigate]);

  return blocked ? null : <>{children}</>;
}
