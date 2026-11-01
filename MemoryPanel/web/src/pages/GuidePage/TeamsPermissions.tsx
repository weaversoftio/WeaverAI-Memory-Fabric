/**
 * TeamsPermissions - "Teams & access" guide tab: who can see / do what (roles), the sharing rules
 * for agents, assets and task outputs, and where to do the common permission tasks.
 */
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const ROLES = ['platformAdmin', 'teamAdmin', 'member', 'viewer'] as const;
const RULES = ['teamAgent', 'privateAgent', 'teamAssets', 'taskOutputs'] as const;
const HOWTOS: Array<{ id: string; path: string }> = [
  { id: 'createTeam', path: '/team/members' },
  { id: 'addMember', path: '/team/members' },
  { id: 'changeRole', path: '/team/members' },
  { id: 'platformAdmin', path: '/team/members' },
  { id: 'followAgent', path: '/' },
  { id: 'myConnection', path: '/' },
];

export function TeamsPermissions() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <section className="guide-surface guide-perm">
      <div className="guide-perm-intro">
        <h2>{t('guide.perm.heading')}</h2>
        <p>{t('guide.perm.intro')}</p>
      </div>

      <h3 className="guide-perm-section">{t('guide.perm.roles.title')}</h3>
      <div className="guide-perm-table" role="table">
        <div className="guide-perm-row guide-perm-head" role="row">
          <span role="columnheader">{t('guide.perm.col.role')}</span>
          <span role="columnheader">{t('guide.perm.col.sees')}</span>
          <span role="columnheader">{t('guide.perm.col.does')}</span>
        </div>
        {ROLES.map((r) => (
          <div key={r} className="guide-perm-row" role="row">
            <span role="cell">
              <b>{t(`guide.perm.role.${r}`)}</b>
              <small>{t(`guide.perm.role.${r}.who`)}</small>
            </span>
            <span role="cell">{t(`guide.perm.role.${r}.sees`)}</span>
            <span role="cell">{t(`guide.perm.role.${r}.does`)}</span>
          </div>
        ))}
      </div>

      <h3 className="guide-perm-section">{t('guide.perm.rules.title')}</h3>
      <div className="guide-perm-cards">
        {RULES.map((r) => (
          <div key={r} className="guide-perm-card">
            <b>{t(`guide.perm.rule.${r}.title`)}</b>
            <p>{t(`guide.perm.rule.${r}.desc`)}</p>
          </div>
        ))}
      </div>

      <h3 className="guide-perm-section">{t('guide.perm.howto.title')}</h3>
      <ul className="guide-perm-howto">
        {HOWTOS.map((h) => (
          <li key={h.id}>
            <div>
              <b>{t(`guide.perm.howto.${h.id}.title`)}</b>
              <span>{t(`guide.perm.howto.${h.id}.steps`)}</span>
            </div>
            <button type="button" onClick={() => navigate(h.path)}>
              {t('guide.perm.howto.open')} →
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
