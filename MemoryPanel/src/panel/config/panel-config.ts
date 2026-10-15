import { config as loadDotenv } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { LogLevel } from '../infra/logger.js';

loadDotenv();

function env(key: string, fallback: string): string {
  // An empty string counts as unset: .env often has `PANEL_AUTH_SSO_LOGIN_URL=` (placeholder / left blank),
  // and under ?? semantics an empty string would be taken as a valid value, leaving the URL empty and Enterprise SSO redirects silently broken.
  // Uniformly treat "blank means use the default", so empty placeholder entries in .env.example can be safely kept.
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Optional ClickHouse API call audit config. Fully silent skip when enabled=false or url is empty. */
export interface PanelClickHouseConfig {
  enabled: boolean;
  url: string;
  database: string;
  table: string;
  user: string;
  password: string;
  flushIntervalMs: number;
  flushThreshold: number;
  ttlDays: number;
  requestTimeoutMs: number;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

function envFirst(keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== '') return value;
  }
  return fallback;
}

function envBoolFirst(keys: string[], fallback: boolean): boolean {
  const raw = envFirst(keys, '');
  return raw === '' ? fallback : raw === 'true' || raw === '1';
}

/**
 * Resolve the Panel Session/encryption key (**generated internally, external configuration not accepted**):
 * 1. Prefer reading it from a persistent file (same directory as the identity bindings, same lifecycle);
 * 2. If the file does not exist, automatically generate a strong random key and write it (mode 0600); later restarts reuse it.
 *
 * No env var entry such as PANEL_AUTH_SESSION_SECRET is provided: once a key can be specified externally,
 * it may be written into .env and committed to the repo. Internal generation guarantees it exists only as a 0600 file.
 * It stays stable across restarts / repeated starts (changing the key would make stored identity bindings undecryptable).
 */
