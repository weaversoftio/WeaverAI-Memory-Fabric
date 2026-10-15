/**
 * TaskDetail - workbench task detail (edit title/description, switch status, view participants, delete).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Segment, Text } from '@/components/ui';
import { DeleteIcon, EditIcon, UserIcon, TeamIcon } from '@/components/ui/icons';
import { canEditTask, type Task, type Team } from '@/services';
import { useUserDisplayName } from '@/services/user-profile-store';
import { feedback } from '@/lib/feedback';
import { useStatusLabels, type AgentOption, type TaskParticipationView } from '../utils/workbench-utils';

/**
 * Participant chip: the visible text shows display_name (falls back to id on cache miss),
 * title keeps the semantic tooltip + user_id for troubleshooting.
 * A sub-component is required by the Rules of Hooks (useUserDisplayName cannot be called in a loop inside .map).
 */
function UserChip({
  userId,
  currentUser,
  tooltip,
}: {
  userId: string;
  currentUser: string;
  tooltip: string;
}) {
  const { t } = useTranslation();
  const name = useUserDisplayName(userId);
  return (
    <span className="_memory-workbench-chip" title={`${tooltip} · ${userId}`}>
      <UserIcon size={12} />
      <Text theme="text">{name || userId}</Text>
      {userId === currentUser && <span className="_memory-workbench-chip-you">{t('common.you.short')}</span>}
    </span>
  );
}

export default function TaskDetail({
  task,
  onUpdateStatus,
  onUpdateTask,
  onDelete,
  canDelete,
  agents,
  team,
  currentUser,
  participation,
}: {
  task: Task;
  onUpdateStatus: (s: Task['status']) => void;
  onUpdateTask: (patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>>) => void;
  /** Delete the current task (permission check and secondary confirmation are handled uniformly by the outer layer) */
  onDelete: () => void;
  canDelete: boolean;
  agents: AgentOption[];
  /** Team the current task belongs to - may be null (in theory it won't, but the team-deleted scenario needs a fallback) */
  team: Team | null;
  currentUser: string;
  /** Observation data of the current task passed down after bucketing by useTeamParticipation */
  participation: TaskParticipationView;
}) {
  const { t } = useTranslation();
  const statusLabels = useStatusLabels();
  // Edit permission: any member in the team can edit a task (including switching status).
  const canEdit = canEditTask(task, team, currentUser);

  // -- Edit state: entered only after the user clicks "Edit"; the draft is maintained independently, cancel discards it -- //
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [draftDesc, setDraftDesc] = useState(task.description);

  // Sync the draft when switching task / leaving edit mode (so that after editing A and switching to B the draft doesn't stay on A)
  useEffect(() => {
    setEditing(false);
    setDraftTitle(task.title);
    setDraftDesc(task.description);
  }, [task.task_id]);

  function startEdit() {
    setDraftTitle(task.title);
    setDraftDesc(task.description);
    setEditing(true);
  }
  function cancelEdit() {
    setEditing(false);
  }
  function saveEdit() {
    const patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>> = {};
    const title = draftTitle.trim();
    if (title.length === 0) {
      feedback.notify.warning(t('task.titleRequired'));
      return;
    }
    if (title !== task.title) patch.title = title;
    if (draftDesc !== task.description) patch.description = draftDesc;

    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    onUpdateTask(patch);
    setEditing(false);
  }

  // Participant display: creator gets its own separate row; the rest go into "Participating Users".
  // The data source is uniformly the participation-log observation - the "users who actually started a session"
  // appended when proxy session init completes. A creator who starts work with their own agent also counts as real participation,
  // so the creator is no longer filtered out (it would appear in both "Creator" and "Participating Users", with different semantics).
  const participantUsers = participation.users;

  // "Agents actually participating": agents observed in sessions, mapped to the team's agent names;
  // those not in the team agents list (e.g. already deleted) keep agent_id as a fallback display.
  const sessionAgents = useMemo(() => {
    const nameById = new Map(agents.map((a) => [a.id, a.name]));
    return participation.agentIds.map((id) => ({ id, name: nameById.get(id) ?? id }));
  }, [participation.agentIds, agents]);

  return (
    <div className="_memory-workbench-detail-content">
      {/* === Tool row: edit + status switch (title / task_id / team are already shown in the drawer header) === */}
      <div className="_memory-workbench-detail-toolbar">
        {editing ? (
          <>
            <Input
              value={draftTitle}
              onChange={setDraftTitle}
              placeholder={t('task.titlePlaceholder')}
              size="full"
              className="_memory-workbench-title-input"
            />
            <Button onClick={cancelEdit}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={saveEdit}>{t('task.save')}</Button>
          </>
        ) : (
          <>
            {canEdit && (
              <Button type="text" onClick={startEdit} tooltip={t('task.edit.tooltip')}>
                <EditIcon size={14} />
                {t('task.edit')}
              </Button>
            )}
            <Segment
              value={task.status}
              onChange={(v) => onUpdateStatus(v as Task['status'])}
              disabled={!canEdit}
              options={(Object.keys(statusLabels) as Task['status'][]).map((s) => ({
                value: s,
                text: statusLabels[s],
              }))}
            />
          </>
        )}
      </div>

      {/* === Participants === */}
      <div className="_memory-workbench-people">
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.creator')}</Text>
          <UserChip
            userId={task.creator_user_id}
            currentUser={currentUser}
            tooltip={t('task.creator.tooltip')}
          />
        </div>
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.participantUsers')}</Text>
          {participantUsers.length === 0 ? (
            <Text theme="weak">—</Text>
          ) : (
            participantUsers.map((u) => (
              <UserChip
                key={u}
                userId={u}
                currentUser={currentUser}
                tooltip={t('task.participantUsers.tooltip')}
              />
            ))
          )}
        </div>
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.sessionAgents')}</Text>
          {sessionAgents.length === 0 ? (
            <Text theme="weak">—</Text>
          ) : (
            sessionAgents.map((a) => (
              <span
                key={a.id}
                className="_memory-workbench-chip"
                title={t('task.sessionAgents.tooltip', { id: a.id })}
              >
                <TeamIcon size={12} />
                <Text theme="text">{a.name}</Text>
              </span>
            ))
          )}
        </div>
      </div>

      {/* === Description === */}
      <div className="_memory-workbench-block">
        <Text theme="label" className="_memory-workbench-block-label">{t('task.description')}</Text>
        {editing ? (
          <Input.TextArea
            value={draftDesc}
            onChange={setDraftDesc}
            rows={6}
            size="full"
            placeholder={t('task.descriptionPlaceholder')}
          />
        ) : (
          <div className="_memory-workbench-desc-view">{task.description}</div>
        )}
      </div>

      <Text theme="weak" className="_memory-workbench-footer">
        {t('task.footer', { created: new Date(task.created_at_ms).toLocaleString(), updated: new Date(task.updated_at_ms).toLocaleString() })}
      </Text>

      {/* === Danger zone === */}
      {canDelete && (
        <div className="_memory-workbench-danger">
          <Button type="error" onClick={onDelete}>
            <DeleteIcon size={12} /> {t('task.delete.okText')}
          </Button>
        </div>
      )}
    </div>
  );
}
