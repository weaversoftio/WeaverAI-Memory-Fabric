/**
 * `POST /v3/instance/proxy-destroy` -- ops endpoint: clean up the ProxyStorage data cached on the proxy side for an instance
 * (= spaceId).
 *
 * Contract field names align with core's `/v3/instance/destroy`
 * (`wamf-memory-openclaw-plugin/src/gateway/server.ts:1202-1221`); the path uses the
 * `proxy-destroy` action to distinguish it from core's `destroy`, easy to tell apart in captures/logs.
 *
 * Request:
 *   { "instance_id": "<spaceId>" }
 * Header optional: Authorization: Bearer <admin.apiKey>
 *
 * Response 200:
 *   {
 *     "code": 0, "message": "ok",
 *     "data": {
 *       "instance_id": "...",
 *       "cleaned": {
 *         "storage_backend": "sqlite" | "fs" | "memory",
 *         "storage_ttl_deleted":   <number>,   // defaults to 0; on error storage_ttl_error appears as well
 *         "storage_nottl_deleted": <number>,
 *         "redis_skipped":         "per-session-ttl-only"
 *       }
 *     }
 *   }
 *
 * Failures:
 *   400 missing parameter / invalid parameter (contains `/` or `..`)
 *   401 auth enabled and Bearer missing / mismatched
 *   200 partial failure: cleaned contains a <step>_error field (aligned with core's partial-success-does-not-block policy)
 *
 * Note: the Redis session store (`cg:sess:*`) is not cleaned. The routing module's `sessionKey` comes from
 * `x-conversation-id` / `x-claude-code-session-id` (`profiles/*.ts`) and does not
 * contain the spaceId, so it cannot be SCANned precisely by space; the default TTL of 1800s expires it naturally. `redis_skipped: "per-session-ttl-only"`
 * in cleaned declares this explicitly.
 */

import type { Context } from "hono";
import { getProxyStorage } from "../storage/factory.js";
import { assertKeySegment } from "../storage/key-utils.js";
import { log } from "../report/log.js";
import type { ProxyConfig } from "../types.js";
import { adminAuthError, checkAdminAuth } from "./admin-auth.js";

/** Unified response envelope of the ops endpoint. */
interface EnvelopeOk<T> {
  code: 0;
  message: "ok";
  data: T;
}
interface EnvelopeErr {
  code: number;
  message: string;
}
interface DestroyResponseData {
  instance_id: string;
  cleaned: Record<string, unknown>;
}

/**
 * Build the handler; `config` is only used to read `admin.apiKey`, the storage singleton is obtained via
 * `getProxyStorage(config.storage)` (`initProxyStorage()` has already been
 * awaited in index.ts, so this is an idempotent get).
 */
export function createInstanceDestroyHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    // ── 1. Auth ────────────────────────────────────────────────
    const authResult = checkAdminAuth(c, config.admin.apiKey);
    if (authResult !== "ok") {
      return adminAuthError(c, authResult);
    }

    // -- 2. Parameter parsing & validation -----------------------------------
    let body: { instance_id?: unknown } | null = null;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: 400, message: "invalid JSON body" } satisfies EnvelopeErr, 400);
    }
    const instanceId = typeof body?.instance_id === "string" ? body.instance_id : "";
    if (!instanceId) {
      return c.json(
        { code: 400, message: "Missing required field: instance_id" } satisfies EnvelopeErr,
        400,
      );
    }
    try {
      // Reuse the sessionDirOf validation rules: non-empty + no `/` + no `..`
      assertKeySegment("instance_id", instanceId);
    } catch (err) {
      return c.json(
        {
          code: 400,
          message: `invalid instance_id: ${err instanceof Error ? err.message : String(err)}`,
        } satisfies EnvelopeErr,
        400,
      );
    }

    log.info("instance_destroy.start", { instance_id: instanceId });

    // -- 3. Cleanup actions --------------------------------------------------
    const cleaned: Record<string, unknown> = {};

    const storage = getProxyStorage(config.storage);
    cleaned.storage_backend = storage.type;

    // 3a. ttl/<spaceId>/ --   hot caches such as session-init / hook warm-up
    try {
      cleaned.storage_ttl_deleted = await storage.delPrefix(`ttl/${instanceId}/`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cleaned.storage_ttl_deleted = 0;
      cleaned.storage_ttl_error = msg;
      log.warn("instance_destroy.storage_ttl_error", { instance_id: instanceId, error: msg });
    }

    // 3b. nottl/<spaceId>/ -- business state such as binding / skill extraction / kv version pin
    try {
      cleaned.storage_nottl_deleted = await storage.delPrefix(`nottl/${instanceId}/`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cleaned.storage_nottl_deleted = 0;
      cleaned.storage_nottl_error = msg;
      log.warn("instance_destroy.storage_nottl_error", { instance_id: instanceId, error: msg });
    }

    // 3c. Redis is not cleaned -- declarative, so callers know we did not miss it
    cleaned.redis_skipped = "per-session-ttl-only";

    log.info("instance_destroy.done", { instance_id: instanceId, cleaned });

    return c.json({
      code: 0,
      message: "ok",
      data: { instance_id: instanceId, cleaned },
    } satisfies EnvelopeOk<DestroyResponseData>);
  };
}
