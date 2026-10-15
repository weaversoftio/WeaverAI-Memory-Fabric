/**
 * /skill/* HTTP handlers — v3 (migrated from v2, 2026-06-17).
 *
 * Corresponding design doc: docs/design/2026-06-17-skill-redesign-v2.md section 3.5 / 3.6.
 *
 * Error code mapping (core-layer SkillCoreError -> HTTP envelope code):
 *   INVALID_FRONTMATTER       → 40001  (frontmatter.name does not match body/head)
 *   INVALID_PATH              → 40001
 *   SKILL_NOT_OWNER           → 40301
 *   SKILL_TEAM_MISMATCH       → 40302
 *   SKILL_NOT_FOUND           → 40401
 *   SKILL_VERSION_STALE       → 40901
 *   RESOURCE_TOO_LARGE        → 41301
 *   SKILL_NAME_DUPLICATE      → 42201
 *   SKILL_PATCH_NOT_UNIQUE    → 42202
 *   SKILL_FRONTMATTER_INVALID → 42203  (frontmatter parse / length / regex)
 *   STORAGE_NOT_FOUND         → 50301  (version directory was GC'd)
 *   QUEUE_UNAVAILABLE         → 50301  (queue not ready at extract time)
 *   LLM_UNAVAILABLE           → 50302  (LLM unavailable)
 *   Others                    → 50001
 */

import { randomUUID } from "node:crypto";

import { ZodError } from "zod";

import { errorEnvelope, successEnvelope } from "./v2-router.js";
import {
  createRequestSchema,
  updateRequestSchema,
  patchRequestSchema,
  deleteRequestSchema,
  getRequestSchema,
  getByNameRequestSchema,
  listRequestSchema,
  searchRequestSchema,
  versionsRequestSchema,
  filesWriteRequestSchema,
  filesRemoveRequestSchema,
  filesReadRequestSchema,
  listingRequestSchema,
  extractRequestSchema,
  exportRequestSchema,
  conversationAddRequestSchema,
  forceArchiveRequestSchema,
} from "./skill-schemas.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import { SkillCoreError, type SkillCore } from "../core/skill/skill-core.js";
import type { SkillExtractor } from "../core/skill/skill-extractor.js";
import type { Logger } from "../core/types.js";
import type { Skill, ResolvedSkillConfig } from "../core/skill/types.js";
import { DEFAULT_COMPRESS_OPTIONS } from "../core/skill/conversation-add/message-compressor.js";
import { DEFAULT_OVERSIZE_OPTIONS } from "../core/skill/conversation-add/oversize-strategy.js";
import { prepareArchivePayload } from "../core/skill/conversation-add/prepare-archive.js";
import type { CompressibleMessage } from "../core/skill/conversation-add/message-compressor.js";
import { trace } from "../core/report/trace.js";
import { metricProducer } from "../core/report/kafka-metric-producer.js";
import { obsLogger } from "../core/report/obs-logger.js";

const TAG = "[skill-handlers]";

// [obs] All observability instrumentation goes through the obsLogger base (`src/core/report/obs-logger.ts`);
// event names `skill.<xxx>.done` / `skill.<xxx>.<phase>` are written as literals directly, and fields are
// inline dicts. undefined values are passed as is, without filtering -- fully consistent with other modules in the repo (e.g.
// core/report/traced-task-executor.ts). Degradation is provided by the try/catch inside
// obsLogger; business code adds no extra defense.

// ═════════════════════════════════════════════════════════════════════
//  Deps
// ═════════════════════════════════════════════════════════════════════

export interface SkillRouterDeps {
  getSkillCore: () => SkillCore | undefined;
  /** Optional. Extractor instance (driven internally by the worker). */
  getSkillExtractor?: () => SkillExtractor | undefined;
  /** Optional. Resolved skill config; handleListing uses searchTopK to limit the number of injected entries. */
  getResolvedSkillConfig?: () => ResolvedSkillConfig | undefined;
  logger: Logger;
  /**
   * Service mode: resolve per-instance SkillCore (MongoSkillStore + file storage).
   * When provided, takes precedence over getSkillCore() for /v3/skill/* requests
   * that carry x-wamf-service-id.
   */
  resolveSkillCore?: (instanceId: string) => Promise<SkillCore | undefined>;
  /** Quota manager for skill count limit checks (like memory's checkMemoryQuota). */
  quotaManager?: import("../core/quota/quota-manager.js").QuotaManager;
  /**
   * Service mode: build a SkillExtractor for a given SkillCore.
   * Pass in the per-instance SkillCore (a remote database + file storage) + the instanceId of the current request, and returns an extractor.
   * Used for the synchronous extraction of /v3/skill/extract in service mode, replacing standalone's asynchronous queue mode.
   *
   * `instanceId` is passed to `resolveStandaloneLlmForRuntime` to build
   * `${baseUrl}/proxy/<instanceId>/v1` -- without it, the skill extractor under
   * `provider=proxy` would hit the wrong upstream URL.
   */
  buildSkillExtractor?: (
    core: SkillCore,
    instanceId: string,
  ) => SkillExtractor | Promise<SkillExtractor>;
  /**
   * Get the (per instance) MetadataService. Used to automatically register the
   * skill asset after handleCreate succeeds (asset_id === skill_id) and bind it to the owner agent's fixed-asset.
   *
   * In standalone mode the SkillCore is built globally by WamfCore (without hooks), so the handler
   * layer does this registration; in service mode the onSkillCreated hook in buildSkillCore does the same
   * thing (idempotent, no side effects on repeated calls). Both paths are covered, ensuring the frontend control page can always see the skill.
   *
   * Semantics are consistent with how handleConversationAdd in v2-router uses the same dep to automatically register chat_memory assets
   * (see v2-router.ts:648 and metadata-service.ts:ensureSkillAsset).
   */
  getMetadataService?: (instanceId: string) => Promise<import("../metadata/service/metadata-service.js").MetadataService>;
  /**
   * `POST /v3/skill/conversation/add` + `POST /v3/skill/extract`
   * Shared provider of the wired result. Returns a whole set of { handler, trigger, buffer, ... }:
   *   - handleConversationAdd uses .handler
   *   - handleExtract uses .trigger
   *
   * In service mode each tenant holds its own copy; standalone mode returns a singleton. Cached + resolved by auth.serviceId
   * in the wiring layer (server.ts).
   */
  resolveConversationAdd?: (instanceId: string) => Promise<
    import("../core/skill/conversation-add/wire.js").WiredConversationAddHandler | undefined
  >;
}

