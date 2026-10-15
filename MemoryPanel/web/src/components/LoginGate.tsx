/**
 * LoginGate - login page shown before entering the app (talks to the new panel Control, see design doc 09 section 3.3).
 *
 * Login flow (no Cookie, no OAuth, dual-credential auth via Headers):
 *   1. GET /api/v1/meta/instances              -> pick a memory instance
 *   2. The user enters their own user_key (sk-mem-...)
 *   3. POST /api/v1/meta/auth/verify (Header only X-Wamf-Service-Id, user_key in the body)
 *      -> data.valid === true means login succeeded; data.user is written to the session
 *   4. The frontend caches { instance_id, user_key, user } in localStorage (see lib/panelSession.ts),
 *      and every later meta request reads from there to inject the dual Headers
 *
 * Design: single-column centered, bright minimalist style - a full-screen dot-matrix ripple animated background (ParticleWaveBackground,
 * pure Canvas with zero dependencies, visually inspired by React Bits' Particles / DotGrid) + a centered frosted-glass card,
 * and the card holds the "pick instance + enter user_key" form.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Input, Select } from 'tea-component';
import { getErrorMessage } from '@/lib/error-message';
import {
  authMethodsApi,
  authVerifyApi,
  metaInstancesApi,
  type AuthMethod,
  type MetadataInstance,
  type PublicUser,
} from '@/lib/teamApi';
import { getPanelSession, setPanelSession, clearPanelSession } from '@/lib/panelSession';
import ParticleWaveBackground from './ParticleWaveBackground';
import './login-gate.css';

export interface AuthState {
  /** Display name (display_name || username); keeps the old field name for downstream component compatibility */
  user: string;
  /** Backend ULID - the real key for all ownership checks (owner_user_id / creator_user_id / team_members.user_id) */
  user_id: string;
  instance_id: string;
  instance_name: string;
  loggedInAt: number;
  /**
   * Whether this is a global admin - from auth/verify response data.user.user_type === 'system_admin'.
   * admin is a global role, unrelated to creating/joining any team (manages teams, not resources);
   * regular non-admin users (user_type !== 'system_admin') need their role looked up in the team.members table.
   */
  isAdmin: boolean;
}

// In-memory cache - real persistence is left to localStorage (lib/panelSession.ts, shared across tabs).
// This is just a synchronously readable mirror cache for legacy components that have no props and read identity directly via readAuth()
// (ChatMemoryPanel / WikiSourcesPanel / CodeSourcesPanel, etc.).
let _authCache: AuthState | null = null;

export function readAuth(): AuthState | null {
  return _authCache;
}

/** Logout / 401 fallback: clears both the in-memory mirror cache and the instance_id+user_key in localStorage. */
export function clearAuth(): void {
  _authCache = null;
  clearPanelSession();
}

function writeAuthCache(auth: AuthState): void {
  _authCache = auth;
}

function toAuthState(user: PublicUser, instanceId: string, instanceName: string): AuthState {
  return {
    user: user.display_name || user.username,
    user_id: user.user_id,
    instance_id: instanceId,
    instance_name: instanceName,
    loggedInAt: Date.now(),
    isAdmin: user.user_type === 'system_admin',
  };
}

/** Default username from an IdP login name: IdPs allow dots and @, Memory usernames don't. */
function usernameFrom(loginName: string): string {
  return loginName.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The backend's error code (e.g. USERNAME_TAKEN) from a failed panel call, if any. */
function apiErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  return (err as Error & { rawMessage?: string }).rawMessage ?? err.message;
}

/** Reads and strips ?sso_error=CODE, which the backend adds when an SSO login fails. */
function takeSsoError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('sso_error');
  if (!code) return null;
  url.searchParams.delete('sso_error');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  return code;
}

