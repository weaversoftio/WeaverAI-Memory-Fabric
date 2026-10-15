/**
 * TeamHeaderCard -- overview card of the current team (avatar + name + team_id + member count + description).
 *
 * Extracted from the TeamManagementPanel header, reused by the team management page, the Task workbench and other pages,
 * to uniformly show "which team I am operating on now". Style classes are defined in team-management-panel.css.
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Tag } from '@/components/ui';
import type { Team } from '@/services';

export function TeamHeaderCard({ team, ops }: { team: Team; ops?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="_memory-panel-card">
      <div className="_memory-team-header-row">
        <div className="_memory-team-header-info">
          <div className="_memory-team-header-avatar">
            {team.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="_memory-team-header-meta">
            <div className="_memory-team-header-meta-row">
              <span className="_memory-team-header-name">{team.name}</span>
              <Tag size="sm">{team.team_id}</Tag>
              <span className="_memory-team-header-count">
                {t('team.memberCount', { count: team.members.length })}
              </span>
            </div>
            {team.description && (
              <div className="_memory-team-header-desc">{team.description}</div>
            )}
          </div>
        </div>
        {ops && <div className="_memory-team-header-ops">{ops}</div>}
      </div>
    </div>
  );
}
