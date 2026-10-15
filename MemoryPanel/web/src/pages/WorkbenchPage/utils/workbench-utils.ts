/**
 * workbench-utils - shared types, constants and pure utility functions of the workbench.
 * Split out of TaskWorkbench.tsx.
 */
import { useTranslation } from 'react-i18next';

export type WorkbenchTab = 'board' | 'logs';

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Task status is simplified to two states in the demo stage: in progress / completed.
// The historical pending / blocked / archived states have been retired (see normalizeTaskStatus in backendStore.ts).
export function useStatusLabels() {
  const { t } = useTranslation();
  return {
    running: t('task.status.running'),
    completed: t('task.status.completed'),
  };
}

export interface AgentOption {
  id: string;
  name: string;
}

/**
 * Task-level aggregated view: bucket by task_id, then dedupe each bucket separately.
 *
 * Kernel append-only semantics: for the same (user, agent, task), every session init appends a row,
 * so the database table accumulates redundancy; the frontend dedupes on the client with a Set, so "ran 10 sessions" and
 * "ran 1 session" display the same.
 */
export interface TaskParticipationView {
  /** user_id list after dedupe */
  users: string[];
  /** agent_id list after dedupe */
  agentIds: string[];
}

export const EMPTY_VIEW: TaskParticipationView = { users: [], agentIds: [] };

export function participationOf(
  byTask: Map<string, TaskParticipationView>,
  taskId: string,
): TaskParticipationView {
  return byTask.get(taskId) ?? EMPTY_VIEW;
}
