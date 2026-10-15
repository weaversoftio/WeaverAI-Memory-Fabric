/**
 * Low-level HTTP transport for the WeaverAI Memory Fabric v2 API.
 *
 * - Auth: `Authorization: Bearer {apiKey}` + `x-wamf-service-id` + optional `x-wamf-user-key`
 * - Envelope unwrap: `code === 0` → return `data`; else throw `WAMFError`
 * - trace_id: extracted from `x-trace-id` response header
 * - Zero runtime dependencies — uses native `fetch`.
 * - TLS: certificates are verified; pass `rejectUnauthorized: false` only for self-signed test gateways.
 */

import { WAMFError } from "./errors.js";
import type { ApiResponseEnvelope } from "./types.js";

export interface HttpTransportOptions {
  endpoint: string;
  /** Gateway Bearer key (KERNEL_AUTH_TOKEN / WAMF_GATEWAY_API_KEY). */
  apiKey: string;
  /** Memory instance ID (x-wamf-service-id). */
  serviceId: string;
  /** User API key (x-wamf-user-key); user/create and user/delete require a system_admin key. */
  userKey?: string;
  timeout?: number;
  /** Whether to reject self-signed / invalid TLS certs. Default: true. */
  rejectUnauthorized?: boolean;
}

export class HttpTransport {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;
  private dispatcher: unknown;

  constructor(opts: HttpTransportOptions) {
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.timeout = opts.timeout ?? 30_000;
    this.headers = {
      Authorization: `Bearer ${opts.apiKey}`,
      "x-wamf-service-id": opts.serviceId,
      "Content-Type": "application/json",
    };
    if (opts.userKey) {
      this.headers["x-wamf-user-key"] = opts.userKey;
    }

    // Certificates are verified unless the caller passes rejectUnauthorized: false
    // (self-signed test gateways). Never switch verification off process-wide.
    if (opts.rejectUnauthorized === false) {
      // Node 18+ bundles undici; dynamic import to keep zero-dep for bundlers
      const { Agent } = require("undici");
      this.dispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }
  }

  async post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T & { trace_id?: string }> {
    const url = `${this.endpoint}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const fetchOpts: RequestInit & { dispatcher?: unknown } = {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      };
      if (this.dispatcher) {
        fetchOpts.dispatcher = this.dispatcher;
      }

      const resp = await fetch(url, fetchOpts as RequestInit);

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new WAMFError(resp.status, `HTTP ${resp.status}: ${text}`);
      }

      const envelope = (await resp.json()) as ApiResponseEnvelope<T>;

      if (envelope.code !== 0) {
        const reqId =
          resp.headers.get("x-request-id") ?? envelope.request_id ?? "";
        const details =
          envelope.data && typeof envelope.data === "object"
            ? (envelope.data as Record<string, unknown>)
            : undefined;
        throw new WAMFError(envelope.code, envelope.message, reqId, details);
      }

      const result = (envelope.data ?? {}) as T & { trace_id?: string };
      const traceId = resp.headers.get("x-trace-id");
      if (traceId) {
        (result as Record<string, unknown>).trace_id = traceId;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
