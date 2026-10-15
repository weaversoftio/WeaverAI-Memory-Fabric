/**
 * LanguageSwitcher — header language picker
 */
import { Dropdown, List } from '@/components/ui';
import { GlobeIcon } from '@/components/ui/icons';
import { changeLanguage, getCurrentLanguage, type Language } from '@/i18n';
import './language-switcher.css';

const LANGUAGE_LABELS: Record<Language, string> = {
  'en-US': 'English',
  'he-IL': 'עברית',
};

export function LanguageSwitcher() {
  const current = getCurrentLanguage();

  return (
    <Dropdown
      appearance="pure"
      clickClose
      button={
        <button type="button" className="_memory-lang-switcher-btn" title="Language">
          <GlobeIcon size={16} />
          <span className="_memory-lang-switcher-label">{LANGUAGE_LABELS[current]}</span>
        </button>
      }
    >
      {() => (
        <List type="option">
          {(Object.keys(LANGUAGE_LABELS) as Language[]).map((lang) => (
            <List.Item
              key={lang}
              selected={current === lang}
              onClick={() => { changeLanguage(lang); }}
            >
              {LANGUAGE_LABELS[lang]}
            </List.Item>
          ))}
        </List>
      )}
    </Dropdown>
  );
}
