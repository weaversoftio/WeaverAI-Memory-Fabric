/**
 * App.tsx — root component
 *
 * Responsibilities:
 *   1. Manage login state (zustand auth store, hooked to the new panel Control's sessionStorage session)
 *   2. On startup, check whether the locally cached session is valid (checkSession):
 *        - checking -> loading
 *        - not logged in -> LoginGate
 *        - logged in -> RouterProvider (ConsoleLayout + pages)
 *   3. Initialize event sync of the team store
 *   4. Sync the react-i18next language -> tea-component ConfigProvider,
 *      so the built-in tea-component copy (StatusTip "Loading", Table "No data", etc.)
 *      follows the user's language switch automatically.
 */
import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfigProvider } from 'tea-component';
import LoginGate from '@/components/LoginGate';
import { useAuthStore } from '@/stores/auth';
import { router } from '@/routes';
import { teaHeIL } from '@/i18n/tea-he-IL';

type TeaLocale = 'en' | typeof teaHeIL;

/** react-i18next language → tea-component locale (tea ships no Hebrew pack, so we supply one) */
function toTeaLocale(lang: string): TeaLocale {
  return lang.startsWith('he') ? teaHeIL : 'en';
}

export default function App() {
  const { t, i18n } = useTranslation();
  const auth = useAuthStore((s) => s.auth);
  const setAuth = useAuthStore((s) => s.setAuth);
  const checkSession = useAuthStore((s) => s.checkSession);
  // Current tea-component locale, kept in sync with react-i18next
  const [teaLocale, setTeaLocale] = useState<TeaLocale>(() => toTeaLocale(i18n.language));

  // Follow react-i18next language switches and pass them on to tea-component
  useEffect(() => {
    setTeaLocale(toTeaLocale(i18n.language));
    const handler = (lng: string) => setTeaLocale(toTeaLocale(lng));
    i18n.on('languageChanged', handler);
    return () => i18n.off('languageChanged', handler);
  }, [i18n]);

  // On startup, check whether the { instance_id, user_key, user } cached in sessionStorage is valid
  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const content = (() => {
    if (auth === null) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0f172a]">
          <div className="text-sm text-slate-500 dark:text-slate-400">{t('app.checkingSession')}</div>
        </div>
      );
    }

    if (auth === undefined) {
      return <LoginGate onLoggedIn={(a) => setAuth(a)} />;
    }

    return <RouterProvider router={router} />;
  })();

  return (
    <ConfigProvider locale={teaLocale}>
      {content}
    </ConfigProvider>
  );
}
