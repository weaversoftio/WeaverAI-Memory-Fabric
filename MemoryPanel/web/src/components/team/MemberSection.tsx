/**
 * MemberSection - team member list: one row per person with their team role (editable by team admins)
 * and a "..." menu for platform-admin access / removal.
 * AddMemberDialog / CreatedUserKeyModal - dialogs for adding an existing user / creating a new user.
 */

import { useEffect, useState } from 'react';
import { Alert, Button, Copy, Dropdown, Form, Input, List, Modal, Segment, Select, Switch, Tag } from '@/components/ui';
import { useTranslation } from 'react-i18next';
import { AddIcon, MoreIcon } from '@/components/ui/icons';
import { isTeamAdmin, invalidateBackendCache, type Team } from '@/services';
import { isInstanceAdminType } from '@/services/permissions';
import { membersApi, usersApi } from '@/lib/teamApi';
import { feedback } from '@/lib/feedback';
import { canRemoveMember } from './types';

// =================== Members section ===================

export function MemberSection({
  team,
  currentUser,
  onAdd,
  isAdmin: _globalAdmin,
}: {
  team: Team;
  currentUser: string;
  onAdd: () => void;
  isAdmin: boolean;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** user_id -> user_type, loaded for admins so they can see / toggle who is an admin. */
  const [userTypes, setUserTypes] = useState<Record<string, string>>({});
  const { t } = useTranslation();
  // Only global admin or team admin/owner can add members; regular members have no such entry.
  const canAddMember = _globalAdmin || isTeamAdmin(team, currentUser);
  const memberIds = team.members.map((m) => m.user_id).join(',');

  useEffect(() => {
    if (!_globalAdmin || !memberIds) return;
    let cancelled = false;
    void usersApi
      .list({ user_ids: memberIds.split(',').slice(0, 100) })
      .then((users) => {
        if (cancelled) return;
        setUserTypes(Object.fromEntries(users.map((u) => [u.user_id, String(u.user_type ?? 'normal')])));
      })
      .catch(() => {
        /* badge is best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [_globalAdmin, memberIds]);

  async function handleRoleChange(userId: string, role: 'admin' | 'member' | 'reviewer') {
    setBusy(userId);
    try {
      await membersApi.setRole(team.team_id, userId, role);
      invalidateBackendCache();
      feedback.notify.success(t('member.role.changed'));
    } catch (err) {
      feedback.notify.error(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleToggleAdmin(userId: string, name: string, makeAdmin: boolean) {
    const ok = await feedback.confirm({
      message: makeAdmin ? t('member.admin.grant.confirm', { userId: name }) : t('member.admin.revoke.confirm', { userId: name }),
      description: makeAdmin ? t('member.admin.grant.desc') : t('member.admin.revoke.desc'),
      okText: makeAdmin ? t('member.admin.grant') : t('member.admin.revoke'),
    });
    if (!ok) return;
    setBusy(userId);
    try {
      const updated = await usersApi.setAdmin(userId, makeAdmin);
      setUserTypes((prev) => ({ ...prev, [userId]: String(updated?.user_type ?? (makeAdmin ? 'admin' : 'normal')) }));
    } catch (err) {
      feedback.notify.error(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove(userId: string, name: string) {
    const ok = await feedback.confirm({
      message: t('member.remove.confirm', { userId: name }),
      description: t('member.remove.desc'),
      okText: t('member.remove.ok'),
    });
    if (!ok) return;
    setRemoving(userId);
    try {
      await membersApi.remove(team.team_id, userId);
      invalidateBackendCache();
    } catch (err) {
      feedback.notify.error(err);
    } finally {
      setRemoving(null);
    }
  }

  const nameOf = (userId: string) =>
    team.members.find((m) => m.user_id === userId)?.username?.trim() || userId;

  return (
    <div className="_memory-panel-card">
      <div className="_memory-section-header">
        <div className="_memory-section-header-info">
          <div className="_memory-section-header-title-row">
            <div className="_memory-section-title">{t('member.title', { count: team.members.length })}</div>
          </div>
          <div className="_memory-section-subtitle">{t('member.subtitle.simple', { name: team.name })}</div>
        </div>
        {canAddMember && (
          <Button type="primary" onClick={onAdd} title={t('member.add.tooltip')} data-guide="add-member">
            <AddIcon size={14} /> {t('member.add')}
          </Button>
        )}
      </div>

      {/* One-line role legend: what each team role can do */}
      <div className="_memory-member-legend">
        {(['member', 'admin', 'reviewer'] as const).map((r) => (
          <span key={r} className="_memory-member-legend-item">
            <strong>{t(`member.role.${r}`)}</strong> {t(`member.role.${r}.short`)}
          </span>
        ))}
      </div>

      <div className="_memory-member-list" data-guide="members-list">
        {team.members.map((m) => {
          const isOwner = team.owner_user_id === m.user_id;
          const isMe = m.user_id === currentUser;
          const userType = userTypes[m.user_id];
          return (
            <MemberRow
              key={m.user_id}
              user_id={m.user_id}
              username={m.username}
              role={m.role}
              isOwner={isOwner}
              isMe={isMe}
              canRemove={canRemoveMember(team, m.user_id, currentUser, _globalAdmin)}
              busy={busy === m.user_id || removing === m.user_id}
              onRemove={() => void handleRemove(m.user_id, nameOf(m.user_id))}
              canChangeRole={canAddMember && !isOwner && !isMe}
              onRoleChange={(role) => void handleRoleChange(m.user_id, role)}
              isPlatformAdmin={isInstanceAdminType(userType)}
              canTogglePlatformAdmin={_globalAdmin && !isMe && !!userType && userType !== 'system_admin'}
              onTogglePlatformAdmin={() =>
                void handleToggleAdmin(m.user_id, nameOf(m.user_id), !isInstanceAdminType(userType))
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function MemberRow({
  user_id,
  username,
  role,
  isOwner,
  isMe,
  canRemove,
  busy,
  onRemove,
  canChangeRole,
  onRoleChange,
  isPlatformAdmin,
  canTogglePlatformAdmin,
  onTogglePlatformAdmin,
}: {
  user_id: string;
  username?: string;
  role: 'admin' | 'member' | 'reviewer';
  isOwner: boolean;
  isMe: boolean;
  canRemove: boolean;
  busy: boolean;
  onRemove: () => void;
  canChangeRole: boolean;
  onRoleChange: (role: 'admin' | 'member' | 'reviewer') => void;
  isPlatformAdmin: boolean;
  canTogglePlatformAdmin: boolean;
  onTogglePlatformAdmin: () => void;
}) {
  const { t } = useTranslation();
  const displayName = username?.trim() || user_id;
  const hasMenu = canTogglePlatformAdmin || canRemove;

  return (
    <div className="_memory-member-row">
      <div className={`_memory-member-avatar${isOwner ? ' _memory-member-avatar--owner' : ''}`}>
        {displayName.slice(0, 2).toUpperCase()}
      </div>

      <div className="_memory-member-info">
        <div className="_memory-member-name-row">
          <span className="_memory-member-id">{displayName}</span>
          {isMe && <span className="_memory-member-me-tag">{t('member.me')}</span>}
          {isOwner && (
            <Tag size="sm" title={t('member.owner.desc')}>
              {t('member.owner')}
            </Tag>
          )}
          {isPlatformAdmin && (
            <Tag size="sm" theme="primary" title={t('member.admin.badge.desc')}>
              {t('member.admin.badge')}
            </Tag>
          )}
        </div>
        {username?.trim() && <div className="_memory-member-subid">{user_id}</div>}
      </div>

      <div className="_memory-member-role-cell" title={t(`member.role.${role}.desc`)}>
        {canChangeRole ? (
          <Select
            size="m"
            value={role}
            disabled={busy}
            onChange={(v) => {
              if (v !== role) onRoleChange(v as 'admin' | 'member' | 'reviewer');
            }}
            options={(['member', 'admin', 'reviewer'] as const).map((r) => ({
              value: r,
              text: t(`member.role.${r}`),
              tooltip: t(`member.role.${r}.desc`),
            }))}
          />
        ) : (
          <span className="_memory-member-role-text">{t(`member.role.${role}`)}</span>
        )}
      </div>

      <div className="_memory-member-actions">
        {hasMenu ? (
          <Dropdown
            appearance="pure"
            placement="bottom-end"
            disabled={busy}
            button={
              <button type="button" className="_memory-member-more-btn" aria-label={t('member.actions')} title={t('member.actions')}>
                <MoreIcon size={16} />
              </button>
            }
          >
            {(close) => (
              <List type="option">
                {canTogglePlatformAdmin && (
                  <List.Item
                    onClick={() => {
                      close();
                      onTogglePlatformAdmin();
                    }}
                  >
                    {isPlatformAdmin ? t('member.admin.revoke') : t('member.admin.grant')}
                  </List.Item>
                )}
                {canRemove && (
                  <List.Item
                    onClick={() => {
                      close();
                      onRemove();
                    }}
                  >
                    <span style={{ color: 'var(--wf-color-text-error-default)' }}>{t('member.remove.menu')}</span>
                  </List.Item>
                )}
              </List>
            )}
          </Dropdown>
        ) : (
          <span className="_memory-member-more-placeholder" />
        )}
      </div>
    </div>
  );
}

// =================== Add/create member dialog ===================

/**
 * Add user - two modes:
 *   - Add an existing user: join the team by a known user_id
 *   - Create a new user and join the team: call meta/user/create to create the user account, then automatically join the team
 */
export function AddMemberDialog({
  team,
  onClose,
  onCreatedUser,
  currentUser,
  isAdmin: _globalAdmin,
}: {
  team: Team;
  onClose: () => void;
  /** After the new user is created, call back the parent to show the initial API Key */
  onCreatedUser?: (info: { username: string; userId: string; keyValue: string }) => void;
  currentUser: string;
  isAdmin: boolean;
}) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'admin' | 'member' | 'reviewer'>('member');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { t } = useTranslation();

  // New-user form
  const [newUsername, setNewUsername] = useState('');
  // Custom user_key switch (only effective in create-user mode): default off -> kernel auto-generates; on -> use user/create-with-key
  const [customKeyEnabled, setCustomKeyEnabled] = useState(false);
  const [customKey, setCustomKey] = useState('');

  const canGrantAdmin = isTeamAdmin(team, currentUser) || _globalAdmin;
  // user/create requires system_admin permission (see docs/api/metadata-api.md section 1.4),
  // non-global admins calling it always get 403 - so the "create user" option is hidden here, rather than failing after the user acts.
  const canCreateUser = _globalAdmin;



  async function submitExisting() {
    const id = userId.trim();
    if (!id) {
      setError(t('addMember.error.emptyId'));
      return;
    }
    if (id === currentUser) {
      setError(t('addMember.error.self'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await membersApi.add(team.team_id, { user_id: id, role });
      invalidateBackendCache();
      onClose();
    } catch (err) {
      feedback.notify.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitNew() {
    const username = newUsername.trim();
    if (!username) {
      setError(t('addMember.error.emptyName'));
      return;
    }
    // Username may only contain English letters, digits and underscores (consistent with the backend user_id segment validation rule)
    if (!/^[A-Za-z0-9_]+$/.test(username)) {
      setError(t('addMember.error.invalidName'));
      return;
    }
    // In custom key mode, additionally validate that user_key is non-empty
    const trimmedKey = customKey.trim();
    if (customKeyEnabled && !trimmedKey) {
      setError(t('addMember.error.emptyKey'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Step 1: create the user
      //   - By default use meta/user/create (kernel auto-generates default_user_key)
      //   - With "custom user_key" on -> use meta/user/create-with-key, handing the key to the kernel as the default key
      const created = customKeyEnabled
        ? await usersApi.createWithKey({ username, user_key: trimmedKey })
        : await usersApi.create({
            username,
            auth_provider: 'api_key',
            external_id: username,
          });
      const keyValue = created.default_user_key ?? '';
      // Step 3: automatically join the current team
      await membersApi.add(team.team_id, { user_id: created.user_id, role });
      invalidateBackendCache();
      // Step 4: close the add dialog and let the parent show the key dialog via callback
      onClose();
      onCreatedUser?.({
        username,
        userId: created.user_id,
        keyValue,
      });
    } catch (err) {
      feedback.notify.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    mode === 'existing'
      ? userId.trim().length > 0
      : newUsername.trim().length > 0 &&
        /^[A-Za-z0-9_]+$/.test(newUsername.trim()) &&
        (!customKeyEnabled || customKey.trim().length > 0);

  async function handleSubmit() {
    if (mode === 'existing') await submitExisting();
    else await submitNew();
  }

  return (
    <Modal
      visible
      caption={<>{t('addMember.caption', { name: team.name })}<Tag size="sm">{team.team_id}</Tag></>}
      size="m"
      onClose={onClose}
      disableEscape={submitting}
    >
      <Modal.Body>
        {!canGrantAdmin && <Alert type="info">{t('addMember.adminOnlyHint')}</Alert>}
        <Form>
      <Form.Item label={t('addMember.mode')}>
        {canCreateUser ? (
          <Segment
            value={mode}
            onChange={(v) => {
              setMode(v as 'existing' | 'new');
              setError(null);
              if (v === 'new') setRole('member');
            }}
            options={[
              { value: 'existing', text: t('addMember.mode.existing') },
              { value: 'new', text: t('addMember.mode.new') },
            ]}
          />
        ) : (
          <div className="_memory-field-hint">
            {t('addMember.mode.hint')}
          </div>
        )}
      </Form.Item>

      {mode === 'existing' ? (
        <Form.Item label={t('addMember.userId')}>
          <div>
            <Input
              autoFocus
              size="full"
              value={userId}
              onChange={(v) => {
                setUserId(v);
                setError(null);
              }}
              onPressEnter={() => void handleSubmit()}
              placeholder={t('addMember.userId.placeholder')}
            />
            <div className="_memory-field-hint">{t('addMember.userId.hint')}</div>
          </div>
        </Form.Item>
      ) : (
        <>
          <Form.Item label={t('addMember.username')} required>
            <div>
              <Input
                autoFocus
                size="full"
                value={newUsername}
                onChange={(v) => {
                  setNewUsername(v);
                  setError(null);
                }}
                onPressEnter={() => void handleSubmit()}
                placeholder={t('addMember.username.placeholder')}
              />
              {newUsername.trim() && !/^[A-Za-z0-9_]+$/.test(newUsername.trim()) ? (
                <div className="_memory-field-hint" style={{ color: 'var(--wf-color-text-error-default)' }}>
                  {t('addMember.username.invalid')}
                </div>
              ) : (
                <div className="_memory-field-hint">{t('addMember.username.hint')}</div>
              )}
            </div>
          </Form.Item>

          {/*
            Custom user_key switch:
            - Off (default): use user/create, kernel auto-generates default_user_key (existing behavior)
            - On: use user/create-with-key, with the user-specified key as the default key
          */}
          <Form.Item label={t('addMember.customKey.label')}>
            <div>
              <Switch
                value={customKeyEnabled}
                onChange={(v) => {
                  setCustomKeyEnabled(v);
                  setError(null);
                  if (!v) setCustomKey('');
                }}
              />
              <div className="_memory-field-hint">{t('addMember.customKey.hint')}</div>
            </div>
          </Form.Item>

          {customKeyEnabled && (
            <Form.Item label={t('addMember.customKey.value')} required>
              <div>
                <Input
                  size="full"
                  value={customKey}
                  onChange={(v) => {
                    setCustomKey(v);
                    setError(null);
                  }}
                  onPressEnter={() => void handleSubmit()}
                  placeholder={t('addMember.customKey.placeholder')}
                />
                <div className="_memory-field-hint">{t('addMember.customKey.valueHint')}</div>
              </div>
            </Form.Item>
          )}
        </>
      )}

      <Form.Item label={t('addMember.role')}>
        <Select
          size="full"
          value={role}
          disabled={!canGrantAdmin}
          onChange={(v) => setRole((v as 'admin' | 'member' | 'reviewer') || 'member')}
          options={
            canGrantAdmin
              ? [
                  { value: 'member', text: t('member.role.member'), tooltip: t('member.role.member.desc') },
                  { value: 'admin', text: t('member.role.admin'), tooltip: t('member.role.admin.desc') },
                  { value: 'reviewer', text: t('member.role.reviewer'), tooltip: t('member.role.reviewer.desc') },
                ]
              : [{ value: 'member', text: t('member.role.member') }]
          }
        />
        <div className="_memory-field-hint">
          {canGrantAdmin ? t('addMember.role.hintAdmin') : t('addMember.role.hint')}
        </div>
      </Form.Item>
          {error && <Form.Item><Alert type="error">{error}</Alert></Form.Item>}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void handleSubmit()} disabled={!canSubmit || submitting} loading={submitting}>
          {mode === 'existing' ? t('addMember.existing.submit') : t('addMember.new.submit')}
        </Button>
        <Button onClick={onClose} disabled={submitting}>{t('addMember.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}

/**
 * After the user is created, show the initial API Key - only this once; it cannot be retrieved again after closing.
 */
export function CreatedUserKeyModal({
  info,
  onClose,
}: {
  info: { username: string; userId: string; keyValue: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();

  return (
    <Modal visible caption={t('createdUserKey.caption')} size="m" onClose={onClose}>
      <Modal.Body>
        <Form>
          <Alert type="success">{t('createdUserKey.success', { username: info.username, userId: info.userId })}</Alert>
          <div className="space-y-4 text-[13px]">
        {info.keyValue ? (
          <>
            <Alert type="warning">
              <strong>{t('createdUserKey.warning')}</strong>
            </Alert>
            <Form.Item label={t('createdUserKey.keyLabel')}>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded border bg-muted px-3 py-2 text-[12px] font-mono break-all select-all">
                  {info.keyValue}
                </code>
                <Copy text={info.keyValue}>
                  <Button onClick={() => setCopied(true)}>
                    {copied ? t('createdUserKey.copied') : t('createdUserKey.copy')}
                  </Button>
                </Copy>
              </div>
            </Form.Item>
          </>
        ) : (
          <Alert type="warning">
            {t('createdUserKey.noKey')}
            <code
              className="mt-1 block rounded px-2 py-1 text-[12px] font-mono select-all"
              style={{ background: 'var(--wf-color-bg-primary-default)' }}
            >
              {info.userId}
            </code>
          </Alert>
        )}
          </div>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={onClose}>{t('createdUserKey.close')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
