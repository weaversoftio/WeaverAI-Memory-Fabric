import type { Context, Hono, Next } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { buildExpiredSessionCookie, buildSessionCookie, buildTransientCookie, readCookie } from '../../auth/cookies.js';
import { PanelAuthError } from '../../auth/service.js';

const INSTANCE_QUERY = 'instance_id';
const RETURN_QUERY = 'return_to';
const PENDING_SSO_COOKIE = 'wamf_sso_pending';
const PENDING_SSO_TTL_SECONDS = 300;
/** Encrypted OIDC login state (state, nonce, PKCE verifier) between the redirect to the IdP and its callback. */
const OIDC_STATE_COOKIE = 'wamf_oidc_state';
const OIDC_STATE_TTL_SECONDS = 600;
/**
 * Suppression Cookie for "switch to user_key login this time".
 *
 * The upstream gateway injects the identity header on every request, and the middleware registered for the Enterprise SSO ingress route
 * rebuilds the pending login on every access to the root path. So "switch to user_key" cannot just clear the pending
 * Cookie; it must additionally drop a suppression marker, otherwise refreshing the page would immediately bounce back to the Enterprise SSO confirmation page.
 *
 * A Cookie rather than server memory: it stays valid after a process restart and needs no session table.
 * It stores only a constant value with no identity information, to avoid writing identifiable data to the browser.
 *
 * It must be **session-scoped** (no Max-Age). A 12h persistent Cookie was mistakenly used before, and the frontend logout() does not call the backend
 * /auth/logout (the new panel has no server-side session; logout only clears localStorage), so once the marker was dropped it
 * could not be cleared: after a user clicked "switch to user_key login" once, they could never enter the Enterprise SSO flow again for 12 hours.
 * Session scope guarantees it expires when the browser closes, limiting the impact to "this browsing session".
 */
const SSO_DISMISSED_COOKIE = 'wamf_sso_dismissed';
const SSO_DISMISSED_VALUE = '1';

function headersOf(c: { req: { raw: Request } }): Record<string, string | undefined> {
  return Object.fromEntries(c.req.raw.headers.entries());
}

function returnTo(value: string | undefined): string {
  // Browsers read "/\evil.com" as "//evil.com" and drop control characters: same-origin paths only.
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  return value;
}

/** Login page URL carrying an SSO failure code for the login screen to show. */
function ssoErrorUrl(err: unknown): string {
  const code = typeof err === 'string' ? err : err instanceof PanelAuthError ? err.code : 'OIDC_LOGIN_FAILED';
  return `/?sso_error=${encodeURIComponent(code)}`;
}

function handleAuthError(c: Context, err: unknown): Response {
  if (err instanceof PanelAuthError) {
    return c.json(
      { code: err.status, message: err.code, request_id: c.get('reqId') ?? '', data: null },
      err.status as 400 | 401 | 403 | 404 | 500,
    );
  }
  throw err;
}

/**
 * Browsers send Origin on cross-site POSTs (a form post from a sibling subdomain is
 * same-site, so SameSite=Lax cookies alone do not stop it). Auth state changes only
 * accept our own origin; non-browser callers (memory-mcp) send no Origin.
 */
function sameOrigin(origin: string | undefined, host: string | undefined, appUrl: string): boolean {
  if (!origin) return true;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (appUrl) {
    try {
      return o.origin === new URL(appUrl).origin;
    } catch {
      // fall through to the Host comparison
    }
  } else if (o.hostname === 'localhost' || o.hostname === '127.0.0.1') {
    return true; // local dev (vite proxy rewrites Host)
  }
  return !!host && o.host === host;
}

