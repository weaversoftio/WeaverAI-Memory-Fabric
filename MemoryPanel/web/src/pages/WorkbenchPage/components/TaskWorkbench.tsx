/**
 * TaskWorkbench - user workbench.
 *
 * Narrowed to two things:
 *   1. List/create/manage the tasks under this team;
 *   2. View a task's history via the log tab.
 *
 * Layout: the page opens as a full-width card grid; clicking a card pulls out a Drawer in which to view details and settings
 * (change status, edit title/description, delete).
 *
 * Data goes through backend path A (services/backendStore.ts, which internally calls the meta endpoints of @/lib/teamApi).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Text } from '@/components/ui';
import {
  useTasks,
  useTeams,
  createTask,
  deleteTask,
  updateTask,
  updateTaskStatus,
  canDeleteTask,
  canEditTask,
} from '@/services';
import { feedback } from '@/lib/feedback';
import { TeamHeaderCard } from '@/components/team/TeamHeaderCard';
import TaskCreateDialog, { type TaskDraft } from './TaskCreateDialog';
import BoardView from './BoardView';
import { useTeamParticipation } from '../hooks/useTeamParticipation';
import { errMsg, type AgentOption, type WorkbenchTab } from '../utils/workbench-utils';
import '../styles/task-workbench.css';

function EmptyTeam() {
  const { t } = useTranslation();
  return (
    <Card>
      <Card.Body className="_memory-workbench-empty-card">
        <Text theme="strong" className="_memory-workbench-empty-title">{t('task.emptyTeam.title')}</Text>
        <Text theme="weak" className="_memory-workbench-empty-desc">
          {t('task.emptyTeam.desc')}
        </Text>
      </Card.Body>
    </Card>
  );
}

export default function TaskWorkbench(props: {
  tab?: WorkbenchTab;
  onTabChange?: (tab: WorkbenchTab) => void;
  /** Currently active team id (may be empty: when none is selected only the empty state is shown) */
  activeTeamId: string | null;
  /** Current username (the task's creator_user_id) */
  currentUser: string;
  /** Agents that can be linked under the current team (same data source as TeamManagementPanel) */
  agents: AgentOption[];
  /** Whether this is a global admin (kept for interface compatibility; admin no longer has task privileges) */
  isAdmin?: boolean;
}) {
  const { t } = useTranslation();
  const { activeTeamId, currentUser, agents } = props;
  // Backend pagination: useTasks calls the Panel aggregation endpoint by page + pageSize, and the kernel returns only the current page
  const PAGE_SIZE = 12;
  const [currentPage, setCurrentPage] = useState(1);
  const { tasks, total: tasksTotal, loading: tasksLoading } = useTasks(activeTeamId, currentPage, PAGE_SIZE);
  const { teams, activeTeam } = useTeams();
  const participationByTask = useTeamParticipation(activeTeamId);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Reset to page 1 when switching team
  useEffect(() => { setCurrentPage(1); }, [activeTeamId]);

  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => b.updated_at_ms - a.updated_at_ms);
  }, [tasks]);

  const selected = useMemo(
    () => (selectedId ? tasks.find((t) => t.task_id === selectedId) ?? null : null),
    [selectedId, tasks]
  );

  /**
   * Create task: team_id is fully determined by the currently active team; the dialog no longer lets you choose a team
   * (the only entry for switching team is the global TeamSwitcher at the top right).
   */
  async function handleCreate(draft: TaskDraft) {
    // Whoever clicks "Create Task" is the creator_user_id.
    const team = teams.find((t) => t.team_id === draft.team_id);
    if (!team) {
      feedback.notify.error(`team "${draft.team_id}" ${t('task.emptyTeam.title')}`);
      return;
    }
    try {
      const task = await createTask({
        team_id: draft.team_id,
        creator_user_id: currentUser,
        title: draft.title,
        description: draft.description,
        source_type: draft.source_type,
        source_url: draft.source_url,
        linked_agents: draft.linked_agents
      });
      setSelectedId(task.task_id);
      setShowCreate(false);
    } catch (err) {
      feedback.notify.error(errMsg(err));
    }
  }

  return (
    <div className="_memory-workbench-body">
      {!activeTeamId ? (
        <EmptyTeam />
      ) : (
        <>
          {/* Current team overview (same component as the team management page) */}
          {activeTeam && <TeamHeaderCard team={activeTeam} />}
          <BoardView
          tasks={sortedTasks}
          tasksLoading={tasksLoading}
          tasksTotal={tasksTotal}
          currentPage={currentPage}
          setCurrentPage={setCurrentPage}
          pageSize={PAGE_SIZE}
          selected={selected}
          onSelect={(id) => setSelectedId(id)}
          onCreate={() => setShowCreate(true)}
          onDelete={async (task) => {
            // Permission: deleting a task is limited to the creator / team admin / global admin
            const team = teams.find((t) => t.team_id === task.team_id) ?? null;
            if (!canDeleteTask(task, team, currentUser)) {
              feedback.notify.warning(
                t('task.delete.noPermission', { title: task.title, creator: task.creator_user_id })
              );
              return;
            }
            const ok = await feedback.confirm({
              message: t('task.delete.confirm', { title: task.title }),
              description: t('task.delete.description', { id: task.task_id }),
              okText: t('task.delete.okText'),
              cancelText: t('task.delete.cancelText'),
            });
            if (ok) {
              try {
                await deleteTask(task.task_id);
                if (selectedId === task.task_id) setSelectedId(null);
              } catch (err) {
                feedback.notify.error(errMsg(err));
              }
            }
          }}
          onUpdateStatus={async (task, status) => {
            // Permission: editing a task (including switching status) is allowed for any member / admin in the team
            const team = teams.find((t) => t.team_id === task.team_id) ?? null;
            if (!canEditTask(task, team, currentUser)) {
              feedback.notify.warning(t('task.noPermissionEdit'));
              return;
            }
            try {
              await updateTaskStatus(task.task_id, status, currentUser);
            } catch (err) {
              feedback.notify.error(errMsg(err));
            }
          }}
          onUpdateTask={async (task, patch) => {
            const team = teams.find((t) => t.team_id === task.team_id) ?? null;
            if (!canEditTask(task, team, currentUser)) {
              feedback.notify.warning(t('task.noPermissionEdit'));
              return;
            }
            try {
              await updateTask(task.task_id, patch, currentUser);
            } catch (err) {
              feedback.notify.error(errMsg(err));
            }
          }}
          agents={agents}
          teams={teams}
          currentUser={currentUser}
          participationByTask={participationByTask}
          />
        </>
      )}

      {showCreate && activeTeam && (
        // The team is determined by the global TeamSwitcher at the top right; the dialog no longer lets the user choose;
        // activeTeam must be non-empty here, because the !activeTeamId branch above already went to EmptyTeam
        <TaskCreateDialog
          team={{ team_id: activeTeam.team_id, name: activeTeam.name }}
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}
    </div>
  );
}
