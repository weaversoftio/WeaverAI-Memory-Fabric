/**
 * /v3/chat-memory/* HTTP handlers -- Chat Memory content clearing.
 *
 * Design notes:
 *   - `clear` deletes only the **content**, not the asset. asset_id, Team/Agent ownership, Agent bindings,
 *     ACL, Owner, name and visibility are all kept; after clearing, the Agent keeps writing with the original memory_id.
 *   - If any memory_id does not exist / is not chat_memory / has no resolvable agent, the whole batch is rejected
 *     (deletion starts only after all upfront resolution passes).
 *   - Idempotent: calling again with an already-cleared memory_id still returns success, with counts of 0.
 *   - Audit: for each memory_id, one delete event each for L1/L2/L3, recording only
 *     memory_id + time + result, **retaining no original content**.
 *
 * Auth model (consistent with the L0-L3 data plane):
 *   The kernel treats Bearer + x-wamf-service-id as a trusted admin-level credential, **does no user-level
 *   auth** and does not parse x-wamf-user-key -- consistent with similar delete endpoints such as conversation/delete and
 *   atomic/delete. "Only the asset Owner may operate" is enforced by the **panel backend** before forwarding
 *   (see the NOT_ASSET_OWNER check in MemoryPanel routes/chat-memory.ts).
 *
 * Registered the same way as /v3/skill/* and /v3/knowledge/* (extraRouteTable),
 * so it bypasses the strict-isolation triple check of L0-L3 -- this endpoint's scope is determined by
 * memory_ids themselves and does not depend on the agent/session in request headers.
 */

import { randomUUID } from "node:crypto";

import { ZodError, z } from "zod";

import { errorEnvelope, successEnvelope } from "./v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import type { IMemoryStore, MemoryContentClearResult } from "../core/store/types.js";
import { StoragePaths } from "../core/storage/types.js";
import { createScopedStorageAdapter, scopeProfileStorageView, type StorageAdapter } from "../core/storage/adapter.js";
import { buildProfileIsolationScope } from "../core/profile/profile-scope.js";
import { MetadataError, type MetadataService } from "../metadata/service/metadata-service.js";
import type { Logger } from "../core/types.js";

const TAG = "[chat-memory-handlers]";

/** Upper limit of memory_ids per clear call. */
export const CHAT_MEMORY_CLEAR_MAX = 100;

// ═════════════════════════════════════════════════════════════
//  Schema
// ═════════════════════════════════════════════════════════════

export const chatMemoryClearRequestSchema = z.object({
  memory_ids: z.array(z.string()).min(1).max(CHAT_MEMORY_CLEAR_MAX),
}).transform((data) => {
  const seen = new Set<string>();
  const memoryIds: string[] = [];
  for (const raw of data.memory_ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    memoryIds.push(id);
  }
  return { memory_ids: memoryIds };
}).refine(
  (data) => data.memory_ids.length > 0,
  { message: "memory_ids must contain at least one non-empty id" },
);

/** Clear result of a single memory. */
export interface ChatMemoryClearItem {
  memory_id: string;
  /** Whether the clear succeeded. On failure, the memory_id content may remain; the caller can retry (idempotent). */
  cleared: boolean;
  l0_deleted: number;
  l1_deleted: number;
  /** Number of L2/L3 profile records (store rows + storage files). */
  profile_deleted: number;
  /** Failure reason; not returned on success. */
  reason?: string;
  /**
   * Whether the failure is worth retrying.
   *
   * Clearing is idempotent, so it has already been retried several times internally; true here means retries still did not
   * succeed (usually database/storage is persistently unavailable), and the caller can try again later to clean up the remaining content.
   * Non-retryable failures such as parameter errors are false.
   */
  retryable?: boolean;
  /** Actual number of internal attempts, for troubleshooting. */
  attempts?: number;
}

export interface ChatMemoryClearData {
  items: ChatMemoryClearItem[];
  /** true when everything succeeded. */
  all_cleared: boolean;
}

// ═════════════════════════════════════════════════════════════
//  Deps
// ═════════════════════════════════════════════════════════════

export interface ChatMemoryRouterDeps {
  getStore: () => IMemoryStore | undefined;
  getStorage: () => StorageAdapter | undefined;
  getMetadataService?: (instanceId: string) => Promise<MetadataService>;
  logger: Logger;
}

