import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import { PanelAuthError, PanelAuthService } from '../../../src/panel/auth/service.js';
import { OidcProvider } from '../../../src/panel/auth/oidc-provider.js';
import { InstanceRegistry } from '../../../src/panel/config/instance-registry.js';
import type { PanelAuthConfig } from '../../../src/panel/config/panel-config.js';
import type { Logger } from '../../../src/panel/infra/logger.js';
import type { MetaKernelPort } from '../../../src/panel/kernel/ports/meta-kernel-port.js';

const PUBLIC_ISSUER = 'https://auth.example.com/realms/acme';
const INTERNAL_ISSUER = 'http://keycloak.platform.svc/realms/acme';
const APP_URL = 'https://memory.example.com';
const ADMIN_KEY = 'sk-mem-admin-key-0001';
const PLATFORM_JWKS = 'http://platform.test/api/auth/jwks.json';
/** Like production: the instance api_key is a placeholder, the admin key comes from a mounted file. */
const PLACEHOLDER_API_KEY = 'local';
const ADMIN_ONLY = new Set([
  'user/create', 'user/create-with-key', 'user/bind-external', 'user/find-by-external', 'user/list',
  'user-key/create', 'team/list', 'team/create', 'team-member/add',
]);

interface IdpUser {
  preferred_username: string;
  name?: string;
  email?: string;
}

/**
 * Fake Keycloak. Discovery advertises the public hostname (as Keycloak does with KC_HOSTNAME set),
 * so the provider must rewrite server-side calls to the in-cluster issuer.
 */
async function fakeIdp() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { nonce: string; challenge: string; user: IdpUser }>();
  const calls: string[] = [];
  let signingKey: CryptoKey = privateKey;
  let audience = 'agent-memory';
  let next = 0;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url === `${INTERNAL_ISSUER}/.well-known/openid-configuration`) {
      return json({
        issuer: PUBLIC_ISSUER,
        authorization_endpoint: `${PUBLIC_ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${PUBLIC_ISSUER}/protocol/openid-connect/token`,
        jwks_uri: `${PUBLIC_ISSUER}/protocol/openid-connect/certs`,
        end_session_endpoint: `${PUBLIC_ISSUER}/protocol/openid-connect/logout`,
      });
    }
    if (url === `${INTERNAL_ISSUER}/protocol/openid-connect/certs`) return json({ keys: [jwk] });
    if (url === `${INTERNAL_ISSUER}/protocol/openid-connect/token`) {
      const form = new URLSearchParams(String(init?.body));
      const grant = codes.get(form.get('code') ?? '');
      if (!grant || form.get('client_secret') !== 'shh' || form.get('redirect_uri') !== `${APP_URL}/api/v1/auth/idp/keycloak/callback`) {
        return json({ error: 'invalid_grant' }, 400);
      }
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== grant.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
      codes.delete(form.get('code') ?? '');
      const idToken = await new SignJWT({ ...grant.user, nonce: grant.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(PUBLIC_ISSUER)
        .setAudience(audience)
        .setSubject(`kc-${grant.user.preferred_username}`)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signingKey);
      return json({ id_token: idToken, access_token: 'unused' });
    }
    return json({ error: 'not_found' }, 404);
  };

  return {
    fetchImpl,
    calls,
    /** What the browser does at the IdP: the user signs in, the IdP redirects back with a code. */
    authorize(authorizeUrl: string, user: IdpUser): string {
      const url = new URL(authorizeUrl);
      const code = `code-${++next}`;
      codes.set(code, {
        nonce: url.searchParams.get('nonce') ?? '',
        challenge: url.searchParams.get('code_challenge') ?? '',
        user,
      });
      return code;
    },
    async rotateToForeignKey() {
      signingKey = (await generateKeyPair('RS256')).privateKey;
    },
    setAudience(value: string) {
      audience = value;
    },
  };
}

