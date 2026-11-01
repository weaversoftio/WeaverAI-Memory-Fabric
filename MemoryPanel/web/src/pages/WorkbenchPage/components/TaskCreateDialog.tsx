/**
 * TaskCreateDialog - "New Task" dialog.
 *
 * Required fields (frontend validation):
 *   - title         task title
 *   - description   task description
 *
 * About team ownership:
 *   The user no longer picks a team in the dialog. The team is decided by the global TeamSwitcher at the top right,
 *   and here it is only shown readonly as "will be created in team: name (team_id)", avoiding the inconsistency of two contexts
 *   ("top right says A but the dialog defaulted to B and the user did not notice, so everything went off track").
 *
 * Agents can be assigned at creation time (optional) or later from the task detail. Assigned agents' work on
 * the task shows up in the task's "Outputs" for the whole team.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Tag, Input, Button, Form, Modal, Select } from '@/components/ui';
import type { AgentOption } from '../utils/workbench-utils';
import '../styles/task-create-dialog.css';

export type TaskSourceType = 'manual' | 'tapd';

export interface TaskDraft {
  team_id: string;
  title: string;
  description: string;
  source_type: TaskSourceType;
  source_url: string;
  linked_agents: string[];
}

export default function TaskCreateDialog(props: {
  team: { team_id: string; name: string };
  /** Team agents that can be assigned to the task. */
  agents?: AgentOption[];
  onClose: () => void;
  onCreate: (draft: TaskDraft) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkedAgents, setLinkedAgents] = useState<string[]>([]);
  const agentOptions = props.agents ?? [];
  const nameById = new Map(agentOptions.map((a) => [a.id, a.name]));

  const canSubmit = title.trim().length > 0 && description.trim().length > 0;

  async function submit() {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await props.onCreate({
        team_id: props.team.team_id,
        title: title.trim(),
        description: description.trim(),
        source_type: 'manual',
        source_url: '',
        linked_agents: linkedAgents,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal visible caption={t('taskCreate.caption')} size="m" onClose={props.onClose} disableEscape={submitting}>
      <Modal.Body>
        <Form>
          <Form.Item label={t('taskCreate.team')}>
            <div className="_memory-tcd-team-row">
              <span className="_memory-tcd-team-avatar">{props.team.name.slice(0, 1).toUpperCase()}</span>
              <div className="_memory-tcd-team-meta">
                <div className="_memory-tcd-team-label">{t('taskCreate.teamLabel')}</div>
                <div className="_memory-tcd-team-name-row">
                  <span className="_memory-tcd-team-name">{props.team.name}</span>
                  <Tag size="sm">{props.team.team_id}</Tag>
                </div>
              </div>
            </div>
          </Form.Item>
          <Form.Item label={t('taskCreate.title')} required>
            <Input
              autoFocus
              size="full"
              value={title}
              onChange={setTitle}
              placeholder={t('taskCreate.titlePlaceholder')}
            />
          </Form.Item>
          <Form.Item label={t('taskCreate.description')} required extra={t('taskCreate.descriptionExtra')}>
            <Input.TextArea
              size="full"
              value={description}
              onChange={setDescription}
              rows={4}
              placeholder={t('taskCreate.descriptionPlaceholder')}
            />
          </Form.Item>
          <Form.Item label={t('taskCreate.agents')} extra={t('taskCreate.agentsExtra')}>
            <div>
              {linkedAgents.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                  {linkedAgents.map((id) => (
                    <Tag key={id} size="sm" onClose={() => setLinkedAgents((prev) => prev.filter((x) => x !== id))}>
                      {nameById.get(id) ?? id}
                    </Tag>
                  ))}
                </div>
              )}
              <Select
                size="full"
                value=""
                placeholder={agentOptions.length ? t('taskCreate.agentsPlaceholder') : t('taskCreate.agentsEmpty')}
                disabled={agentOptions.length === 0}
                searchable
                onChange={(v) => {
                  if (v && !linkedAgents.includes(v)) setLinkedAgents((prev) => [...prev, v]);
                }}
                options={agentOptions
                  .filter((a) => !linkedAgents.includes(a.id))
                  .map((a) => ({ value: a.id, text: a.name }))}
              />
            </div>
          </Form.Item>
          {error && <Form.Item><Alert type="error">{error}</Alert></Form.Item>}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void submit()} disabled={!canSubmit} loading={submitting}>{t('taskCreate.submit')}</Button>
        <Button onClick={props.onClose} disabled={submitting}>{t('taskCreate.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
