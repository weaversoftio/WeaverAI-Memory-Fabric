/**
 * App.tsx — root component
 *
 * Responsibilities:
 *   1. Manage login state (zustand auth store, hooked to the new panel Control's sessionStorage session)
 *   2. On startup, check whether the locally cached session is valid (checkSession):
 *        - checking -> loading
 *        - not logged in -> LoginGate
 *        - logged in -> RouterProvider (ConsoleLayout + pages)
 *   3. Provide app-wide UI context (direction for Hebrew, tooltips, toasts, confirm dialogs)
 */
import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import LoginGate from '@/components/LoginGate';
import { UIProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { router } from '@/routes';

export default function App() {
  const { t } = useTranslation();
  const auth = useAuthStore((s) => s.auth);
  const setAuth = useAuthStore((s) => s.setAuth);
  const checkSession = useAuthStore((s) => s.checkSession);

  // On startup, check whether the { instance_id, user_key, user } cached in sessionStorage is valid
  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const content = (() => {
    if (auth === null) {
      return (
        <div className="wf-boot">
          <img src="/logo.png" alt="" className="wf-boot__logo" />
          <div className="wf-boot__status">
            <Loader2 size={14} className="wf-spin" />
            {t('app.checkingSession')}
          </div>
        </div>
      );
    }

    if (auth === undefined) {
      return <LoginGate onLoggedIn={(a) => setAuth(a)} />;
    }

    return <RouterProvider router={router} />;
  })();

  return <UIProvider>{content}</UIProvider>;
}