export function registerAuthRoutes(api: Hono, deps: PanelDeps): void {
  api.use('/auth/*', async (c, next) => {
    if (c.req.method === 'POST' && !sameOrigin(c.req.header('origin'), c.req.header('host'), deps.config.auth.appUrl)) {
      return c.json({ code: 403, message: 'CROSS_ORIGIN_REQUEST', data: null }, 403);
    }
    await next();
  });

  api.get('/auth/methods', (c) => c.json({ methods: deps.auth.listMethods() }));

  /**
   * The four Enterprise SSO-specific GET routes are targets of **full-page browser navigation** (the user clicks a link / the gateway redirects directly),
   * not fetch calls. When Enterprise SSO is not enabled they must not return a bare JSON 404 and leave the browser on an error page -- they must redirect back to the
   * login page root path, handing it back to the SPA to show the user_key form, so it "works the same as before Enterprise SSO was developed".
   * This only affects those four GET routes; POST endpoints (dismiss/resume/bind/preview-key/complete)
   * are fetch calls, and JSON errors are unaffected.
   */
  const isSsoEnabled = () => deps.auth.listMethods().some((m) => m.type === 'sso');

  const login = (c: Context) => {
    if (!isSsoEnabled()) return c.redirect('/', 302);
    try {
      const instanceId = c.req.query(INSTANCE_QUERY);
      if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
      const url = deps.auth.buildSsoLoginUrl(instanceId, returnTo(c.req.query(RETURN_QUERY)));
      return c.redirect(url, 302);
    } catch (err) {
      return handleAuthError(c, err);
    }
  };
  api.get('/auth/idp/sso/login', login);
  api.get('/auth/idp/sso/authorize', login);

  api.get('/auth/idp/sso/callback', async (c: Context) => {
    if (!isSsoEnabled()) return c.redirect('/', 302);
    try {
      const instanceId = c.req.query(INSTANCE_QUERY);
      if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
      const result = await deps.auth.completeSsoLogin(
        instanceId,
        headersOf(c),
        returnTo(c.req.query(RETURN_QUERY)),
        c.get('reqId'),
      );
      c.header('Set-Cookie', buildSessionCookie(
        deps.config.auth.sessionCookieName,
        result.session.token,
        deps.config.auth.sessionTtlSeconds,
        deps.config.auth.sessionSecure,
      ));
      return c.redirect(returnTo(c.req.query(RETURN_QUERY)), 302);
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  api.get('/auth/session', (c: Context) => {
    const session = deps.auth.getSession(readCookie(c.req.header('cookie'), deps.config.auth.sessionCookieName));
    if (!session) {
      const pending = deps.auth.getPendingSsoLogin(readCookie(c.req.header('cookie'), PENDING_SSO_COOKIE));
      if (!pending) return c.json({ authenticated: false }, 200);
      return c.json({
        authenticated: false,
        pending: true,
        instance_id: pending.instanceId,
        pending_identity: {
          display_name: pending.identity.displayName,
          login_name: pending.identity.loginName,
          subject: pending.identity.subject,
          provider_id: pending.identity.providerId,
          provider_type: deps.auth.hasOidcProvider(pending.identity.providerId) ? 'oidc' : 'sso',
        },
      }, 200);
    }
    const requestedInstance = c.req.query(INSTANCE_QUERY);
    if (requestedInstance && requestedInstance !== session.instanceId) {
      return c.json({ authenticated: false }, 200);
    }
    return c.json({
      authenticated: true,
      method: 'idp',
      instance_id: session.instanceId,
      user_id: session.coreUserId,
      provider_id: session.providerId,
      external_subject: session.externalSubject,
      display_name: session.displayName,
      user: session.user,
      expires_at: session.expiresAt,
    });
  });

  // -- user_key login (compatible with users holding their own key) --
  //
  // A pair of endpoints parallel to the Enterprise SSO flow, but **not depending on the pending Cookie**: the user enters their own key directly,
  // and if the system does not have it, it is used to create an account (registered on first login). Two-step confirmation (preview -> confirm) prevents wrong binding.
  //
  // Goes through the Panel rather than the frontend connecting to core directly: account creation needs instance admin credentials, which the frontend cannot get,
  // and auth/verify is a read-only probe that cannot create accounts.
  api.post('/auth/user-key/preview', async (c: Context) => {
    try {
      const body = await c.req.json().catch(() => ({})) as {
        instance_id?: unknown;
        user_key?: unknown;
      };
      const instanceId = typeof body.instance_id === 'string' ? body.instance_id : '';
      if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
      const preview = await deps.auth.previewUserKeyLogin({
        instanceId,
        userKey: typeof body.user_key === 'string' ? body.user_key : '',
        requestId: c.get('reqId'),
      });
      return c.json(preview);
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  api.post('/auth/user-key/login', async (c: Context) => {
    try {
      const body = await c.req.json().catch(() => ({})) as {
        instance_id?: unknown;
        user_key?: unknown;
        username?: unknown;
      };
      const instanceId = typeof body.instance_id === 'string' ? body.instance_id : '';
      if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
      const result = await deps.auth.loginWithUserKey({
        instanceId,
        userKey: typeof body.user_key === 'string' ? body.user_key : '',
        username: typeof body.username === 'string' ? body.username : undefined,
        requestId: c.get('reqId'),
      });
      return c.json({
        authenticated: true,
        instance_id: instanceId,
        user_id: result.user_id,
        user: result.user,
        created: result.created,
      });
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  // Preview: whether the user_key the user entered already has a corresponding account in the system.
  // The anti-wrong-binding step of first external-auth login -- first let the user see clearly "whom this key belongs to",
  // then decide whether to bind it or create a new one, instead of silently deciding for the user.
  api.post('/auth/idp/sso/preview-key', async (c: Context) => {
    try {
      const token = readCookie(c.req.header('cookie'), PENDING_SSO_COOKIE);
      if (!token) return c.json({ code: 401, message: 'SSO_LOGIN_PENDING_REQUIRED', data: null }, 401);
      const body = await c.req.json().catch(() => ({})) as { user_key?: unknown };
      const userKey = typeof body.user_key === 'string' ? body.user_key : '';
      const preview = await deps.auth.previewPendingSsoLogin({
        token,
        userKey,
        requestId: c.get('reqId'),
      });
      return c.json(preview);
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  api.post('/auth/idp/sso/complete', async (c: Context) => {
    try {
      const token = readCookie(c.req.header('cookie'), PENDING_SSO_COOKIE);
      if (!token) return c.json({ code: 401, message: 'SSO_LOGIN_PENDING_REQUIRED', data: null }, 401);
      const body = await c.req.json().catch(() => ({})) as {
        username?: unknown;
        user_key?: unknown;
        custom_user_key?: unknown;
        create_new?: unknown;
      };
      const result = await deps.auth.completePendingSsoLogin({
        token,
        username: typeof body.username === 'string' ? body.username : undefined,
        userKey: typeof body.user_key === 'string' ? body.user_key : undefined,
        customUserKey: typeof body.custom_user_key === 'string' ? body.custom_user_key : undefined,
        createNew: body.create_new === true,
        requestId: c.get('reqId'),
      });
      c.header('Set-Cookie', buildExpiredSessionCookie(PENDING_SSO_COOKIE, deps.config.auth.sessionSecure));
      // The user has completed login via Enterprise SSO; the suppression marker is no longer needed, clear it so it does not affect the next login.
      c.header('Set-Cookie', buildExpiredSessionCookie(SSO_DISMISSED_COOKIE, deps.config.auth.sessionSecure), { append: true });
      c.header('Set-Cookie', buildSessionCookie(
        deps.config.auth.sessionCookieName,
        result.session.token,
        deps.config.auth.sessionTtlSeconds,
        deps.config.auth.sessionSecure,
      ), { append: true });
      return c.json({
        authenticated: true,
        instance_id: result.session.instanceId,
        user_id: result.session.coreUserId,
        user: result.session.user,
        // Return the newly created account's user_key once, for the user to copy into clients such as CodeBuddy/ClaudeCode to connect to the proxy.
        // A custom key is provided by the user and need not be echoed; an auto-generated key is visible only this once.
        user_key: result.userKeyDisplay ?? undefined,
        user_key_autogenerated: result.userKeyAutogenerated ?? false,
      });
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  // "Switch to user_key login": clear the Enterprise SSO pending state + drop the suppression marker, so the login page stays on the user_key form.
  // The suppression marker is cleared on successful login (user_key or IdP), so it does not affect the next normal login.
  api.post('/auth/idp/sso/dismiss', (c: Context) => {
    const pendingToken = readCookie(c.req.header('cookie'), PENDING_SSO_COOKIE);
    deps.auth.dismissPendingSsoLogin(pendingToken);
    c.header('Set-Cookie', buildExpiredSessionCookie(PENDING_SSO_COOKIE, deps.config.auth.sessionSecure));
    // Session-scoped (no Max-Age): expires when the browser closes, so a "temporary choice" does not become cross-day persistent state.
    c.header('Set-Cookie', buildTransientCookie(
      SSO_DISMISSED_COOKIE,
      SSO_DISMISSED_VALUE,
      deps.config.auth.sessionSecure,
    ), { append: true });
    return c.json({ ok: true });
  });

  // "Switch back to Enterprise SSO login": clear the suppression marker. dismiss is a reversible temporary choice; the user can switch back at any time.
  api.post('/auth/idp/sso/resume', (c: Context) => {
    c.header('Set-Cookie', buildExpiredSessionCookie(SSO_DISMISSED_COOKIE, deps.config.auth.sessionSecure));
    return c.json({ ok: true });
  });

  api.post('/auth/logout', (c: Context) => {
    const token = readCookie(c.req.header('cookie'), deps.config.auth.sessionCookieName);
    deps.auth.destroySession(token);
    c.header('Set-Cookie', buildExpiredSessionCookie(
      deps.config.auth.sessionCookieName,
      deps.config.auth.sessionSecure,
    ));
    // Logging out means the "this time" choice has ended; clear the suppression marker so the next login returns to the default (Enterprise SSO) entry.
    c.header('Set-Cookie', buildExpiredSessionCookie(SSO_DISMISSED_COOKIE, deps.config.auth.sessionSecure), { append: true });
    return c.json({ ok: true });
  });

  api.get('/auth/idp/sso/logout', (c: Context) => {
    const token = readCookie(c.req.header('cookie'), deps.config.auth.sessionCookieName);
    deps.auth.destroySession(token);
    c.header('Set-Cookie', buildExpiredSessionCookie(
      deps.config.auth.sessionCookieName,
      deps.config.auth.sessionSecure,
    ));
    c.header('Set-Cookie', buildExpiredSessionCookie(SSO_DISMISSED_COOKIE, deps.config.auth.sessionSecure), { append: true });
    if (!isSsoEnabled()) return c.redirect('/', 302);
    try {
      return c.redirect(deps.auth.buildSsoLogoutUrl(returnTo(c.req.query(RETURN_QUERY))), 302);
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  // ── OIDC (e.g. Keycloak) ─────────────────────────────────────────────
  //
  // Full-page browser navigations, so failures redirect to the login page with ?sso_error=CODE
  // instead of answering JSON. A provider id that isn't an OIDC provider falls through, so
  // these never shadow the Enterprise SSO routes above.

  // Logout for any IdP session: drop the panel session, then end the IdP session too.
  api.get('/auth/idp/logout', async (c: Context) => {
    const token = readCookie(c.req.header('cookie'), deps.config.auth.sessionCookieName);
    const session = deps.auth.getSession(token);
    deps.auth.destroySession(token);
    c.header('Set-Cookie', buildExpiredSessionCookie(deps.config.auth.sessionCookieName, deps.config.auth.sessionSecure));
    return c.redirect(await deps.auth.buildIdpLogoutUrl(session), 302);
  });

  api.get('/auth/idp/:provider/login', async (c: Context, next: Next) => {
    const providerId = c.req.param('provider') ?? '';
    if (!deps.auth.hasOidcProvider(providerId)) return next();
    const instanceId = c.req.query(INSTANCE_QUERY) || deps.instanceRegistry.listAll()[0]?.instance_id;
    if (!instanceId) return c.redirect(ssoErrorUrl('MISSING_INSTANCE_ID'), 302);
    try {
      const { url, stateToken } = await deps.auth.beginOidcLogin({
        providerId,
        instanceId,
        returnTo: returnTo(c.req.query(RETURN_QUERY)),
      });
      c.header('Set-Cookie', buildSessionCookie(OIDC_STATE_COOKIE, stateToken, OIDC_STATE_TTL_SECONDS, deps.config.auth.sessionSecure));
      return c.redirect(url, 302);
    } catch (err) {
      return c.redirect(ssoErrorUrl(err), 302);
    }
  });

  api.get('/auth/idp/:provider/callback', async (c: Context, next: Next) => {
    const providerId = c.req.param('provider') ?? '';
    if (!deps.auth.hasOidcProvider(providerId)) return next();
    const secure = deps.config.auth.sessionSecure;
    c.header('Set-Cookie', buildExpiredSessionCookie(OIDC_STATE_COOKIE, secure));
    // The IdP reports a refusal or failure as ?error=... (e.g. the user cancelled).
    if (c.req.query('error')) {
      deps.logger.warn('OIDC login refused by the identity provider', {
        error: c.req.query('error'),
        description: c.req.query('error_description'),
      });
      return c.redirect(ssoErrorUrl('OIDC_DENIED'), 302);
    }
    try {
      const result = await deps.auth.completeOidcLogin({
        providerId,
        stateToken: readCookie(c.req.header('cookie'), OIDC_STATE_COOKIE),
        state: c.req.query('state'),
        code: c.req.query('code'),
        requestId: c.get('reqId'),
      });
      if (result.kind === 'pending') {
        c.header('Set-Cookie', buildSessionCookie(PENDING_SSO_COOKIE, result.pending.token, PENDING_SSO_TTL_SECONDS, secure), { append: true });
        return c.redirect('/', 302);
      }
      c.header('Set-Cookie', buildSessionCookie(
        deps.config.auth.sessionCookieName,
        result.session.token,
        deps.config.auth.sessionTtlSeconds,
        secure,
      ), { append: true });
      c.header('Set-Cookie', buildExpiredSessionCookie(PENDING_SSO_COOKIE, secure), { append: true });
      return c.redirect(result.returnTo, 302);
    } catch (err) {
      return c.redirect(ssoErrorUrl(err), 302);
    }
  });

  // MCP servers behind the WAIP MCP proxy exchange the platform's signed caller identity
  // (X-WAIP-Identity) for that person's user_key, so agents need no key of their own.
  // Errors carry the human-readable reason in `message` (the MCP shows it to the agent).
  api.post('/auth/waip/exchange', async (c: Context) => {
    const instanceId = c.req.header('X-Wamf-Service-Id')?.trim() || deps.instanceRegistry.listAll()[0]?.instance_id;
    const assertion = c.req.header('X-WAIP-Identity')?.trim();
    const fail = (status: number, code: string, message: string) =>
      c.json({ code: status, message, request_id: c.get('reqId') ?? '', data: { error: code } }, status as 400 | 401 | 403 | 404 | 500);
    if (!instanceId) return fail(400, 'MISSING_INSTANCE_ID', 'missing X-Wamf-Service-Id');
    if (!assertion) return fail(401, 'MISSING_WAIP_IDENTITY', 'missing X-WAIP-Identity');
    try {
      const { userKey, user } = await deps.auth.exchangeWaipIdentity(instanceId, assertion, c.get('reqId'));
      return c.json({ code: 0, message: 'ok', request_id: c.get('reqId') ?? '', data: { user_key: userKey, user } });
    } catch (err) {
      if (err instanceof PanelAuthError) return fail(err.status, err.code, err.message);
      throw err;
    }
  });

  api.post('/auth/idp/sso/bind', async (c: Context) => {
    try {
      const instanceId = c.req.header('X-Wamf-Service-Id')?.trim();
      const userKey = c.req.header('X-Wamf-User-Key')?.trim();
      if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
      if (!userKey) return c.json({ code: 400, message: 'MISSING_USER_KEY', data: null }, 400);
      const result = await deps.auth.bindSsoIdentity(instanceId, userKey, headersOf(c), c.get('reqId'));
      return c.json({ code: 0, message: 'ok', request_id: c.get('reqId') ?? '', data: result });
    } catch (err) {
      return handleAuthError(c, err);
    }
  });
}

export function registerSsoIngressRoutes(app: Hono, deps: PanelDeps): void {
  // All Providers using the "gateway-injected identity header" mode (currently only Enterprise SSO) enter through this middleware:
  // iterate the registered header-injected Providers; a hit on any provider's ingressHeaderName
  // counts as a login request initiated by it. To add a second Provider of the same kind later (e.g. Enterprise SSO), just register one in the
  // registry; this middleware needs no change.
  const headerProviders = deps.auth.listHeaderInjectedProviders();
  if (headerProviders.length === 0) return;
  app.get('*', async (c: Context, next: Next) => {
    // The gateway's redirect-back target is the APP_URL root path, and the identity is injected by the gateway via request headers.
    if (c.req.path !== '/') return next();
    // Find the first matching Provider in registration order. No match -> let it pass (keeping "same as before development when no IdP is enabled").
    const matched = headerProviders.find((p) => c.req.header(p.ingressHeaderName));
    if (!matched) return next();
    // The user has explicitly chosen to switch to user_key login: do not automatically enter the IdP flow this time.
    if (readCookie(c.req.header('cookie'), SSO_DISMISSED_COOKIE) === SSO_DISMISSED_VALUE) return next();
    const sessionToken = readCookie(c.req.header('cookie'), deps.config.auth.sessionCookieName);
    const pendingToken = readCookie(c.req.header('cookie'), PENDING_SSO_COOKIE);
    if (deps.auth.getSession(sessionToken) || deps.auth.getPendingSsoLogin(pendingToken)) return next();
    const instanceId = c.req.query(INSTANCE_QUERY) || deps.instanceRegistry.listAll()[0]?.instance_id;
    if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
    const returnPath = returnTo(c.req.query(RETURN_QUERY));
    try {
      const result = await deps.auth.completeSsoLogin(
        instanceId,
        headersOf(c),
        returnPath,
        c.get('reqId'),
      );
      c.header('Set-Cookie', buildSessionCookie(
        deps.config.auth.sessionCookieName,
        result.session.token,
        deps.config.auth.sessionTtlSeconds,
        deps.config.auth.sessionSecure,
      ));
      return c.redirect(returnPath, 302);
    } catch (err) {
      if (err instanceof PanelAuthError && err.code === 'IDENTITY_NOT_BOUND') {
        const pending = await deps.auth.createPendingSsoLogin({
          instanceId,
          headers: headersOf(c),
        });
        c.header('Set-Cookie', buildSessionCookie(
          PENDING_SSO_COOKIE,
          pending.token,
          PENDING_SSO_TTL_SECONDS,
          deps.config.auth.sessionSecure,
        ));
        return c.redirect(returnPath, 302);
      }
      return handleAuthError(c, err);
    }
  });
}