// ═════════════════════════════════════════════════════════════════════
//  Error mapping
// ═════════════════════════════════════════════════════════════════════

const ERROR_CODE_MAP: Record<string, number> = {
  INVALID_FRONTMATTER: 40001,
  INVALID_PATH: 40001,
  SKILL_NOT_OWNER: 40301,
  SKILL_TEAM_MISMATCH: 40302,
  SKILL_NOT_FOUND: 40401,
  SKILL_VERSION_STALE: 40901,
  RESOURCE_TOO_LARGE: 41301,
  SKILL_NAME_DUPLICATE: 42201,
  SKILL_PATCH_NOT_UNIQUE: 42202,
  SKILL_FRONTMATTER_INVALID: 42203,
  STORAGE_NOT_FOUND: 50301,
  LLM_UNAVAILABLE: 50302,
  SKILL_STORAGE_REQUIRED: 50303,
  SKILL_ID_COLLISION: 50304,
  SKILL_VERSION_EXPIRED: 41002,
  SKILL_EXPORT_TOO_LARGE: 41301,
};

function mapCoreError(e: unknown, requestId: string, deps?: SkillRouterDeps, meta?: Record<string, unknown>): ApiResponseEnvelope {
  if (e instanceof SkillCoreError) {
    const code = ERROR_CODE_MAP[e.code] ?? 50001;

    // Log a warn on version conflict, to help gather conflict-frequency statistics later
    if (e.code === "SKILL_VERSION_STALE" && deps) {
      deps.logger.warn(
        `${TAG} version_conflict requestId=${requestId} skill_id=${meta?.skill_id ?? "?"} ` +
        `expected_version=${meta?.expected_version ?? "?"} detail="${e.message}"`,
      );
    }

    // Also include current_version in the 409 version-conflict response, so callers can retry
    if (e.code === "SKILL_VERSION_STALE") {
      const match = e.message?.match(/head is (\d+)/);
      const currentVersion = match ? Number(match[1]) : undefined;
      return errorEnvelope(code, e.message, requestId, { current_version: currentVersion });
    }

    // Also include latest_version in the 410 version-expired response, so callers can upgrade
    if (e.code === "SKILL_VERSION_EXPIRED") {
      const match = e.message?.match(/latest version v(\d+)/);
      const latestVersion = match ? Number(match[1]) : undefined;
      return errorEnvelope(code, e.message, requestId, { latest_version: latestVersion });
    }

    return errorEnvelope(code, e.message, requestId);
  }
  return errorEnvelope(50001, (e as Error).message ?? "internal error", requestId);
}

function formatZodErr(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

// ═════════════════════════════════════════════════════════════════════
//  Shared preconditions
// ═════════════════════════════════════════════════════════════════════

/**
 * Unified precondition validation: first try to get the per-instance SkillCore (a remote database + file storage)
 * via resolveSkillCore(auth.serviceId), falling back to getSkillCore() (standalone).
 *
 * Fix (2026-07-04): in service mode the read handlers used to only use getSkillCore() (standalone
 * SQLite), so after writing to the per-instance store, reads queried an empty SQLite. Now the read/write paths are aligned on the same
 * store resolution logic.
 */
async function precheck<T>(
  schema: { safeParse(b: unknown): { success: true; data: T } | { success: false; error: ZodError } },
  body: unknown,
  auth: V2AuthContext,
  deps: SkillRouterDeps,
  requestId: string,
): Promise<{ ok: true; core: SkillCore; data: T } | { ok: false; envelope: ApiResponseEnvelope }> {
  let core: SkillCore | undefined;
  if (deps.resolveSkillCore) {
    core = await deps.resolveSkillCore(auth.serviceId);
  }
  if (!core) {
    core = deps.getSkillCore();
  }
  if (!core) return { ok: false, envelope: errorEnvelope(404, "Skill module not enabled", requestId) };
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, envelope: errorEnvelope(40001, formatZodErr(parsed.error), requestId) };
  return { ok: true, core, data: parsed.data };
}

/**
 * Precheck for the write path: exactly the same logic as precheck, just with a name that expresses the "write semantics" more clearly.
 * Kept to maintain consistency of existing handler naming; the two could be merged, but backward compatibility is preserved for now.
 */
async function precheckWrite<T>(
  schema: { safeParse(b: unknown): { success: true; data: T } | { success: false; error: ZodError } },
  body: unknown,
  auth: V2AuthContext,
  deps: SkillRouterDeps,
  requestId: string,
): Promise<{ ok: true; core: SkillCore; data: T } | { ok: false; envelope: ApiResponseEnvelope }> {
  let core: SkillCore | undefined;
  if (deps.resolveSkillCore) {
    core = await deps.resolveSkillCore(auth.serviceId);
  }
  if (!core) {
    core = deps.getSkillCore();
  }
  if (!core) return { ok: false, envelope: errorEnvelope(404, "Skill module not enabled", requestId) };
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, envelope: errorEnvelope(40001, formatZodErr(parsed.error), requestId) };
  return { ok: true, core, data: parsed.data };
}

