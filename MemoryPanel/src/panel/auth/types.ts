import type { Context } from 'hono';

export type AuthMethod = 'user_key' | 'idp';
export type ProviderType = 'sso' | 'oidc' | 'oauth2';

/**
 * Interaction shape between a Provider and the Panel.
 *
 * - `header-injected`: the upstream gateway completes SSO on our behalf and writes the identity into request headers on redirect-back.
 *   Typical: Enterprise SSO / Enterprise SSO / TOF. The Provider only needs to implement `authenticateFromHeaders`.
 * - `redirect-oauth2`: we generate the authorize URL, the user's browser calls back with a code,
 *   we exchange the code for a token and then fetch userinfo. Typical: GitHub / self-hosted OIDC.
 *   The Provider must implement `prepareAuthorize` + `authenticateFromCallback` (not landed in this PR).
 *
 * A single field converges the capability shape; the Service decides which path to take by narrowing on `kind`,
 * avoiding hard branches on provider id in the Service.
 */
export type ProviderKind = 'header-injected' | 'redirect-oauth2';

export interface ExternalIdentity {
  providerId: string;
  subject: string;
  loginName: string;
  displayName?: string;
  email?: string;
  staffId?: string;
  departmentId?: string;
  departmentName?: string;
  claims: Record<string, unknown>;
}

export interface PanelAuthContext {
  method: AuthMethod;
  instanceId: string;
  userId?: string;
  userKey?: string;
  providerId?: string;
  externalSubject?: string;
}

/**
 * The minimal contract shared by all IdP Providers.
 *
 * A Provider is **only** responsible for converting "external protocol -> internal unified `ExternalIdentity`",
 * and is not aware of:
 *   - the Core meta API (`user/create`, `user/find-by-external`, etc. are orchestrated on the Service side)
 *   - the Panel Session / Cookie / Pending flow (Service side)
 *   - the Instance Registry (Service side)
 *
 * The concrete entry point that produces an identity is given by the sub-interfaces (header-injected / redirect-oauth2).
 */
export interface AuthProvider {
  readonly id: string;
  readonly type: ProviderType;
  readonly kind: ProviderKind;
  /**
   * Display name in the frontend login menu. May be read at runtime, replacing the hard-coded `'Enterprise SSO / Enterprise SSO'`.
   * Separate from `id`: id is the stable key for routing/storage, while displayName can be localized per deployment.
   */
  readonly displayName: string;
  /**
   * External domain identifier written to Core `meta_users.auth_provider`.
   * Together with `external_id` it forms the account lookup key; each Provider has exactly one domain.
   */
  readonly authProviderDomain: string;
}

/**
 * Provider in the gateway-injected-header mode (Enterprise SSO / Enterprise SSO / TOF).
 *
 * Characteristic: the ingress middleware identifies ownership by `ingressHeaderName`, and on a hit calls
 * `authenticateFromHeaders` to normalize into `ExternalIdentity`.
 */
export interface HeaderInjectedProvider extends AuthProvider {
  readonly kind: 'header-injected';
  /** The ingress middleware identifies request ownership by this header name, e.g. 'x-enterprise-sso-identity'. **No built-in default**. */
  readonly ingressHeaderName: string;
  buildLoginUrl(callbackUrl: string): string;
  buildLogoutUrl(returnTo: string): string;
  authenticateFromHeaders(
    headers: Record<string, string | undefined>,
  ): Promise<ExternalIdentity | null>;
}

/**
 * OAuth2 / OIDC provider (e.g. Keycloak): the panel sends the browser to the IdP's
 * authorize URL (`prepareAuthorize`); the IdP redirects back with a code, which
 * `authenticateFromCallback` exchanges for tokens and turns into an `ExternalIdentity`.
 */
export interface RedirectOAuth2Provider extends AuthProvider {
  readonly kind: 'redirect-oauth2';
  prepareAuthorize(input: {
    state: string;
    redirectUri: string;
    nonce: string;
  }): Promise<{ url: string; codeVerifier: string }>;
  authenticateFromCallback(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    expectedNonce: string;
  }): Promise<{ identity: ExternalIdentity; idToken: string }>;
  /** IdP logout URL that ends the IdP session too, or null when the IdP has none. */
  buildLogoutUrl(input: { returnTo: string; idToken?: string }): Promise<string | null>;
}

export interface AuthRouteContext {
  request: Context;
  instanceId: string;
  returnTo: string;
}

