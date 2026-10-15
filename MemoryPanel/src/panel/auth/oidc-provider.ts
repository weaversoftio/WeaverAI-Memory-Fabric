import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import type { ExternalIdentity, RedirectOAuth2Provider } from './types.js';

/**
 * OIDC login (authorization code + PKCE) against an IdP such as Keycloak.
 *
 * The IdP has two addresses: the public issuer the browser is sent to (and that tokens
 * carry as `iss`), and an optional in-cluster issuer the panel itself calls for discovery,
 * the token exchange and signing keys. Endpoints are rewritten between the two, so it works
 * whether or not the IdP advertises its public hostname to in-cluster callers.
 */
export interface OidcProviderConfig {
  /** Stable id: the route segment (/auth/idp/{id}/...) and the identity-binding key. */
  id: string;
  displayName: string;
  issuerUrl: string;
  /** In-cluster issuer for server-side calls; empty = use issuerUrl. */
  internalIssuerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** ID-token claim used as the user's external id and default username. */
  usernameClaim: string;
  /** Written to core `meta_users.auth_provider` for users created or linked through this IdP. */
  authProvider: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface Endpoints {
  authorization: string;
  token: string;
  jwks: string;
  endSession?: string;
}

const DISCOVERY_TTL_MS = 10 * 60 * 1000;

export class OidcLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcLoginError';
  }
}

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function stringClaim(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class OidcProvider implements RedirectOAuth2Provider {
  readonly id: string;
  readonly type = 'oidc' as const;
  readonly kind = 'redirect-oauth2' as const;
  readonly displayName: string;
  readonly authProviderDomain: string;
  private readonly issuer: string;
  private readonly internalIssuer: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private endpoints: { value: Endpoints; loadedAt: number } | null = null;
  private keys: ReturnType<typeof createLocalJWKSet> | null = null;

  constructor(private readonly config: OidcProviderConfig) {
    const missing = [
      ['PANEL_AUTH_OIDC_ISSUER_URL', config.issuerUrl],
      ['PANEL_AUTH_OIDC_CLIENT_ID', config.clientId],
      ['PANEL_AUTH_OIDC_CLIENT_SECRET_FILE', config.clientSecret],
    ].filter(([, value]) => !value?.trim()).map(([name]) => name);
    if (missing.length) {
      throw new Error(`OIDC login is enabled but not configured: set ${missing.join(', ')}`);
    }
    this.id = config.id;
    this.displayName = config.displayName;
    this.authProviderDomain = config.authProvider;
    this.issuer = trimSlash(config.issuerUrl);
    this.internalIssuer = trimSlash(config.internalIssuerUrl || config.issuerUrl);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async prepareAuthorize(input: { state: string; redirectUri: string; nonce: string }) {
    const { authorization } = await this.loadEndpoints();
    const codeVerifier = base64url(randomBytes(32));
    const url = new URL(authorization);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: input.redirectUri,
      scope: this.config.scopes,
      state: input.state,
      nonce: input.nonce,
      code_challenge: base64url(createHash('sha256').update(codeVerifier).digest()),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), codeVerifier };
  }

  async authenticateFromCallback(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    expectedNonce: string;
  }): Promise<{ identity: ExternalIdentity; idToken: string }> {
    const endpoints = await this.loadEndpoints();
    const res = await this.fetchImpl(endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await res.json().catch(() => null) as { id_token?: unknown; error?: unknown; error_description?: unknown } | null;
    if (!res.ok || typeof body?.id_token !== 'string') {
      const reason = body?.error_description ?? body?.error ?? `HTTP ${res.status}`;
      throw new OidcLoginError(`token exchange failed: ${String(reason)}`);
    }
    const idToken = body.id_token;
    const payload = await this.verifyIdToken(idToken, endpoints);
    if (payload.nonce !== input.expectedNonce) {
      throw new OidcLoginError('ID token nonce does not match this login');
    }
    const username = stringClaim(payload, this.config.usernameClaim);
    if (!username) {
      throw new OidcLoginError(`ID token has no "${this.config.usernameClaim}" claim`);
    }
    return {
      idToken,
      identity: {
        providerId: this.id,
        subject: username,
        loginName: username,
        displayName: stringClaim(payload, 'name'),
        email: stringClaim(payload, 'email'),
        claims: payload as Record<string, unknown>,
      },
    };
  }

  async buildLogoutUrl(input: { returnTo: string; idToken?: string }): Promise<string | null> {
    const { endSession } = await this.loadEndpoints();
    if (!endSession) return null;
    const url = new URL(endSession);
    const params = new URLSearchParams({ client_id: this.config.clientId, post_logout_redirect_uri: input.returnTo });
    if (input.idToken) params.set('id_token_hint', input.idToken);
    url.search = params.toString();
    return url.toString();
  }

  /** Signature, issuer (public or in-cluster), audience and expiry; refetches keys once if the IdP rotated them. */
  private async verifyIdToken(idToken: string, endpoints: Endpoints): Promise<JWTPayload> {
    const verify = async (refresh: boolean) => {
      const keys = await this.signingKeys(endpoints, refresh);
      const { payload } = await jwtVerify(idToken, keys, {
        issuer: [...new Set([this.issuer, this.internalIssuer])],
        audience: this.config.clientId,
        clockTolerance: 30,
      });
      return payload;
    };
    try {
      return await verify(false);
    } catch (err) {
      if ((err as { code?: string }).code === 'ERR_JWKS_NO_MATCHING_KEY') {
        try {
          return await verify(true);
        } catch (retryErr) {
          throw new OidcLoginError(`ID token is invalid: ${(retryErr as Error).message}`);
        }
      }
      throw new OidcLoginError(`ID token is invalid: ${(err as Error).message}`);
    }
  }

  private async signingKeys(endpoints: Endpoints, refresh: boolean) {
    if (!this.keys || refresh) {
      const jwks = await this.getJson(endpoints.jwks, 'signing keys') as JSONWebKeySet;
      this.keys = createLocalJWKSet(jwks);
    }
    return this.keys;
  }

  private async loadEndpoints(): Promise<Endpoints> {
    if (this.endpoints && Date.now() - this.endpoints.loadedAt < DISCOVERY_TTL_MS) return this.endpoints.value;
    const doc = await this.getJson(`${this.internalIssuer}/.well-known/openid-configuration`, 'discovery') as Record<string, unknown>;
    const str = (key: string) => (typeof doc[key] === 'string' ? (doc[key] as string) : undefined);
    const authorization = str('authorization_endpoint');
    const token = str('token_endpoint');
    const jwks = str('jwks_uri');
    if (!authorization || !token || !jwks) {
      throw new OidcLoginError('IdP discovery document is missing its authorization, token or jwks endpoint');
    }
    const endSession = str('end_session_endpoint');
    const value: Endpoints = {
      authorization: this.toPublic(authorization),
      token: this.toInternal(token),
      jwks: this.toInternal(jwks),
      endSession: endSession ? this.toPublic(endSession) : undefined,
    };
    this.endpoints = { value, loadedAt: Date.now() };
    return value;
  }

  private async getJson(url: string, what: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new OidcLoginError(`IdP ${what} unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw new OidcLoginError(`IdP ${what} failed: HTTP ${res.status}`);
    return res.json();
  }

  /** Browser-facing endpoints must use the public issuer. */
  private toPublic(url: string): string {
    return url.startsWith(this.internalIssuer) ? this.issuer + url.slice(this.internalIssuer.length) : url;
  }

  /** Server-side calls go to the in-cluster issuer. */
  private toInternal(url: string): string {
    return url.startsWith(this.issuer) ? this.internalIssuer + url.slice(this.issuer.length) : url;
  }
}