/** Fake WAIP platform: publishes its JWKS and mints X-WAIP-Identity assertions like the MCP proxy. */
async function fakePlatform() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'p1', alg: 'RS256', use: 'sig' };
  const foreign = (await generateKeyPair('RS256')).privateKey;
  return {
    jwks: { keys: [jwk] },
    assertion(username: string, opts: { audience?: string; issuer?: string; key?: CryptoKey } = {}) {
      return new SignJWT({ preferred_username: username, email: `${username}@example.com` })
        .setProtectedHeader({ alg: 'RS256', kid: 'p1' })
        .setIssuer(opts.issuer ?? 'weaverai-platform')
        .setAudience(opts.audience ?? 'mcp:memory-mcp')
        .setSubject(username)
        .setIssuedAt()
        .setExpirationTime('2m')
        .sign(opts.key ?? privateKey);
    },
    foreign,
  };
}

/** In-memory core metadata API: just the actions the auth service calls. */
function fakeCore() {
  type User = { user_id: string; username: string; key: string; external_id?: string; auth_provider: string; user_type: string };
  const users: User[] = [{ user_id: 'usr-admin', username: 'admin', key: ADMIN_KEY, auth_provider: 'local', user_type: 'system_admin' }];
  const teams: Array<{ team_id: string; name: string; owner_user_id: string }> = [];
  const members: Array<{ team_id: string; user_id: string; role: string }> = [];
  const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
  let seq = 0;
  const ok = (data: unknown) => ({ code: 0, message: 'ok', request_id: '', data });
  const fail = (code: number, message: string) => ({ code, message, request_id: '', data: null });
  const pub = (u: User) => ({ user_id: u.user_id, username: u.username, user_type: u.user_type });

  const kernel: MetaKernelPort = {
    async invoke(action, body, ctx) {
      calls.push({ action, body });
      if (ADMIN_ONLY.has(action) && ctx.userKey !== ADMIN_KEY) return fail(401, 'unauthorized: invalid_user_key');
      switch (action) {
        case 'auth/verify': {
          const u = users.find((x) => x.key === body.user_key);
          return ok(u ? { valid: true, user: pub(u) } : { valid: false, user: null });
        }
        case 'user/create':
        case 'user/create-with-key': {
          const u: User = {
            user_id: `usr-${++seq}`,
            username: String(body.username),
            key: action === 'user/create' ? `sk-mem-generated-${seq}` : String(body.user_key),
            external_id: body.external_id as string | undefined,
            auth_provider: (body.auth_provider as string) ?? 'local',
            user_type: 'normal',
          };
          users.push(u);
          return ok({ user_id: u.user_id, default_user_key: u.key });
        }
        case 'user/bind-external': {
          const u = users.find((x) => x.user_id === body.user_id);
          if (u) u.external_id = String(body.external_id);
          return ok({});
        }
        case 'user/find-by-external': {
          const u = users.find((x) => x.external_id === body.external_id && (!body.auth_provider || x.auth_provider === body.auth_provider));
          return ok(u ? { user_id: u.user_id } : null);
        }
        case 'user/list':
          return ok({ items: users.filter((x) => x.username === body.username).map(pub), total: 0 });
        case 'user-key/create': {
          const u = users.find((x) => x.user_id === body.user_id)!;
          return ok({ key_value: u.key });
        }
        case 'team/list':
          return ok({ items: teams.filter((t) => t.name === body.name) });
        case 'team/create': {
          const team = { team_id: `team-${++seq}`, name: String(body.name), owner_user_id: String(body.owner_user_id) };
          teams.push(team);
          return ok(team);
        }
        case 'team-member/add':
          if (!teams.some((t) => t.team_id === body.team_id)) return fail(404, 'team_not_found');
          members.push({ team_id: String(body.team_id), user_id: String(body.user_id), role: String(body.role) });
          return ok({});
        default:
          return fail(404, `unexpected action ${action}`);
      }
    },
  };
  return { kernel, users, teams, members, calls };
}

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