function formatZodErr(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** MetadataError.code -> envelope code. Keeps the same semantics as the mapping in v3-meta-router. */
function metadataErrorCode(code: string): number {
  if (code === "permission_denied") return 403;
  if (code.endsWith("_not_found")) return 404;
  return 400;
}

// ═════════════════════════════════════════════════════════════
//  Clear
// ═════════════════════════════════════════════════════════════

/**
 * Delete all L2/L3 storage objects under this (team, agent) scope.
 *
 * Storage is isolated by the profile scope prefix (`profiles/<scope>/`), so deletion goes directly by prefix
 * as a whole, covering persona.md, scene_blocks/, .metadata/scene_index.json and any
 * derived files; it never goes beyond the scope of this (team, agent).
 *
 * Returns the number of deleted objects (used for the audit count). Failures are thrown upward; the caller marks this memory as failed.
 */
async function clearProfileStorage(
  baseStorage: StorageAdapter,
  teamId: string,
  agentId: string,
): Promise<number> {
  // WARNING: must validate here; cannot rely on the caller.
  // buildProfileIsolationScope silently falls back to "default" for empty values, producing
  // the **legitimate-looking** scope `team:default|agent:default` -- once
  // teamId/agentId is empty, it would delete data in the shared default scope instead of reporting an error.
  const team = (teamId ?? "").trim();
  const agent = (agentId ?? "").trim();
  if (!team || !agent) {
    throw new Error(
      "clearProfileStorage requires non-empty teamId and agentId " +
      "(empty values would silently target the shared \"default\" profile scope)",
    );
  }

  const scope = buildProfileIsolationScope({ teamId: team, agentId: agent });
  // The scope prefix must stay exactly the same as v2-router scopedProfileStorage,
  // otherwise the wrong directory is cleared (or nothing is cleared).
  const scopePrefix = `profiles/${encodeURIComponent(scope)}/`;

  // rowfs: a row is a file. An empty prefix on the composite backend only routes to the fallback file side (rows are not deleted, and it
  // would wrongly delete the instance-level JSONL), so the two kinds of profile keys are deleted explicitly here; rows are also
  // deleted by store.clearMemoryContent, and both sides are idempotent.
  if (baseStorage.getBackend().type === "rowfs") {
    const storage = scopeProfileStorageView(baseStorage, scopePrefix, { teamId: team, agentId: agent });
    let removedRows = 0;
    try {
      const entries = await storage.readdir(StoragePaths.sceneBlocksDir);
      removedRows = entries.filter((e) => !e.isDirectory).length;
      if (await storage.exists(StoragePaths.persona)) removedRows += 1;
    } catch { /* scope does not exist yet -> treat as already cleared */ }
    await storage.rmdir(StoragePaths.sceneBlocksDir);
    await storage.unlink(StoragePaths.persona);
    return removedRows;
  }

  const storage = createScopedStorageAdapter(baseStorage, scopePrefix);

  // Count first, then delete: the return value of deleteByPrefix is not fully consistent across backends,
  // so the result of list is used here as the authoritative source for the audit count.
  let removed = 0;
  try {
    const entries = await storage.readdir("");
    removed = entries.filter((e) => !e.isDirectory).length;
  } catch { /* scope does not exist yet -> treat as already cleared */ }

  // After the scoped adapter's key() concatenation, an empty-string prefix becomes `profiles/<scope>/`,
  // which is never empty, never crosses into other agents, and never triggers the backend's empty-key protection.
  await storage.rmdir("");

  return removed;
}

/**
 * Clear the chat_memory **content** of a (team, agent): L0/L1/L2/L3 + vectors + files.
 * Deletes content only and **touches no asset records** (asset / binding / ACL are decided by each caller).
 *
 * Shared by two callers, to keep the two cleanup logics from drifting apart:
 *   - `/v3/chat-memory/clear` -- keeps the asset after clearing; the Agent keeps using the original memory_id
 *   - `MetadataService.archiveAgent` -- deletes the asset after clearing (Agent deletion scenario)
 *
 * Failures are thrown upward; the caller decides whether to mark a single item as failed or abort the whole flow.
 */
export async function clearChatMemoryContent(args: {
  store: IMemoryStore;
  storage: StorageAdapter;
  teamId: string;
  agentId: string;
}): Promise<{ l0Deleted: number; l1Deleted: number; profileDeleted: number }> {
  // Self-validate at the entry: this is a destructive operation with two callers, so it cannot rely on upstream having validated.
  const teamId = (args.teamId ?? "").trim();
  const agentId = (args.agentId ?? "").trim();
  if (!teamId || !agentId) {
    throw new Error("clearChatMemoryContent requires non-empty teamId and agentId");
  }

  if (typeof args.store.clearMemoryContent !== "function") {
    throw new Error("store does not support clearMemoryContent");
  }
  const result: MemoryContentClearResult = await args.store.clearMemoryContent({
    teamId,
    agentId,
  });
  const filesRemoved = await clearProfileStorage(args.storage, teamId, agentId);
  return {
    l0Deleted: result.l0Deleted,
    l1Deleted: result.l1Deleted,
    profileDeleted: result.profilesDeleted + filesRemoved,
  };
}

/** Upper limit of overall retries for content clearing (including the first attempt). */
export const CLEAR_MAX_ATTEMPTS = 3;
/** Retry backoff base (milliseconds); the actual wait is BASE * 2^(n-1). */
const CLEAR_RETRY_BASE_DELAY_MS = 300;

/**
 * Decide whether an error is worth retrying.
 *
 * Non-retryable errors are **input/contract errors** -- retrying ten thousand times gives the same result and only prolongs the request.
 * All others (database timeouts, storage 5xx, connection resets, etc.) are treated as transient failures and retried.
 */
function isNonRetryableClearError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    // Empty input -- a caller bug; retrying is pointless
    msg.includes("requires non-empty teamId and agentId")
    || msg.includes("requires a non-empty sessionId")
    // store capability missing -- a configuration problem
    || msg.includes("does not support clearMemoryContent")
    // Dangerous filter blocked by the guardrail -- a code defect; it must be surfaced rather than masked by retries
    || msg.includes("refusing clearMemoryContent")
    || msg.includes("would wipe the whole collection")
    || msg.includes("missing required scope field")
  );
}