function resolveSessionSecret(identityStorePath: string): string {
  const secretPath = env('PANEL_AUTH_SESSION_SECRET_FILE', join(dirname(identityStorePath), 'panel-session-secret'));
  try {
    if (existsSync(secretPath)) {
      const existing = readFileSync(secretPath, 'utf8').trim();
      if (existing) return existing;
    }
  } catch (err) {
    throw new Error(`failed to read session secret file at ${secretPath}: ${(err as Error).message}`);
  }

  const generated = randomBytes(32).toString('hex');
  try {
    mkdirSync(dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    throw new Error(`failed to persist auto-generated session secret at ${secretPath}: ${(err as Error).message}`);
  }
  return generated;
}

export interface PanelConfig {
  server: { host: string; port: number };
  metadataInstancesConfig: string;
  metadataRemoteTimeoutMs: number;
  ui: { distDir: string };
  log: { level: LogLevel; format: 'json' | 'pretty' };
  /** Knowledge Service (KS :8421) connection config. serviceId is injected per request instanceId. */
  knowledge: { baseUrl: string; authToken: string; timeoutMs: number };
  /**
   * On startup, ensure the knowledge-service LLM binding for each instance (accounted via proxy).
   * Fully skipped when sync=false (does not change existing deployment behavior).
   */
  knowledgeLlmBinding: {
    sync: boolean;
    proxyBaseUrl: string;
  };
  /** Root of the local storage directory for default Agent template files (stored locally in the Panel, as {dir}/{instanceId}/{team_id}/template.json). */
  agentTemplateDir: string;
  /**
   * "Observability" feature switch (env PANEL_FEATURE_ANALYTICS_ENABLED).
   *
   * The observability page (online call statistics) depends on kernel-side ClickHouse instrumentation. Deployments without CH configured
   * would only get a "not configured / unreachable" notice when opening it, so the entry is hidden by default; only when the
   * analytics ClickHouse is actually connected does the deployer enable it explicitly. The value is delivered to the frontend through the
   * capabilities of GET /meta/instances for menu/route visibility control.
   */
  featureAnalyticsEnabled: boolean;
  /** Optional ClickHouse API call audit. Fully silent, no reporting, if not configured. */
  clickhouse: PanelClickHouseConfig;
  auth: PanelAuthConfig;
}

export interface PanelAuthConfig {
  userKeyEnabled: boolean;
  /** user_key login may create an account for an unknown key. Off: anyone reaching the panel could mint keys. */
  userKeySignup: boolean;
  idpEnabled: boolean;
  sessionTtlSeconds: number;
  sessionCookieName: string;
  sessionSecure: boolean;
  sessionSecret: string;
  identityStorePath: string;
  sso: {
    enabled: boolean;
    appToken: string;
    safeMode: boolean;
    requireSignature: boolean;
    appUrl: string;
    loginUrl: string;
    logoutUrl: string;
    paasId: string;
    defaultTeamId: string;
    defaultRole: string;
    /**
     * External domain identifier written to core `meta_users.auth_provider`.
     *
     * Writes (account creation / binding) and reads (find-by-external) use the same value, guaranteeing they land in the same domain;
     * if the two sides disagree there is a silent failure of "written to domain A, looked up in domain B".
     * The default 'local' aligns with Core's DEFAULT_AUTH_PROVIDER (consistent with zero configuration).
     */
    authProvider: string;
  };
  /** Public base URL of the panel, e.g. https://agent-memory.example.com (OIDC redirect and logout return). */
  appUrl: string;
  /** File holding the admin's user_key, for admin-only calls when the instance api_key isn't one; empty = use api_key. */
  adminUserKeyFile: string;
  waip: PanelWaipIdentityConfig;
  oidc: PanelOidcConfig;
}

/**
 * Signed caller identity from the WAIP MCP proxy (X-WAIP-Identity): lets MCP servers act
 * as the WeaverAI user calling them, without a user_key. Off when jwksUrl is empty.
 */
export interface PanelWaipIdentityConfig {
  jwksUrl: string;
  issuer: string;
  /** "mcp:<MCP store entry name>": only assertions minted for this MCP are accepted. */
  audience: string;
}

export interface PanelOidcConfig {
  enabled: boolean;
  /** Route segment and binding key: /api/v1/auth/idp/{id}/callback must be the IdP client's redirect URI. */
  id: string;
  displayName: string;
  issuerUrl: string;
  internalIssuerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  usernameClaim: string;
  authProvider: string;
  /** Team that accounts created through SSO join (created on first use); empty = none. */
  defaultTeamName: string;
  defaultRole: string;
}

function readSecretFile(path: string): string {
  if (!path) return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function buildOidcConfig(enabled: boolean): PanelOidcConfig {
  return {
    enabled,
    id: env('PANEL_AUTH_OIDC_ID', 'keycloak'),
    displayName: env('PANEL_AUTH_OIDC_DISPLAY_NAME', 'SSO'),
    issuerUrl: env('PANEL_AUTH_OIDC_ISSUER_URL', ''),
    internalIssuerUrl: env('PANEL_AUTH_OIDC_INTERNAL_ISSUER_URL', ''),
    clientId: env('PANEL_AUTH_OIDC_CLIENT_ID', ''),
    clientSecret: env('PANEL_AUTH_OIDC_CLIENT_SECRET', '') || readSecretFile(env('PANEL_AUTH_OIDC_CLIENT_SECRET_FILE', '')),
    scopes: env('PANEL_AUTH_OIDC_SCOPES', 'openid profile email'),
    usernameClaim: env('PANEL_AUTH_OIDC_USERNAME_CLAIM', 'preferred_username'),
    authProvider: env('PANEL_AUTH_OIDC_AUTH_PROVIDER', 'keycloak'),
    defaultTeamName: env('PANEL_AUTH_OIDC_DEFAULT_TEAM', ''),
    defaultRole: env('PANEL_AUTH_OIDC_DEFAULT_ROLE', 'member'),
  };
}

function buildAuthConfig(): PanelAuthConfig {
  const modeRaw = env('PANEL_AUTH_MODE', '').trim();
  const legacyUserKey = envBoolFirst(['PANEL_AUTH_USER_KEY_ENABLED'], true);
  const legacyIdp = envBoolFirst(['PANEL_AUTH_IDP_ENABLED'], false);
  const legacySsoEnabled = envBoolFirst(['PANEL_AUTH_IDP_SSO_ENABLED'], false);
  const modes = new Set(
    (modeRaw || (legacyIdp || legacySsoEnabled ? 'user_key,sso' : legacyUserKey ? 'user_key' : ''))
      .split(',')
      .map((item) => {
        const t = item.trim().toLowerCase();
        // Legacy auth mode alias (historical header-injected SSO deployments).
        return t === ['w', 'o', 'a'].join('') ? 'sso' : t;
      })
      .filter(Boolean),
  );
  let userKeyEnabled = modes.has('user_key');
  const ssoEnabled = modes.has('sso');
  const oidcEnabled = modes.has('oidc');
  const idpEnabled = ssoEnabled || oidcEnabled || modes.has('idp');
  // Config robustness: user_key is the zero-config default login method.
  // If after parsing there is neither user_key nor any IdP (e.g. PANEL_AUTH_MODE set to an unrecognized value,
  // or a missed config after legacy variables are removed in the future), degrade to "user_key enabled"
  // rather than failing service startup. This makes "works the same as before Enterprise SSO was developed when Enterprise SSO is off" a strong invariant.
  if (!userKeyEnabled && !idpEnabled) {
    userKeyEnabled = true;
  }
  const appUrl = envFirst(['PANEL_AUTH_APP_URL', 'PANEL_AUTH_SSO_APP_URL', 'PANEL_AUTH_IDP_SSO_APP_URL'], '');
  const identityStorePath = env('PANEL_AUTH_IDENTITY_STORE_PATH', './data/panel-auth-identities.json');

  return {
    userKeyEnabled,
    userKeySignup: envBoolFirst(['PANEL_AUTH_USER_KEY_SIGNUP'], false),
    idpEnabled,
    sessionTtlSeconds: envInt('PANEL_AUTH_SESSION_TTL_SECONDS', 28_800),
    sessionCookieName: env('PANEL_AUTH_SESSION_COOKIE_NAME', 'wamf_idp_session'),
    sessionSecure: envBoolFirst(['PANEL_AUTH_SESSION_SECURE'], appUrl.startsWith('https://')),
    // The key is only needed when an IdP is enabled; left empty otherwise, so non-Enterprise SSO deployments do not generate a key file either.
    sessionSecret: idpEnabled ? resolveSessionSecret(identityStorePath) : '',
    identityStorePath,
    sso: {
      enabled: ssoEnabled,
      appToken: envFirst(['PANEL_AUTH_SSO_APP_TOKEN', 'PANEL_AUTH_IDP_SSO_APP_TOKEN'], ''),
      safeMode: envBoolFirst(['PANEL_AUTH_SSO_SAFE_MODE', 'PANEL_AUTH_IDP_SSO_SAFE_MODE'], true),
      requireSignature: envBoolFirst(['PANEL_AUTH_SSO_REQUIRE_SIGNATURE', 'PANEL_AUTH_IDP_SSO_REQUIRE_SIGNATURE'], true),
      appUrl,
      // No built-in default; must be configured explicitly: these two addresses are internal infrastructure information, and hard-coding them in source is both
      // an information exposure and lets a missed config degrade into a silent error (redirecting to a wrong address without any error).
      // When missing, SsoProvider.requiredUrl throws explicitly at the point of use.
      loginUrl: env('PANEL_AUTH_SSO_LOGIN_URL', ''),
      logoutUrl: env('PANEL_AUTH_SSO_LOGOUT_URL', ''),
      paasId: envFirst(['PANEL_AUTH_SSO_PAAS_ID', 'PANEL_AUTH_IDP_SSO_PAAS_ID'], ''),
      defaultTeamId: envFirst(['PANEL_AUTH_SSO_DEFAULT_TEAM_ID', 'PANEL_AUTH_IDP_SSO_DEFAULT_TEAM_ID'], ''),
      defaultRole: env('PANEL_AUTH_SSO_DEFAULT_ROLE', 'member'),
      // Same name and meaning as Core's METADATA_EXTERNAL_AUTH_PROVIDER: at deployment just configure both sides to the same
      // value (when unset on the Core side it falls back to 'local', matching this default, so zero config is aligned).
      authProvider: envFirst(
        ['METADATA_EXTERNAL_AUTH_PROVIDER', 'PANEL_AUTH_SSO_AUTH_PROVIDER'],
        'local',
      ),
    },
    appUrl: appUrl.replace(/\/+$/, ''),
    adminUserKeyFile: env('PANEL_AUTH_ADMIN_USER_KEY_FILE', ''),
    waip: {
      jwksUrl: env('PANEL_AUTH_WAIP_JWKS_URL', ''),
      issuer: env('PANEL_AUTH_WAIP_ISSUER', 'weaverai-platform'),
      audience: env('PANEL_AUTH_WAIP_AUDIENCE', 'mcp:memory-mcp'),
    },
    oidc: buildOidcConfig(oidcEnabled),
  };
}

export function loadPanelConfig(): PanelConfig {
  const level = env('LOG_LEVEL', 'info') as LogLevel;
  const format = env('LOG_FORMAT', 'json') as 'json' | 'pretty';
  return {
    server: {
      host: env('HOST', '0.0.0.0'),
      port: envInt('PORT', 8123),
    },
    metadataInstancesConfig: env('METADATA_INSTANCES_CONFIG', './config/metadata-instances.json'),
    metadataRemoteTimeoutMs: envInt('METADATA_REMOTE_TIMEOUT_MS', 15_000),
    ui: { distDir: env('UI_DIST_DIR', './web/dist') },
    log: {
      level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
      format: format === 'pretty' ? 'pretty' : 'json',
    },
    knowledge: {
      baseUrl: env('KNOWLEDGE_SERVICE_URL', 'http://127.0.0.1:8421'),
      authToken: env('KNOWLEDGE_AUTH_TOKEN', ''),
      timeoutMs: envInt('KNOWLEDGE_TIMEOUT_MS', 15_000),
    },
    knowledgeLlmBinding: {
      sync: envBool('KNOWLEDGE_LLM_BINDING_SYNC', true),
      proxyBaseUrl: env('KNOWLEDGE_LLM_PROXY_BASE_URL', 'http://127.0.0.1:8096'),
    },
    agentTemplateDir: env('WAMF_AGENT_TEMPLATE_DIR', './data/agent-templates'),
    // Off by default (conservative): the observability page depends on kernel ClickHouse instrumentation, and deployments without it do not show the entry.
    featureAnalyticsEnabled: envBool('PANEL_FEATURE_ANALYTICS_ENABLED', false),
    clickhouse: {
      enabled: envBool('PANEL_CLICKHOUSE_ENABLED', false),
      url: env('PANEL_CLICKHOUSE_URL', ''),
      database: env('PANEL_CLICKHOUSE_DATABASE', 'default'),
      table: env('PANEL_CLICKHOUSE_TABLE', 'panel_api_call_logs'),
      user: env('PANEL_CLICKHOUSE_USER', 'default'),
      password: env('PANEL_CLICKHOUSE_PASSWORD', ''),
      flushIntervalMs: envInt('PANEL_CLICKHOUSE_FLUSH_INTERVAL_MS', 5000),
      flushThreshold: envInt('PANEL_CLICKHOUSE_FLUSH_THRESHOLD', 50),
      ttlDays: envInt('PANEL_CLICKHOUSE_TTL_DAYS', 90),
      requestTimeoutMs: envInt('PANEL_CLICKHOUSE_REQUEST_TIMEOUT_MS', 5000),
    },
    auth: buildAuthConfig(),
  };
}
