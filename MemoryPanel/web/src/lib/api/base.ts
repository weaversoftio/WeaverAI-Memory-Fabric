/**
 * api/base.ts - API infrastructure.
 *
 * Rules (no Cookie, stateless):
 *   - Metadata CRUD all goes through POST /api/v1/meta/{action};
 *   - Auth: the frontend caches instance_id + user_key in sessionStorage (see lib/panelSession.ts),
 *     and injects the Headers X-Wamf-Service-Id + X-Wamf-User-Key on every request (except auth/verify,
 *     whose user_key goes only in the body, not in a Header);
 *   - agent-fixed-asset/* does not apply to the generic "asset" UI (PANEL_CAPABILITIES.assets is false),
 *     and skill mounting goes through the v3 data-plane fork (skillApi.forkToAgent);
 *   - All functions return Promise<T> and throw ApiError on failure.
 */
import { getPanelSession, clearPanelSession } from '../panelSession';
import { formatApiErrorMessage } from '../error-message';
import type { MetaEnvelope, PaginatedResult, PublicUser } from './types';

/**
 * Generic "asset" capability switch.
 * Before the UI consumes assetsApi / agentsApi.getAssets|getFixedAssets|setFixedAssets it should check
 * `PANEL_CAPABILITIES.assets`; when false, show a "not yet available" placeholder and do not issue requests doomed to return 501.
 */
export const PANEL_CAPABILITIES = {
  assets: false,
} as const;

// ========================= Error =========================

export class ApiError extends Error {
  public code?: number | string;
  public requestId?: string;
  public rawMessage?: string;

  constructor(
    public status: number,
    public statusText: string,
    public body: string,
    opts: { code?: number | string; requestId?: string; rawMessage?: string } = {}
  ) {
    super(formatApiErrorMessage({
      code: opts.code,
      message: opts.rawMessage ?? statusText,
      requestId: opts.requestId,
      httpStatus: status,
      httpStatusText: statusText,
      body,
    }));
    this.name = 'ApiError';
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.rawMessage = opts.rawMessage ?? statusText;
  }
}

// ========================= Base Request =========================

const AUTH_UNAUTHORIZED_EVENT = 'auth:unauthorized';

/** Emit a 401 event; the App layer listens, clears the auth state and shows the login page */
function emitUnauthorized() {
  window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT));
}

/** Listen for the 401 event */
export function onUnauthorized(handler: () => void): () => void {
  window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handler);
  return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handler);
}

function parseMetaErrorEnvelope(text: string): {
  code?: number | string;
  requestId?: string;
  rawMessage?: string;
} {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return {};
  try {
    const env = JSON.parse(trimmed) as MetaEnvelope<unknown>;
    if (typeof env?.message === 'string' && env.message.trim()) {
      return {
        code: env.code,
        requestId: env.request_id,
        rawMessage: env.message,
      };
    }
  } catch {
    /* non-JSON error body */
  }
  return {};
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders };
  const init: RequestInit = { method, headers, credentials: 'include' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    const text = await res.text().catch(() => '');
    const env = parseMetaErrorEnvelope(text);
    // A Enterprise SSO login confirmation has not yet established a business session; on failure the whole login page state must not be cleared.
    if (!path.endsWith('/auth/idp/sso/complete')) emitUnauthorized();
    throw new ApiError(res.status, res.statusText, text || 'Unauthorized', env);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const env = parseMetaErrorEnvelope(text);
    throw new ApiError(res.status, res.statusText, text, env);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// ========================= Meta API base =========================

export const META_PREFIX = '/api/v1/meta';
export const META_PAGE_SIZE = 100;

/**
 * Clear the frontend session on logout / 401 (instance_id + user_key + user cache).
 * There is no Cookie; "clearing the session" just clears sessionStorage and involves no backend call.
 */
export function clearSessionCache(): void {
  clearPanelSession();
}

/** Get the current logged-in user from the session; throws when not logged in (callers should ensure they are logged in first). */
export async function getCurrentUser(): Promise<PublicUser> {
  const session = getPanelSession();
  if (!session?.user) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  return session.user;
}

/**
 * Unwrap the kernel's unified envelope: throws ApiError when `code !== 0` or `data` is empty.
 *
 * The envelope structure of transparent proxies such as meta (/api/v1/meta/*) and analytics (/api/v1/analytics/*) is
 * exactly the same, and the unwrap logic is carried by this one function, avoiding behavior drift from each client reimplementing it.
 */
export function unwrapEnvelope<T>(envelope: MetaEnvelope<T>, emptyMessage: string): T {
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  if (envelope.data === null || envelope.data === undefined) {
    throw new ApiError(200, envelope.message || emptyMessage, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message || emptyMessage,
    });
  }
  return envelope.data;
}

