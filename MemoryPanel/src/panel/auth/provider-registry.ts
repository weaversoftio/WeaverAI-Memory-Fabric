import type { AuthProvider, HeaderInjectedProvider, ProviderKind, RedirectOAuth2Provider } from './types.js';

export class AuthProviderRegistry {
  private readonly providers = new Map<string, AuthProvider>();

  register(provider: AuthProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`duplicate auth provider: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): AuthProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): AuthProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Filter Providers by capability shape.
   *
   * Used by the ingress middleware (`header-injected` types must match by header name) and by the callback route
   * (`redirect-oauth2` types need state -> provider lookup).
   */
  listByKind(kind: 'header-injected'): HeaderInjectedProvider[];
  listByKind(kind: 'redirect-oauth2'): RedirectOAuth2Provider[];
  listByKind(kind: ProviderKind): AuthProvider[] {
    return this.list().filter((p) => p.kind === kind);
  }
}

