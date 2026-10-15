/**
 * Thin client for the WeaverAI Memory Fabric panel API (/api/v1/*).
 *
 * Every call carries the caller's own user key, so the panel's normal permission
 * checks (team membership, asset ownership, ACL) apply exactly as in the browser.
 */

export interface Envelope<T = unknown> {
  code: number;
  message: string;
  request_id?: string;
  data: T;
}

export class HubError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "HubError";
  }
}

export interface HubClientOptions {
  baseUrl: string;
  serviceId: string;
  userKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Why there is no key, when it's not simply missing (e.g. the WeaverAI identity was refused). */
  noKeyReason?: string;
}

const MISSING_KEY =
  "Missing memory key: connect through the WeaverAI MCP proxy with your WeaverAI token, or add your sk-mem key as the X-Memory-User-Key header in your MCP config.";

/**
 * Exchanges the WeaverAI MCP proxy's signed caller identity (X-WAIP-Identity) for the
 * caller's own Agent Memory user_key. The hub verifies the assertion; this server trusts
 * nothing in it. Throws HubError with the hub's reason when it's refused.
 */
export async function exchangeWaipIdentity(opts: {
  baseUrl: string;
  serviceId: string;
  assertion: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl}/api/v1/auth/waip/exchange`, {
      method: "POST",
      headers: { "x-wamf-service-id": opts.serviceId, "x-waip-identity": opts.assertion },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    throw new HubError(503, `WeaverAI Memory Fabric panel is unreachable (${err instanceof Error ? err.message : String(err)})`);
  }
  const env = (await res.json().catch(() => null)) as Envelope<{ user_key?: string }> | null;
  if (!env || env.code !== 0 || !env.data?.user_key) {
    throw new HubError(env?.code || res.status || 502, env?.message || `WeaverAI identity exchange failed (HTTP ${res.status})`);
  }
  return env.data.user_key;
}

export class HubClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HubClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get userKey(): string {
    return this.opts.userKey;
  }

  get serviceId(): string {
    return this.opts.serviceId;
  }

  /** POST /api/v1/{path}; returns `data` on code 0, throws HubError otherwise. */
  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!this.opts.userKey) {
      throw new HubError(401, this.opts.noKeyReason ?? MISSING_KEY);
    }
    const url = `${this.opts.baseUrl}/api/v1/${path.replace(/^\/+/, "")}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-wamf-service-id": this.opts.serviceId,
          "x-wamf-user-key": this.opts.userKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      throw new HubError(503, `WeaverAI Memory Fabric panel is unreachable (${err instanceof Error ? err.message : String(err)})`);
    }
    let env: Envelope<T>;
    try {
      env = (await res.json()) as Envelope<T>;
    } catch {
      throw new HubError(res.status || 502, `WeaverAI Memory Fabric panel returned a non-JSON response (HTTP ${res.status})`);
    }
    if (env.code !== 0) throw new HubError(env.code, env.message || `HTTP ${res.status}`);
    return env.data;
  }
}
