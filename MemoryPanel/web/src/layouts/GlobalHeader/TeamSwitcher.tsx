/**
 * TeamSwitcher — Team switcher embedded in the global top bar
 *
 * Inline pill-style version after moving from the sidebar to the top bar: uses UI kit `Dropdown` to host the popup panel
 * (with built-in positioning, click-outside close, scroll close, etc.), and assembles the panel with `List`/`Input`/`Button`.
 *
 * Team edit entry: on the right of the current active team row (visible to owner / admin) there are "Edit" and "Delete"
 * icon buttons, reusing EditTeamDialog + feedback.confirm for secondary confirmation. This consolidates here the "Edit Team / Delete current Team" entries
 * previously on the TeamManagementPanel header.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dropdown, Input, Button } from '@/components/ui';
import { ChevronDownIcon, AddIcon, EditIcon, DeleteIcon } from '@/components/ui/icons';
import {
  useTeams,
  writeActiveTeamId,
  invalidateBackendCache,
  isTeamAdmin,
} from '@/services';
import { useBackendStore } from '@/stores/backend';
import { type TeamRole } from '@/services/useCurrentRole';
import { teamsApi } from '@/lib/teamApi';
import { getPanelSession } from '@/lib/panelSession';
import { teamColor } from '@/utils/color';
import { feedback } from '@/lib/feedback';
import { getErrorMessage } from '@/lib/error-message';
import EditTeamDialog from '@/components/team/EditTeamDialog';
import './team-switcher.css';

export function TeamSwitcher({ userRole }: { userRole: TeamRole | null }) {
  const { t } = useTranslation();
  const { teams, activeTeamId } = useTeams();
  const refreshTeams = useBackendStore((s) => s.refreshTeams);
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamDesc, setNewTeamDesc] = useState('');
  const [creating, setCreating] = useState(false);
  // Edit dialog visibility state
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);

  const myTeams = teams;
  const active = myTeams.find((tm) => tm.team_id === activeTeamId) ?? null;
  // Current user's user_id (readable synchronously from panelSession)
  const currentUserId = getPanelSession()?.user?.user_id ?? '';
  // Whether the current active team can be edited / deleted: global admin, or owner / admin of the current team
  const canManageActiveTeam =
    !!active && (userRole === 'admin' || isTeamAdmin(active, currentUserId));

  function resetCreateForm() {
    setShowCreateTeam(false);
    setNewTeamName('');
    setNewTeamDesc('');
  }

  function pick(team_id: string, close: () => void) {
    // Only switch activeTeamId, without invalidateTeamCache:
    //  - useAgents/useTasks cache by teamId bucket; if the target team already has a cache (viewed before) when switching,
    //    it opens instantly with no re-loading; only without a cache does it fetch -- that is "auto refresh" rather than
    //    a "whole-page reload".
    //  - invalidateTeamCache would delete the target team's cache + broadcast BACKEND_REFRESH_EVENT,
    //    making all pages (including unrelated data such as counts/participation) re-fetch after a team switch,
    //    showing up as "one switch = everything refreshes once". invalidateBackendCache after write operations
    //    already guarantees data freshness; the switch itself needs no forced refresh.
    writeActiveTeamId(team_id);
    close();
  }

  async function handleCreate() {
    const name = newTeamName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await teamsApi.create({ name, description: newTeamDesc.trim() });
      invalidateBackendCache();
      writeActiveTeamId(created.team_id);
      resetCreateForm();
    } catch (err) {
      feedback.notify.error(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdateTeam(input: { name: string; description: string }) {
    const id = editingTeamId;
    if (!id) return;
    try {
      await teamsApi.update(id, input);
      invalidateBackendCache();
      setEditingTeamId(null);
    } catch (err) {
      feedback.notify.error(getErrorMessage(err));
    }
  }

  async function handleDeleteTeam(teamId: string, teamName: string, memberCount: number) {
    // Fetch the agent count once (for cascade display) -- use the store cache to avoid extra requests
    let agentCount = 0;
    try {
      const cached = useBackendStore.getState().agentsByTeam[teamId];
      if (cached) agentCount = cached.length;
    } catch {
      /* Silent: only used to show the cascade scope; failing to get it does not affect deletion */
    }
    const ok = await feedback.confirm({
      message: t('teamSwitcher.delete.confirm', { name: teamName }),
      description: t('teamSwitcher.delete.desc', {
        members: memberCount,
        agents: agentCount,
      }),
      okText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await teamsApi.delete(teamId);
      // On deleting the current active team, clear activeTeamId so ensureValidActiveTeamId
      // lands on the first remaining team (or the empty state) automatically after the store refreshes.
      if (teamId === activeTeamId) writeActiveTeamId(null);
      invalidateBackendCache();
    } catch (err) {
      feedback.notify.error(getErrorMessage(err));
    }
  }

  const editingTeam = editingTeamId ? myTeams.find((tm) => tm.team_id === editingTeamId) ?? null : null;

  return (
    <>
      <Dropdown
        appearance="pure"
        clickClose={false}
        matchButtonWidth={false}
        className="_memory-team-switcher-dropdown"
        boxClassName="_memory-team-switcher-box"
        // Silent refresh: only keep the team list in the dropdown fresh, without flipping teamsLoading,
        // otherwise consumers such as TeamManagementPanel would all enter a loading placeholder (showing up as
        // "opening the team-selection dropdown makes the members/Agents management page refresh").
        onOpen={() => { void refreshTeams({ silent: true }); }}
        onClose={resetCreateForm}
        button={
          <button
            type="button"
            className="_memory-team-switcher-trigger"
            title={active?.name ?? t('teamSwitcher.selectTeam')}
          >
            <span className={`_memory-team-switcher-avatar ${active ? teamColor(active.team_id) : 'bg-primary'}`}>
              {(active?.name ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <span className="_memory-team-switcher-meta">
              <span className="_memory-team-switcher-name">{active?.name ?? t('teamSwitcher.selectTeam')}</span>
              <span className="_memory-team-switcher-id">{active?.team_id ?? t('teamSwitcher.noTeam')}</span>
            </span>
            <ChevronDownIcon size={12} className="_memory-team-switcher-chevron" />
          </button>
        }
      >
        {(close) => (
          <div className="_memory-team-switcher-panel">
            <div className="_memory-team-switcher-panel-header">
              <div className="_memory-team-switcher-panel-title">{t('teamSwitcher.title')}</div>
              <div className="_memory-team-switcher-panel-desc">
                {t('teamSwitcher.desc')}
              </div>
            </div>

            <div className="_memory-team-switcher-panel-label">{t('teamSwitcher.teamCount', { count: myTeams.length })}</div>

            <div className="_memory-team-switcher-list-wrap">
              {myTeams.length === 0 ? (
                <div className="_memory-team-switcher-empty">
                  {userRole === 'admin'
                    ? t('teamSwitcher.empty.admin')
                    : t('teamSwitcher.empty.member')}
                </div>
              ) : (
                // Use native ul/li instead of UI kit List: UI kit List.Item selected automatically renders a checkmark
                // and changes padding, and split="divide" injects padding/border-top, which repeatedly conflict with the custom
                // card-style row styling (rounded corners + border + spacing) (showing up as the selected row being clipped on the left and
                // the row divider covered by the previous row). Here we control all styling ourselves, so behavior is more predictable.
                <ul className="_memory-team-switcher-list">
                  {myTeams.map((tm) => {
                    const isActive = tm.team_id === activeTeamId;
                    // Only the current active team row shows the edit/delete buttons, and only owner/admin can operate
                    const showOps = isActive && canManageActiveTeam;
                    return (
                      <li key={tm.team_id} className="_memory-team-switcher-row">
                        <button
                          type="button"
                          className={`_memory-team-switcher-item${isActive ? ' is-active' : ''}`}
                          aria-current={isActive || undefined}
                          onClick={() => pick(tm.team_id, close)}
                        >
                          <span className={`_memory-team-switcher-item-avatar ${teamColor(tm.team_id)}`}>
                            {tm.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="_memory-team-switcher-item-meta">
                            <span className="_memory-team-switcher-item-name">{tm.name}</span>
                            <span className="_memory-team-switcher-item-count">
                              {t('teamSwitcher.memberCount', { count: tm.members.length })}
                            </span>
                          </span>
                          {/* The selected state is conveyed by background color + border, no extra checkmark -- to avoid crowding with the right-side
                              action buttons. The action buttons are an absolutely positioned overlay and take no row layout width. */}
                        </button>
                        {showOps && (
                          <span className="_memory-team-switcher-item-ops">
                            <button
                              type="button"
                              className="_memory-team-switcher-item-op"
                              title={t('teamSwitcher.edit.tooltip')}
                              aria-label={t('teamSwitcher.edit.tooltip')}
                              onClick={() => setEditingTeamId(tm.team_id)}
                            >
                              <EditIcon size={14} />
                            </button>
                            <button
                              type="button"
                              className="_memory-team-switcher-item-op _memory-team-switcher-item-op-danger"
                              title={t('teamSwitcher.delete.tooltip')}
                              aria-label={t('teamSwitcher.delete.tooltip')}
                              onClick={() => {
                                void handleDeleteTeam(tm.team_id, tm.name, tm.members.length);
                              }}
                            >
                              <DeleteIcon size={14} />
                            </button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="_memory-team-switcher-footer">
              {userRole !== 'admin' ? null : showCreateTeam ? (
                <div className="_memory-team-switcher-create-form">
                  <Input
                    autoFocus
                    size="full"
                    value={newTeamName}
                    onChange={setNewTeamName}
                    placeholder={t('teamSwitcher.teamNamePlaceholder')}
                  />
                  <Input
                    size="full"
                    value={newTeamDesc}
                    onChange={setNewTeamDesc}
                    placeholder={t('teamSwitcher.teamDescPlaceholder')}
                  />
                  <div className="_memory-team-switcher-create-actions">
                    <Button onClick={resetCreateForm}>{t('teamSwitcher.cancel')}</Button>
                    <Button type="primary"
                      loading={creating}
                      disabled={!newTeamName.trim() || creating}
                      onClick={handleCreate}
                    >
                      {t('teamSwitcher.create')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button type="text"
                  className="_memory-team-switcher-create-trigger"
                  onClick={() => setShowCreateTeam(true)}
                >
                  <AddIcon size={14} />
                  {t('teamSwitcher.newTeam')}
                </Button>
              )}
            </div>
          </div>
        )}
      </Dropdown>

      {/* The edit dialog is mounted outside the Dropdown: to prevent Dropdown clickClose from interfering with Modal visibility */}
      {editingTeam && (
        <EditTeamDialog
          team={editingTeam}
          onClose={() => setEditingTeamId(null)}
          onSave={handleUpdateTeam}
          busy={false}
        />
      )}
    </>
  );
}