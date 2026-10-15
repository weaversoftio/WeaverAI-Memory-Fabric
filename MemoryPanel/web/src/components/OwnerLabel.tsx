/**
 * OwnerLabel -- generic "asset Owner display" component.
 *
 * Previously Wiki (WikiOwnerLabel) and Code (CodeOwnerLabel) each implemented the identical
 * "@displayName + append a "You" marker for the current user" logic (both depend on the useUserDisplayName global
 * cache + a child-component structure, since under the Rules of Hooks a hook cannot be called in a loop inside .map).
 * It is unified here; title / youText / youClassName are injected by the caller to accommodate each page's i18n and styles.
 */
import { useUserDisplayName } from '@/services/user-profile-store';

export function OwnerLabel({
  userId,
  currentUserId,
  title,
  youText,
  youClassName,
}: {
  userId: string;
  currentUserId: string;
  /** hover tooltip text (the caller handles i18n, usually with a userId interpolation) */
  title: string;
  /** Text of the "You" marker (shown for the current user) */
  youText: string;
  /** class of the "You" marker (each page can inject its own style class) */
  youClassName?: string;
}) {
  const name = useUserDisplayName(userId);
  return (
    <span title={title}>
      @{name || userId}
      {userId === currentUserId && (
        <span className={youClassName ?? '_owner-label-you'}>{youText}</span>
      )}
    </span>
  );
}