// Shape a Skill row into SkillSummary form (without content; manifest is added when used as detail)
// Fields aligned with design doc section 3.4 SkillSummary.
/** Deserialize skill.metadata_json into a metadata object; returns undefined for invalid JSON. */
function parseMetadata(s: Skill): Record<string, unknown> | undefined {
  const raw = s.metadata_json;
  if (!raw || raw === "{}" || raw === "") return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function toSummary(s: Skill) {
  const metadata = parseMetadata(s);
  return {
    skill_id: s.skill_id,
    name: s.name,
    description: s.description,
    version: s.version,
    is_head: s.is_head,
    status: s.status,
    owner_user_id: s.user_id,
    owner_agent_id: s.owner_agent_id,
    team_id: s.team_id,
    task_id: s.task_id,
    created_at_ms: s.created_at_ms,
    updated_at_ms: s.updated_at_ms,
    ...(metadata ? { metadata } : {}),
  };
}

// ═════════════════════════════════════════════════════════════════════
//  Handlers
// ═════════════════════════════════════════════════════════════════════

export async function handleCreate(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(createRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleCreate.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  // Quota check (like memory's checkMemoryQuota)
  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handleCreate.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.create(pre.data);
    try { trace.report("skill.create", { skill_id: r.skill_id, team_id: r.team_id, agent_id: r.owner_agent_id, name: r.name }); } catch { /* noop */ }

    // -- Auto-register the skill asset (asset_id === skill_id) + bind it to the owner agent's fixed-asset --
    //
    // Why it is done here:
    //   - In standalone mode the SkillCore is built globally by WamfCore (no onSkillCreated hook);
    //   - Without registering here, metadata-layer APIs such as asset/list-accessible / acl/* cannot find this skill,
    //     and the frontend control page's "team assets / authorization" flow is completely broken.
    //
    // Relationship with service mode:
    //   - In service mode the gateway attaches a hook of the same name when building the per-instance SkillCore with buildSkillCore,
    //     and both paths call `metaSvc.ensureSkillAsset({ skill_id, team_id, agent_id, name })`,
    //     which is already idempotent in metadata-service.ts (LRU + primary-key dedup), so repeated calls have no side effects.
    //
    // Failure policy:
    //   - Throw -> the create request as a whole returns an error. Avoids the silent inconsistent state where
    //     "the skill is persisted but the asset is missing" (users would wonder "I created it successfully but can't see it").
    //   - Consistent with how ensureChatMemoryAsset is done in handleConversationAdd of v2-router.ts.
    if (deps.getMetadataService && r.team_id && r.owner_agent_id) {
      try {
        const metaSvc = await deps.getMetadataService(auth.serviceId);
        await metaSvc.ensureSkillAsset({
          skill_id: r.skill_id,
          team_id: r.team_id,
          agent_id: r.owner_agent_id,
          name: r.name,
        });
      } catch (err) {
        deps.logger.error(
          `${TAG} ensureSkillAsset failed for ${r.skill_id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        obsLogger.error("skill.handleCreate.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: r.skill_id, phase: "ensureSkillAsset" }, err instanceof Error ? err : undefined);
        return mapCoreError(err, requestId, deps, { skill_id: r.skill_id });
      }
    }

    obsLogger.info("skill.handleCreate.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, name: r.name, version: r.version });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) { obsLogger.error("skill.handleCreate.done", { req_id: requestId, dur_ms: Date.now() - t0 }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleUpdate(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(updateRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleUpdate.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handleUpdate.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.update(pre.data);
    try { trace.report("skill.update", { skill_id: r.skill_id, team_id: r.team_id, agent_id: r.owner_agent_id, name: r.name, version: r.version }); } catch { /* noop */ }
    obsLogger.info("skill.handleUpdate.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, name: r.name, version: r.version });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    obsLogger.error("skill.handleUpdate.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handlePatch(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(patchRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handlePatch.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handlePatch.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.patch(pre.data);
    try { trace.report("skill.patch", { skill_id: r.skill_id, team_id: r.team_id, agent_id: r.owner_agent_id, name: r.name, version: r.version }); } catch { /* noop */ }
    obsLogger.info("skill.handlePatch.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, name: r.name, version: r.version });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    obsLogger.error("skill.handlePatch.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handleDelete(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(deleteRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleDelete.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const r = await pre.core.delete(pre.data);

    // -- Fallback for physical asset deletion: DELETE meta_assets + cascade-clear agent bindings / ACL --
    //
    // Why do it again here:
    //   - service mode: the onSkillArchived hook in buildSkillCore has already been called once; calling again
    //     here is idempotent convergence (deleteAssets treats an already non-existent asset as success, no side effects).
    //   - standalone mode: the SkillCore is built globally by WamfCore without hooks injected (to avoid coupling to
    //     the MetadataService startup order). This call in the handler layer is the only linkage entry.
    //
    // Failure policy: fire-and-forget; warn without rolling back delete. A second delete re-triggers the core hook
    // and this fallback, eventually converging. See the symmetric approach of ensureSkillAsset in handleCreate
    // (only the failure policy is opposite: create fails strictly, delete is lenient to guarantee the skill side always succeeds).
    let assetSynced = false;
    if (r.archived && deps.getMetadataService && pre.data.team_id) {
      try {
        const metaSvc = await deps.getMetadataService(_auth.serviceId);
        await metaSvc.deleteAssets([r.skill_id]);
        assetSynced = true;
      } catch (err) {
        deps.logger.warn(
          `${TAG} [skill-asset-sync] deleteAssets(archive) failed for ${r.skill_id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    try {
      trace.report("skill.delete", {
        skill_id: r.skill_id,
        team_id: pre.data.team_id,
        agent_id: pre.data.agent_id,
        asset_synced: assetSynced,
      });
    } catch { /* noop */ }
    obsLogger.info("skill.handleDelete.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, archived: r.archived, asset_synced: assetSynced });
    return successEnvelope(r, requestId);
  } catch (e) {
    obsLogger.error("skill.handleDelete.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

/**
 * `POST /v3/skill/get-by-name` -- (team_id, agent_id, skill_name) -> skill details.
 *
 * See the motivation comment of `getByNameRequestSchema` in skill-schemas.ts. Implementation path:
 *   1) the schema already enforces team_id + agent_id + skill_name as required
 *   2) go through `SkillCore.list` to get the candidates (1-2) of (team, agent, name_prefix=name)
 *   3) exact-match one by name and hand it to `SkillCore.get(skill_id)` to reuse the include_content /
 *      include_manifest / version branches, guaranteeing the same output body as /v3/skill/get
 *
 * Not found -> 40401 SKILL_NOT_FOUND (aligned with get; from the agent's view it cannot tell "this name does not exist
 * or this id does not exist", so a single error code is used).
 */
export async function handleGetByName(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(getByNameRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleGetByName.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    // Use name as the prefix to fetch 1-2 candidates (prefix LIKE hits neighbors with the same prefix,
    // so exact-match explicitly again; limit=1 is not used so the exact hit is stable).
    const listed = await pre.core.list({
      team_id: pre.data.team_id,
      agent_id: pre.data.agent_id,
      filters: { name_prefix: pre.data.skill_name },
      pagination: { limit: 10 },
    });
    const hit = listed.items.find((s) => s.name === pre.data.skill_name);
    if (!hit) {
      obsLogger.info("skill.handleGetByName.done", {
        req_id: requestId, code: 40401, dur_ms: Date.now() - t0,
        team_id: pre.data.team_id, agent_id: pre.data.agent_id, skill_name: pre.data.skill_name,
        reason: "not_found",
      });
      // Same path as handleGet SKILL_NOT_FOUND: errorEnvelope(40401, ...)
      return errorEnvelope(40401, `SKILL_NOT_FOUND: no skill named "${pre.data.skill_name}" for agent ${pre.data.agent_id}`, requestId);
    }

    // Reuse the body of handleGet: build the get input and go through core.get, guaranteeing fully identical behavior
    // (including the version branch and include_content / include_manifest semantics).
    const row = await pre.core.get({
      user_id: pre.data.user_id,
      team_id: pre.data.team_id,
      agent_id: pre.data.agent_id,
      task_id: pre.data.task_id,
      skill_id: hit.skill_id,
      version: pre.data.version,
      include_content: pre.data.include_content,
      include_manifest: pre.data.include_manifest,
    });
    const includeContent = pre.data.include_content ?? true;
    const includeManifest = pre.data.include_manifest ?? true;
    const data = {
      ...toSummary(row),
      ...(row.content_hash ? { content_hash: row.content_hash } : {}),
      ...(row.storage_dir ? { storage_dir: row.storage_dir } : {}),
      ...(includeContent ? { content: row.content } : {}),
      ...(includeManifest ? { manifest: row.manifest } : {}),
    };
    obsLogger.info("skill.handleGetByName.done", {
      req_id: requestId, code: 0, dur_ms: Date.now() - t0,
      skill_id: row.skill_id, version: row.version,
      content_len: row.content?.length ?? 0,
      manifest_n: row.manifest?.length ?? 0,
    });
    return successEnvelope(data, requestId);
  } catch (e) {
    obsLogger.error("skill.handleGetByName.done", {
      req_id: requestId, dur_ms: Date.now() - t0,
      skill_name: pre.data.skill_name,
    }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId);
  }
}

export async function handleGet(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(getRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleGet.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const row = await pre.core.get(pre.data);
    const includeContent = pre.data.include_content ?? true;
    const includeManifest = pre.data.include_manifest ?? true;
    // Detail view additionally attaches content_hash / storage_dir (summary does not output these).
    // See the SkillDetail fields in docs/design/2026-06-17-skill-redesign-v2.md section 3.4.
    const data = {
      ...toSummary(row),
      ...(row.content_hash ? { content_hash: row.content_hash } : {}),
      ...(row.storage_dir ? { storage_dir: row.storage_dir } : {}),
      ...(includeContent ? { content: row.content } : {}),
      ...(includeManifest ? { manifest: row.manifest } : {}),
    };
    obsLogger.info("skill.handleGet.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: row.skill_id,
      version: row.version,
      content_len: row.content?.length ?? 0,
      manifest_n: row.manifest?.length ?? 0, });
    return successEnvelope(data, requestId);
  } catch (e) { obsLogger.error("skill.handleGet.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleList(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(listRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleList.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    // Archive semantics note: `filters.status` allows explicitly passing `['archived']` / `['active','archived']`,
    // only for the admin console's "recycle bin" view. When status is not passed, only active is returned by default (see the
    // defaults in SqliteSkillStore.listSkills / MongoSkillStore.listSkills).
    // Ordinary business callers **should not** explicitly request archived -- it is already invisible to read/write APIs.
    const r = await pre.core.list(pre.data);
    obsLogger.info("skill.handleList.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, items: r.items.length, total: r.total });
    return successEnvelope({ items: r.items.map(toSummary), total: r.total }, requestId);
  } catch (e) { obsLogger.error("skill.handleList.done", { req_id: requestId, dur_ms: Date.now() - t0 }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleSearch(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(searchRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleSearch.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    // scope="team" → strip agent_id so store does team-wide search (no owner filter).
    // The v3 isolation middleware already verified team_id + agent_id + user_id are present.
    const { scope, ...data } = pre.data;
    const searchInput = scope === "team"
      ? { ...data, agent_id: undefined }
      : data;
    const hits = await pre.core.search(searchInput);
    const items = hits.map((h) => ({
      ...toSummary(h.skill),
      score: h.score,
      // The FTS5 snippet may be empty (content too short); fall back to description.
      snippet: h.snippet && h.snippet.length > 0 ? h.snippet : h.skill.description,
    }));
    obsLogger.info("skill.handleSearch.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, items: items.length, scope: pre.data.scope ?? "agent" });
    return successEnvelope({ items }, requestId);
  } catch (e) { obsLogger.error("skill.handleSearch.done", { req_id: requestId, dur_ms: Date.now() - t0 }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleVersions(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(versionsRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleVersions.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const r = await pre.core.listVersions(pre.data);
    if (r.total === 0) {
      obsLogger.warn("skill.handleVersions.done", { req_id: requestId, code: 40401, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, reason: "not_found" });
      return errorEnvelope(40401, "skill not found", requestId);
    }
    const items = r.items.map((s) => ({
      ...toSummary(s),
      is_expired: (s as Skill & { is_expired: boolean }).is_expired ?? false,
    }));
    obsLogger.info("skill.handleVersions.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, items: items.length, total: r.total });
    return successEnvelope({ items, total: r.total }, requestId);
  } catch (e) { obsLogger.error("skill.handleVersions.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleFilesWrite(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(filesWriteRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleFilesWrite.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handleFilesWrite.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.writeFiles(pre.data);
    obsLogger.info("skill.handleFilesWrite.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, version: r.version, files: pre.data.files.length });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    obsLogger.error("skill.handleFilesWrite.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handleFilesRemove(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheckWrite(filesRemoveRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleFilesRemove.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      obsLogger.warn("skill.handleFilesRemove.done", { req_id: requestId, code: 4291, dur_ms: Date.now() - t0, reason: "quota", current: check.current, limit: check.limit });
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.removeFiles(pre.data);
    obsLogger.info("skill.handleFilesRemove.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: r.skill_id, version: r.version, paths: pre.data.paths.length });
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    obsLogger.error("skill.handleFilesRemove.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id, expected_version: pre.data.expected_version }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handleFilesRead(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(filesReadRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleFilesRead.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const r = await pre.core.readFile(pre.data);
    obsLogger.info("skill.handleFilesRead.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id,
      version: r.version,
      size_bytes: r.size_bytes,
      encoding: r.encoding, });
    return successEnvelope(r, requestId);
  } catch (e) { obsLogger.error("skill.handleFilesRead.done", { req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

export async function handleExport(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(exportRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) {
    obsLogger.warn("skill.handleExport.done", {
      req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck",
    });
    return pre.envelope;
  }
  try {
    const r = await pre.core.exportSkill(pre.data);
    obsLogger.info("skill.handleExport.done", {
      req_id: requestId, code: 0, dur_ms: Date.now() - t0,
      skill_id: pre.data.skill_id, version: r.version,
      file_count: r.file_count, total_bytes: r.total_bytes,
    });
    return successEnvelope(r, requestId);
  } catch (e) {
    obsLogger.error("skill.handleExport.done", {
      req_id: requestId, dur_ms: Date.now() - t0, skill_id: pre.data.skill_id,
    }, e instanceof Error ? e : undefined);
    return mapCoreError(e, requestId);
  }
}

export async function handleListing(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();
  const pre = await precheck(listingRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) { obsLogger.warn("skill.handleListing.done", { req_id: requestId, code: pre.envelope.code, dur_ms: Date.now() - t0, reason: "precheck" }); return pre.envelope; }
  try {
    const charBudget = pre.data.char_budget ?? 8000;
    const query = (pre.data.query ?? "").trim();
    const useSearch = query.length > 0;

    // Read routing from config: searchTopK (max entries injected into the listing) + mode (bm25/embedding/hybrid).
    const routing = deps.getResolvedSkillConfig?.()?.routing;
    const topK = routing?.searchTopK ?? 20;

    // search mode: choose the retrieval algorithm by routing.mode; fall back to list head (when query is empty).
    type Item = { skill_id: string; name: string; description: string; version: number };
    let items: Item[];
    let mode: "full" | "search";
    if (useSearch) {
      const hits = await pre.core.search({
        user_id: pre.data.user_id,
        team_id: pre.data.team_id,
        agent_id: pre.data.agent_id,
        query,
        top_k: topK,
        mode: routing?.mode,
      });
      items = hits.map((h) => ({
        skill_id: h.skill.skill_id,
        name: h.skill.name,
        description: h.skill.description,
        version: h.skill.version,
      }));
      mode = "search";
    } else {
      const r = await pre.core.list({
        user_id: pre.data.user_id,
        team_id: pre.data.team_id,
        agent_id: pre.data.agent_id,
        pagination: { limit: topK },
      });
      items = r.items.map((s) => ({
        skill_id: s.skill_id,
        name: s.name,
        description: s.description,
        version: s.version,
      }));
      mode = items.length < topK ? "full" : "search";
    }

    // Render the listing; truncate by char_budget (keep the head + an explicit truncation marker).
    // Default id mode: each line is the structured `- id=<skill_id>, name=<name>, desc=<description>`,
    //   with a format-description line added at the top of the block so the agent clearly knows which field is skill_id and to use it when calling skill_view.
    // With SKILL_VIEW_MODE=name, fall back to the old format `- name: description` (id not exposed).
    // See the skill_eval v9 (name) vs v10 (id) comparison experiment.
    const exposeSkillId = (process.env.SKILL_VIEW_MODE ?? "id").toLowerCase() !== "name";
    // Newlines in description would break the "one skill per line" structure, so fold them into spaces.
    const flat = (s: string) => (s ?? "").replace(/\s*\n\s*/g, " ").trim();
    const lines = items.map((s) =>
      exposeSkillId
        ? `- id=${s.skill_id}, name=${s.name}, desc=${flat(s.description)}`
        : `- ${s.name}: ${s.description}`,
    );
    const formatHint = exposeSkillId
      ? "# One skill per line, fields separated by commas: id=<skill_id>, name=<name>, desc=<description>.\n" +
        "# When calling skill_view, pass the value of the id field (like skl-xxxxxx).\n"
      : "";
    let listing = lines.length === 0
      ? "<available_skills>\n(none)\n</available_skills>"
      : `<available_skills>\n${formatHint}${lines.join("\n")}\n</available_skills>`;

    if (listing.length > charBudget) {
      const truncated = listing.slice(0, Math.max(0, charBudget - 32));
      listing = `${truncated}\n... [truncated]\n</available_skills>`;
    }

    obsLogger.info("skill.handleListing.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, mode,
      hits: items.length,
      listing_len: listing.length,
      truncated: listing.length >= charBudget, });
    return successEnvelope({
      mode,
      listing,
      hits: items.map((s) => ({ skill_id: s.skill_id, version: s.version, name: s.name })),
    }, requestId);
  } catch (e) { obsLogger.error("skill.handleListing.done", { req_id: requestId, dur_ms: Date.now() - t0 }, e instanceof Error ? e : undefined); return mapCoreError(e, requestId); }
}

/**
 * `POST /v3/skill/extract` -- direct-trigger archive of one conversation slice.
 *
 * Before the rework it was "enqueue a Redis job + poll /result"; after the rework it goes through exactly the same
 * downstream as conversation/add (`SkillTriggerService.archive()` -> agent queue -> reuse
 * `SkillConversationExtractWorker`), only without writing data-current/meta; one call
 * produces one independent archive + one SkillTaskEntry.
 *
 * See `docs/design/2026-07-17-skill-extract-direct-trigger-plan.md` for details.
 */
export async function handleExtract(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  // [obs] The handler logs in segments via obsLogger: one info event per segment, with structured fields
  // (req_id / dur_ms / ...), all correlatable by req_id; obsLogger has an internal try/catch,
  // so even if the logger backend is down the business is unaffected.
  const t0 = Date.now();

  const t0Parse = Date.now();
  const parsed = extractRequestSchema.safeParse(body);
  obsLogger.info("skill.handleExtract.schema_parse", {
    req_id: requestId, dur_ms: Date.now() - t0Parse, ok: parsed.success,
  });
  if (!parsed.success) {
    obsLogger.warn("skill.handleExtract.done", { req_id: requestId, code: 40001, dur_ms: Date.now() - t0, reason: "schema" });
    return errorEnvelope(40001, formatZodErr(parsed.error), requestId);
  }
  const input = parsed.data;

  if (!deps.resolveConversationAdd) {
    obsLogger.warn("skill.handleExtract.done", { req_id: requestId, code: 50301, dur_ms: Date.now() - t0, reason: "not_wired" });
    return errorEnvelope(50301, "skill extract not wired (resolveConversationAdd missing)", requestId);
  }
  const t0Wire = Date.now();
  const wired = await deps.resolveConversationAdd(auth.serviceId);
  obsLogger.info("skill.handleExtract.resolve_wired", {
    req_id: requestId, dur_ms: Date.now() - t0Wire, service_id: auth.serviceId, hit: !!wired,
  });
  if (!wired) {
    obsLogger.warn("skill.handleExtract.done", { req_id: requestId, code: 50301, dur_ms: Date.now() - t0, reason: "not_wired_for_instance" });
    return errorEnvelope(50301, "skill extract not wired for this instance", requestId);
  }

  // direct-trigger always generates a one-off session id (prefix sx-) -- because it has no cross-turn buffer,
  // session_id only determines the archive path segment, so each call being independent is fine; it is accepted if the caller passes one.
  const sessionId = input.session_id ?? `sx-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

  // Compression + fallback policy (redesigned 2026-08-10):
  //   (1) total < chunkMax -> archive in full, no compression or truncation
  //   (2) total >= chunkMax -> compress tool messages (tool_call/tool_result over threshold get head/tail truncated)
  //   (3) still >= chunkMax after compression -> oversize fallback truncation (keep head + tail, cut the middle)
  // Parameters come from resolvedSkillConfig; DEFAULT_* are only fallbacks (standalone unconfigured scenario).
  const skillCfg = deps.getResolvedSkillConfig?.();
  const compressOpts = skillCfg
    ? {
        toolContentThresholdBytes: skillCfg.compress.toolContentThresholdBytes,
        headBytes: skillCfg.compress.headBytes,
        tailBytes: skillCfg.compress.tailBytes,
      }
    : DEFAULT_COMPRESS_OPTIONS;
  const oversizeOpts = skillCfg
    ? {
        chunkMaxBytes: skillCfg.extraction.chunkMaxBytes,
        headKeepBytes: skillCfg.extraction.headKeepBytes,
        tailKeepBytes: skillCfg.extraction.tailKeepBytes,
      }
    : DEFAULT_OVERSIZE_OPTIONS;
  const chunkMax = oversizeOpts.chunkMaxBytes ?? DEFAULT_OVERSIZE_OPTIONS.chunkMaxBytes;

  const t0Prep = Date.now();
  const incoming: CompressibleMessage[] = input.messages.map((m) => ({
    role: m.role,
    content: m.content,
    tool_name: m.tool_name,
    tool_call_id: m.tool_call_id,
  }));

  // Compute the raw bytes first; only go through compression + fallback when it exceeds chunkMax
  const rawBytes = incoming.reduce(
    (sum, m) => sum + Buffer.byteLength(JSON.stringify(m), "utf8"), 0,
  );
  const needCompress = rawBytes >= chunkMax;

  const prepared = prepareArchivePayload(
    /* existing */ [],
    incoming,
    {
      compress: compressOpts,
      oversize: oversizeOpts,
      forceCompress: needCompress,
    },
  );
  obsLogger.info("skill.handleExtract.prepare_archive", {
    req_id: requestId, dur_ms: Date.now() - t0Prep,
    msg_in: input.messages.length, msg_out: prepared.messages.length,
    raw_bytes: rawBytes, need_compress: needCompress,
    used_compress: prepared.usedCompress, used_oversize: prepared.usedOversize,
  });

  // space_id is taken from body first (backward compatible with early callers), defaulting back to auth.serviceId --
  // the two values should be equal by design (both are "the currently logged-in instance"). If not equal, log a warning to help find early
  // bugs where the caller passes the wrong instance; isolation/auth/routing all rely on auth.serviceId, unrelated to body.
  const spaceId = input.space_id ?? auth.serviceId;
  if (input.space_id && input.space_id !== auth.serviceId) {
    deps.logger.warn(
      `${TAG} /v3/skill/extract space_id mismatch: body=${input.space_id} auth=${auth.serviceId}; using body`,
    );
  }

  try {
    const t0Archive = Date.now();
    const res = await wired.trigger.archive({
      session: {
        // 2026-07-30 instance_id is put into the tuple; after the worker pool takes it from the queue it routes by this
        // to the corresponding instance's resources (file storage / database / LLM key).
        instance_id: auth.serviceId,
        space_id: spaceId,
        user_id: input.user_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        session_id: sessionId,
      },
      bufferAtTrigger: { messages: prepared.messages as Array<Record<string, unknown>> },
      taskRefId: input.task_id,
      reason: input.reason,
      maxIterations: input.options?.max_iterations,
      // Pass requestId through to the trigger's internal segmented obsLogger events as an anchor
      perfRequestId: requestId,
    });
    obsLogger.info("skill.handleExtract.trigger_archive", {
      req_id: requestId, dur_ms: Date.now() - t0Archive,
      task_id: res.taskId, archive_key: res.archiveKey,
    });

    try {
      metricProducer.send({ metric: "skill.extract.request", instanceId: input.team_id, value: 1 });
    } catch { /* noop */ }

    // trace.report backend span: aligned with create/update/patch/delete; task_id is the anchor,
    // and in clickhouse / langfuse task_id can pull up the worker-side skill.worker.task_done.
    try {
      trace.report("skill.extract", {
        task_id: res.taskId,
        task_ref_id: input.task_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        session_id: sessionId,
        msg_count: prepared.messages.length,
        success: true,
      });
    } catch { /* noop */ }

    obsLogger.info("skill.handleExtract.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, task_id: res.taskId, msg_count: prepared.messages.length, });
    return successEnvelope({
      ok: true,
      task_id: res.taskId,
      archived_at_ms: res.archivedAtMs,
      archive_key: res.archiveKey,
    }, requestId);
  } catch (e) {
    deps.logger.warn(`${TAG} /v3/skill/extract archive failed: ${(e as Error).message} req_id=${requestId}`);
    obsLogger.error("skill.handleExtract.done", { req_id: requestId, dur_ms: Date.now() - t0, reason: "archive_failed" }, e instanceof Error ? e : undefined);
    return errorEnvelope(50001, (e as Error).message ?? "internal error", requestId);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  /v3/skill/conversation/add  --  new flow: per-turn conversation incremental entry
// ═════════════════════════════════════════════════════════════════════

/**
 * `POST /v3/skill/conversation/add`
 *
 * The Client (proxy) calls this synchronously once after each conversation turn ends. The Handler internally completes
 * concatenation + threshold decision + archive segment (register first, then write archive). Returns { status, archived? }.
 *
 * See section 11.1 of `docs/design/2026-07-15-skill-trigger-in-core-design.md`.
 */
export async function handleConversationAdd(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: SkillRouterDeps,
): Promise<ApiResponseEnvelope> {
  // [obs] The proxy fires this at the end of every turn, the highest-frequency skill API. Segment events:
  //   skill.handleConversationAdd.schema_parse / resolve_wired / handler_handle / done
  // handler.handle internally also splits into read_buffer / prepare_archive / trigger.archive /
  // write_back (logged by SkillConversationAddHandler through obsLogger, correlated with trigger
  // by the same req_id).
  const t0 = Date.now();

  if (!deps.resolveConversationAdd) {
    obsLogger.warn("skill.handleConversationAdd.done", { req_id: requestId, code: 404, dur_ms: Date.now() - t0, reason: "not_wired" });
    return errorEnvelope(404, "Skill conversation-add module not enabled", requestId);
  }
  const t0Parse = Date.now();
  const parsed = conversationAddRequestSchema.safeParse(body);
  obsLogger.info("skill.handleConversationAdd.schema_parse", {
    req_id: requestId, dur_ms: Date.now() - t0Parse, ok: parsed.success,
  });
  if (!parsed.success) {
    obsLogger.warn("skill.handleConversationAdd.done", { req_id: requestId, code: 40001, dur_ms: Date.now() - t0, reason: "schema" });
    return errorEnvelope(40001, formatZodErr(parsed.error), requestId);
  }
  const input = parsed.data;

  // In service mode use auth.serviceId to resolve the tenant-level wired; standalone ignores serviceId
  // and the wiring returns a singleton.
  const t0Wire = Date.now();
  const wired = await deps.resolveConversationAdd(auth.serviceId);
  obsLogger.info("skill.handleConversationAdd.resolve_wired", {
    req_id: requestId, dur_ms: Date.now() - t0Wire, service_id: auth.serviceId, hit: !!wired,
  });
  if (!wired) {
    obsLogger.warn("skill.handleConversationAdd.done", { req_id: requestId, code: 404, dur_ms: Date.now() - t0, reason: "not_wired_for_instance" });
    return errorEnvelope(404, "Skill conversation-add module not enabled for this instance", requestId);
  }

  // space_id is taken from body first, defaulting back to auth.serviceId (same handling as handleExtract).
  // The two values should be equal by design; warn if not.
  const spaceId = input.space_id ?? auth.serviceId;
  if (input.space_id && input.space_id !== auth.serviceId) {
    deps.logger.warn(
      `${TAG} /v3/skill/conversation/add space_id mismatch: body=${input.space_id} auth=${auth.serviceId}; using body`,
    );
  }

  try {
    const t0Handle = Date.now();
    const out = await wired.handler.handle({
      // 2026-07-30 instance_id is put into the tuple; the worker pool routes by it after taking from the queue.
      instance_id: auth.serviceId,
      session_id: input.session_id,
      space_id: spaceId,
      user_id: input.user_id,
      team_id: input.team_id,
      agent_id: input.agent_id,
      task_id: input.task_id,
      // The schema guarantees role is valid; tool_name/tool_call_id are validated inside the handler
      messages: input.messages.map((m) => ({
        role: m.role,
        content: m.content,
        tool_name: m.tool_name,
        tool_call_id: m.tool_call_id,
        timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
      })),
      // Pass requestId through to the handler's internal segmented obsLogger; trigger.archive passes it on one more level
      perfRequestId: requestId,
    });
    obsLogger.info("skill.handleConversationAdd.handler_handle", {
      req_id: requestId, dur_ms: Date.now() - t0Handle,
      status: out.status, reason: out.archived?.reason,
    });

    try {
      trace.report("skill.conversation_add", {
        session_id: input.session_id,
        task_ref_id: input.task_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        status: out.status,
        archived_task_id: out.archived?.task_id,
        reason: out.archived?.reason,
        msg_count: input.messages.length,
        success: true,
      });
    } catch { /* noop */ }

    obsLogger.info("skill.handleConversationAdd.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, status: out.status,
      reason: out.archived?.reason,
      task_id: out.archived?.task_id,
      msg_count: input.messages.length, });
    return successEnvelope(out, requestId);
  } catch (err) {
    // HandlerValidationError -> 400; others -> 500
    const isValidation = err instanceof Error && err.name === "HandlerValidationError";
    if (isValidation) {
      obsLogger.error("skill.handleConversationAdd.done", { req_id: requestId, dur_ms: Date.now() - t0, field: (err as { field?: string }).field }, err instanceof Error ? err : undefined);
      return errorEnvelope(40001, err.message, requestId);
    }
    deps.logger.warn(`${TAG} /v3/skill/conversation/add failed: ${(err as Error).message}`);
    obsLogger.error("skill.handleConversationAdd.done", { req_id: requestId, dur_ms: Date.now() - t0 }, err instanceof Error ? err : undefined);
    return errorEnvelope(50001, (err as Error).message ?? "internal error", requestId);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  POST /v3/skill/conversation/force-archive
//  Manually force-archive the current session buffer (third trigger condition: skip the threshold)
// ═════════════════════════════════════════════════════════════════════

export async function handleForceArchive(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: SkillRouterDeps,
): Promise<ApiResponseEnvelope> {
  const t0 = Date.now();

  if (!deps.resolveConversationAdd) {
    obsLogger.warn("skill.handleForceArchive.done", { req_id: requestId, code: 50301, dur_ms: Date.now() - t0, reason: "not_wired" });
    return errorEnvelope(50301, "skill force-archive not wired (resolveConversationAdd missing)", requestId);
  }

  const parsed = forceArchiveRequestSchema.safeParse(body);
  if (!parsed.success) {
    obsLogger.warn("skill.handleForceArchive.done", { req_id: requestId, code: 40001, dur_ms: Date.now() - t0, reason: "schema" });
    return errorEnvelope(40001, formatZodErr(parsed.error), requestId);
  }
  const input = parsed.data;

  const wired = await deps.resolveConversationAdd(auth.serviceId);
  if (!wired) {
    obsLogger.warn("skill.handleForceArchive.done", { req_id: requestId, code: 50301, dur_ms: Date.now() - t0, reason: "not_wired_for_instance" });
    return errorEnvelope(50301, "skill force-archive not wired for this instance", requestId);
  }

  const sess = {
    // 2026-08-04 fix: a missing instance_id makes trigger.archive -> serializeAgentTuple
    // throw `instance_id must be a non-empty string`, which the handler wraps into envelope
    // 50001 returned to the proxy, making the panel / mem:create-skill "force archive" fail 100% of the time.
    // Consistent with handleExtract / handleConversationAdd, fall back to auth.serviceId.
    instance_id: auth.serviceId,
    space_id: input.space_id,
    user_id: input.user_id,
    team_id: input.team_id,
    agent_id: input.agent_id,
    session_id: input.session_id,
  };

  try {
    // Read the current buffer
    const [current, meta] = await Promise.all([
      wired.buffer.readCurrent(sess),
      wired.buffer.readMeta(sess),
    ]);

    // Buffer is empty: no need to archive
    if (!current.messages || current.messages.length === 0) {
      obsLogger.info("skill.handleForceArchive.done", { req_id: requestId, code: 0, dur_ms: Date.now() - t0, status: "empty" });
      return successEnvelope({ status: "empty", message: "No messages in buffer to archive" }, requestId);
    }

    // Call trigger.archive unconditionally (skip the threshold check)
    const archiveRes = await wired.trigger.archive({
      session: sess,
      bufferAtTrigger: { messages: current.messages },
      taskRefId: input.task_id,
      reason: input.reason,
      perfRequestId: requestId,
    });

    // After archiving, clear the buffer + reset meta (consistent with the behavior after add-handler archiving)
    const nowMs = Date.now();
    await Promise.all([
      wired.buffer.writeCurrent(sess, { messages: [] }),
      wired.buffer.writeMeta(sess, {
        session_id: sess.session_id,
        space_id: sess.space_id,
        user_id: sess.user_id,
        team_id: sess.team_id,
        agent_id: sess.agent_id,
        tool_call_count: 0,
        byte_count: 0,
        last_appended_at_ms: nowMs,
        last_archived_at_ms: archiveRes.archivedAtMs,
      }),
    ]);

    obsLogger.info("skill.handleForceArchive.done", {
      req_id: requestId, code: 0, dur_ms: Date.now() - t0,
      status: "archived", task_id: archiveRes.taskId,
    });
    return successEnvelope({
      status: "archived",
      task_id: archiveRes.taskId,
      archived_at_ms: archiveRes.archivedAtMs,
      archive_key: archiveRes.archiveKey,
    }, requestId);
  } catch (err) {
    deps.logger.warn(`${TAG} /v3/skill/conversation/force-archive failed: ${(err as Error).message} req_id=${requestId}`);
    obsLogger.error("skill.handleForceArchive.done", { req_id: requestId, dur_ms: Date.now() - t0 }, err instanceof Error ? err : undefined);
    return errorEnvelope(50001, (err as Error).message ?? "internal error", requestId);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  Route table
// ═════════════════════════════════════════════════════════════════════

export type SkillHandler = (
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: SkillRouterDeps,
) => Promise<ApiResponseEnvelope>;

export function makeSkillRouteTable(): Record<string, SkillHandler> {
  return {
    "/v3/skill/create": handleCreate,
    "/v3/skill/update": handleUpdate,
    "/v3/skill/patch": handlePatch,
    "/v3/skill/delete": handleDelete,
    "/v3/skill/get": handleGet,
    "/v3/skill/get-by-name": handleGetByName,
    "/v3/skill/list": handleList,
    "/v3/skill/search": handleSearch,
    "/v3/skill/versions": handleVersions,
    "/v3/skill/files/write": handleFilesWrite,
    "/v3/skill/files/remove": handleFilesRemove,
    "/v3/skill/files/read": handleFilesRead,
    "/v3/skill/export": handleExport,
    "/v3/skill/listing": handleListing,
    "/v3/skill/extract": handleExtract,
    "/v3/skill/conversation/add": handleConversationAdd,
    "/v3/skill/conversation/force-archive": handleForceArchive,
  };
}