function authConfig(dir: string, overrides: Partial<PanelAuthConfig['oidc']> = {}): PanelAuthConfig {
  const adminKeyFile = join(dir, 'admin-user-key');
  writeFileSync(adminKeyFile, `${ADMIN_KEY}
`);
  return {
    userKeyEnabled: true,
    userKeySignup: false,
    idpEnabled: true,
    sessionTtlSeconds: 3600,
    sessionCookieName: 'wamf_idp_session',
    sessionSecure: true,
    sessionSecret: 'test-session-secret-0123456789abcdef',
    identityStorePath: join(dir, 'identities.json'),
    sso: {
      enabled: false, appToken: '', safeMode: true, requireSignature: true, appUrl: '', loginUrl: '',
      logoutUrl: '', paasId: '', defaultTeamId: '', defaultRole: 'member', authProvider: 'local',
    },
    appUrl: APP_URL,
    adminUserKeyFile: adminKeyFile,
    waip: { jwksUrl: PLATFORM_JWKS, issuer: 'weaverai-platform', audience: 'mcp:memory-mcp' },
    oidc: {
      enabled: true,
      id: 'keycloak',
      displayName: 'WeaverAI',
      issuerUrl: PUBLIC_ISSUER,
      internalIssuerUrl: INTERNAL_ISSUER,
      clientId: 'agent-memory',
      clientSecret: 'shh',
      scopes: 'openid profile email',
      usernameClaim: 'preferred_username',
      authProvider: 'keycloak',
      defaultTeamName: 'weaversoft',
      defaultRole: 'member',
      ...overrides,
    },
  };
}

let idp: Awaited<ReturnType<typeof fakeIdp>>;
let platform: Awaited<ReturnType<typeof fakePlatform>>;
let core: ReturnType<typeof fakeCore>;
let service: PanelAuthService;