/**
 * Try to restore the login state from the { instance_id, user_key, user } cached in localStorage.
 * The new panel has no Cookie and the frontend holds the credentials itself; but the cache is persistent (cross-tab, survives closing a tab),
 * so trusting only the local cache would still report "logged in" after the instance is deleted / user_key invalidated, causing a fake login.
 * Therefore a liveness check via auth/verify against the backend is required before restoring:
 *   - valid === true  -> restore with the latest user returned by the backend (also refreshes user info and the admin determination);
 *   - valid !== true or the request throws (instance deleted / credential invalid / business error) -> clear the cache, return null, back to the login page.
 * Called at app startup; on success writes the in-memory mirror cache and returns; on failure (not logged in / incomplete cache / liveness check failed) returns null.
 *
 * Race guard: verify is async, and within its RTT window the local session may be changed by concurrent operations
 * (e.g. another tab logging out triggers a storage event that clears the cache, or switching the instance). If, after it returns,
 * the { instanceId, userKey } in localStorage no longer matches what it was at the start, this restore result
 * is stale: discard it and do not write the cache, to avoid writing back a login state that was cleared/replaced.
 */
export async function resumeSession(): Promise<AuthState | null> {
  const session = getPanelSession();
  // Path 1: a local user_key cache exists (legacy login) - restore after a liveness check against the backend.
  if (session?.user && session.instanceId && session.userKey) {
    try {
      const res = await authVerifyApi.verify(session.instanceId, session.userKey);

      // If the local session was concurrently logged out/switched during the verify RTT, this result is void.
      const latest = getPanelSession();
      if (
        !latest ||
        latest.instanceId !== session.instanceId ||
        latest.userKey !== session.userKey
      ) {
        return null;
      }

      if (!res.valid) {
        // Liveness check failed: instance deleted / user_key invalid; clear the stale login state.
        clearAuth();
        return null;
      }
      // Prefer the latest user just returned by the backend; fall back to the cached user if missing.
      const user = res.user ?? session.user;
      const auth = toAuthState(user, session.instanceId, session.instanceName ?? '');
      writeAuthCache(auth);
      return auth;
    } catch {
      // Request threw (instance missing / backend rejected / network unreachable): treat the login state as invalid, clear the cache and go back to the login page.
      clearAuth();
      return null;
    }
  }

  // Path 2: an IdP (Enterprise SSO) session uses an HttpOnly Cookie and cannot be restored from localStorage;
  // query the backend for the current session. Only reached when the local session is missing / has no userKey (IdP login does not persist a userKey).
  try {
    const idp = await authMethodsApi.session();
    if (!idp.authenticated || !idp.instance_id || !idp.user) return null;
    setPanelSession({
      authMethod: 'idp',
      instanceId: idp.instance_id,
      userKey: '',
      user: idp.user,
    });
    const auth = toAuthState(idp.user, idp.instance_id, '');
    writeAuthCache(auth);
    return auth;
  } catch {
    return null;
  }
}

