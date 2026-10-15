/**
 * UserName - unified display and fallback for "user_id -> username".
 *
 * The user/list batch resolution (useUserNames) may fail to resolve individual ids (internal accounts
 * filtered by the proxy layer / deleted users, etc.); the old logic rendered the bare user_id as text, which looked like a "missing
 * name". This component handles it uniformly:
 *   - Resolved -> render the username (tooltip carries the full user_id, to distinguish short strings of the same id)
 *   - Resolution failed -> render a muted "Unrecognized user" placeholder + tooltip with the full user_id,
 *     so the caller/user can get the id without showing the id as a name.
 *
 * Usage: just place it inside an existing container of the caller (plain-text cell / link button both work),
 * this component handles ellipsis and tooltip itself and no longer depends on the outer layer.
 */
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui';

export function UserName({
  userId,
  displayName,
}: {
  /** Raw user_id (used for tooltip display / fallback checks). */
  userId: string;
  /** Display name resolved by useUserNames; internally falls back to user_id when resolution fails. */
  displayName: string;
}) {
  const { t } = useTranslation();
  const resolved = displayName !== userId;
  return (
    <Text overflow tooltip={userId} theme={resolved ? undefined : 'weak'}>
      {resolved ? displayName : t('analytics.member.unrecognized')}
    </Text>
  );
}