beforeEach(async () => {
  idp = await fakeIdp();
  platform = await fakePlatform();
  core = fakeCore();
  // The service builds its OidcProvider (and the WAIP key set) with the global fetch.
  vi.stubGlobal('fetch', (async (input, init) =>
    String(input) === PLATFORM_JWKS
      ? new Response(JSON.stringify(platform.jwks), { headers: { 'content-type': 'application/json' } })
      : idp.fetchImpl(input, init)) as typeof fetch);
  service = new PanelAuthService({
    config: authConfig(mkdtempSync(join(tmpdir(), 'panel-oidc-'))),
    instances: new InstanceRegistry([{ instance_id: 'default', name: 'default', gateway_endpoint: 'http://core.test', api_key: PLACEHOLDER_API_KEY }]),
    metaKernel: core.kernel,
    logger: silentLogger,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One browser round trip: panel → IdP → callback. */
async function signIn(user: IdpUser) {
  const { url, stateToken } = await service.beginOidcLogin({ providerId: 'keycloak', instanceId: 'default', returnTo: '/agents' });
  const code = idp.authorize(url, user);
  return service.completeOidcLogin({ providerId: 'keycloak', stateToken, state: new URL(url).searchParams.get('state') ?? '', code });
}

describe('OidcProvider', () => {
  it('sends the browser to the public issuer with PKCE S256, and calls the IdP in-cluster', async () => {
    const provider = new OidcProvider({ ...authConfig(mkdtempSync(join(tmpdir(), 'panel-oidc-'))).oidc, fetchImpl: idp.fetchImpl });
    const { url, codeVerifier } = await provider.prepareAuthorize({ state: 's1', nonce: 'n1', redirectUri: `${APP_URL}/cb` });
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${PUBLIC_ISSUER}/protocol/openid-connect/auth`);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBe(createHash('sha256').update(codeVerifier).digest('base64url'));
    expect(parsed.searchParams.get('client_id')).toBe('agent-memory');
    expect(idp.calls.every((c) => c.startsWith(INTERNAL_ISSUER))).toBe(true);
  });

  it('refuses to start without its client secret', () => {
    expect(() => new OidcProvider({ ...authConfig(mkdtempSync(join(tmpdir(), 'panel-oidc-'))).oidc, clientSecret: '' })).toThrow(/CLIENT_SECRET/);
  });
});

describe('WAIP identity exchange (MCP servers behind the WAIP MCP proxy)', () => {
  it('a new person gets an account (default team, member) and the same key every time', async () => {
    const first = await service.exchangeWaipIdentity('default', await platform.assertion('noa.levi'));
    const created = core.users.find((u) => u.username === 'noa-levi')!;
    expect(created).toMatchObject({ external_id: 'noa.levi', auth_provider: 'keycloak' });
    expect(first.userKey).toBe(created.key);
    expect(core.members).toEqual([{ team_id: core.teams[0].team_id, user_id: created.user_id, role: 'member' }]);

    const again = await service.exchangeWaipIdentity('default', await platform.assertion('noa.levi'));
    expect(again.userKey).toBe(created.key);
    expect(core.users.filter((u) => u.username === 'noa-levi')).toHaveLength(1);
  });

  it('someone who linked their account with SSO gets their own key', async () => {
    core.users.push({ user_id: 'usr-dyze', username: 'dyze', key: 'sk-mem-dyze-existing', auth_provider: 'local', user_type: 'normal' });
    const r = await signIn({ preferred_username: 'dyze' });
    if (r.kind !== 'pending') throw new Error('expected pending');
    await service.completePendingSsoLogin({ token: r.pending.token, username: 'dyze', userKey: 'sk-mem-dyze-existing' });

    const out = await service.exchangeWaipIdentity('default', await platform.assertion('dyze'));
    expect(out).toMatchObject({ userKey: 'sk-mem-dyze-existing', user: { user_id: 'usr-dyze' } });
  });

  it('an existing account not yet linked to WeaverAI is never claimed by an agent', async () => {
    core.users.push({ user_id: 'usr-dyze', username: 'dyze', key: 'sk-mem-dyze-existing', auth_provider: 'local', user_type: 'normal' });
    await expect(service.exchangeWaipIdentity('default', await platform.assertion('dyze')))
      .rejects.toMatchObject({ code: 'WAIP_IDENTITY_NOT_LINKED', status: 403 });
    expect(core.users).toHaveLength(2);
  });

  it('rejects assertions for another MCP, from another issuer, or not signed by the platform', async () => {
    for (const bad of [
      await platform.assertion('mallory', { audience: 'mcp:some-other-mcp' }),
      await platform.assertion('mallory', { issuer: 'someone-else' }),
      await platform.assertion('mallory', { key: platform.foreign }),
      'not-a-jwt',
    ]) {
      await expect(service.exchangeWaipIdentity('default', bad)).rejects.toMatchObject({ code: 'WAIP_IDENTITY_INVALID' });
    }
    expect(core.users).toHaveLength(1);
  });

  it('is off without a JWKS URL', async () => {
    const off = new PanelAuthService({
      config: { ...authConfig(mkdtempSync(join(tmpdir(), 'panel-oidc-'))), waip: { jwksUrl: '', issuer: 'weaverai-platform', audience: 'mcp:memory-mcp' } },
      instances: new InstanceRegistry([{ instance_id: 'default', name: 'default', gateway_endpoint: 'http://core.test', api_key: PLACEHOLDER_API_KEY }]),
      metaKernel: core.kernel,
      logger: silentLogger,
    });
    await expect(off.exchangeWaipIdentity('default', await platform.assertion('noa')))
      .rejects.toMatchObject({ code: 'WAIP_IDENTITY_DISABLED' });
  });
});

describe('OIDC login', () => {
  it('first login: a new user creates an account, joins the default team as member, sees the key once', async () => {
    const first = await signIn({ preferred_username: 'dana.cohen', name: 'Dana Cohen', email: 'dana@example.com' });
    expect(first.kind).toBe('pending');
    if (first.kind !== 'pending') return;
    expect(first.pending.identity).toMatchObject({ providerId: 'keycloak', subject: 'dana.cohen', displayName: 'Dana Cohen' });

    const done = await service.completePendingSsoLogin({ token: first.pending.token, username: 'dana-cohen', createNew: true });
    const created = core.users.find((u) => u.username === 'dana-cohen')!;
    expect(created).toMatchObject({ external_id: 'dana.cohen', auth_provider: 'keycloak' });
    expect(done.userKeyAutogenerated).toBe(true);
    expect(done.userKeyDisplay).toBe(created.key);
    expect(core.teams).toEqual([{ team_id: expect.any(String), name: 'weaversoft', owner_user_id: 'usr-admin' }]);
    expect(core.members).toEqual([{ team_id: core.teams[0].team_id, user_id: created.user_id, role: 'member' }]);

    // Next login goes straight in, as the same user.
    const again = await signIn({ preferred_username: 'dana.cohen' });
    expect(again.kind).toBe('session');
    if (again.kind !== 'session') return;
    expect(again.session).toMatchObject({ coreUserId: created.user_id, userKey: created.key, providerId: 'keycloak' });
    expect(again.session.idToken).toEqual(expect.any(String));
    expect(again.returnTo).toBe('/agents');
    expect(core.users.filter((u) => u.username === 'dana-cohen')).toHaveLength(1);
  });

  it('creates the default team once and reuses it', async () => {
    for (const name of ['avi', 'noa']) {
      const r = await signIn({ preferred_username: name });
      if (r.kind !== 'pending') throw new Error('expected pending');
      await service.completePendingSsoLogin({ token: r.pending.token, username: name, createNew: true });
    }
    expect(core.teams).toHaveLength(1);
    expect(core.members.map((m) => m.team_id)).toEqual([core.teams[0].team_id, core.teams[0].team_id]);
  });

  it('existing user: linking their key keeps their account and adds no team', async () => {
    core.users.push({ user_id: 'usr-dyze', username: 'dyze', key: 'sk-mem-dyze-existing', auth_provider: 'local', user_type: 'normal' });
    const r = await signIn({ preferred_username: 'dyze' });
    if (r.kind !== 'pending') throw new Error('expected pending');

    const done = await service.completePendingSsoLogin({ token: r.pending.token, username: 'dyze', userKey: 'sk-mem-dyze-existing' });
    expect(done.session).toMatchObject({ coreUserId: 'usr-dyze', userKey: 'sk-mem-dyze-existing' });
    expect(done.userKeyDisplay).toBeUndefined();
    expect(core.users.find((u) => u.user_id === 'usr-dyze')!.external_id).toBe('dyze');
    expect(core.users).toHaveLength(2);
    expect(core.members).toHaveLength(0);

    const again = await signIn({ preferred_username: 'dyze' });
    expect(again.kind === 'session' && again.session.coreUserId).toBe('usr-dyze');
  });

  it('never creates an account from an unknown key, and never duplicates a username', async () => {
    core.users.push({ user_id: 'usr-dyze', username: 'dyze', key: 'sk-mem-dyze-existing', auth_provider: 'local', user_type: 'normal' });
    const r = await signIn({ preferred_username: 'dyze' });
    if (r.kind !== 'pending') throw new Error('expected pending');

    await expect(service.completePendingSsoLogin({ token: r.pending.token, username: 'dyze', userKey: 'sk-mem-typo-0000' }))
      .rejects.toMatchObject({ code: 'USER_KEY_NOT_FOUND' });
    await expect(service.completePendingSsoLogin({ token: r.pending.token, username: 'dyze', createNew: true }))
      .rejects.toMatchObject({ code: 'USERNAME_TAKEN' });
    await expect(service.completePendingSsoLogin({ token: r.pending.token, username: 'dyze' }))
      .rejects.toMatchObject({ code: 'INVALID_USER_KEY' });
    expect(core.users).toHaveLength(2);
  });

  it('rejects a callback whose state does not match the login that was started', async () => {
    const { url, stateToken } = await service.beginOidcLogin({ providerId: 'keycloak', instanceId: 'default', returnTo: '/' });
    const code = idp.authorize(url, { preferred_username: 'mallory' });
    await expect(service.completeOidcLogin({ providerId: 'keycloak', stateToken, state: 'forged', code }))
      .rejects.toMatchObject({ code: 'OIDC_STATE_INVALID' });
    await expect(service.completeOidcLogin({ providerId: 'keycloak', stateToken: undefined, state: new URL(url).searchParams.get('state')!, code }))
      .rejects.toMatchObject({ code: 'OIDC_STATE_INVALID' });
  });

  it('rejects ID tokens signed by another key or issued for another client', async () => {
    await idp.rotateToForeignKey();
    await expect(signIn({ preferred_username: 'mallory' })).rejects.toMatchObject({ code: 'OIDC_LOGIN_FAILED' });

    idp = await fakeIdp();
    vi.stubGlobal('fetch', idp.fetchImpl);
    idp.setAudience('some-other-app');
    const fresh = new PanelAuthService({
      config: authConfig(mkdtempSync(join(tmpdir(), 'panel-oidc-'))),
      instances: new InstanceRegistry([{ instance_id: 'default', name: 'default', gateway_endpoint: 'http://core.test', api_key: PLACEHOLDER_API_KEY }]),
      metaKernel: core.kernel,
      logger: silentLogger,
    });
    service = fresh;
    await expect(signIn({ preferred_username: 'mallory' })).rejects.toBeInstanceOf(PanelAuthError);
    expect(core.users).toHaveLength(1);
  });

  it('logout sends the browser to the IdP with the ID token, returning to the panel', async () => {
    const r = await signIn({ preferred_username: 'avi' });
    if (r.kind !== 'pending') throw new Error('expected pending');
    const { session } = await service.completePendingSsoLogin({ token: r.pending.token, username: 'avi', createNew: true });
    const url = new URL(await service.buildIdpLogoutUrl(session));
    expect(`${url.origin}${url.pathname}`).toBe(`${PUBLIC_ISSUER}/protocol/openid-connect/logout`);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${APP_URL}/`);
    expect(url.searchParams.get('client_id')).toBe('agent-memory');
    // Even with no panel session, still send the browser to the IdP so SSO cannot survive a second logout click.
    const nullSessionUrl = new URL(await service.buildIdpLogoutUrl(null));
    expect(`${nullSessionUrl.origin}${nullSessionUrl.pathname}`).toBe(`${PUBLIC_ISSUER}/protocol/openid-connect/logout`);
    expect(nullSessionUrl.searchParams.get('client_id')).toBe('agent-memory');
    expect(nullSessionUrl.searchParams.get('id_token_hint')).toBeNull();
  });

  it('admin-only calls fail without the admin key file (placeholder api_key only)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'panel-oidc-'));
    service = new PanelAuthService({
      config: { ...authConfig(dir), adminUserKeyFile: join(dir, 'not-mounted') },
      instances: new InstanceRegistry([{ instance_id: 'default', name: 'default', gateway_endpoint: 'http://core.test', api_key: PLACEHOLDER_API_KEY }]),
      metaKernel: core.kernel,
      logger: silentLogger,
    });
    const r = await signIn({ preferred_username: 'avi' });
    if (r.kind !== 'pending') throw new Error('expected pending');
    await expect(service.completePendingSsoLogin({ token: r.pending.token, username: 'avi', createNew: true }))
      .rejects.toBeInstanceOf(PanelAuthError);
    expect(core.users).toHaveLength(1);
  });

  it('a misconfigured IdP disables SSO but keeps key login', () => {
    const svc = new PanelAuthService({
      config: authConfig(mkdtempSync(join(tmpdir(), 'panel-oidc-')), { clientSecret: '' }),
      instances: new InstanceRegistry([{ instance_id: 'default', name: 'default', gateway_endpoint: 'http://core.test', api_key: PLACEHOLDER_API_KEY }]),
      metaKernel: core.kernel,
      logger: silentLogger,
    });
    expect(svc.hasOidcProvider('keycloak')).toBe(false);
    expect(svc.listMethods().map((m) => m.type)).toEqual(['user_key']);
    expect(service.listMethods()).toContainEqual({ id: 'keycloak', type: 'oidc', display_name: 'WeaverAI', enabled: true });
  });
});

describe('user_key login (no sign-in required to call it)', () => {
  it('logs in an existing key', async () => {
    const out = await service.loginWithUserKey({ instanceId: 'default', userKey: ADMIN_KEY });
    expect(out).toMatchObject({ user_id: 'usr-admin', created: false });
  });

  it('never creates an account for an unknown key by default', async () => {
    await expect(service.loginWithUserKey({ instanceId: 'default', userKey: 'sk-mem-made-up-by-anyone', username: 'mallory' }))
      .rejects.toMatchObject({ code: 'INVALID_USER_KEY', status: 401 });
    expect(core.users).toHaveLength(1);
    expect(core.calls.some((c) => c.action === 'user/create-with-key')).toBe(false);
  });

  it('creates one only when PANEL_AUTH_USER_KEY_SIGNUP is on', async () => {
    const svc = new PanelAuthService({
      config: { ...authConfig(mkdtempSync(join(tmpdir(), 'panel-oidc-'))), userKeySignup: true },
      instances: new InstanceRegistry([{ instance_id: 'default', name: 'default', gateway_endpoint: 'http://core.test', api_key: PLACEHOLDER_API_KEY }]),
      metaKernel: core.kernel,
      logger: silentLogger,
    });
    const out = await svc.loginWithUserKey({ instanceId: 'default', userKey: 'sk-mem-new-person-key', username: 'newbie' });
    expect(out.created).toBe(true);
    expect(core.users.map((u) => u.username)).toContain('newbie');
  });
});