export default function LoginGate({
  onLoggedIn,
}: {
  onLoggedIn: (auth: AuthState) => void;
}) {
  const { t } = useTranslation();
  const [instances, setInstances] = useState<MetadataInstance[]>([]);
  const [authMethods, setAuthMethods] = useState<AuthMethod[]>([]);
  const [instanceId, setInstanceId] = useState('');
  const [userKey, setUserKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instancesError, setInstancesError] = useState(false);
  const [authMethodsLoaded, setAuthMethodsLoaded] = useState(false);
  const [pendingSso, setPendingSso] = useState<{
    instanceId: string;
    displayName?: string;
    loginName?: string;
    /** 'oidc': OIDC SSO login; 'sso': header-injected Enterprise SSO flow. */
    providerType: 'sso' | 'oidc';
  } | null>(null);
  const [ssoError] = useState<string | null>(() => takeSsoError());
  const [pendingUsername, setPendingUsername] = useState('');
  // First external-auth login: the user_key supplied by the user (required).
  const [pendingUserKey, setPendingUserKey] = useState('');
  // Preview result: null = not previewed; exists=true means the key already belongs to an account in the system (can be bound).
  const [pendingPreview, setPendingPreview] = useState<{
    exists: boolean;
    user_id?: string;
    username?: string;
    display_name?: string;
    user_type?: string;
  } | null>(null);
  const [pendingPreviewing, setPendingPreviewing] = useState(false);
  const [pendingSubmitting, setPendingSubmitting] = useState(false);
  const [dismissingSso, setDismissingSso] = useState(false);
  const [resumingSso, setResumingSso] = useState(false);
  // After account creation, show the auto-generated user_key once (for the user to copy to the client that connects to the proxy).
  const [createdKey, setCreatedKey] = useState<{ userKey: string; user: PublicUser; instanceId: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const hasUserKeyMethod = authMethods.some((method) => method.type === 'user_key');
  const showSsoLogin = authMethodsLoaded && authMethods.some((method) => method.type === 'sso');
  const oidcMethods = authMethodsLoaded ? authMethods.filter((method) => method.type === 'oidc') : [];
  /**
   * The user_key form is always shown directly - there is no "login method selection page" layer.
   *
   * Enabling Enterprise SSO no longer changes the default page: the login page is the user_key form, with SSO as a
   * link below the form. The two login surfaces each embed a link to the other, one click away.
   */
  const showUserKeyLogin = authMethodsLoaded && hasUserKeyMethod;

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    authMethodsApi.session()
      .then((session) => {
        if (!cancelled && session.pending && session.instance_id) {
          const providerType = session.pending_identity?.provider_type === 'oidc' ? 'oidc' : 'sso';
          const loginName = session.pending_identity?.login_name || '';
          setPendingSso({
            instanceId: session.instance_id,
            displayName: session.pending_identity?.display_name,
            loginName,
            providerType,
          });
          setPendingUsername(providerType === 'oidc' ? usernameFrom(loginName) : loginName);
          setInstanceId(session.instance_id);
        }
      })
      .catch(() => undefined);
    authMethodsApi.list()
      .then((result) => {
        if (cancelled) return;
        setAuthMethods(result.methods.filter((method) => method.enabled));
        setAuthMethodsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        // When the config endpoint is unavailable, conservatively fall back to the legacy user_key login to avoid a blank login page.
        setAuthMethods([{ id: 'user_key', type: 'user_key', display_name: 'user_key', enabled: true }]);
        setAuthMethodsLoaded(true);
      });
    metaInstancesApi
      .list()
      .then((list) => {
        if (cancelled) return;
        setInstancesError(false);
        setInstances(list);
        if (list.length > 0) setInstanceId(list[0].instance_id);
      })
      .catch((err) => {
        if (cancelled) return;
        setInstancesError(true);
        setError(t('login.error.loadInstances', { detail: err instanceof Error ? ` (${err.message})` : '' }));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  /** Submit user_key: log in directly after the liveness check passes; an invalid key reports an error (no automatic account creation). */
  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!instanceId) {
      setError(t('login.error.selectInstance'));
      return;
    }
    const key = userKey.trim();
    if (!key) {
      setError(t('login.error.emptyKey'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { valid, user } = await authVerifyApi.verify(instanceId, key);
      if (!valid) {
        setError(t('login.error.invalidKey'));
        setSubmitting(false);
        return;
      }
      if (!user) {
        setError(t('login.error.noUser'));
        setSubmitting(false);
        return;
      }
      const instance = instances.find((i) => i.instance_id === instanceId) ?? null;
      setPanelSession({ authMethod: 'user_key', instanceId, instanceName: instance?.name, userKey: key, user });
      const auth = toAuthState(user, instanceId, instance?.name ?? '');
      writeAuthCache(auth);
      onLoggedIn(auth);
    } catch (err) {
      setError(getErrorMessage(err));
      setSubmitting(false);
    }
  }

  function enterWithAuth(user: PublicUser, instanceId: string) {
    setPanelSession({
      authMethod: 'idp',
      instanceId,
      userKey: '',
      user,
    });
    const auth = toAuthState(user, instanceId, '');
    writeAuthCache(auth);
    onLoggedIn(auth);
  }

  /**
   * Step 1 (preview): query whether the user_key the user entered already has an account in the system.
   * exists=true -> show that account's info for the user to confirm binding (legacy data fully preserved);
   * exists=false -> have the user confirm creating a new account with this key.
   * When the user changes the key the old preview must be cleared, to avoid submitting A's preview result for B.
   */
  async function previewPendingKey() {
    const key = pendingUserKey.trim();
    if (!key) {
      setError(t('login.sso.userKeyRequired'));
      return;
    }
    setPendingPreviewing(true);
    setError(null);
    try {
      setPendingPreview(await authMethodsApi.previewSsoKey(key));
    } catch (err) {
      setError(getErrorMessage(err));
      setPendingPreview(null);
    } finally {
      setPendingPreviewing(false);
    }
  }

  // Step 2 (confirm): bind the existing account or create a new one according to the preview result.
  async function completePendingSso() {
    if (!/^[A-Za-z0-9_-]+$/.test(pendingUsername.trim())) {
      setError(t('login.sso.invalidUsername'));
      return;
    }
    if (!pendingUserKey.trim()) {
      setError(t('login.sso.userKeyRequired'));
      return;
    }
    // The preview must be seen before submitting, so the user confirms knowing whether it is a bind or a create.
    if (!pendingPreview) {
      await previewPendingKey();
      return;
    }
    setPendingSubmitting(true);
    setError(null);
    try {
      const result = await authMethodsApi.completeSso({
        username: pendingUsername.trim(),
        userKey: pendingUserKey.trim(),
      });
      if (!result.user) throw new Error(t('login.error.noUser'));
      const user = result.user;
      // Auto-generated key: show it once for the user to copy and save, then enter the panel;
      // custom key: the user already knows it, enter directly.
      if (result.user_key_autogenerated && result.user_key) {
        setCreatedKey({ userKey: result.user_key, user, instanceId: result.instance_id });
        setPendingSubmitting(false);
      } else {
        enterWithAuth(user, result.instance_id);
      }
    } catch (err) {
      setError(getErrorMessage(err));
      setPendingSubmitting(false);
    }
  }

  /** Turns a failed SSO first-login call into a message the user can act on. */
  function ssoFailure(err: unknown): string {
    switch (apiErrorCode(err)) {
      case 'USERNAME_TAKEN':
        return t('login.sso.usernameTaken', { name: pendingUsername.trim() });
      case 'USER_KEY_NOT_FOUND':
        return t('login.sso.keyNotFound');
      case 'SSO_LOGIN_EXPIRED':
        return t('login.sso.expired');
      default:
        return getErrorMessage(err);
    }
  }

  function finishFirstLogin(result: {
    user?: PublicUser;
    instance_id: string;
    user_key?: string;
    user_key_autogenerated?: boolean;
  }) {
    if (!result.user) throw new Error(t('login.error.noUser'));
    if (result.user_key_autogenerated && result.user_key) {
      setCreatedKey({ userKey: result.user_key, user: result.user, instanceId: result.instance_id });
      setPendingSubmitting(false);
    } else {
      enterWithAuth(result.user, result.instance_id);
    }
  }

  /** First SSO login, new user: create the account (in the default team) with a generated key. */
  async function createSsoAccount() {
    if (!/^[A-Za-z0-9_-]+$/.test(pendingUsername.trim())) {
      setError(t('login.sso.invalidUsername'));
      return;
    }
    setPendingSubmitting(true);
    setError(null);
    try {
      finishFirstLogin(await authMethodsApi.completeSso({ username: pendingUsername.trim(), createNew: true }));
    } catch (err) {
      setError(ssoFailure(err));
      setPendingSubmitting(false);
    }
  }

  /** First SSO login, existing user: link the account their key belongs to (keeps memories and teams). */
  async function linkSsoAccount() {
    const key = pendingUserKey.trim();
    if (!key) {
      setError(t('login.sso.userKeyRequired'));
      return;
    }
    setPendingSubmitting(true);
    setError(null);
    try {
      const preview = await authMethodsApi.previewSsoKey(key);
      if (!preview.exists) {
        setError(t('login.sso.keyNotFound'));
        setPendingSubmitting(false);
        return;
      }
      finishFirstLogin(await authMethodsApi.completeSso({
        username: preview.username || pendingUsername.trim(),
        userKey: key,
      }));
    } catch (err) {
      setError(ssoFailure(err));
      setPendingSubmitting(false);
    }
  }

  function ssoErrorMessage(code: string): string {
    switch (code) {
      case 'OIDC_DENIED':
        return t('login.sso.error.denied');
      case 'OIDC_STATE_INVALID':
        return t('login.sso.expired');
      case 'OIDC_UNAVAILABLE':
        return t('login.sso.error.unavailable');
      default:
        return t('login.sso.error.failed', { code });
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !submitting) void submit();
  }

  /**
   * Enterprise SSO confirmation page -> switch to user_key login.
   *
   * The backend dismiss must be called first: the SSO gateway injects identity headers on every request, so clearing only frontend state
   * would bounce the user right back to the confirmation page on refresh. The backend clears the pending Cookie and issues a suppression marker.
   */
  async function switchToUserKeyFromSso() {
    setDismissingSso(true);
    setError(null);
    try {
      await authMethodsApi.dismissSso();
      setPendingSso(null);
      setPendingUserKey('');
      setPendingPreview(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setDismissingSso(false);
    }
  }

  /**
   * Enterprise SSO button: revoke the suppression marker and return to the original behavior.
   *
   * Must be paired with switchToUserKeyFromSso: revoke the previously set suppression marker,
   * otherwise the SSO ingress middleware lets the request straight through and the user stays on the user_key form.
   *
   * A backend call failure does not block: the suppression marker is session-scoped and expires when the browser is closed.
   */
  async function switchToSso() {
    setResumingSso(true);
    setError(null);
    try {
      await authMethodsApi.resumeSso();
    } catch {
      // Ignore: see the note above, failure does not block.
    }
    setResumingSso(false);
    if (instanceId) authMethodsApi.loginSso(instanceId);
  }

  return (
    <div className="_wamf-login">
      {/* Bright dot-matrix ripple animated background (pure Canvas, zero external dependencies) */}
      <div className="_wamf-login-bg" aria-hidden="true">
        <ParticleWaveBackground
          className="_wamf-login-bg-canvas"
          gap={22}
          dotRadius={1.6}
          speed={1}
        />
      </div>

      {/* Centered content area */}
      <main className="_wamf-login-main">
        <div className="_wamf-login-card">
          <img src="/logo.png" alt="WeaverAI Memory Fabric" className="_wamf-login-logo" />

          <h1 className="_wamf-login-title">{t('login.welcome')}</h1>
          <p className="_wamf-login-subtitle">{t('login.tagline')}</p>

          {pendingSso && createdKey && (
            <div className="_wamf-login-pending">
              <h2 className="_wamf-login-pending-title">{t('login.sso.keyReadyTitle')}</h2>
              <p className="_wamf-login-hint">{t('login.sso.keyReadyHint')}</p>

              <div className="_wamf-login-field">
                <p className="_wamf-login-field-label">{t('login.sso.yourUserKey')}</p>
                <Input
                  size="full"
                  value={createdKey.userKey}
                  readonly
                />
                <Button
                  className="_wamf-login-copy"
                  onClick={() => {
                    void navigator.clipboard?.writeText(createdKey.userKey);
                    setCopied(true);
                  }}
                >
                  {copied ? t('login.sso.copied') : t('login.sso.copyKey')}
                </Button>
                <p className="_wamf-login-hint _wamf-login-warn">{t('login.sso.keyReadyWarn')}</p>
              </div>

              <Button
                type="primary"
                className="_wamf-login-submit"
                onClick={() => enterWithAuth(createdKey.user, createdKey.instanceId)}
              >
                {t('login.sso.savedEnter')}
              </Button>
            </div>
          )}

          {pendingSso?.providerType === 'oidc' && !createdKey && (
            <div className="_wamf-login-pending">
              <h2 className="_wamf-login-pending-title">
                {t('login.sso.firstTitle', { name: pendingSso.displayName || pendingSso.loginName || '' })}
              </h2>
              <p className="_wamf-login-hint">{t('login.sso.firstHint')}</p>

              <div className="_wamf-login-field">
                <p className="_wamf-login-field-label">{t('login.sso.usernameLabel')}</p>
                <Input
                  size="full"
                  value={pendingUsername}
                  onChange={(value) => {
                    setPendingUsername(value);
                    setError(null);
                  }}
                  placeholder={t('login.sso.usernamePlaceholder')}
                  disabled={pendingSubmitting}
                />
              </div>

              {error && (
                <div className="_wamf-login-alert">
                  <Alert type="error">{error}</Alert>
                </div>
              )}

              <Button
                type="primary"
                className="_wamf-login-submit"
                onClick={() => void createSsoAccount()}
                loading={pendingSubmitting && !pendingUserKey.trim()}
                disabled={pendingSubmitting || !pendingUsername.trim()}
              >
                {t('login.sso.createAccount')}
              </Button>

              <p className="_wamf-login-divider">{t('login.sso.haveAccount')}</p>
              <div className="_wamf-login-field">
                <Input.Password
                  size="full"
                  value={pendingUserKey}
                  onChange={(value) => {
                    setPendingUserKey(value);
                    setError(null);
                  }}
                  placeholder={t('login.placeholder.userKey')}
                  disabled={pendingSubmitting}
                  rules={false}
                />
                <p className="_wamf-login-hint">{t('login.sso.linkHint')}</p>
              </div>
              <Button
                type="weak"
                className="_wamf-login-submit"
                onClick={() => void linkSsoAccount()}
                loading={pendingSubmitting && !!pendingUserKey.trim()}
                disabled={pendingSubmitting || !pendingUserKey.trim()}
              >
                {t('login.sso.linkAccount')}
              </Button>
            </div>
          )}

          {pendingSso?.providerType === 'sso' && !createdKey && (
            <div className="_wamf-login-pending">
              <h2 className="_wamf-login-pending-title">{t('login.sso.pendingTitle')}</h2>
              <p className="_wamf-login-hint">
                {t('login.sso.pendingIdentity', { name: pendingSso.displayName || pendingSso.loginName || 'SSO user' })}
              </p>

              <div className="_wamf-login-field">
                <p className="_wamf-login-field-label">{t('login.sso.usernameLabel')}</p>
                <Input
                  size="full"
                  value={pendingUsername}
                  onChange={(value) => {
                    setPendingUsername(value);
                    setError(null);
                  }}
                  placeholder={t('login.sso.usernamePlaceholder')}
                  disabled={pendingSubmitting}
                />
                <p className="_wamf-login-hint">{t('login.sso.usernameHint')}</p>
              </div>

              <div className="_wamf-login-field">
                <p className="_wamf-login-field-label">{t('login.sso.userKeyLabel')}</p>
                <Input
                  size="full"
                  value={pendingUserKey}
                  onChange={(value) => {
                    setPendingUserKey(value);
                    // The key changed, so the old preview is invalidated immediately - otherwise A's preview result would be used to submit B.
                    setPendingPreview(null);
                    setError(null);
                  }}
                  placeholder={t('login.sso.userKeyPlaceholder')}
                  disabled={pendingSubmitting}
                />
                <p className="_wamf-login-hint">{t('login.sso.userKeyHint')}</p>
              </div>

              {/* Preview result: let the user see whose key this is before deciding to bind or create */}
              {pendingPreview && (
                <div className="_wamf-login-alert">
                  {pendingPreview.exists ? (
                    <Alert type="info">
                      {t('login.sso.keyExistsHint', {
                        name: pendingPreview.display_name || pendingPreview.username || pendingPreview.user_id || '',
                      })}
                    </Alert>
                  ) : (
                    <Alert type="info">{t('login.sso.keyMissingHint')}</Alert>
                  )}
                </div>
              )}

              {error && (
                <div className="_wamf-login-alert">
                  <Alert type="error">{error}</Alert>
                </div>
              )}

              <Button
                type="primary"
                className="_wamf-login-submit"
                onClick={() => void completePendingSso()}
                loading={pendingSubmitting || pendingPreviewing}
                disabled={pendingSubmitting || pendingPreviewing || !pendingUsername.trim() || !pendingUserKey.trim()}
              >
                {/* Not previewed = Next (first see who owns the key); previewed = clearly state whether this is a bind or a create */}
                {!pendingPreview
                  ? t('login.sso.previewNext')
                  : pendingPreview.exists
                    ? t('login.sso.confirmBind')
                    : t('login.sso.confirmCreate')}
              </Button>

              {/* Legacy users who already have a user_key should not be forced to create an account: offer an exit back to user_key login */}
              {hasUserKeyMethod && (
                <div className="_wamf-login-switch">
                  <Button
                    type="link"
                    className="_wamf-login-switch-link"
                    onClick={() => void switchToUserKeyFromSso()}
                    loading={dismissingSso}
                    disabled={pendingSubmitting || dismissingSso}
                  >
                    {t('login.switchUserKey')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {!pendingSso && oidcMethods.length > 0 && (
            <div className="_wamf-login-sso">
              {ssoError && (
                <div className="_wamf-login-alert">
                  <Alert type="error">{ssoErrorMessage(ssoError)}</Alert>
                </div>
              )}
              {oidcMethods.map((method) => (
                <Button
                  key={method.id}
                  type="primary"
                  className="_wamf-login-submit"
                  disabled={!instanceId}
                  onClick={() => authMethodsApi.loginOidc(method.id, instanceId)}
                >
                  {t('login.sso.signIn', { name: method.display_name })}
                </Button>
              ))}
              {showUserKeyLogin && <p className="_wamf-login-divider">{t('login.sso.orKey')}</p>}
            </div>
          )}

          {!pendingSso && showUserKeyLogin && (
            <form onSubmit={submit} className="_wamf-login-form">
            {/* Memory instance selection - GET /api/v1/meta/instances */}
            <div className="_wamf-login-field">
              <label className="_wamf-login-label" htmlFor="wamf-login-instance">
                {t('login.field.instance')}
              </label>
              <Select
                appearance="button"
                size="full"
                value={instanceId}
                onChange={(value) => {
                  setInstanceId(value);
                  setError(null);
                }}
                disabled={submitting || instances.length === 0}
                placeholder={
                  instancesError ? t('login.placeholder.instanceError') : t('login.placeholder.instance')
                }
                options={instances.map((inst) => ({ value: inst.instance_id, text: inst.name }))}
                boxSizeSync
              />
            </div>

            {/* user_key (sk-mem-...), written to the frontend session after the auth/verify liveness check */}
            <div className="_wamf-login-field">
              <label className="_wamf-login-label" htmlFor="wamf-login-key">
                {t('login.field.userKey')}
              </label>
              <Input.Password
                size="full"
                value={userKey}
                onChange={(value) => {
                  setUserKey(value);
                  setError(null);
                }}
                onKeyDown={onKeyDown}
                placeholder={t('login.placeholder.userKey')}
                autoComplete="current-password"
                disabled={submitting}
                rules={false}
              />
              <p className="_wamf-login-hint">{t('login.hint.userKey')}</p>
            </div>

            {error && (
              <div className="_wamf-login-alert">
                <Alert type="error">{error}</Alert>
              </div>
            )}

            <Button
              type={oidcMethods.length > 0 ? 'weak' : 'primary'}
              htmlType="submit"
              className="_wamf-login-submit"
              loading={submitting}
              disabled={submitting || !userKey.trim() || !instanceId}
            >
              {submitting ? t('login.submitting') : t('login.submit')}
            </Button>
            </form>
          )}

          {/* Enterprise SSO entry below the user_key form */}
          {!pendingSso && showSsoLogin && showUserKeyLogin && instanceId && (
            <div className="_wamf-login-switch">
              <Button
                type="link"
                className="_wamf-login-switch-link"
                onClick={() => void switchToSso()}
                loading={resumingSso}
                disabled={submitting || resumingSso}
              >
                {t('login.useSso')}
              </Button>
            </div>
          )}
        </div>

        <p className="_wamf-login-footer">{t('login.footer')}</p>
      </main>
    </div>
  );
}