/**
 * Content clearing with overall retry.
 *
 * Why retry at **this layer** instead of relying only on the driver's per-request retry:
 * per-request retry only covers "a flaky single HTTP call", but clearing is the four steps L0->L1->profiles->storage,
 * and a complete failure in any step leaves a "half-cleared" state. Clearing is naturally idempotent (deleting by filter;
 * deleting what was already deleted returns 0), so re-running the whole thing is safe and converges a half-cleared state to fully cleared.
 *
 * On failure, throws the last error, with the attempt count prefixed to the message for troubleshooting.
 */
async function clearChatMemoryContentWithRetry(args: {
  store: IMemoryStore;
  storage: StorageAdapter;
  teamId: string;
  agentId: string;
  logger: Logger;
  memoryId: string;
}): Promise<{
  result: { l0Deleted: number; l1Deleted: number; profileDeleted: number };
  attempts: number;
}> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= CLEAR_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await clearChatMemoryContent({
        store: args.store,
        storage: args.storage,
        teamId: args.teamId,
        agentId: args.agentId,
      });
      if (attempt > 1) {
        args.logger.info(
          `${TAG} clear succeeded on attempt ${attempt}/${CLEAR_MAX_ATTEMPTS} memory=${args.memoryId}`,
        );
      }
      return { result, attempts: attempt };
    } catch (err) {
      lastErr = err;

      if (isNonRetryableClearError(err)) {
        args.logger.error(
          `${TAG} clear failed with non-retryable error memory=${args.memoryId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }

      if (attempt < CLEAR_MAX_ATTEMPTS) {
        const delay = CLEAR_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        args.logger.warn(
          `${TAG} clear attempt ${attempt}/${CLEAR_MAX_ATTEMPTS} failed memory=${args.memoryId}, ` +
          `retrying in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastErr;
}

/**
 * Clearing with overall retry, reused by `archiveAgent` (which also clears content when deleting an Agent).
 *
 * Shares the same retry policy as the clear endpoint so both paths behave consistently: both self-heal transient
 * database/storage failures, and neither masks parameter errors with retries.
 */
export async function clearChatMemoryContentResilient(args: {
  store: IMemoryStore;
  storage: StorageAdapter;
  teamId: string;
  agentId: string;
  logger: Logger;
}): Promise<{ l0Deleted: number; l1Deleted: number; profileDeleted: number }> {
  const { result } = await clearChatMemoryContentWithRetry({
    ...args,
    memoryId: `${args.teamId}/${args.agentId}`,
  });
  return result;
}

/**
 * Write clear audit. One delete event each for L1/L2/L3, with record_id set to memory_id (asset_id),
 * writing no original content. Audit failure does not block the main flow (same semantics as v2-router recordAudit).
 */
export async function recordClearAudit(
  store: IMemoryStore,
  args: {
    memoryId: string;
    teamId: string;
    agentId: string;
    requestId: string;
    logger: Logger;
  },
): Promise<void> {
  if (!store.appendAudit) return;
  const now = Date.now();
  for (const layer of ["L1", "L2", "L3"] as const) {
    try {
      await store.appendAudit({
        audit_id: `audit-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        record_id: args.memoryId,
        layer,
        action: "delete",
        team_id: args.teamId,
        agent_id: args.agentId,
        version: 0,
        updated_at_ms: now,
        request_id: args.requestId,
      });
    } catch (err) {
      args.logger.warn(
        `${TAG} audit append failed (clear/${layer} memory=${args.memoryId}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function handleChatMemoryClear(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  depsRaw: unknown,
): Promise<ApiResponseEnvelope> {
  const deps = depsRaw as ChatMemoryRouterDeps;
  const parsed = chatMemoryClearRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const { memory_ids } = parsed.data;

  const store = deps.getStore();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  if (typeof store.clearMemoryContent !== "function") {
    return errorEnvelope(503, "Store does not support chat memory clear", requestId);
  }
  const storage = deps.getStorage();
  if (!storage) return errorEnvelope(503, "Storage not available", requestId);
  if (!deps.getMetadataService) {
    return errorEnvelope(503, "Metadata service not available", requestId);
  }

  let metaSvc: MetadataService;
  try {
    metaSvc = await deps.getMetadataService(auth.serviceId);
  } catch (err) {
    deps.logger.warn(`${TAG} metadata service unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return errorEnvelope(503, "Metadata service not available", requestId);
  }

  // -- Upfront whole-batch resolution: asset exists + asset_type=chat_memory + agent resolvable.
  //    If any fails the whole batch is rejected and nothing is cleared.
  //
  //    **No user-level Owner check here** -- keeps the same trust model as the L0-L3 data plane:
  //    the kernel data plane treats Bearer + x-wamf-service-id as a trusted (admin-level) credential
  //    and does not parse x-wamf-user-key. "Only the asset Owner may operate" is done by the **panel backend**
  //    before forwarding (see the NOT_ASSET_OWNER check in MemoryPanel routes/chat-memory.ts).
  //    Doing it again in the kernel would cause: (1) behavior inconsistent with similar delete endpoints (conversation/atomic delete);
  //    (2) server-side callers (with no user context) being unable to use this endpoint.
  let targets: Array<{ asset_id: string; team_id: string; agent_id: string }>;
  try {
    targets = await metaSvc.resolveChatMemoryTargets(memory_ids);
  } catch (err) {
    if (err instanceof MetadataError) {
      return errorEnvelope(metadataErrorCode(err.code), err.message, requestId);
    }
    throw err;
  }

  // -- Clear content one by one. All validation has passed, so a failure here can only be a storage/database fault,
  //    hence the overall retry (clearing is idempotent, re-running is safe). --
  const items: ChatMemoryClearItem[] = [];
  for (const target of targets) {
    try {
      const { result, attempts } = await clearChatMemoryContentWithRetry({
        store,
        storage,
        teamId: target.team_id,
        agentId: target.agent_id,
        logger: deps.logger,
        memoryId: target.asset_id,
      });

      await recordClearAudit(store, {
        memoryId: target.asset_id,
        teamId: target.team_id,
        agentId: target.agent_id,
        requestId,
        logger: deps.logger,
      });

      items.push({
        memory_id: target.asset_id,
        cleared: true,
        l0_deleted: result.l0Deleted,
        l1_deleted: result.l1Deleted,
        profile_deleted: result.profileDeleted,
        ...(attempts > 1 ? { attempts } : {}),
      });
    } catch (err) {
      // No rollback: clearing is idempotent, so the caller can simply retry to clean up what remains.
      // Record only safe information; do not pass the underlying error text through to the caller.
      const retryable = !isNonRetryableClearError(err);
      deps.logger.error(
        `${TAG} clear failed memory=${target.asset_id} team=${target.team_id} ` +
        `agent=${target.agent_id} retryable=${retryable}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      items.push({
        memory_id: target.asset_id,
        cleared: false,
        l0_deleted: 0,
        l1_deleted: 0,
        profile_deleted: 0,
        reason: retryable
          ? `clear failed after ${CLEAR_MAX_ATTEMPTS} attempts, please retry later`
          : "clear rejected due to invalid request or server configuration",
        retryable,
        attempts: retryable ? CLEAR_MAX_ATTEMPTS : 1,
      });
    }
  }

  return successEnvelope<ChatMemoryClearData>({
    items,
    all_cleared: items.every((i) => i.cleared),
  }, requestId);
}

// ═════════════════════════════════════════════════════════════
//  Route table
// ═════════════════════════════════════════════════════════════

type RouteHandler = (
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: unknown,
) => Promise<ApiResponseEnvelope>;

export function makeChatMemoryRouteTable(): Record<string, RouteHandler> {
  return {
    "/v3/chat-memory/clear": handleChatMemoryClear,
  };
}

export { handleChatMemoryClear };
