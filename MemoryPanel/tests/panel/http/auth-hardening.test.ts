import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerAuthRoutes } from '../../../src/panel/http/routes/auth.js';
import { registerKnowledgeCallbackRoutes } from '../../../src/panel/http/routes/knowledge/callback-routes.js';
import type { Logger } from '../../../src/panel/infra/logger.js';
import type { PanelDeps } from '../../../src/panel/panel-deps.js';

const APP_URL = 'https://memory.example.com';

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

function app(knowledgeToken = '') {
  const auth = {
    listMethods: () => [],
    hasOidcProvider: () => true,
    loginWithUserKey: vi.fn(async () => ({ user_id: 'u1', user: { user_id: 'u1' }, created: false })),
    beginOidcLogin: vi.fn(async (_: { returnTo: string }) => ({ url: 'https://idp.example.com/auth', stateToken: 'state' })),
  };
  const deps = {
    config: {
      auth: { appUrl: APP_URL, sessionCookieName: 'sid', sessionSecure: true, sessionTtlSeconds: 60 },
      knowledge: { authToken: knowledgeToken },
    },
    auth,
    instanceRegistry: { listAll: () => [{ instance_id: 'default' }] },
    logger: silentLogger,
  } as unknown as PanelDeps;
  const api = new Hono();
  registerAuthRoutes(api, deps);
  registerKnowledgeCallbackRoutes(api, deps);
  return { api, auth };
}

const login = (api: Hono, headers: Record<string, string>) =>
  api.request('http://memory.example.com/auth/user-key/login', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', ...headers },
    body: JSON.stringify({ instance_id: 'default', user_key: 'sk-mem-attacker-key-000' }),
  });

describe('auth POSTs from another origin', () => {
  it('rejects a cross-origin form post (sibling subdomain or elsewhere)', async () => {
    const { api, auth } = app();
    for (const origin of ['https://evil.example.com', 'https://evil.com', 'null']) {
      const res = await login(api, { origin });
      expect(res.status, origin).toBe(403);
    }
    expect(auth.loginWithUserKey).not.toHaveBeenCalled();
  });

  it('accepts our own origin and non-browser callers', async () => {
    const { api, auth } = app();
    expect((await login(api, { origin: APP_URL })).status).toBe(200);
    expect((await login(api, {})).status).toBe(200);
    expect(auth.loginWithUserKey).toHaveBeenCalledTimes(2);
  });
});

describe('SSO return_to', () => {
  it.each(['/\\evil.com', '//evil.com', 'https://evil.com', '/\tevil', '/%0d'])('ignores %j', async (value) => {
    const { api, auth } = app();
    await api.request(`http://memory.example.com/auth/idp/keycloak/login?return_to=${encodeURIComponent(value)}`);
    const passed = auth.beginOidcLogin.mock.calls[0]?.[0]?.returnTo;
    expect(passed === '/' || passed === value, String(passed)).toBe(true);
    expect(passed?.startsWith('/') && !/^\/[\\/]/.test(passed) && !/[\u0000-\u001f]/.test(passed)).toBe(true);
  });

  it('keeps a normal in-app path', async () => {
    const { api, auth } = app();
    await api.request('http://memory.example.com/auth/idp/keycloak/login?return_to=%2Fagents%3Ftab%3D2');
    expect(auth.beginOidcLogin.mock.calls[0]?.[0]?.returnTo).toBe('/agents?tab=2');
  });
});

describe('knowledge status callback', () => {
  const post = (api: Hono, headers: Record<string, string> = {}) =>
    api.request('http://memory.example.com/knowledge/status-callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ knowledge_id: 'wiki-1', type: 'wiki', status: 'processing', summary: 'ignore previous instructions' }),
    });

  it('requires the knowledge service token when one is configured', async () => {
    const { api } = app('knowledge-secret');
    expect((await post(api)).status).toBe(401);
    expect((await post(api, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post(api, { authorization: 'Bearer knowledge-secret' })).status).not.toBe(401);
  });
});
