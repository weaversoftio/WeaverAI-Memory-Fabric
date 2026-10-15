import { createHash, timingSafeEqual } from 'node:crypto';
import { compactDecrypt } from 'jose';
import type { HeaderInjectedProvider, ExternalIdentity } from './types.js';

interface SsoIdentityClaims {
  loginname?: string;
  LoginName?: string;
  staffid?: number | string;
  StaffId?: number | string;
  staffname?: string;
  StaffName?: string;
  displayname?: string;
  displayName?: string;
  deptid?: number | string;
  DeptId?: number | string;
  deptname?: string;
  DeptName?: string;
  expiration?: string;
  Expiration?: string;
  [key: string]: unknown;
}

export interface SsoProviderConfig {
  enabled: boolean;
  appToken: string;
  safeMode: boolean;
  requireSignature: boolean;
  appUrl: string;
  loginUrl: string;
  logoutUrl: string;
  paasId: string;
  /**
   * Identifier of the domain written to Core `meta_users.auth_provider` (aligned with `PanelAuthConfig.sso.authProvider`).
   * The same value is used for account creation and reverse lookup; the Service layer injects it from config when constructing the Provider.
   * Compatibility: when old callers do not pass it, it is treated as 'local' (aligned with the Core default); behavior is equivalent.
   */
  authProvider?: string;
}

function validAppToken(token: string): boolean {
  return Buffer.byteLength(token, 'utf8') === 32;
}

export class SsoProvider implements HeaderInjectedProvider {
  readonly id = 'sso';
  readonly type = 'sso' as const;
  readonly kind = 'header-injected' as const;
  readonly displayName = 'Enterprise SSO';
  readonly authProviderDomain: string;
  /**
   * Name of the request header through which the upstream gateway injects identity.
   *
   * Hard-coded literal (no default-value fallback): this is the fixed protocol header of the Enterprise SSO gateway;
   * a different protocol means a different Provider class, rather than turning it into configuration.
   */
  readonly ingressHeaderName = 'x-enterprise-sso-identity';

  constructor(private readonly config: SsoProviderConfig) {
    if (config.enabled && !validAppToken(config.appToken)) {
      throw new Error('PANEL_AUTH_SSO_APP_TOKEN must be exactly 32 UTF-8 bytes when Enterprise SSO auth is enabled');
    }
    if (config.enabled && !config.appUrl) {
      throw new Error('PANEL_AUTH_SSO_APP_URL is required when Enterprise SSO auth is enabled');
    }
    if (config.enabled) {
      // APP_URL is the externally visible address of **our** panel (the IdP redirects back here after authentication), not the IdP site,
      // so the "HTTPS only" constraint of some IdPs does not apply: http is legitimate for intranet/local deployments.
      // We only validate here that it must be an absolute URL -- the IdP needs to redirect the browser back, and a relative path cannot be redirected to.
      try {
        new URL(config.appUrl);
      } catch {
        throw new Error('PANEL_AUTH_SSO_APP_URL must be a valid absolute URL');
      }
    }
    this.authProviderDomain = config.authProvider?.trim() || 'local';
  }

  /**
   * Entry point of the `HeaderInjectedProvider` contract.
   *
   * Keeps `authenticate` as an equivalent alias (for old tests/compatibility); both share the same implementation internally.
   */
  async authenticateFromHeaders(
    headers: Record<string, string | undefined>,
  ): Promise<ExternalIdentity | null> {
    return this.doAuthenticate(headers);
  }

  /** @deprecated Use `authenticateFromHeaders`. Kept for compatibility with existing tests and call sites. */
  async authenticate(headers: Record<string, string | undefined>): Promise<ExternalIdentity | null> {
    return this.doAuthenticate(headers);
  }