/**
 * Common call for the meta transparent proxy: inject the given Headers, POST the body, parse the envelope.
 * `auth/verify` goes through this function but passes only X-Wamf-Service-Id (no user-key),
 * other actions go through `metaPost` (which injects both Headers from the session automatically).
 */export async function metaCall<T>(
  action: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<T> {
  const envelope = await request<MetaEnvelope<T>>('POST', `${META_PREFIX}/${action}`, body, headers);
  return unwrapEnvelope(envelope, 'empty meta response');
}

export async function metaPost<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const session = getPanelSession();
  if (!session) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  const headers: Record<string, string> = { 'X-Wamf-Service-Id': session.instanceId };
  // An IdP Session authenticates with an HttpOnly Cookie; user_key is not sent down to the browser.
  if (session.userKey) headers['X-Wamf-User-Key'] = session.userKey;
  return metaCall<T>(action, body, headers);
}

/**
 * Fetch all items of a meta list page by page (kernel DEFAULT_PAGINATION = {limit: 20};
 * without passing limit you only get the first 20, so list-type reads must use this helper to get everything).
 *
 * offset must step by limit, **not** by `items.length`: for endpoints with filter semantics
 * (e.g. agent-fixed-asset/list-with-detail, where total is the pre-filter total and items is the filtered set),
 * `items.length < limit`, and stepping by items.length would restart the next page from the wrong position,
 * causing duplicate entries; when a whole page is filtered out it would also break early and miss trailing data.
 */
export async function metaListAll<T>(action: string, body: Record<string, unknown>): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await metaPost<PaginatedResult<T>>(action, {
      ...body,
      limit: META_PAGE_SIZE,
      offset,
    });
    const batch = page.items ?? [];
    items.push(...batch);
    const total = typeof page.total === 'number' ? page.total : undefined;
    if (batch.length === 0) {
      // Empty page: usually means the end has been reached. But for endpoints with filter semantics a middle page may be entirely empty
      // (total is still the pre-filter total); in that case keep advancing so later valid data is not missed.
      if (total !== undefined && offset + META_PAGE_SIZE < total) {
        offset += META_PAGE_SIZE;
        continue;
      }
      break;
    }
    offset += META_PAGE_SIZE;
    if (total !== undefined && offset >= total) break;
  }
  return items;
}

/**
 * "In-flight request dedup": while the previous call on the same key has not settled, reuse the same Promise,
 * and remove it from the table as soon as the request finishes (no result caching).
 *
 * Purpose: eliminate the duplicate network requests for the same endpoint caused by React 18 StrictMode double-invoking effects in development,
 * and by components mounting concurrently.
 *
 * Constraint: use only for **idempotent read-only** endpoints (list/get). Write operations such as create/revoke must never reuse it,
 * otherwise two independent writes would be merged into one.
 */
const inFlightReads = new Map<string, Promise<unknown>>();
export function dedupeInFlight<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = inFlightReads.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = factory().finally(() => {
    inFlightReads.delete(key);
  });
  inFlightReads.set(key, p);
  return p;
}