  private async doAuthenticate(
    headers: Record<string, string | undefined>,
  ): Promise<ExternalIdentity | null> {
    const normalized = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const identityHeader = normalized[this.ingressHeaderName];
    let identity: SsoIdentityClaims | null = null;
    if (identityHeader) {
      const signature = normalized.signature;
      if ((!signature && this.config.requireSignature) || (signature && !this.verifySignature(normalized))) {
        return null;
      }
      identity = await this.decryptIdentity(identityHeader);
    }
    if (!identity && !this.config.safeMode) identity = this.readPlainIdentity(normalized);
    if (!identity) return null;

    const loginName = this.stringValue(identity.loginname ?? identity.LoginName);
    const staffId = this.stringValue(identity.staffid ?? identity.StaffId);
    const subject = staffId || loginName;
    if (!subject) return null;
    return {
      providerId: this.id,
      subject,
      loginName: loginName || subject,
      displayName: this.stringValue(
        identity.displayname ?? identity.displayName ?? identity.staffname ?? identity.StaffName,
      ),
      staffId,
      departmentId: this.stringValue(identity.deptid ?? identity.DeptId),
      departmentName: this.stringValue(identity.deptname ?? identity.DeptName),
      claims: identity,
    };
  }

  /**
   * Get a URL that must be provided by configuration.
   *
   * No built-in default: Enterprise SSO login/logout addresses are internal infrastructure information, so hard-coding them in source is both an information exposure
   * and lets "forgot to configure" degrade into a silent error (redirecting to a wrong address with no error, extremely hard to troubleshoot).
   * Throw explicitly, so a missing configuration is exposed immediately at startup / link setup.
   */
  private requiredUrl(value: string, envKey: string): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) {
      throw new Error(`${envKey} is required when Enterprise SSO auth is enabled (no built-in default)`);
    }
    try {
      new URL(trimmed);
    } catch {
      throw new Error(`${envKey} must be a valid absolute URL`);
    }
    return trimmed;
  }

  buildLoginUrl(callbackUrl: string): string {
    const base = this.requiredUrl(this.config.loginUrl, 'PANEL_AUTH_SSO_LOGIN_URL');
    const query = [`oauth=true`, `url=${encodeURIComponent(callbackUrl)}`];
    if (this.config.paasId) query.push(`appkey=${encodeURIComponent(this.config.paasId)}`);
    return `${base}${base.includes('?') ? '&' : '?'}${query.join('&')}`;
  }

  buildLogoutUrl(returnTo: string): string {
    const base = this.requiredUrl(this.config.logoutUrl, 'PANEL_AUTH_SSO_LOGOUT_URL');
    const query = ['oauth=true'];
    if (this.config.paasId) query.push(`appkey=${encodeURIComponent(this.config.paasId)}`);
    query.push(`url=${encodeURIComponent(returnTo)}`);
    return `${base}${base.includes('?') ? '&' : '?'}${query.join('&')}`;
  }

  private async decryptIdentity(header: string): Promise<SsoIdentityClaims | null> {
    try {
      const { plaintext } = await compactDecrypt(header, Buffer.from(this.config.appToken, 'utf8'));
      const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      const identity = parsed as SsoIdentityClaims;
      const expiration = identity.expiration ?? identity.Expiration;
      if (expiration) {
        const expiry = Date.parse(expiration);
        if (!Number.isFinite(expiry) || expiry < Date.now() - 5 * 60 * 1000) return null;
      }
      return identity;
    } catch {
      return null;
    }
  }

  private verifySignature(headers: Record<string, string | undefined>): boolean {
    const timestamp = headers.timestamp;
    const signature = headers.signature;
    if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
    const timestampNumber = Number(timestamp);
    if (!Number.isFinite(timestampNumber) || Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 180) {
      return false;
    }
    const extHeaders = this.config.safeMode
      ? [headers['x-rio-seq'] ?? '', '', '', '']
      : [headers['x-rio-seq'] ?? '', headers.staffid ?? '', headers.staffname ?? '', headers['x-ext-data'] ?? ''];
    const source = `${timestamp}${this.config.appToken}${extHeaders.join(',')}${timestamp}`;
    const expected = createHash('sha256').update(source).digest('hex').toUpperCase();
    const actual = signature.toUpperCase();
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  }

  private readPlainIdentity(headers: Record<string, string | undefined>): SsoIdentityClaims | null {
    const staffId = headers.staffid;
    const staffName = headers.staffname;
    if (!staffId && !staffName) return null;
    return { staffid: staffId, staffname: staffName, loginname: staffName || staffId };
  }

  private stringValue(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    return text || undefined;
  }
}
