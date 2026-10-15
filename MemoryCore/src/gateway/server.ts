/**
 * WAMF Gateway — HTTP server for the Hermes sidecar.
 *
 * Exposes WAMF Core capabilities as HTTP endpoints:
 *   GET  /health              — Health check
 *   POST /recall              — Memory recall (prefetch)
 *   POST /capture             — Conversation capture (sync_turn)
 *   POST /search/memories     — L1 memory search
 *   POST /search/conversations — L0 conversation search
 *   POST /session/end         — Session end + flush
 *   POST /seed               — Batch seed historical conversations (L0 → L1)
 *
 * Built with Node.js native `http` module — no Express/Fastify dependency.
 * Designed to run as a managed sidecar alongside Hermes.
 */

import http from "node:http";
import { join } from "node:path";
import { URL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import zlib from "node:zlib";
import dayjs from "dayjs";
import { WamfCore } from "../core/wamf-core.js";
import { StandaloneHostAdapter } from "../adapters/standalone/host-adapter.js";
import { loadGatewayConfig, parseBrokers, resolveStoreModeOverride } from "./config.js";
import type { GatewayConfig, GatewayConfigOverrides } from "./config.js";
import { dbChoiceToStoreConfigs, LocalBackendResolver } from "../core/backend-selection/index.js";
import type { BackendResolver } from "../core/backend-selection/index.js";
import { applyMetadataEnvFromGatewayConfig } from "./metadata-env.js";
import { initDataDirectories } from "../utils/pipeline-factory.js";
import { SessionFilter } from "../utils/session-filter.js";
import { WorkerPermitPool } from "../services/worker-permit-pool.js";
import { createExtractorAdapter, SkillExtractor as SkillExtractorClass } from "../core/skill/skill-extractor.js";
import type { SkillCore as SkillCoreType } from "../core/skill/skill-core.js";
import { SkillCoreError } from "../core/skill/skill-core.js";
import type { IMemoryStore } from "../core/store/types.js";
import type {
  HealthResponse,
  RecallRequest,
  RecallResponse,
  CaptureRequest,
  CaptureResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  ConversationSearchRequest,
  ConversationSearchResponse,
  SessionEndRequest,
  SessionEndResponse,
  SeedRequest,
  SeedResponse,
  GatewayErrorResponse,
} from "./types.js";
import type { Logger } from "../core/types.js";
import { InstanceConfigProvider } from "../core/instance-config-provider.js";
import type { MongoConfig } from "../core/instance-config-provider.js";
import { wrapWithTrace } from "../core/report/trace-middleware.js";
import { initOTelSDK, shutdownOTelSDK } from "../core/report/otel-sdk-init.js";
import { initObservabilityBackend } from "../core/report/factory.js";
import type { ObservabilityConfig as CoreObservabilityConfig } from "../core/report/types.js";
import { TracedTaskExecutor } from "../core/report/traced-task-executor.js";
import { StorePool } from "../core/store/store-pool.js";
import { validateAndNormalizeRaw, SeedValidationError } from "../core/seed/input.js";
import { executeSeed } from "../core/seed/seed-runtime.js";
import type { SeedProgress } from "../core/seed/types.js";
import { handleV2Route, errorEnvelope, makeRequestId } from "./v2-router.js";
import { isSafeInstanceId } from "../utils/instance-id.js";
import type { V2RouterDeps } from "./v2-router.js";
import { handleV3MetaRoute, V3_PREFIX } from "../metadata/router/v3-meta-router.js";
import { handleInternalMetaRoute, V3_INTERNAL_PREFIX } from "../metadata/router/internal-meta-router.js";
import { MetadataService } from "../metadata/service/metadata-service.js";
import { ConfigParamService } from "../metadata/service/config-param-service.js";
import { loadDefaultRegistry } from "../metadata/config/param-registry.js";
import type { IMetadataStore } from "../metadata/store/interface.js";
import {
  MetadataStorePool,
  validateMetadataStartupConfig,
} from "../metadata/store/factory.js";
import {
  maskMemorySystemUserKeyForLog,
  resolveMemorySystemUserConfig,
  validateMemorySystemUserConfig,
} from "../metadata/system-user.js";
import type { MemorySystemUserConfig } from "../metadata/system-user.js";
import { validateLlmProviderConfig, LlmResolveError } from "./llm-resolver.js";
import type { StandaloneLLMConfig } from "../adapters/standalone/llm-runner.js";
import { resolveStandaloneLlmForRuntime } from "../adapters/standalone/llm-provider-resolver.js";
import { resolveReportedCredit } from "./quota-credit-policy.js";
import {
  initApiTraceConfig,
  wrapApiServiceForTrace,
  wrapApiStoreForTrace,
} from "../api-trace/index.js";
import { readApiTraceEnabled } from "../utils/env-config.js";
import { readMongoEnvConfig } from "../utils/env-config.js";
import { makeSkillRouteTable } from "./skill-handlers.js";
import { handleV3AnalyticsRoute, createAnalyticsChClientAsync } from "./analytics/index.js";
import type { AnalyticsChClient } from "./analytics/index.js";
import type { SkillRouterDeps as SkillRouterDeps } from "./skill-handlers.js";
import {
  wireConversationAddHandler,
  RedisSkillAgentTaskQueue,
  LocalSkillAgentTaskQueue,
  SkillWorkerPool,
  parseAgentTuple as parseSkillAgentTuple,
  type ISkillAgentTaskQueue,
  type WiredConversationAddHandler,
  type WireConversationAddDeps,
  type SkillAgentTaskQueueRedisLike,
  type SkillCandidatesSink,
} from "../core/skill/conversation-add/index.js";
import type { ISkillExtractor } from "../core/skill/queue/types.js";
import type { SkillBufferStorage } from "../core/skill/conversation-add/index.js";
import { makeKnowledgeRouteTable } from "./knowledge-handlers.js";
import { makeChatMemoryRouteTable, clearChatMemoryContentResilient } from "./chat-memory-handlers.js";
import { makeMemoryPromptRouteTable } from "./memory-prompt-handlers.js";
import { makeMemoryGenerationLogRouteTable } from "./memory-generation-log-handlers.js";
import { handleOffloadV2Route } from "../offload_server/router.js";
import type { OffloadV2Deps } from "../offload_server/router.js";
import { resolveV3StrictIsolation } from "../utils/env-config.js";
import { initServerOpikTracer } from "../offload_server/opik-tracer.js";
import { classifyError } from "./error-handler.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import { ProfileRowStorageBackend } from "../core/storage/profile-row-backend.js";
import { CompositeStorageBackend } from "../core/storage/composite-backend.js";
import { MongoFSBackend } from "../core/storage/mongo-fs-backend.js";
import { getSharedMongoClientPool } from "../core/store/mongodb/client-pool.js";
import type { FsOthersKind } from "../core/backend-selection/index.js";
import { requireProfileRowStore } from "../core/store/profile-row-store.js";
import type { TaskPayload } from "../core/state/types.js";
import type { TaskExecutor } from "../services/pipeline-worker.js";
import type { IStateBackend } from "../core/state/types.js";
import type { TimerScanner } from "../services/timer-scanner.js";
import type { PipelineWorker } from "../services/pipeline-worker.js";
import type { StatefulPipelineManager } from "../utils/stateful-pipeline-manager.js";
import type { PipelineLogger } from "../utils/pipeline-factory.js";
import { parsePipelineTimerMember } from "../core/state/timer-member.js";

const TAG = "[wamf-gateway]";
const VERSION = "0.1.0";

// ============================
// Console logger (for standalone gateway — no OpenClaw logger available)
// ============================

/**
 * Format current time as ISO 8601 in the system's local timezone.
 *
 * Example: "2026-05-21T06:47:03.512Z"
 *
 * dayjs's `Z` token emits the local UTC offset (not a literal 'Z'), so the
 * wall-clock matches what the operator sees in `tmux` / `tail -f` while the
 * line stays ISO 8601 compliant and round-trippable.
 */
function nowLocalIso(): string {
  return dayjs().format("YYYY-MM-DDTHH:mm:ss.SSSZ");
}

function createConsoleLogger(): Logger {
  return {
    debug: (msg: string) => console.debug(`${nowLocalIso()} DEBUG ${TAG} ${msg}`),
    info: (msg: string) => console.info(`${nowLocalIso()} INFO  ${TAG} ${msg}`),
    warn: (msg: string) => console.warn(`${nowLocalIso()} WARN  ${TAG} ${msg}`),
    error: (msg: string) => console.error(`${nowLocalIso()} ERROR ${TAG} ${msg}`),
  };
}

// ============================
// Request body parser
// ============================

/**
 * Default request body size limit: 1 MiB (1,048,576 bytes).
 *
 * Override via env `MEMORY_MAX_BODY_BYTES` (must be a positive integer).
 * Capture / seed routes typically need more than 1 MB; if that becomes a
 * recurring issue, raise the env or split per-route limits.
 *
 * Implementation note: env-variable access is delegated to
 * `utils/env-config.ts` to keep this file free of environment-reader
 * tokens, which avoids a known OpenClaw security-scanner false positive
 * triggered by the combination of env reads and the documented route
 * comments above.
 */
import { resolveMaxBodyBytes } from "../utils/env-config.js";

const MAX_BODY_BYTES = resolveMaxBodyBytes();

/**
 * Thrown by `parseJsonBody` when the incoming body exceeds `MAX_BODY_BYTES`.
 * Caught at the top-level request handler (and v2 router) and translated
 * to HTTP 413 instead of being conflated with HTTP 500.
 */
export class PayloadTooLargeError extends Error {
  readonly statusCode = 413;
  readonly limitBytes: number;
  constructor(limitBytes: number) {
    super(`Request body exceeds ${limitBytes} bytes limit`);
    this.name = "PayloadTooLargeError";
    this.limitBytes = limitBytes;
  }
}

export async function parseJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    // Reject early when Content-Length header already exceeds the limit:
    // saves transferring up to MAX_BODY_BYTES of attacker-controlled data.
    const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(new PayloadTooLargeError(MAX_BODY_BYTES));
      // Drain & destroy so the client doesn't keep streaming.
      req.resume();
      req.destroy();
      return;
    }

    // Determine if the body is compressed (Content-Encoding header).
    // Support gzip and deflate; reject unsupported encodings with 400.
    const encoding = (req.headers["content-encoding"] ?? "").toLowerCase().trim();
    let source: NodeJS.ReadableStream = req;
    if (encoding === "gzip" || encoding === "x-gzip") {
      source = req.pipe(zlib.createGunzip());
    } else if (encoding === "deflate") {
      source = req.pipe(zlib.createInflate());
    } else if (encoding !== "" && encoding !== "identity") {
      req.resume(); // drain
      reject(new Error(`Unsupported Content-Encoding: ${encoding}`));
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;

    source.on("data", (chunk: Buffer) => {
      if (aborted) return;
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        aborted = true;
        reject(new PayloadTooLargeError(MAX_BODY_BYTES));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    source.on("end", () => {
      if (aborted) return;
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(body) as T);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    source.on("error", (_err) => {
      if (aborted) return;  // already rejected with PayloadTooLargeError
      // Decompression errors (e.g. truncated gzip) are client-side faults
      reject(new Error("Invalid JSON body"));
    });
  });
}

/** Memory-config sections /seed callers may tune; none of them carries an endpoint or key. */
const SEED_OVERRIDABLE_KEYS: ReadonlySet<string> = new Set([
  "capture", "extraction", "persona", "pipeline", "recall", "promptMode",
]);

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message } satisfies GatewayErrorResponse);
}

/**
 * Constant-time string equality for secrets.
 *
 * Returns `false` on any length mismatch (without comparing bytes), and uses
 * `crypto.timingSafeEqual` for the equal-length case so that an attacker
 * probing the API key cannot use response timing to learn a prefix match.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ============================
// Gateway Server
// ============================

export class WamfGateway {
  private config: GatewayConfig;
  private logger: Logger;
  private core: WamfCore;
  private server: http.Server | null = null;
  private startTime = Date.now();
  /** Guards against concurrent / repeated stop() invocations (e.g. multiple SIGINT). */
  private stopPromise: Promise<void> | null = null;

  // ── Integrated services (Scanner + Worker) ──
  private stateBackend: IStateBackend | null = null;
  private timerScanner: TimerScanner | null = null;
  /** Daily raw-history (L0) retention, when WAMF_L0_RETENTION_DAYS is set. */
  private l0RetentionTimers: NodeJS.Timeout[] = [];
  private pipelineWorker: PipelineWorker | null = null;
  /**
   * Concurrency semaphore shared across modules -- used by the memory PipelineWorker; the skill side goes through
   * the SkillConversationExtractWorker wired by conversation-add (agent-level serial lock,
   * which does not rely on the semaphore for a concurrency limit).
   */
  private workerPermitPool: WorkerPermitPool | null = null;

  // ── Instance config & Store pool (multi-instance) ──
  private configProvider: InstanceConfigProvider | null = null;
  // P9 selection layer: when non-null the assembly layer resolves via the resolver; null = old global-switch branch (rollback).
  private backendResolver: BackendResolver | null = null;
  private storePool: StorePool | null = null;
  private quotaManager: import("../core/quota/quota-manager.js").QuotaManager | null = null;
  private statefulPipelineManager: StatefulPipelineManager | null = null;

  // ── Per-instance file StorageAdapter cache (local / mongofs legs) ──
  private fileStorageCache: Map<string, StorageAdapter> | null = null;

  // ── Metadata (v3): shared store pool + per-instance MetadataService ──
  private metadataStorePool: MetadataStorePool | null = null;
  private analyticsChClientInstance: AnalyticsChClient | null | undefined = undefined; // undefined = not yet initialized
  private analyticsChInitPromise: Promise<void> | null = null;
  private memorySystemUserConfig: MemorySystemUserConfig | undefined;
  private readonly metadataServiceByInstance = new Map<string, MetadataService>();

  // ── Skill conversation-add (§21): per-instance handler cache ──
  //
  // After the 2026-07-30 pooling refactor, each instance only caches handler + trigger + sink + buffer
  // (no worker); all instances share the same SkillWorkerPool and skillSharedQueue.
  // The handler-side storage still goes through the per-instance storage resolver
  // (resolveStorageForInstance) so each instance lands in its own file space.
  //
  // Use an in-flight Promise cache so concurrent requests for the same instance wire the handler only once
  // (the worker pool is a global singleton, so concurrency is no longer a wiring problem).
  private readonly conversationAddByInstance = new Map<string, Promise<WiredConversationAddHandler>>();

  /** 2026-07-30: process-wide shared skill agent queue (List + Set). Lazily initialized after startup. */
  private skillSharedQueue: ISkillAgentTaskQueue | null = null;
  /** 2026-07-30: the single process-wide skill extraction worker pool. */
  private skillWorkerPool: SkillWorkerPool | null = null;

  constructor(configOverrides?: GatewayConfigOverrides) {
    this.config = loadGatewayConfig(configOverrides);
    this.logger = createConsoleLogger();

    // Create host adapter
    const adapter = new StandaloneHostAdapter({
      dataDir: this.config.data.baseDir,
      llmConfig: this.config.llm,
      logger: this.logger,
      platform: "gateway",
    });

    // Create core
    //
    // -- Skill asset linkage hooks (standalone/OpenClaw aligned with service mode) --
    // In service mode gateway/server.ts:resolveSkillCore builds a separate per-instance SkillCore for each instanceId
    // and attaches hooks of the same name; the SkillCore in wamf-core is used on the
    // standalone / OpenClaw embedded / bypass-resolveSkillCore paths. The two do not interfere
    // (each SkillCore only calls the hooks attached to itself), and ensureSkillAsset / deleteAssets
    // are idempotent, so there are no side effects even if both fire. See the SkillAssetHooks doc for details.
    //
    // In standalone mode instanceId is fixed to "default" (see
    // `this.config.instanceId ?? "default"` in start()), so the closure can just use default here;
    // in service mode this SkillCore is in fact never reached by v3/skill/*, and the closure's default
    // is only a placeholder (no effect if it never fires).
    const gatewayRef = this;
    const skillAssetInstanceId = this.config.instanceId
      ?? (this.config.deployMode === "service" ? "__unset__" : "default");
    // Shared permit pool -- used by the memory PipelineWorker. The skill side goes through the
    // SkillConversationExtractWorker inside wireConversationAdd (agent-level serial lock),
    // and no longer uses the semaphore for a concurrency limit.
    this.workerPermitPool = new WorkerPermitPool(this.config.worker.concurrency);

    this.core = new WamfCore({
      hostAdapter: adapter,
      config: this.config.memory,
      sessionFilter: new SessionFilter(this.config.memory.capture.excludeAgents),
      skillAssetHooks: {
        // v1 pioneered the upfront await: throwing = create fails (avoids the silent inconsistency of
        // "skill is persisted but asset is missing"). In standalone mode, besides the fallback in the handler layer's
        // handleCreate, this is the only registration entry -- it fires whoever calls SkillCore.create.
        onSkillCreated: async ({ skill_id, team_id, agent_id, name }) => {
          if (!team_id || !agent_id) return; // no tenant context -> skip (OpenClaw local scope, etc.)
          const metaSvc = await gatewayRef.ensureMetadataService(skillAssetInstanceId);
          await metaSvc.ensureSkillAsset({ skill_id, team_id, agent_id, name });
        },
        // Self-heal on read: fire-and-forget, exceptions swallowed. Fixes orphan skills left by history / migration / accidental deletion.
        onSkillAccessed: (skill) => {
          if (!skill.team_id || !skill.owner_agent_id) return;
          gatewayRef
            .ensureMetadataService(skillAssetInstanceId)
            .then((svc) => svc.ensureSkillAsset({
              skill_id: skill.skill_id,
              team_id: skill.team_id!,
              agent_id: skill.owner_agent_id!,
              name: skill.name,
            }))
            .catch((err: unknown) => {
              gatewayRef.logger.warn(
                `[skill-asset-sync] ensureSkillAsset(access) failed for ${skill.skill_id}: `
                  + (err instanceof Error ? err.message : String(err)),
              );
            });
        },
        // Archive cascade: fire-and-forget, exceptions swallowed. A second delete re-triggers the hook and eventually converges.
        onSkillArchived: ({ skill_id, team_id }) => {
          gatewayRef
            .ensureMetadataService(skillAssetInstanceId)
            .then((svc) => svc.deleteAssets([skill_id]))
            .catch((err: unknown) => {
              gatewayRef.logger.warn(
                `[skill-asset-sync] deleteAssets(archive) failed for ${skill_id}`
                  + ` (team=${team_id ?? "-"}): `
                  + (err instanceof Error ? err.message : String(err)),
              );
            });
        },
      },
    });
  }

  /**
   * Lazily init metadata store pool on first /v3/meta request.
   */
  private async ensureMetadataStorePool(): Promise<MetadataStorePool> {
    if (!this.metadataStorePool) {
      const fallbackSqliteBaseDir = join(this.config.data.baseDir, "metadata");
      const config = validateMetadataStartupConfig(
        this.config.deployMode,
        process.env,
        fallbackSqliteBaseDir,
      );
      this.metadataStorePool = new MetadataStorePool(config);
      this.logger.info(`[META-V3] metadata store pool ready (backend=${config.backend})`);
    }
    return this.metadataStorePool;
  }

  private async ensureMetadataStore(instanceId: string): Promise<IMetadataStore> {
    const pool = await this.ensureMetadataStorePool();
    return pool.getStore(instanceId);
  }

  /**
   * Lazily init the analytics CH read client (singleton, all instances share one proxy CH).
   * Returns null when analytics CH is not configured — router returns 503 / config:false.
   * First call triggers async init; returns a Promise-wrapped getter for the dispatch to await.
   */
  private async ensureAnalyticsChClient(): Promise<AnalyticsChClient | null> {
    if (this.analyticsChClientInstance !== undefined) return this.analyticsChClientInstance;

    const chConfig = this.config.analytics?.clickhouse;
    if (!chConfig?.enabled || !chConfig.endpoint) {
      this.analyticsChClientInstance = null;
      return null;
    }

    if (!this.analyticsChInitPromise) {
      this.analyticsChInitPromise = createAnalyticsChClientAsync(chConfig, this.logger)
        .then((client) => {
          this.analyticsChClientInstance = client;
          if (client) this.logger.info?.("[analytics-ch] read client ready");
        })
        .catch((err) => {
          this.analyticsChClientInstance = null;
          this.logger.warn?.("[analytics-ch] init failed:", (err as Error).message);
        });
    }

    await this.analyticsChInitPromise;
    return this.analyticsChClientInstance ?? null;
  }

  private async ensureMetadataService(instanceId: string): Promise<MetadataService> {
    let svc = this.metadataServiceByInstance.get(instanceId);
    if (!svc) {
      const [store, pool] = await Promise.all([
        this.ensureMetadataStore(instanceId),
        this.ensureMetadataStorePool(),
      ]);
      const storeSource = pool.backend === "mongodb" ? "mongodb-adapter.ts" : "sqlite-adapter.ts";
      const rawSvc = new MetadataService(
        wrapApiStoreForTrace(store, storeSource),
        instanceId,
        this.logger,
        this.config.metadata,
        this.memorySystemUserConfig,
      );

      const registry = loadDefaultRegistry(this.config.metadata.configParamsFile);
      const configSvc = new ConfigParamService(store, registry);
      await configSvc.initDefaults(registry, this.config.metadata);
      rawSvc.setConfigParamService(configSvc);

      // When archiving an Agent, also clear its chat_memory content (L0-L3 + vectors + files).
      // The metadata layer cannot get IMemoryStore / StorageAdapter, so the cleanup capability is
      // injected here; it shares the same cleanup implementation + retry policy as /v3/chat-memory/clear,
      // avoiding orphan data where "the asset is deleted but the content remains".
      //
      // Must resolve store/storage by instanceId: in service mode each instance has its own
      // database + file space, and using the global singleton would clear the wrong one.
      rawSvc.setChatMemoryContentCleaner(async ({ teamId, agentId }) => {
        const { store: memoryStore, storage } = await this.resolveMemoryContentTargets(instanceId);
        await clearChatMemoryContentResilient({
          store: memoryStore, storage, teamId, agentId, logger: this.logger,
        });
      });

      svc = wrapApiServiceForTrace(rawSvc);
      this.metadataServiceByInstance.set(instanceId, svc);
    }
    return svc;
  }

  /**
   * Start the Gateway HTTP server.
   */
  async start(): Promise<void> {
    // Initialize data directories
    initDataDirectories(this.config.data.baseDir);

    applyMetadataEnvFromGatewayConfig(this.config.metadata);

    this.memorySystemUserConfig = resolveMemorySystemUserConfig(this.config.metadata);
    validateMemorySystemUserConfig(this.config.deployMode, this.memorySystemUserConfig);
    if (this.memorySystemUserConfig) {
      this.logger.info(
        `[META-V3] memory system user loaded user_id=${this.memorySystemUserConfig.userId} ` +
        `key_prefix=${maskMemorySystemUserKeyForLog(this.memorySystemUserConfig.userKey)}`,
      );
    }

    // Fail-fast when llm.provider=proxy: confirm the memory system user is complete and the userKey format is valid.
    // instanceId varies per request and is re-validated at runtime by resolveEffectiveLlmConfig; here we
    // only catch errors determinable at startup such as systemUser / baseUrl, to avoid blowing up at the first extraction.
    try {
      validateLlmProviderConfig(this.config.llm, this.config.metadata);
      if (this.config.llm.provider === "proxy") {
        this.logger.info(
          `[LLM] provider=proxy, baseUrl=${this.config.llm.baseUrl}, ` +
          `useMemorySystemUserKey=${this.config.llm.proxy?.useMemorySystemUserKey ?? true}`,
        );
      }
    } catch (err) {
      if (err instanceof LlmResolveError) {
        throw new Error(`[LLM] provider config validation failed: ${err.message}`);
      }
      throw err;
    }

    const metadataStoreCfg = validateMetadataStartupConfig(
      this.config.deployMode,
      process.env,
      join(this.config.data.baseDir, "metadata"),
    );
    if (this.config.deployMode === "service") {
      this.logger.info(
        `[META-V3] metadata store configured (backend=${metadataStoreCfg.backend})`,
      );
    }

    const metadataPool = await this.ensureMetadataStorePool();
    initApiTraceConfig(metadataPool.backend, { enabled: readApiTraceEnabled() });

    // -- Initialize the observability facade layer's global backend --
    // Must be called before initOTelSDK, because LangfuseFilteringProcessor's constructor
    // gets its processor via getObservabilityBackend().llmTrace.createSpanProcessor().
    // If not initialized first, all facade-layer APIs (trace.report / metricProducer.send / obsLogger)
    // go to NoopBackend, and Metric, Langfuse and business Trace are all lost.
    const obsCfg = this.config.observability;
    try {
      const clickhouseConfig = Object.fromEntries([
        ["enabled", obsCfg.clickhouse.enabled],
        ["endpoint", obsCfg.clickhouse.endpoint],
        ["username", obsCfg.clickhouse.username],
        ["password", obsCfg.clickhouse.password],
        ["database", obsCfg.clickhouse.database],
      ]) as CoreObservabilityConfig["clickhouse"];
      const langfuseConfig = Object.fromEntries([
        ["enabled", obsCfg.langfuse.enabled],
        ["host", obsCfg.langfuse.host],
        ["publicKey", obsCfg.langfuse.publicKey],
        ["secretKey", obsCfg.langfuse.secretKey],
      ]) as CoreObservabilityConfig["langfuse"];
      const coreObsCfg: CoreObservabilityConfig = {
        type: "internal",
        otel: {
          enabled: obsCfg.otel.enabled,
          endpoint: obsCfg.otel.endpoint,
          protocol: obsCfg.otel.protocol,
          serviceName: obsCfg.otel.serviceName,
          tenantId: obsCfg.otel.tenantId,
        },
        clickhouse: clickhouseConfig,
        kafka: {
          brokers: parseBrokers(obsCfg.kafka.brokers),
          topic: obsCfg.kafka.topic,
          enabled: obsCfg.kafka.enabled,
        },
        langfuse: langfuseConfig,
      };
      await initObservabilityBackend(coreObsCfg);
      this.logger.info("Observability backend initialized (type=internal)");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Observability backend init failed (non-fatal): ${msg}`);
    }

    // -- Initialize the OTel SDK (Trace + Log + ClickHouse dual-write + Langfuse) --
    // Must be initialized before the HTTP server is created, otherwise the Tracer in wrapWithTrace is a NoopTracer
    // Note: even if otel.enabled=false, the SDK must still be initialized when langfuse.enabled=true
    // (Langfuse reports LLM spans via the OTel SDK's spanProcessor)
    const needOTelSDK = obsCfg.otel.enabled || obsCfg.langfuse.enabled;
    if (needOTelSDK) {
      try {
        const otelOk = await initOTelSDK({
          serviceName: obsCfg.otel.serviceName,
          serviceVersion: obsCfg.otel.serviceVersion,
          // Pass endpoint only when otel is enabled, to avoid creating an invalid gRPC exporter in langfuse-only mode
          endpoint: obsCfg.otel.enabled ? obsCfg.otel.endpoint : undefined,
          protocol: obsCfg.otel.protocol,
          tenantId: obsCfg.otel.tenantId,
          logExportIntervalMs: obsCfg.otel.logExportInterval * 1000,
          clickhouse: obsCfg.clickhouse.enabled
            ? Object.fromEntries([
                ["endpoint", obsCfg.clickhouse.endpoint],
                ["username", obsCfg.clickhouse.username],
                ["password", obsCfg.clickhouse.password],
                ["database", obsCfg.clickhouse.database],
              ])
            : false,
          langfuse: obsCfg.langfuse.enabled
            ? Object.fromEntries([
                ["host", obsCfg.langfuse.host],
                ["publicKey", obsCfg.langfuse.publicKey],
                ["secretKey", obsCfg.langfuse.secretKey],
              ])
            : false,
        });
        this.logger.info(`OTel SDK initialized: ${otelOk ? "enabled" : "skipped (deps not available)"}`);
      } catch (err) {
        // Observability init failure does not affect the main business
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`OTel SDK init failed (non-fatal): ${msg}`);
      }
    }

    // Initialize core
    await this.core.initialize();

    // ── Initialize Opik tracer for offload server ──
    await initServerOpikTracer(this.logger);

    // ── Start integrated services (Scanner + Worker + State Backend) ──
    await this.startIntegratedServices();

    // ── Initialize StorageAdapter for v2 API ──
    // local → LocalStorageBackend pointing to dataDir; rowfs → composite backend.
    if (!this.core.getStorage()) {
      if (this.config.data.fileStore === "rowfs") {
        // rowfs: the core storage is the composite backend (row view + others leg),
        // sharing the same assembly point with the v2 data plane, so pipeline/plugin paths also hit rows.
        const rowfsAdapter = await this.resolveStorageForInstance(this.config.instanceId ?? "default");
        this.core.setStorage(rowfsAdapter);
        this.logger.info(`${TAG} StorageAdapter initialized (rowfs, db=${this.storePool?.mode})`);
      } else {
        const backend = new LocalStorageBackend(this.config.data.baseDir);
        this.core.setStorage(new StorageAdapter(backend));
        this.logger.info(`${TAG} StorageAdapter initialized (local: ${this.config.data.baseDir})`);
      }
    }

    this.startL0Retention();

    // ── Skill module post-wiring (after storage is set) ──
    // setStorage() above kicks off ensureSkillModuleWired() asynchronously
    // (B1 fix in wamf-core: concurrent triggers coalesce onto one promise);
    // we await it here so the FIRST /v3/skill/* request after `start()`
    // resolves doesn't race against an unfinished construction. Noop when
    // cfg.skill is absent or disabled.
    try {
      await this.core.ensureSkillModuleWired();
    } catch (err) {
      this.logger.warn(`${TAG} ensureSkillModuleWired failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Create HTTP server (with Trace middleware wrapping)
    //
    // [skill-perf 2026-07-21] Skill API observability instrumentation (issue: /v3/skill/extract
    // ttfb is erratic, and there is no phase-by-phase timing log):
    //   - log tcp.connect at socket level (debug)
    //   - log skill.perf.req.enter right after the request headers are read, as the server-side T0
    //   - log skill.perf.req.finish on res.on('finish') (the moment the server flushes)
    // Only for the /v3/skill/ prefix, to avoid polluting meta / memory main-path logs.
    this.server = http.createServer((req, res) => {
      const perfT0 = Date.now();
      const isSkill = typeof req.url === "string" && req.url.startsWith("/v3/skill/");
      if (isSkill) {
        // Attach to req so the handler can read T0 to compute phase timings
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (req as any).__skillPerfT0 = perfT0;
        const src = `${req.socket.remoteAddress ?? "?"}:${req.socket.remotePort ?? "?"}`;
        this.logger.info(
          `[skill-perf] req.enter t=${perfT0} method=${req.method ?? "?"} url=${req.url} src=${src}`,
        );
        res.on("finish", () => {
          const now = Date.now();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rid = (res as any).__skillReqId ?? "-";
          this.logger.info(
            `[skill-perf] req.finish t=${now} total=${now - perfT0}ms status=${res.statusCode} req_id=${rid} url=${req.url}`,
          );
        });
        res.on("close", () => {
          if (!res.writableEnded) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rid = (res as any).__skillReqId ?? "-";
            this.logger.warn(
              `[skill-perf] req.close-before-end t=${Date.now()} elapsed=${Date.now() - perfT0}ms req_id=${rid} url=${req.url}`,
            );
          }
        });
      }
      wrapWithTrace(req, res, () => this.handleRequest(req, res)).catch((err) => {
        // wrapWithTrace already records the error internally; here only a fallback
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal Server Error" }));
        }
      });
    });

    // TCP-level: log a debug line for each new socket, to see whether keepalive hits (the same src ip:port
    // triggering this log many times in a short period = the reverse proxy/gateway is not reusing connections)
    this.server.on("connection", (socket) => {
      this.logger.debug?.(
        `[skill-perf] tcp.connect t=${Date.now()} src=${socket.remoteAddress ?? "?"}:${socket.remotePort ?? "?"}`,
      );
    });

    const { port, host } = this.config.server;

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => {
        this.startTime = Date.now();
        this.logger.info(`Gateway listening on http://${host}:${port}`);
        this.logSecurityPosture();
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  /**
   * Emit a one-shot security posture summary at startup.
   *
   * Goals:
   *   1. Make the "auth disabled" state highly visible to anyone reading logs
   *      (this is the documented default, but operators must know it before
   *      they expose the port).
   *   2. Loudly warn when the gateway is bound to anything other than the
   *      loopback interface without an API key — that exact combination is
   *      what the security audit flagged as a real exposure.
   *   3. Never log the key itself.
   */
  private logSecurityPosture(): void {
    const { host, apiKey, corsOrigins } = this.config.server;
    const authOn = !!apiKey;
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";

    this.logger.info(
      `Security posture: auth=${authOn ? "ENABLED (Bearer)" : "disabled"} ` +
      `host=${host} cors=${corsOrigins.length === 0 ? "no-headers" : corsOrigins.includes("*") ? "wildcard(*)" : `allowlist(${corsOrigins.length})`}`
    );

    if (!authOn) {
      this.logger.warn(
        "WAMF_GATEWAY_API_KEY is NOT set — all routes except GET /health are " +
        "open to anyone who can reach this port. This is the legacy default. " +
        "Set WAMF_GATEWAY_API_KEY (or server.apiKey in wamf-gateway.yaml) and " +
        "pass `Authorization: Bearer <key>` from clients before exposing the " +
        "gateway beyond the loopback interface."
      );
    }
    if (!loopback && !authOn) {
      this.logger.warn(
        `Gateway is bound to ${host} (non-loopback) WITHOUT an API key. ` +
        "Every /capture, /search/conversations, /recall, /seed call from the " +
        "network is currently unauthenticated. Bind to 127.0.0.1, or set " +
        "WAMF_GATEWAY_API_KEY, before continuing."
      );
    }
    if (corsOrigins.includes("*")) {
      this.logger.warn(
        "CORS allow-list contains '*' — every browser origin can call this " +
        "gateway. Restrict server.corsOrigins to a concrete allow-list for any " +
        "non-local deployment."
      );
    }
  }

  /**
   * Gracefully stop the Gateway.
   */
  /**
   * Raw history (L0) retention: once a day, delete L0 messages older than
   * WAMF_L0_RETENTION_DAYS (off when unset or 0; at least 3). Only L0 is touched: the facts,
   * scenes and profile extracted from it (L1-L3) are kept. Extraction runs within minutes of
   * a conversation going quiet, so anything this old has long been processed. Standalone
   * (local store) only. The store refuses to delete more than 80% of L0 in one pass, as a
   * guard against a mistyped setting.
   */
  private startL0Retention(): void {
    const raw = process.env.WAMF_L0_RETENTION_DAYS?.trim();
    const days = raw ? Number(raw) : 0;
    if (!Number.isFinite(days) || days <= 0) return;
    if (days < 3) {
      this.logger.warn(`${TAG} L0 retention off: WAMF_L0_RETENTION_DAYS=${raw} is below the minimum of 3`);
      return;
    }
    if (this.config.deployMode !== "standalone") {
      this.logger.info(`${TAG} L0 retention off: only supported in standalone mode`);
      return;
    }
    const run = async () => {
      const store = this.core.getVectorStore();
      if (!store) return;
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      try {
        const removed = await store.deleteL0Expired(cutoff);
        this.logger.info(`${TAG} L0 retention: removed ${removed} raw message(s) older than ${days} days (before ${cutoff})`);
      } catch (err) {
        this.logger.warn(`${TAG} L0 retention failed (will retry tomorrow): ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    // First pass 10 minutes after start, then daily; neither keeps the process alive.
    const first = setTimeout(() => void run(), 10 * 60 * 1000);
    const daily = setInterval(() => void run(), 24 * 60 * 60 * 1000);
    first.unref?.();
    daily.unref?.();
    this.l0RetentionTimers.push(first, daily);
    this.logger.info(`${TAG} L0 retention on: raw history older than ${days} days is deleted daily`);
  }

  async stop(): Promise<void> {
    // Idempotent: repeated calls (e.g. multiple SIGINT) share the same shutdown.
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.stopPromise = this.doStop();
    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    this.logger.info("Shutting down gateway...");
    for (const t of this.l0RetentionTimers) clearTimeout(t);
    this.l0RetentionTimers = [];

    // Gracefully shut down the OTel SDK (flush remaining Span/Log)
    try {
      await shutdownOTelSDK();
    } catch {
      // Best-effort shutdown, does not affect the main flow
    }

    // Stop integrated services first
    if (this.pipelineWorker) {
      await this.pipelineWorker.stop();
      this.logger.info("Pipeline Worker stopped");
    }
    // After the 2026-07-30 pooling refactor, there is one SkillWorkerPool per process, and stopping the pool directly is enough.
    // conversationAddByInstance only holds handler bundles, no lifecycle resources.
    if (this.skillWorkerPool) {
      await this.skillWorkerPool.stop().catch((e) =>
        this.logger.warn(`[skill-worker-pool] stop failed: ${e}`),
      );
      this.skillWorkerPool = null;
      this.logger.info("Skill Worker Pool stopped");
    }
    this.conversationAddByInstance.clear();
    if (this.timerScanner) {
      await this.timerScanner.stop();
      this.logger.info("Timer Scanner stopped");
    }
    if (this.stateBackend) {
      await this.stateBackend.destroy?.();
      this.logger.info("State Backend closed");
    }
    if (this.storePool) {
      // In the process-shutdown scenario there are no in-flight requests to protect, so skip the grace period (default 30s);
      // otherwise closeAll would block waiting for the full grace before returning, slowing exit.
      this.storePool.setGraceCloseDelay(0);
      await this.storePool.closeAll();
      this.logger.info("Store Pool closed");
    }
    if (this.metadataStorePool) {
      await this.metadataStorePool.closeAll();
      this.metadataStorePool = null;
      this.logger.info("Metadata Store Pool closed");
    }

    if (this.analyticsChClientInstance) {
      await this.analyticsChClientInstance.close().catch(() => {});
      this.analyticsChClientInstance = null;
      this.logger.info?.("Analytics CH client closed");
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }

    await this.core.destroy();
    this.logger.info("Gateway stopped");
  }

  // ============================
  // Request router
  // ============================

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method?.toUpperCase() ?? "GET";
    const pathname = url.pathname;

    // Apply CORS headers based on configured allow-list (empty → no headers).
    this.applyCorsHeaders(req, res);

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Instance ids become path segments; refuse anything that is not a plain id.
    for (const header of ["x-wamf-service-id", "x-instance-id"]) {
      const raw = req.headers[header];
      const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
      if (values.some((v) => v.trim() !== "" && !isSafeInstanceId(v.trim()))) {
        sendJson(res, 400, errorEnvelope(400, `Invalid ${header}`, makeRequestId()));
        return;
      }
    }

    try {
      // ── /v2/instance/destroy — admin endpoint, gated by the v1-style
      //    Bearer apiKey only (no service-id / per-request envelope).
      //    When `server.apiKey` is unset this is open by default, matching
      //    the pre-existing behaviour; operators see the "auth disabled"
      //    WARN at startup.
      if (method === "POST" && pathname === "/v2/instance/destroy") {
        if (!this.checkAuth(req, res)) return;
        return await this.handleInstanceDestroy(req, res);
      }

      // -- /v3/instance/destroy -- v3-compatible version.
      //    The request/response contract is the same as v2; auth is the same as v2 (Bearer apiKey, ops endpoint,
      //    does not use the tenant x-wamf-user-key).
      //    The implementation first reuses v2's generic cleanup (state / store / files / quota), then reserves
      //    v3-specific metadata cleanup (team/user/asset/acl, etc.), to be filled in later by whoever owns v3
      //    metadata. It is not fully reused here, to avoid silently missing the v3-side cleanup.
      if (method === "POST" && pathname === "/v3/instance/destroy") {
        if (!this.checkAuth(req, res)) return;
        return await this.handleInstanceDestroyV3(req, res);
      }

      // -- v3 internal metadata (/v3/internal/meta/*, Bearer only) --
      if (pathname.startsWith(`${V3_INTERNAL_PREFIX}/`)) {
        if (!this.checkAuthForV2(req, res)) return;
        const handledInternal = await handleInternalMetaRoute(
          req, res, pathname, method, parseJsonBody, sendJson,
          {
            getMetadataService: (instanceId) => this.ensureMetadataService(instanceId),
            logger: this.logger,
          },
        );
        if (handledInternal) return;
      }

      // ── v3 metadata routes (/v3/meta/*) ──
      // Layer 1: same Bearer apiKey gate as v2. Layer 3 (x-wamf-user-key) in handleV3MetaRoute.
      if (pathname.startsWith(`${V3_PREFIX}/`)) {
        if (!this.checkAuthForV2(req, res)) return;
        const handledV3 = await handleV3MetaRoute(req, res, pathname, method, parseJsonBody, sendJson, {
          getMetadataService: (instanceId) => this.ensureMetadataService(instanceId),
          logger: this.logger,
        });
        if (handledV3) return;
      }

      // ── v3 analytics routes (/v3/analytics/*) ──
      // Layer 1 (Bearer apiKey): checked here explicitly. The /v3/meta/*
      // guard above ONLY covers `V3_PREFIX = "/v3/meta"`, it does not
      // cover analytics — without this line analytics would bypass the
      // shared-secret gate entirely and rely solely on Layer 2+3, which
      // some routes (`route.noUserKey`) intentionally weaken. The generic
      // /v2/*/v3/* fallback below fires too late because a matched
      // analytics route returns straight from this block.
      // Layer 2+3 (service-id + user-key system_admin) inside handleV3AnalyticsRoute.
      if (pathname.startsWith("/v3/analytics/")) {
        if (!this.checkAuthForV2(req, res)) return;
        const handledAnalytics = await handleV3AnalyticsRoute(
          req, res, pathname, method, parseJsonBody, sendJson,
          {
            getAnalyticsChClient: async (_instanceId) => this.ensureAnalyticsChClient(),
            getMetadataService: (instanceId) => this.ensureMetadataService(instanceId),
            logger: this.logger,
          },
        );
        if (handledAnalytics) return;
      }

      // ── v2 / v3 API routes ──
      // /v2 = existing data plane + management plane entry (team/agent optional, user fallback).
      // /v3 = "strict isolation version" of the L0-L3 data plane (team/agent/user/session required), sharing the same handler implementations,
      //       with only one extra validation layer at the dispatch layer. See the V3_PREFIX/V3_ALLOWED_SUBPATHS comments in v2-router.ts.
      //
      // Apply the develop-introduced apiKey gate first so v2/v3 inherits the
      // optional shared-secret protection. v2's own `parseV2Auth` (Bearer +
      // x-wamf-service-id) still runs inside `handleV2Route`, preserving
      // its existing semantics. When `server.apiKey` is unset, this gate
      // is a no-op (default-open), matching the develop_server_test
      // baseline.
      if (pathname.startsWith("/v2/") || pathname.startsWith("/v3/")) {
        if (!this.checkAuthForV2(req, res)) return;
      }

      const v2Deps: V2RouterDeps = {
        getStore: () => this.core.getVectorStore(),
        getEmbedding: () => this.core.getEmbeddingService(),
        getStorage: () => this.core.getStorage(),
        deployMode: this.config.deployMode,
        // Inject pipeline introspection deps for /v2/pipeline/status (standalone-only).
        // Both can be undefined in legacy standalone (no stateBackend configured) —
        // the handler returns 503 in that case.
        stateBackend: this.stateBackend ?? undefined,
        pipelineWorker: this.pipelineWorker ?? undefined,
        logger: this.logger,
        // `V3_STRICT_ISOLATION` controls only /v3 L0–L3 memory data-plane
        // strictness. Default OFF for local/integration; production should set it.
        v3StrictIsolation: resolveV3StrictIsolation(),
        // handleConversationAdd uses it to automatically register a chat_memory asset (team+agent granularity)
        // and bind it to the agent. The first write triggers create + bind; subsequent writes for the same (team, agent) take
        // the in-process LRU short-circuit of MetadataService.
        getMetadataService: (instanceId) => this.ensureMetadataService(instanceId),
      };

      // Skill module deps — composed alongside V2RouterDeps so v2-router.ts
      // doesn't have to widen its interface (and break v2-router.test.ts
      // mocks). The skill route table is registered as `extraRouteTable` in
      // handleV2Route below, and our `mergedDeps` object satisfies BOTH
      // interfaces simultaneously (TypeScript-wise the cast widens it to
      // `unknown` so each handler reads its own fields).
      const skillDeps: SkillRouterDeps = {
        getSkillCore: () => this.core.getSkillCore(),
        getSkillExtractor: () => this.core.getSkillExtractor(),
        getResolvedSkillConfig: () => this.core.getResolvedSkillConfig(),
        quotaManager: this.quotaManager ?? undefined,
        logger: this.logger,
        // In Standalone mode the SkillCore is built globally by WamfCore (without the onSkillCreated hook);
        // handleCreate uses this dep to call metaSvc.ensureSkillAsset() after a skill is created successfully,
        // completing asset registration + agent fixed-asset binding. In service mode the onSkillCreated hook in buildSkillCore
        // does the same thing; both paths are covered, and ensureSkillAsset itself is idempotent.
        getMetadataService: (instanceId) => this.ensureMetadataService(instanceId),
      };

      // Inject per-instance resolvers (storePool + configProvider + file storage)
      if (this.storePool && this.configProvider) {
        const storePool = this.storePool;

        v2Deps.resolveStore = async (instanceId: string) => {
          const { mongoConfig } = await this.resolveStoreBackendConfigs(instanceId);
          const pooled = await storePool.getStore(instanceId, mongoConfig);
          return { store: pooled.store, embedding: pooled.embedding };
        };

        v2Deps.resolveStorage = (instanceId: string) => this.resolveStorageForInstance(instanceId);

        // Pipeline notify: trigger async L1 extraction when v2 /conversation/add writes L0
        if (this.statefulPipelineManager) {
          const pipelineManager = this.statefulPipelineManager;
          v2Deps.notifyPipeline = async (
            instanceId: string,
            sessionId: string,
            rounds: number,
            teamId?: string,
            agentId?: string,
          ) => {
            await pipelineManager.notifyConversation(sessionId, [], instanceId, rounds, teamId, agentId);
          };
        }

        // Inject QuotaManager for memory/credit limit checks
        if (this.quotaManager) {
          v2Deps.quotaManager = this.quotaManager;
        }

        // ── Skill: per-instance resolver (MongoSkillStore + per-instance file storage) ──
        // Reuse the Memory side's storage resolver to create a per-instance SkillCore.
        // If the Skill queue + worker are already started in wamf-core, reuse them; otherwise
        // in service mode they can be started separately here.
        if (storePool.mode === "mongodb") {
          // The per-instance resolvers are extracted into private methods (the same implementation is shared by the handler and the skill worker).
          // mongodb: MongoSkillStore + the instance's resolved file storage (local / rowfs).
          skillDeps.resolveSkillCore = (instanceId: string) => this.resolveSkillCoreForInstance(instanceId);
          skillDeps.buildSkillExtractor = (core, instanceId) => this.buildSkillExtractorForInstance(core, instanceId);
        }
        // /v3/skill/conversation/add + /v3/skill/extract{,result} wiring:
        //   - mongodb: go through ensureConversationAddForInstance
        //     (per-instance store from StorePool + resolveStorageForInstance);
        //     extracted skills land in the per-instance backend (mongodb -> MongoSkillStore).
        //   - sqlite (standalone): go through ensureConversationAddForStandalone (singleton SqliteSkillStore + LocalStorage/in-memory queue)
        //
        // Returns the full WiredConversationAdd:
        //   - handleConversationAdd uses .handler
        //   - handleExtract uses .trigger (direct-trigger)
        skillDeps.resolveConversationAdd = async (instanceId: string) => {
          const wired = storePool.mode === "mongodb"
            ? await this.ensureConversationAddForInstance(instanceId)
            : await this.ensureConversationAddForStandalone(instanceId);
          return wired;
        };
      }

      // ── Offload V2 routes (async ingest + mmd query) ──
      const offloadDeps: OffloadV2Deps = {
        resolveStorage: v2Deps.resolveStorage,
        getStorage: v2Deps.getStorage ?? (() => undefined),
        logger: this.logger,
        stateBackend: this.stateBackend,
        config: { ...this.config.offload, l1Model: "", l15Model: "", l2Model: "" },
      };
      const offloadHandled = await handleOffloadV2Route(req, res, pathname, method, parseJsonBody, sendJson, offloadDeps);
      if (offloadHandled) return;

      // Compose deps: V2RouterDeps fields + SkillRouterDeps fields. The
      // route table union of routeTable + makeSkillRouteTable() is what
      // tells the dispatcher which subset of fields each handler reads.
      const mergedDeps = Object.assign({}, v2Deps, skillDeps);

      // Merge management-plane extra route tables.
      const extraRoutes = {
        ...makeSkillRouteTable(),
        ...makeKnowledgeRouteTable(),
        ...makeChatMemoryRouteTable(),
        ...makeMemoryPromptRouteTable(),
        ...makeMemoryGenerationLogRouteTable(),
      } as Record<
        string,
        (body: unknown, auth: import("./v2-schemas.js").V2AuthContext, requestId: string, deps: unknown) => Promise<import("./v2-schemas.js").ApiResponseEnvelope>
      >;

      const handled = await handleV2Route(
        req,
        res,
        pathname,
        method,
        parseJsonBody,
        sendJson,
        mergedDeps as V2RouterDeps,
        extraRoutes,
      );
      if (handled) return;

      // ── v1 API routes ──

      // GET /health is always reachable without auth — operators and
      // orchestrators (k8s liveness, docker health-check) rely on it being
      // an unconditionally cheap probe.
      if (method === "GET" && pathname === "/health") {
        return this.handleHealth(res);
      }

      // All other routes go through the optional auth gate. When apiKey is
      // unset the gate is a no-op (preserves legacy open behaviour) — the
      // startup WARN in `logSecurityPosture` covers that case.
      if (!this.checkAuth(req, res)) return;

      switch (`${method} ${pathname}`) {
        case "POST /recall":
          return await this.handleRecall(req, res);
        case "POST /capture":
          return await this.handleCapture(req, res);
        case "POST /search/memories":
          return await this.handleSearchMemories(req, res);
        case "POST /search/conversations":
          return await this.handleSearchConversations(req, res);
        case "POST /session/end":
          return await this.handleSessionEnd(req, res);
        case "POST /seed":
          return await this.handleSeed(req, res);
        default:
          sendError(res, 404, `Not found: ${method} ${pathname}`);
      }
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        // Fast-path: PayloadTooLargeError messages are already safe (constant + numeric limit).
        this.logger.warn(`Request rejected [${method} ${pathname}]: ${err.message}`);
        sendError(res, 413, err.message);
        return;
      }
      // H-13: classify + sanitize before sending to client.
      // Server log keeps full stack via classified.logLine; client only sees
      // a safe code + message + trace_id.
      const classified = classifyError(err);
      this.logger.error(`Request error [${method} ${pathname}] ${classified.logLine}`);
      sendJson(res, classified.status, {
        // Keep legacy `error` field for backward compat with existing v1 clients.
        error: classified.client.message,
        code: classified.client.code,
        message: classified.client.message,
        trace_id: classified.client.trace_id,
        retryable: classified.client.retryable,
      });
    }
  }

  // ============================
  // Auth & CORS gates (opt-in, off by default)
  // ============================

  /**
   * Verify the `Authorization: Bearer <apiKey>` header against the configured
   * shared secret using a constant-time comparison.
   *
   * When `server.apiKey` is unset (`undefined`), this returns `"ok"` without
   * inspecting the request — this is the documented default and matches the
   * pre-existing open behaviour. Operators are reminded of this at startup
   * via `logSecurityPosture`.
   *
   * Returns one of:
   *   - `"ok"`            — auth disabled OR token matches; caller proceeds
   *   - `"missing"`       — Authorization header missing or not a Bearer token
   *   - `"invalid"`       — token present but did not match the configured key
   *
   * Caller is responsible for translating `"missing"` / `"invalid"` into the
   * appropriate 401 response (v1 plain-text via {@link checkAuth} or v2
   * envelope via {@link checkAuthForV2}).
   */
  private verifyAuth(req: http.IncomingMessage): "ok" | "missing" | "invalid" {
    const expected = this.config.server.apiKey;
    if (!expected) return "ok"; // auth disabled — default behaviour

    const header = req.headers["authorization"];
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      return "missing";
    }
    const provided = header.slice("Bearer ".length).trim();
    if (!provided || !safeEqual(provided, expected)) {
      return "invalid";
    }
    return "ok";
  }

  /**
   * v1 / admin auth gate. Writes a plain-text 401 on failure (legacy format
   * preserved so existing curl-based callers keep working). Returns `false`
   * when the request must be short-circuited.
   */
  private checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const result = this.verifyAuth(req);
    if (result === "ok") return true;
    sendError(
      res,
      401,
      result === "missing"
        ? "Unauthorized: missing Bearer token"
        : "Unauthorized: invalid token",
    );
    return false;
  }

  /**
   * v2 auth gate. Same verification as {@link checkAuth} but returns the
   * v2 standardized error envelope on failure so v2 clients see a consistent
   * `{ code, message, request_id }` shape.
   *
   * The existing in-router `parseV2Auth` (which checks for non-empty Bearer
   * + `x-wamf-service-id`) is layered on top; this gate runs first.
   */
  private checkAuthForV2(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const result = this.verifyAuth(req);
    if (result === "ok") return true;
    const requestId = makeRequestId();
    const message =
      result === "missing"
        ? "Unauthorized: missing Bearer token"
        : "Unauthorized: invalid token";
    sendJson(res, 401, errorEnvelope(401, message, requestId));
    return false;
  }

  /**
   * Echo `Access-Control-Allow-Origin` (and friends) only for whitelisted
   * origins. With no list configured we emit no CORS headers at all, which
   * makes the browser refuse the cross-origin request as desired.
   *
   * The single-entry list `["*"]` opts back into permissive CORS (development
   * use only; the startup log flags this loudly).
   */
  private applyCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
    const allow = this.config.server.corsOrigins ?? [];
    if (allow.length === 0) return; // strict default — no headers

    if (allow.includes("*")) {
      // Wildcard — preserves the legacy permissive behaviour for callers that
      // opt in explicitly via config. Note: with wildcard we deliberately do
      // not echo back the request Origin and do not send `Vary: Origin`,
      // mirroring how the gateway behaved before this change.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return;
    }

    const requestOrigin = req.headers["origin"];
    if (typeof requestOrigin !== "string" || !allow.includes(requestOrigin)) {
      // Origin not in allow-list — emit no CORS headers; browser will block.
      // Always set Vary so caches don't poison responses across origins.
      res.setHeader("Vary", "Origin");
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Vary", "Origin");
  }

  // ============================
  // Route handlers
  // ============================

  /**
   * POST /v2/instance/destroy — Purge all data for a destroyed instance.
   * Intended for trusted internal callers only.
   *
   * Request body: { instance_id: string }
   * Response: { code, message, data: { instance_id, cleaned: { ... } } }
   */
  private async handleInstanceDestroy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<{ instance_id?: string }>(req);
    const instanceId = body?.instance_id;

    if (!instanceId || typeof instanceId !== "string") {
      sendJson(res, 400, { code: 400, message: "Missing required field: instance_id" });
      return;
    }
    if (!isSafeInstanceId(instanceId)) {
      sendJson(res, 400, { code: 400, message: "Invalid instance_id" });
      return;
    }

    this.logger.info(`[instance/destroy] Purging instance: ${instanceId}`);
    const cleaned = await this.purgeInstanceCommon(instanceId, "v2");

    sendJson(res, 200, {
      code: 0,
      message: "ok",
      data: { instance_id: instanceId, cleaned },
    });
  }

  /**
   * POST /v3/instance/destroy -- v3-compatible route.
   *
   * The request/response contract is exactly the same as v2; callers can switch with zero changes.
   *
   * On top of the generic cleanup, drops the instance's metadata database (v3.0 per-instance databases: `MetadataStorePool.purgeInstance`).
   */
  private async handleInstanceDestroyV3(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<{ instance_id?: string }>(req);
    const instanceId = body?.instance_id;

    if (!instanceId || typeof instanceId !== "string") {
      sendJson(res, 400, { code: 400, message: "Missing required field: instance_id" });
      return;
    }
    if (!isSafeInstanceId(instanceId)) {
      sendJson(res, 400, { code: 400, message: "Invalid instance_id" });
      return;
    }

    this.logger.info(`[instance/destroy] [v3] Purging instance: ${instanceId}`);
    const cleaned = await this.purgeInstanceCommon(instanceId, "v3");

    cleaned.v3_metadata = await this.purgeV3Metadata(instanceId);

    sendJson(res, 200, {
      code: 0,
      message: "ok",
      data: { instance_id: instanceId, cleaned },
    });
  }

  /**
   * Generic cleanup steps (state / store / files / quota), shared by v2 and v3.
   * @param source only used as the log prefix, to tell callers apart.
   */
  private async purgeInstanceCommon(
    instanceId: string,
    source: "v2" | "v3",
  ): Promise<Record<string, unknown>> {
    const tag = `[instance/destroy] [${source}]`;
    const cleaned: Record<string, unknown> = {};

    // 1. Purge state backend (timers, sessions, buffers, pending tasks)
    if (this.stateBackend?.purgeInstance) {
      try {
        const result = await this.stateBackend.purgeInstance(instanceId);
        cleaned.state = result;
        this.logger.info(`${tag} State purged: sessions=${result.sessions}, timers=${result.timers}, buffers=${result.buffers}`);
      } catch (err) {
        this.logger.error(`${tag} State purge failed: ${err instanceof Error ? err.message : String(err)}`);
        cleaned.state_error = err instanceof Error ? err.message : String(err);
      }
    }

    // 2. Evict store from StorePool (Memory + Skill)
    if (this.storePool) {
      try {
        await this.storePool.evict(instanceId);
        this.storePool.evictSkillStore(instanceId);
        cleaned.store_evicted = true;
        cleaned.skill_store_evicted = true;
      } catch (err) {
        this.logger.error(`${tag} Store evict failed: ${err instanceof Error ? err.message : String(err)}`);
        cleaned.store_evicted = false;
        cleaned.skill_store_evicted = false;
      }
    }

    // 3. Drop the cached per-instance file storage handle
    if (this.fileStorageCache?.has(instanceId)) {
      this.fileStorageCache.delete(instanceId);
    }
    // 4. Purge skill queue residue (2026-07-30)
    //
    // The whole process shares one skill agent LIST + SET, and the key does not contain instanceId. To clear
    // the tuples belonging to this instance, SSCAN + LREM by the `{instanceId}|` prefix
    // matching the 5-segment tuple is needed; also clear the locks related to extract-lock:{instanceId}|* / tasks-mutex:*
    // (SCAN + DEL). Standalone / no-redis scenarios use the in-memory queue, deleting by iterating the
    // Local queue's _snapshot.
    try {
      const skillPurged = await this.purgeSkillQueueForInstance(instanceId);
      cleaned.skill_queue = skillPurged;
    } catch (err) {
      this.logger.error(`${tag} Skill queue purge failed: ${err instanceof Error ? err.message : String(err)}`);
      cleaned.skill_queue_error = err instanceof Error ? err.message : String(err);
    }

    // Clear handler bundle cache for this instance
    if (this.conversationAddByInstance.has(instanceId)) {
      this.conversationAddByInstance.delete(instanceId);
      cleaned.skill_handler_cache_cleared = true;
    }

    // 5. Clear QuotaManager cache
    if (this.quotaManager) {
      (this.quotaManager as any).cache?.delete?.(instanceId);
      cleaned.quota_cache_cleared = true;
    }

    return cleaned;
  }

  /**
   * v3-only: drop the instance's metadata database (MongoDB dropDatabase / SQLite delete directory).
   * On failure, writes into the returned structure without throwing, consistent with purgeInstanceCommon.
   */
  private async purgeV3Metadata(instanceId: string): Promise<Record<string, unknown>> {
    try {
      const pool = await this.ensureMetadataStorePool();
      const result = await pool.purgeInstance(instanceId);
      this.metadataServiceByInstance.delete(instanceId);
      this.logger.info(
        `[instance/destroy] [v3] metadata purged: db=${result.db_name} dropped=${result.dropped}`,
      );
      return { db_name: result.db_name, dropped: result.dropped };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[instance/destroy] [v3] metadata purge failed: ${msg}`);
      return { dropped: false, error: msg };
    }
  }

  private handleHealth(res: http.ServerResponse): void {
    const response: HealthResponse = {
      status: this.core.getVectorStore() ? "ok" : "degraded",
      version: VERSION,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      stores: {
        vectorStore: !!this.core.getVectorStore(),
        embeddingService: !!this.core.getEmbeddingService(),
      },
      // Integrated services status
      services: {
        timerScanner: this.timerScanner?.getMetrics() ?? null,
        pipelineWorker: this.pipelineWorker?.getMetrics() ?? null,
        stateBackend: this.stateBackend ? "connected" : "none",
      },
    };
    sendJson(res, 200, response);
  }

  private async handleRecall(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<RecallRequest>(req);

    if (!body.query || !body.session_key) {
      sendError(res, 400, "Missing required fields: query, session_key");
      return;
    }

    const startMs = Date.now();
    const result = await this.core.handleBeforeRecall(body.query, body.session_key);
    const elapsed = Date.now() - startMs;

    // H-15: distinguish "no recall content to inject" from "recall failed".
    // Both return HTTP 200 (recall is non-critical) but the response body
    // carries a non-zero code + message when the recall path itself failed
    // (e.g. EmbeddingService unavailable, database timeout).
    if (result.error) {
      this.logger.warn(
        `Recall failed in ${elapsed}ms: code=${result.error.code} category=${result.error.category} ` +
        `msg="${result.error.message}"`,
      );
    } else {
      this.logger.info(`Recall completed in ${elapsed}ms: context=${(result.appendSystemContext?.length ?? 0)} chars`);
    }

    const response: RecallResponse = {
      context: result.appendSystemContext ?? "",
      strategy: result.recallStrategy,
      memory_count: result.recalledL1Memories?.length ?? 0,
      code: result.error?.code ?? 0,
      message: result.error?.message ?? "ok",
      retryable: result.error?.retryable ?? false,
    };
    sendJson(res, 200, response);
  }

  private async handleCapture(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<CaptureRequest>(req);

    if (!body.user_content || !body.assistant_content || !body.session_key) {
      sendError(res, 400, "Missing required fields: user_content, assistant_content, session_key");
      return;
    }

    const startMs = Date.now();
    const result = await this.core.handleTurnCommitted({
      userText: body.user_content,
      assistantText: body.assistant_content,
      messages: body.messages ?? [
        { role: "user", content: body.user_content },
        { role: "assistant", content: body.assistant_content },
      ],
      sessionKey: body.session_key,
      sessionId: body.session_id,
    });
    const elapsed = Date.now() - startMs;

    this.logger.info(`Capture completed in ${elapsed}ms: l0=${result.l0RecordedCount}`);

    const response: CaptureResponse = {
      l0_recorded: result.l0RecordedCount,
      scheduler_notified: result.schedulerNotified,
    };
    sendJson(res, 200, response);
  }

  private async handleSearchMemories(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<MemorySearchRequest>(req);

    if (!body.query) {
      sendError(res, 400, "Missing required field: query");
      return;
    }

    const result = await this.core.searchMemories({
      query: body.query,
      limit: body.limit,
      type: body.type,
      scene: body.scene,
    });

    const response: MemorySearchResponse = {
      results: result.text,
      total: result.total,
      strategy: result.strategy,
    };
    sendJson(res, 200, response);
  }

  private async handleSearchConversations(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<ConversationSearchRequest>(req);

    if (!body.query) {
      sendError(res, 400, "Missing required field: query");
      return;
    }

    const result = await this.core.searchConversations({
      query: body.query,
      limit: body.limit,
      sessionKey: body.session_key,
    });

    const response: ConversationSearchResponse = {
      results: result.text,
      total: result.total,
    };
    sendJson(res, 200, response);
  }

  private async handleSessionEnd(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<SessionEndRequest>(req);

    if (!body.session_key) {
      sendError(res, 400, "Missing required field: session_key");
      return;
    }

    await this.core.handleSessionEnd(body.session_key);

    const response: SessionEndResponse = { flushed: true };
    sendJson(res, 200, response);
  }

  private async handleSeed(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await parseJsonBody<SeedRequest>(req);

    if (!body.data) {
      sendError(res, 400, "Missing required field: data");
      return;
    }

    // Only tuning sections: llm / embedding / storage overrides would send the gateway's
    // real API keys (merged into the seed config below) to a caller-chosen endpoint.
    if (body.config_override) {
      const disallowed = Object.keys(body.config_override).filter((k) => !SEED_OVERRIDABLE_KEYS.has(k));
      if (disallowed.length > 0) {
        sendError(res, 400, `config_override may only set: ${[...SEED_OVERRIDABLE_KEYS].join(", ")} (got ${disallowed.join(", ")})`);
        return;
      }
    }

    // Validate and normalize input (reuses seed CLI's validation layers 2-6)
    let input;
    try {
      input = validateAndNormalizeRaw(body.data, {
        sessionKey: body.session_key,
        strictRoundRole: body.strict_round_role,
        autoFillTimestamps: body.auto_fill_timestamps ?? true,
      });
    } catch (err) {
      if (err instanceof SeedValidationError) {
        sendJson(res, 400, {
          error: err.message,
          validation_errors: err.errors,
        });
        return;
      }
      throw err;
    }

    this.logger.info(
      `Seed request: ${input.sessions.length} session(s), ` +
      `${input.totalRounds} round(s), ${input.totalMessages} message(s)`,
    );

    // Resolve output directory: use gateway's data dir with a timestamped subfolder
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const outputDir = `${this.config.data.baseDir}/seed-${ts}`;

    // Merge config overrides if provided
    // Start with the base memory config + inject llm config from gateway settings
    const baseConfig = this.config.memory as unknown as Record<string, unknown>;
    let pluginConfig: Record<string, unknown> = {
      ...baseConfig,
      llm: Object.fromEntries([
        ["enabled", true],
        ["baseUrl", this.config.llm.baseUrl],
        ["apiKey", this.config.llm.apiKey],
        ["model", this.config.llm.model],
        ["maxTokens", this.config.llm.maxTokens],
        ["timeoutMs", this.config.llm.timeoutMs],
      ]),
    };
    if (body.config_override) {
      for (const key of Object.keys(body.config_override)) {
        const baseVal = pluginConfig[key];
        const overVal = body.config_override[key];
        if (baseVal && typeof baseVal === "object" && !Array.isArray(baseVal) &&
            overVal && typeof overVal === "object" && !Array.isArray(overVal)) {
          pluginConfig[key] = { ...(baseVal as Record<string, unknown>), ...(overVal as Record<string, unknown>) };
        } else {
          pluginConfig[key] = overVal;
        }
      }
    }

    // Execute seed pipeline (blocking — this may take minutes for large inputs)
    const summary = await executeSeed(input, {
      outputDir,
      openclawConfig: {},
      pluginConfig,
      logger: this.logger as PipelineLogger,
      onProgress: (progress: SeedProgress) => {
        this.logger.debug?.(
          `Seed progress: [${progress.currentRound}/${progress.totalRounds}] ` +
          `session=${progress.sessionKey} stage=${progress.stage}`,
        );
      },
    });

    this.logger.info(
      `Seed complete: sessions=${summary.sessionsProcessed}, rounds=${summary.roundsProcessed}, ` +
      `l0=${summary.l0RecordedCount}, duration=${(summary.durationMs / 1000).toFixed(1)}s`,
    );

    const response: SeedResponse = {
      sessions_processed: summary.sessionsProcessed,
      rounds_processed: summary.roundsProcessed,
      messages_processed: summary.messagesProcessed,
      l0_recorded: summary.l0RecordedCount,
      duration_ms: summary.durationMs,
      output_dir: summary.outputDir,
    };
    sendJson(res, 200, response);
  }

  // ============================
  // Integrated Services (Scanner + Worker)
  // ============================

  /**
   * Start Timer Scanner and Pipeline Worker inside the Gateway process.
   *
   * Activated automatically:
   *   - standalone → local in-process backend (default)
   *   - service    → remote backend (default)
   *
   * env vars:
   *   STATE_BACKEND=local|remote  — backend type
   *   SCANNER_INSTANCES=inst1,inst2 — instances to scan (default: "default")
   *   SCANNER_INTERVAL_MS=500 — scan interval
   *   WORKER_POLL_MS=200 — worker poll interval
   */
  private async startIntegratedServices(): Promise<void> {
    // Determine backend type from config (env > yaml > auto from deployMode):
    //   - "standalone" → local (in-process Map/setTimeout, zero dependencies)
    //   - "service"    → remote state backend
    const backendType: "redis" | "local" =
      this.config.stateBackend ?? (this.config.deployMode === "service" ? "redis" : "local");

    this.logger.info(`Starting integrated services (deployMode=${this.config.deployMode}, state_backend=${backendType})...`);

    // 1. Create State Backend
    const { createStateBackend } = await import("../core/state/index.js");
    this.stateBackend = await createStateBackend({
      type: backendType,
      local: backendType === "local" ? {
        onTimerExpired: (entry) => {
          // Parse timer member by prefix: "offload-{type}:{instanceId}:{sessionId}[:{extra}]"
          // or legacy "session:L2_schedule"
          const member = entry.member;
          let taskType: string;
          let instanceId: string;
          let sessionId: string;
          let teamId: string | undefined;
          let agentId: string | undefined;

          const firstColon = member.indexOf(":");
          const prefix = firstColon > 0 ? member.slice(0, firstColon) : member;

          if (prefix === "offload-l1" || prefix === "offload-l15" || prefix === "offload-l2") {
            taskType = prefix;
            // Format: "offload-{type}:{instanceId}:{sessionId}[:{mmdFile}]"
            // instanceId is the segment right after the prefix
            const rest = member.slice(firstColon + 1);
            const instanceEnd = rest.indexOf(":");
            if (instanceEnd > 0) {
              instanceId = rest.slice(0, instanceEnd);
              sessionId = rest.slice(instanceEnd + 1);
            } else {
              instanceId = this.config.instanceId ?? "default";
              sessionId = rest;
            }
            // For offload-l2: strip trailing ":{mmdFile}" from sessionId
            // (mmdFile is extracted separately from timerMember in the executor)
            if (prefix === "offload-l2" && sessionId.endsWith(".mmd")) {
              const lastColon = sessionId.lastIndexOf(":");
              if (lastColon > 0) {
                sessionId = sessionId.slice(0, lastColon);
              }
            }
          } else {
            // Pipeline memory timer. The member may be legacy "sessionId:L1_idle"
            // or scoped "scope:team:T|agent:A|session:S:L1_idle"; scope is member
            // data only and does not affect Redis key slotting.
            const parsed = parsePipelineTimerMember(member);
            sessionId = parsed.sessionId;
            taskType = parsed.taskType;
            teamId = parsed.teamId;
            agentId = parsed.agentId;
            instanceId = entry.instanceId ?? this.config.instanceId ?? "default";
          }
          const now = Date.now();
          // Extract targetMmdFile from member for offload-l2 (needed by pipeline-worker lockKey)
          let targetMmdFile: string | undefined;
          if (taskType === "offload-l2") {
            const mmdMatch = member.match(/(\d+-[^:]+\.mmd)$/);
            if (mmdMatch) targetMmdFile = mmdMatch[1];
          }
          const task = {
            id: `${taskType}-${sessionId}-${now}`,
            type: taskType as any,
            instanceId,
            sessionId,
            teamId,
            agentId,
            priority: 0,
            createdAt: now,
            data: { triggeredBy: "timer_scanner", timerMember: member, instanceId, targetMmdFile, teamId, agentId },
          };
          this.stateBackend!.enqueueTask(task).then(() => {
            this.logger.info(`[local-timer] Timer fired: ${member} → enqueued ${taskType} task`);
          }).catch((err) => {
            this.logger.error(`[local-timer] Failed to enqueue task for ${member}: ${err instanceof Error ? err.message : String(err)}`);
          });
        },
      } : undefined,
      redis: backendType === "redis" ? Object.fromEntries([
        ["host", this.config.redis.host],
        ["port", this.config.redis.port],
        ["password", this.config.redis.password],
        ["db", this.config.redis.db],
        ["keyPrefix", this.config.redis.keyPrefix],
      ]) : undefined,
    });
    this.logger.info(`State Backend created (${backendType})`);

    // Skill V2 queue opens its own ioredis connection from the
    // `skillRedisUrl` we passed into WamfCore at construction time — see the
    // constructor above. No cross-module shared client, no startup-order
    // coupling with `setStorage()` / `ensureSkillModuleWired()`.

    // 1.2. Config source + quota reporter. Connection info comes from local
    // env/params only (LocalConfigSource); quota reporting is a no-op.
    const { LocalConfigSource } = await import("../core/instance-config-provider.js");
    const { NoopQuotaReporter } = await import("../core/quota/noop-quota-reporter.js");
    this.configProvider = new InstanceConfigProvider({
      source: new LocalConfigSource(this.logger),
      maxInstances: this.config.instanceCache.maxInstances,
      logger: this.logger,
    });

    // 1.2.1. Create QuotaManager (service mode only — in standalone the Noop
    // reporter would short-circuit everything anyway, so we skip allocation).
    if (this.config.deployMode === "service") {
      const { QuotaManager } = await import("../core/quota/index.js");
      this.quotaManager = new QuotaManager({
        reporter: new NoopQuotaReporter(),
        logger: this.logger,
      });
      this.logger.info("QuotaManager initialized (memoryLimit=10000, creditLimit=1000)");
    }
    // Allow overriding store mode independently from deployMode (STORE_MODE).
    // Default: service → mongodb, standalone → sqlite. A removed backend value
    // (e.g. STORE_MODE=vdb) fails fast here instead of silently falling back.
    const storeModeOverride = resolveStoreModeOverride(process.env.STORE_MODE);
    const effectiveStoreMode = storeModeOverride ?? (this.config.deployMode === "service" ? "mongodb" : "sqlite");
    // T12 fail-fast: mongodb backend hard-requires MONGODB_ENDPOINT/DATABASE
    // (delivered via LocalConfigSource.fetchMongo). Missing them is a config
    // error we surface at boot instead of on the first request.
    if (effectiveStoreMode === "mongodb") {
      const mongoEnv = readMongoEnvConfig();
      const missing = [
        !mongoEnv.endpoint && "MONGODB_ENDPOINT",
        !mongoEnv.database && "MONGODB_DATABASE",
      ].filter(Boolean);
      if (missing.length > 0) {
        throw new Error(
          `[gateway] store mode mongodb requires ${missing.join(", ")} to be set`,
        );
      }
      this.logger.info(`[gateway] Store backend = mongodb (endpoint=${mongoEnv.endpoint}, database=${mongoEnv.database})`);
    }
    this.storePool = new StorePool({
      mode: effectiveStoreMode,
      memoryCfg: this.config.memory,
      dataDir: this.config.data.baseDir,
      maxStores: this.config.instanceCache.maxInstances,
      kafka: {
        brokers: parseBrokers(this.config.observability.kafka.brokers),
        topic: this.config.observability.kafka.topic,
        enabled: this.config.observability.kafka.enabled,
      },
      logger: this.logger,
    });
    this.logger.info(`Instance Config Provider + Store Pool initialized (mode=${this.config.deployMode})`);

    // P9 selection layer integration: the assembly layer (resolveStoreBackendConfigs / resolveStorageForInstance)
    // now goes through the resolver. storeMode is passed as an explicit override (when unset the resolver falls back by form, with the same rules as
    // effectiveStoreMode); fileStore is already a definite value resolved by T3.0.
    // WAMF_BACKEND_RESOLVER=off -> the resolver is not built, and the assembly layer falls back to the old global-switch branch.
    if (this.config.features.backendResolver) {
      this.backendResolver = new LocalBackendResolver({
        deployMode: this.config.deployMode,
        storeMode: storeModeOverride,
        fileStore: this.config.data.fileStore,
        fileStoreOthers: this.config.data.fileStoreOthers,
        source: this.configProvider,
      });
      this.logger.info(
        `${TAG} BackendResolver initialized (local, storeMode=${effectiveStoreMode}, fileStore=${this.config.data.fileStore}, others=${this.config.data.fileStoreOthers})`,
      );
    }

    // 1.5. Inject StatefulPipelineManager into Core (replaces legacy MemoryPipelineManager)
    const { createStatefulPipelineManager } = await import("../utils/pipeline-factory.js");
    // Service mode: defaultInstanceId must NOT be "default"; all calls must provide explicit instanceId.
    // Standalone mode: uses configured instanceId or "default" as fallback.
    const instanceId = this.config.instanceId ?? (this.config.deployMode === "service" ? "__unset__" : "default");
    const statefulManager = createStatefulPipelineManager(
      this.config.memory,
      this.stateBackend,
      instanceId,
      this.logger,
    );
    this.statefulPipelineManager = statefulManager;
    // Attach to core — core.setStatefulPipelineManager will wire capture to use captureAtomic
    if (typeof (this.core as any).setStatefulPipelineManager === "function") {
      (this.core as any).setStatefulPipelineManager(statefulManager);
      this.logger.info(`Core switched to StatefulPipelineManager (instance=${instanceId})`);
    }

    // 2. Start Timer Scanner (Scheme D: leaderless, scans sharded global ZSETs)
    const { TimerScanner } = await import("../services/timer-scanner.js");
    const defaultInstances = this.config.scanner.instances.split(",").filter(Boolean);

    this.timerScanner = new TimerScanner(this.stateBackend, {
      scanIntervalMs: this.config.scanner.intervalMs,
    }, this.logger);
    await this.timerScanner.start();
    this.logger.info(`Timer Scanner started (defaultInstances=${defaultInstances.join(",")}, sharded=true, leaderless=true)`);

    // 3. Start Pipeline Worker
    const { PipelineWorker } = await import("../services/pipeline-worker.js");
    const rawExecutor = this.buildTaskExecutor();
    // Wrapped with the TracedTaskExecutor decorator to add Trace Spans to L1/L2/L3 tasks
    const executor = new TracedTaskExecutor(rawExecutor);
    this.pipelineWorker = new PipelineWorker(this.stateBackend, executor, {
      pollIntervalMs: this.config.worker.pollMs,
      concurrency: this.config.worker.concurrency,
      lockTtlMs: this.config.worker.lockTtlMs,
      pendingStaleMs: this.config.worker.pendingStaleMs,
      pendingRecoveryIntervalMs: this.config.worker.pendingRecoveryIntervalMs,
      parkedClaimHeartbeatMs: this.config.worker.parkedClaimHeartbeatMs,
      lockRetryConcurrency: this.config.worker.lockRetryConcurrency,
      maxParkedTasks: this.config.worker.maxParkedTasks,
      // After L1 completes, advance the L2 timer (fast path: L1 done -> trigger L2 after delay seconds)
      onL1Complete: statefulManager.advanceL2TimerAfterL1.bind(statefulManager),
      // After L2 completes, set the maxInterval fallback timer
      onL2Complete: statefulManager.armL2MaxInterval.bind(statefulManager),
      // Node-level concurrency limit shared with the skill worker
      permitPool: this.workerPermitPool ?? undefined,
    }, this.logger);
    await this.pipelineWorker.start();
    this.logger.info("Pipeline Worker started");

    // The Skill worker is started by wireConversationAdd inside ensureConversationAddForInstance/Standalone,
    // no extra start needed here (aligned with the 2026-07-17 skill_extract
    // convergence plan: /v3/skill/extract also goes through the same worker + agent queue).
  }

  /**
   * Resolve the per-instance backend configs to feed StorePool.getStore/getSkillStore.
   *
   * D11: which backend a given instance uses is driven by the process store mode
   * (sqlite|mongodb). Only the config for the active mode is resolved —
   * `mongoConfig` for `mongodb`, null for sqlite (local file store).
   */
  private async resolveStoreBackendConfigs(
    instanceId: string,
  ): Promise<{ mongoConfig: MongoConfig | null }> {
    // P9 selection layer path: the resolution result carries an explicit kind and has passed validateResolution
    // (illegal combinations such as sqlite x rowfs fail-fast at resolution time, instead of at the first read/write).
    if (this.backendResolver) {
      const resolution = await this.backendResolver.resolve(instanceId);
      return dbChoiceToStoreConfigs(resolution.db);
    }
    // Old branch (WAMF_BACKEND_RESOLVER=off rollback path): process-level global mode gate.
    const provider = this.configProvider;
    const mode = this.storePool?.mode;
    if (!provider || !mode) {
      return { mongoConfig: null };
    }
    if (mode === "mongodb") {
      return { mongoConfig: await provider.resolveMongo(instanceId) };
    }
    return { mongoConfig: null };
  }

  /**
   * Build a per-instance SkillCore by instance_id (MongoSkillStore + file storage + versioning + hooks).
   *
   * Shares the same implementation body with the inline version in handleRequest, avoiding the skill worker (process-level singleton)
   * and the handler (per request) taking two different construction logics.
   */
  private async resolveSkillCoreForInstance(instanceId: string): Promise<SkillCoreType> {
    if (!this.configProvider || !this.storePool) {
      throw new SkillCoreError("SKILL_STORAGE_REQUIRED", "resolveSkillCoreForInstance: configProvider/storePool not ready");
    }
    const storePool = this.storePool;
    const logger = this.logger;

    const { mongoConfig } = await this.resolveStoreBackendConfigs(instanceId);
    const skillStore = await storePool.getSkillStore(instanceId, mongoConfig);

    // Skill resource storage: reuse the shared per-instance resolver so the
    // semantics match the memory path (local / rowfs per FILE_STORE_MODE).
    const storage: StorageAdapter = await this.resolveStorageForInstance(instanceId);

    const maxResourceSize = this.core.getResolvedSkillConfig()?.resources.maxResourceSizeBytes ?? 5_000_000;
    const { SkillResourceStore } = await import("../core/skill/skill-resource-store.js");
    const skillResources = new SkillResourceStore({ storage, maxResourceSizeBytes: maxResourceSize });

    const { SkillVersioning } = await import("../core/skill/skill-versioning.js");
    const quotaMgr = this.quotaManager;
    const resolveMetaSvc = () => this.ensureMetadataService(instanceId);
    const skillVersioning = new SkillVersioning({
      store: skillStore,
      resources: skillResources,
      storage,
      logger,
      onSkillRowsChanged: (delta: number) => {
        quotaMgr?.reportUsage(instanceId, delta, 0, "Skill").catch(() => {});
      },
      onSkillCreated: async ({ skill_id, team_id, agent_id, name }) => {
        if (!team_id || !agent_id) return;
        const metaSvc = await resolveMetaSvc();
        await metaSvc.ensureSkillAsset({ skill_id, team_id, agent_id, name });
      },
    });

    const { SkillCore } = await import("../core/skill/skill-core.js");
    return new SkillCore({
      store: skillStore,
      resources: skillResources,
      versioning: skillVersioning,
      onSkillAccessed: (skill) => {
        if (!skill.team_id || !skill.owner_agent_id) return;
        resolveMetaSvc()
          .then((svc) => svc.ensureSkillAsset({
            skill_id: skill.skill_id,
            team_id: skill.team_id,
            agent_id: skill.owner_agent_id,
            name: skill.name,
          }))
          .catch((err: unknown) => {
            logger.warn(
              `[skill-asset-sync] ensureSkillAsset(access) failed for ${skill.skill_id}: `
                + (err instanceof Error ? err.message : String(err)),
            );
          });
      },
      onSkillArchived: ({ skill_id, team_id }) => {
        resolveMetaSvc()
          .then((svc) => svc.deleteAssets([skill_id]))
          .catch((err: unknown) => {
            logger.warn(
              `[skill-asset-sync] deleteAssets(archive) failed for ${skill_id}`
                + ` (team=${team_id ?? "-"}): `
                + (err instanceof Error ? err.message : String(err)),
            );
          });
      },
    });
  }

  /**
   * Build a per-instance SkillExtractor (including the LLM runner) by skillCore + instance_id.
   * instance_id participates in the llm resolver's upstream URL construction (key for the provider=proxy scenario).
   */
  private async buildSkillExtractorForInstance(
    skillCore: SkillCoreType,
    instanceId: string,
  ): Promise<SkillExtractorClass> {
    const { SKILL_REVIEW_PROMPT } = await import("../core/skill/index.js");
    const { StandaloneLLMRunner } = await import("../adapters/standalone/llm-runner.js");
    const { resolveStandaloneLlmForRuntime, LlmProviderResolveError } = await import("../adapters/standalone/llm-provider-resolver.js");

    const llmCfg = this.config.llm;
    if (!llmCfg?.baseUrl) {
      throw new SkillCoreError("LLM_UNAVAILABLE", "LLM baseUrl not configured for skill extraction");
    }
    if ((llmCfg.provider ?? "openai") === "openai" && !llmCfg.apiKey) {
      throw new SkillCoreError("LLM_UNAVAILABLE", "LLM apiKey not configured (provider=openai)");
    }

    let effective: import("../adapters/standalone/llm-runner.js").StandaloneLLMConfig;
    try {
      effective = resolveStandaloneLlmForRuntime(llmCfg, instanceId);
    } catch (err) {
      const msg = err instanceof LlmProviderResolveError ? err.message : String(err);
      throw new SkillCoreError("LLM_UNAVAILABLE", `LLM provider resolve failed: ${msg}`);
    }
    this.logger.debug?.(
      `[skill-extractor] resolved LLM: provider=${llmCfg.provider ?? "openai"}, model=${effective.model}, baseUrl=${effective.baseUrl}`,
    );

    const llmRunner = new StandaloneLLMRunner({
      config: {
        baseUrl: effective.baseUrl,
        apiKey: effective.apiKey,
        model: effective.model ?? "default",
        timeoutMs: effective.timeoutMs ?? 120_000,
        stream: effective.stream ?? false,
      },
    });
    const cfg = this.core.getResolvedSkillConfig();
    return new SkillExtractorClass({
      core: skillCore,
      runner: llmRunner,
      systemPrompt: SKILL_REVIEW_PROMPT,
      maxIterations: cfg?.extraction.maxIterations ?? 5,
      // Pass through the head/tail chars derived from archiveBytes + the independent maxTokens,
      // so that skill.extraction.archiveBytes and skill.extraction.maxTokens take effect
      // (no code change needed after editing yaml). When cfg is missing, SkillExtractor has defaults internally.
      headChars: cfg?.extraction.headChars,
      tailChars: cfg?.extraction.tailChars,
      maxTokens: cfg?.extraction.maxTokens,
      prefixSkillsLimit: cfg?.extraction.prefixSkillsLimit,
      logger: this.logger,
    } as import("../core/skill/skill-extractor.js").ExtractorOptions);
  }

  /**
   * Lazily wire per-instance conversation-add: handler + worker + sink, the whole set.
   *
   * Dependencies:
   *   - storage: reuse memory's per-instance storage (already cached in resolveSkillCoreForInstance)
   *   - redis: reuse the stateBackend's ioredis client (skill:tasks-mutex / skill:extract-lock
   *     use the same physical connection)
   *   - skillCore/extractor: go through the same per-instance factory as handleExtract
   *   - metadataService: fallback registration of the skill asset
   *
   * keyPrefix is concatenated from memory's redis.keyPrefix, e.g.
   * `wamf_memory_prod_v3:skill-conv` -- literally does not collide with the old skill queue
   * (`{prefix}:skill:*`).
   */
  private ensureConversationAddForInstance(instanceId: string): Promise<WiredConversationAddHandler> {
    // In-flight cache: concurrent requests for the same instanceId share the same handler wire promise.
    // (the worker pool is a global singleton, so concurrency no longer causes multiple wired workers contending for locks)
    const cached = this.conversationAddByInstance.get(instanceId);
    if (cached) return cached;

    const inflight = this.buildConversationAddForInstance(instanceId);
    this.conversationAddByInstance.set(instanceId, inflight);
    inflight.catch(() => {
      if (this.conversationAddByInstance.get(instanceId) === inflight) {
        this.conversationAddByInstance.delete(instanceId);
      }
    });
    return inflight;
  }

  /**
   * Standalone (sqlite) version of the in-flight cache entry; semantics are exactly the same as
   * ensureConversationAddForInstance, only the build goes through the standalone path.
   */
  private ensureConversationAddForStandalone(instanceId: string): Promise<WiredConversationAddHandler> {
    const cached = this.conversationAddByInstance.get(instanceId);
    if (cached) return cached;

    const inflight = this.buildConversationAddForStandalone(instanceId);
    this.conversationAddByInstance.set(instanceId, inflight);
    inflight.catch(() => {
      if (this.conversationAddByInstance.get(instanceId) === inflight) {
        this.conversationAddByInstance.delete(instanceId);
      }
    });
    return inflight;
  }

  /**
   * Process-wide shared skill agent queue. Lazily built on first access by redis / memory,
   * after which all handler enqueues + SkillWorkerPool dequeues go through this one queue object.
   *
   * The key prefix is the same as the old per-instance queue (`${mem}:skill-conv:*`), keeping the
   * redis layer smooth during upgrade with no data migration. Old 4-segment tuples are dropped by the pool side + error.
   */
  /**
   * When purging an instance, clear the leftovers belonging to that instance in the shared skill queue (2026-07-30).
   *
   * Scenarios:
   *   - Redis backend: SSCAN `pending-agents-set` matching `{instanceId}|*` -> one by one
   *     SREM + LREM; SCAN all `extract-lock:{instanceId}|*` /
   *     `tasks-mutex:{instanceId}|*` -> DEL.
   *   - Local in-memory backend (standalone / no redis): filter directly using the private list/set fields.
   *
   * Idempotent -- no error when there are no leftovers, returns 0.
   */
  private async purgeSkillQueueForInstance(instanceId: string): Promise<{
    tuples_removed: number;
    locks_removed: number;
    backend: "redis" | "local" | "none";
  }> {
    const queue = this.skillSharedQueue;
    if (!queue) {
      return { tuples_removed: 0, locks_removed: 0, backend: "none" };
    }
    const prefixSegment = `${instanceId}|`;
    const memoryPrefix = this.config.redis?.keyPrefix ?? "wamf_memory";
    const keyPrefix = `${memoryPrefix}:skill-conv`;

    // Redis backend: get the ioredis client directly from stateBackend to SCAN
    const redisClient = this.getSharedIoRedisClient();
    if (redisClient && queue instanceof RedisSkillAgentTaskQueue) {
      const client = redisClient as unknown as {
        sscan(k: string, cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
        scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
        srem(k: string, ...members: string[]): Promise<number>;
        lrem(k: string, count: number, value: string): Promise<number>;
        del(...keys: string[]): Promise<number>;
      };
      const setKey = `${keyPrefix}:pending-agents-set`;
      const listKey = `${keyPrefix}:pending-agents`;
      let tuplesRemoved = 0;
      // SSCAN + MATCH matching the 5-segment tuple
      let cursor = "0";
      do {
        const [next, members] = await client.sscan(setKey, cursor, "MATCH", `${prefixSegment}*`, "COUNT", 500);
        cursor = next;
        for (const m of members) {
          await client.srem(setKey, m);
          await client.lrem(listKey, 0, m);
          tuplesRemoved++;
        }
      } while (cursor !== "0");

      // A 4-segment legacy tuple would also hit the space_id segment's prefix if instanceId happens to equal the space_id
      // value; no heuristic matching is done to avoid collateral damage, relying on the pool's own legacy branch (see
      // worker-pool.ts). If clearing is really needed, a separate script can be opened; this time only 5-segment tuples are cleared.

      // SCAN + MATCH to clear extract-lock / tasks-mutex
      const patterns = [
        `${keyPrefix}:extract-lock:${prefixSegment}*`,
        `${keyPrefix}:tasks-mutex:${prefixSegment}*`,
      ];
      let locksRemoved = 0;
      for (const pattern of patterns) {
        let cur = "0";
        do {
          const [next, keys] = await client.scan(cur, "MATCH", pattern, "COUNT", 500);
          cur = next;
          if (keys.length > 0) {
            const deleted = await client.del(...keys);
            locksRemoved += deleted;
          }
        } while (cur !== "0");
      }
      this.logger.info(
        `[skill-queue-purge] instance=${instanceId} redis: tuples=${tuplesRemoved} locks=${locksRemoved}`,
      );
      return { tuples_removed: tuplesRemoved, locks_removed: locksRemoved, backend: "redis" };
    }

    // Local backend: filter in reverse via _snapshot
    if (queue instanceof LocalSkillAgentTaskQueue) {
      const snap = queue._snapshot();
      let tuplesRemoved = 0;
      const seenRaws = new Set<string>();
      const collect = (arr: string[]) => {
        for (const r of arr) if (r.startsWith(prefixSegment)) seenRaws.add(r);
      };
      collect(snap.list);
      collect(snap.set);
      for (const raw of seenRaws) {
        const t = parseSkillAgentTuple(raw);
        if (t) {
          await queue.removeAgent(t);
          tuplesRemoved++;
        }
      }
      this.logger.info(
        `[skill-queue-purge] instance=${instanceId} local: tuples=${tuplesRemoved}`,
      );
      return { tuples_removed: tuplesRemoved, locks_removed: 0, backend: "local" };
    }
    return { tuples_removed: 0, locks_removed: 0, backend: "none" };
  }

  private ensureSkillSharedQueue(): ISkillAgentTaskQueue {
    if (this.skillSharedQueue) return this.skillSharedQueue;
    const memoryPrefix = this.config.redis?.keyPrefix ?? "wamf_memory";
    const keyPrefix = `${memoryPrefix}:skill-conv`;
    const redisClient = this.getSharedIoRedisClient();
    if (redisClient) {
      this.skillSharedQueue = new RedisSkillAgentTaskQueue({
        client: redisClient as SkillAgentTaskQueueRedisLike,
        keyPrefix,
      });
      this.logger.info(`[skill-worker-pool] shared queue ready: backend=redis prefix=${keyPrefix}`);
    } else {
      // Local state backend / standalone without redis -> single-node in-memory queue
      this.skillSharedQueue = new LocalSkillAgentTaskQueue();
      this.logger.warn(
        `[skill-worker-pool] no shared ioredis (deployMode=${this.config.deployMode}); ` +
          `falling back to in-memory queue (single-node only) prefix=${keyPrefix}`,
      );
    }
    return this.skillSharedQueue;
  }

  /**
   * The single process-wide SkillWorkerPool, called once during the start() phase. Afterwards in stop(),
   * pool.stop() waits for all workerLoops to exit.
   *
   * The resolver closures reuse the existing per-instance caches:
   *   - resolveBuffer  → resolveStorageForInstance + SkillBufferStorage
   *   - resolveExtractor -> buildSkillExtractorForInstance (service) or
   *     WamfCore.getSkillExtractor (standalone)
   *   - resolveSink → ensureMetadataService + SkillCoreSink
   */
  private async ensureSkillWorkerPool(): Promise<SkillWorkerPool | null> {
    if (this.skillWorkerPool) return this.skillWorkerPool;
    const skillCfg = this.core.getResolvedSkillConfig();
    if (!skillCfg) {
      this.logger.info(`[skill-worker-pool] resolved skill config missing (skill.enabled=false?); pool not started`);
      return null;
    }
    const queue = this.ensureSkillSharedQueue();
    const gateway = this;
    // Where extracted skills land is decided by the *store mode*, not deployMode:
    //   - mongodb → per-instance SkillCore from StorePool (MongoSkillStore).
    //     This holds even for standalone + STORE_MODE=mongodb.
    //   - otherwise (sqlite singleton) → WamfCore's standalone SkillExtractor.
    const usePerInstanceSkill = this.storePool?.mode === "mongodb";

    this.skillWorkerPool = new SkillWorkerPool({
      concurrency: skillCfg.worker.concurrency,
      queue,
      logger: this.logger,
      poolId: `skill-pool-${this.config.instanceId ?? "gateway"}-${process.pid}`,
      brpopBlockMs: skillCfg.worker.brpopBlockMs,
      extractLockTtlMs: skillCfg.worker.extractLockTtlMs,
      extractLockRenewIntervalMs: skillCfg.worker.extractLockRenewIntervalMs,
      resolveBuffer: async (instanceId: string): Promise<SkillBufferStorage> => {
        const storage = await gateway.resolveStorageForInstance(instanceId);
        // SkillBufferStorage is newly created each time (lightweight), but the storage adapter is cached
        const { SkillBufferStorage: Cls } = await import("../core/skill/conversation-add/buffer-storage.js");
        return new Cls({ storage });
      },
      resolveExtractor: async (instanceId: string): Promise<ISkillExtractor> => {
        if (!usePerInstanceSkill) {
          const raw = gateway.core.getSkillExtractor();
          if (!raw) {
            throw new Error(`[skill-worker-pool] standalone SkillExtractor unavailable (instance=${instanceId})`);
          }
          return createExtractorAdapter(raw, gateway.logger);
        }
        const skillCore = await gateway.resolveSkillCoreForInstance(instanceId);
        const raw = await gateway.buildSkillExtractorForInstance(skillCore, instanceId);
        return createExtractorAdapter(raw, gateway.logger);
      },
      resolveSink: async (instanceId: string): Promise<SkillCandidatesSink> => {
        const metadataService = await gateway.ensureMetadataService(instanceId).catch(() => undefined);
        const { SkillCoreSink } = await import("../core/skill/conversation-add/skill-core-sink.js");
        return new SkillCoreSink({ metadata: metadataService, logger: gateway.logger });
      },
    });
    this.skillWorkerPool.start();
    this.logger.info(
      `[skill-worker-pool] started concurrency=${skillCfg.worker.concurrency} ` +
        `brpopBlockMs=${skillCfg.worker.brpopBlockMs} extractLockTtlMs=${skillCfg.worker.extractLockTtlMs}`,
    );
    return this.skillWorkerPool;
  }

  /**
   * Translate the archive/compression derived fields of the resolved skill config into override parameters for wireConversationAdd's
   * thresholds / compressOptions / oversizeOptions. Returns an empty object when cfg is missing,
   * and the wire layer falls back to the built-in defaults (equivalent to the old behavior).
   *
   * Makes skill.extraction.archiveBytes / skill.compress in yaml take effect without code changes.
   */
  private buildSkillWireOverrides(): Pick<
    WireConversationAddDeps,
    "thresholds" | "compressOptions" | "oversizeOptions"
  > {
    const cfg = this.core.getResolvedSkillConfig();
    if (!cfg) return {};
    return {
      thresholds: {
        toolCallThreshold: cfg.extraction.toolCallThreshold,
        bytesThreshold: cfg.extraction.bytesThreshold,
        requestCompressThresholdBytes: cfg.extraction.requestCompressThresholdBytes,
      },
      compressOptions: {
        toolContentThresholdBytes: cfg.compress.toolContentThresholdBytes,
        headBytes: cfg.compress.headBytes,
        tailBytes: cfg.compress.tailBytes,
      },
      oversizeOptions: {
        chunkMaxBytes: cfg.extraction.chunkMaxBytes,
        headKeepBytes: cfg.extraction.headKeepBytes,
        tailKeepBytes: cfg.extraction.tailKeepBytes,
      },
    };
  }

  private async buildConversationAddForInstance(instanceId: string): Promise<WiredConversationAddHandler> {
    // After the 2026-07-30 pooling, this function only builds the per-instance handler bundle.
    // extractor / sink are removed from the handler side and fetched on demand by the SkillWorkerPool's resolver.
    // But the wireConversationAddHandler signature still requires an extractor parameter (compatible with the old wireConversationAdd),
    // so pass a noop -- the handler does not use the extractor internally, only the worker does.

    // 1) storage: the same per-instance storage resolveSkillCoreForInstance uses
    await this.resolveSkillCoreForInstance(instanceId);
    const storage = await this.resolveStorageForInstance(instanceId);

    // 2) queue: process-wide shared singleton
    const queue = this.ensureSkillSharedQueue();

    // 3) noop extractor / sink placeholders (the handler does not use them; only the worker pool uses the real ones)
    const noopExtractor: ISkillExtractor = { extract: async () => ({ candidates: [] }) };

    const wired = wireConversationAddHandler({
      storage,
      queue,
      extractor: noopExtractor,
      logger: this.logger,
      ...this.buildSkillWireOverrides(),
    });

    // Ensure the pool on first use, guaranteeing the workers are already running. Multiple instances all reach here on first access,
    // and ensureSkillWorkerPool has an idempotent cache internally.
    await this.ensureSkillWorkerPool();

    this.logger.info(
      `[skill-conversation-add] handler wired instance=${instanceId} storage=${storage.type}`,
    );
    return wired;
  }

  /**
   * Conversation-add wiring in Standalone mode.
   *
   * Differences from service mode (buildConversationAddForInstance):
   *   - skillCore/extractor: use the WamfCore global singleton (SqliteSkillStore + singleton extractor),
   *     not per-instance; standalone is a single-instance deployment anyway.
   *   - storage: goes through resolveStorageForInstance -> LocalStorageBackend.
   *   - redis: not necessarily present; wire.ts automatically degrades to LocalSkillAgentTaskQueue (single-node in-memory queue).
   *   - extractor: if cfg.llm is incomplete and WamfCore did not build a skillExtractor, skipWorker is used,
   *     mounting only handler+buffer; the Client side can still write the buffer, but archive triggering does not work (warn).
   */
  private async buildConversationAddForStandalone(instanceId: string): Promise<WiredConversationAddHandler> {
    // After the 2026-07-30 pooling, standalone goes through the same handler wire, with a global singleton worker pool.
    const skillCore = this.core.getSkillCore();
    if (!skillCore) {
      throw new Error(`[skill-conversation-add] SkillCore not enabled (standalone) — check cfg.skill.enabled`);
    }

    const storage = await this.resolveStorageForInstance(instanceId);
    const queue = this.ensureSkillSharedQueue();
    const noopExtractor: ISkillExtractor = { extract: async () => ({ candidates: [] }) };

    const wired = wireConversationAddHandler({
      storage,
      queue,
      extractor: noopExtractor,
      logger: this.logger,
      ...this.buildSkillWireOverrides(),
    });

    // In Standalone mode the extractor may be unavailable because cfg.llm is not fully configured; but the pool side
    // throws in resolveExtractor, and tuples archived into the queue go through consumeAgent's catch
    // branch and are recognized as transient -> requeued indefinitely until external recovery. Equivalent to the old skipWorker logic
    // (old: after the handler-side wire, skip the worker entirely; new: tasks still land in the queue, but the pool
    // side fails to consume them, and recover naturally once the extractor is configured).
    await this.ensureSkillWorkerPool();

    this.logger.info(
      `[skill-conversation-add] handler wired (standalone) instance=${instanceId} storage=${storage.type}`,
    );
    return wired;
  }

  /**
   * Resolve the "content-side" handles (memory store + storage) of an instance, used to clear chat_memory
   * content. Both modes use their own existing resolution paths, guaranteeing they hit the same data as /v2 data-plane reads/writes:
   *   - service (storePool + configProvider ready): per-instance store + file storage
   *   - standalone: WamfCore's global VectorStore + local storage
   *
   * When either side is unavailable it **throws** instead of silently skipping -- if content cleanup were skipped when archiving an Agent,
   * it would leave behind orphan data where "the asset is deleted but the content remains", which is exactly the problem being fixed here.
   */
  private async resolveMemoryContentTargets(
    instanceId: string,
  ): Promise<{ store: IMemoryStore; storage: StorageAdapter }> {
    let store: IMemoryStore | undefined;

    if (this.storePool && this.configProvider) {
      const { mongoConfig } = await this.resolveStoreBackendConfigs(instanceId);
      const pooled = await this.storePool.getStore(instanceId, mongoConfig);
      store = pooled.store;
    } else {
      store = this.core.getVectorStore();
    }

    if (!store) {
      throw new Error(`memory store unavailable for instance ${instanceId}, cannot clear chat memory content`);
    }

    const storage = this.storePool && this.configProvider
      ? await this.resolveStorageForInstance(instanceId)
      : this.core.getStorage();

    if (!storage) {
      throw new Error(`storage unavailable for instance ${instanceId}, cannot clear chat memory content`);
    }

    return { store, storage };
  }

  /**
   * Resolve per-instance StorageAdapter — the single FS-dimension switch point
   * (Phase 2 M3). Dispatches on the resolved `data.fileStore`:
   *   - `local` → resolveFileOthersForInstance (cached in `fileStorageCache`):
   *       standalone → LocalStorageBackend rooted at data.baseDir;
   *       service    → LocalStorageBackend rooted at data.baseDir/instances/{instanceId}.
   *   - `rowfs` → resolveRowfsStorageForInstance (composite: profile rows +
   *     the others leg this instance would have used).
   *
   * Both `/v2/*` (memory) and `/v3/skill/conversation/add` need per-instance
   * storage; keeping this in one method keeps the others-leg semantics identical
   * on both paths.
   */
  private async resolveStorageForInstance(instanceId: string): Promise<StorageAdapter> {
    // P9 selection layer path: two-axis resolution result (profile x others). rows -> L2/L3 profile
    // keys go through the row view and the other keys go through the others leg; files -> single-backend form, where the others leg serves all keys.
    if (this.backendResolver) {
      const resolution = await this.backendResolver.resolve(instanceId);
      const othersKind = resolution.fs.others.kind;
      if (resolution.fs.profile === "rows") {
        return this.resolveRowfsStorageForInstance(instanceId, othersKind);
      }
      // The mongofs leg needs the instance Mongo config (the local resolver never produces files x mongofs;
      // this is a positive path reserved for per-instance form delivery in the future).
      if (othersKind === "mongofs") {
        const { mongoConfig } = await this.resolveStoreBackendConfigs(instanceId);
        return this.resolveMongoFsOthersForInstance(instanceId, mongoConfig);
      }
      return this.resolveFileOthersForInstance(instanceId);
    }
    // Old branch (WAMF_BACKEND_RESOLVER=off rollback path): FILE_STORE_MODE single-point switch.
    if (this.config.data.fileStore === "rowfs") {
      return this.resolveRowfsStorageForInstance(instanceId, this.config.data.fileStoreOthers);
    }
    return this.resolveFileOthersForInstance(instanceId);
  }

  /**
   * rowfs file mode: a composite of ProfileRowStorageBackend (row view) + the others file backend.
   *
   * - Row-substrate capability check (D8-3 fail-fast): illegal combinations such as sqlite x rowfs throw
   *   BackendCapabilityError here, instead of being exposed on the first read/write.
   * - The returned composite backend is **not bound to an isolation domain**; request-level isolation is rebound into query conditions
   *   by the handler layer's scopeProfileStorageView (constructor parameter pass-through, no key prefix).
   * - Not cached per instance: the composite backend is pure object assembly and very cheap to construct; not caching avoids
   *   holding a stale store handle after the storePool LRU evicts (the others side has its own cache).
   */
  private async resolveRowfsStorageForInstance(
    instanceId: string,
    othersKind?: FsOthersKind,
  ): Promise<StorageAdapter> {
    if (!this.storePool) {
      throw new Error(`FILE_STORE_MODE=rowfs requires a store pool (instance=${instanceId})`);
    }
    const { mongoConfig } = await this.resolveStoreBackendConfigs(instanceId);
    const { store } = await this.storePool.getStore(instanceId, mongoConfig);
    const rowStore = requireProfileRowStore(store, { dbKind: this.storePool.mode, fsKind: "rowfs" });

    // mongofs others leg (zero-disk form): all non-profile keys land in the instance's own
    // Mongo database. Legality (mongofs => db.kind=mongodb) is intercepted by the selection layer
    // validateResolution; the old-branch path defensively checks again here.
    const others =
      othersKind === "mongofs"
        ? await this.resolveMongoFsOthersForInstance(instanceId, mongoConfig)
        : await this.resolveFileOthersForInstance(instanceId);
    const profileBackend = new ProfileRowStorageBackend({
      store: rowStore,
      // The read tool names written for the model in navigation belong to the mount surface; generic tool renaming belongs to special project 7.
      navigation: { readTool: "wamf_read_file" },
      logger: this.logger,
    });
    const adapter = new StorageAdapter(
      new CompositeStorageBackend({ profileBackend, others: others.getBackend(), logger: this.logger }),
    );
    this.logger.info(
      `${TAG} rowfs storage assembled (instance=${instanceId}, db=${this.storePool.mode}, others=${others.type})`,
    );
    return adapter;
  }

  /**
   * The local file backend, cached per instance. It is both the positive path for
   * local mode and the others side of the rowfs-mode composite backend.
   *
   * standalone → data.baseDir (single-instance layout, unchanged);
   * service    → data.baseDir/instances/{instanceId} so instances never share a file space.
   */
  private async resolveFileOthersForInstance(instanceId: string): Promise<StorageAdapter> {
    const cached = this.fileStorageCache?.get(instanceId);
    if (cached) return cached;

    let rootDir = this.config.data.baseDir;
    if (this.config.deployMode === "service") {
      if (!isSafeInstanceId(instanceId)) {
        throw new Error(`invalid instance id: ${JSON.stringify(instanceId)}`);
      }
      rootDir = join(this.config.data.baseDir, "instances", instanceId);
    }
    const backend = new LocalStorageBackend({ rootDir, logger: this.logger });
    const adapter = new StorageAdapter(backend);
    if (!this.fileStorageCache) this.fileStorageCache = new Map();
    this.fileStorageCache.set(instanceId, adapter);
    return adapter;
  }

  /**
   * mongofs others leg (FILE_STORE_OTHERS=mongofs): a generic Mongo file backend,
   * with data landing in the instance's own database (the same Db handle as the memory store, via the shared client pool).
   * Reuses fileStorageCache for per-instance caching -- the Db handle is stateless, and cache invalidation
   * semantics are consistent with the local leg.
   */
  private async resolveMongoFsOthersForInstance(
    instanceId: string,
    mongoConfig: MongoConfig | null,
  ): Promise<StorageAdapter> {
    const cached = this.fileStorageCache?.get(instanceId);
    if (cached) return cached;
    if (!mongoConfig) {
      throw new Error(
        `FILE_STORE_OTHERS=mongofs requires db.kind="mongodb" (instance=${instanceId}) — ` +
          `no MongoConfig resolved. Set STORE_MODE=mongodb (and MONGODB_* env in local mode).`,
      );
    }
    const db = await getSharedMongoClientPool(this.logger).getDb(mongoConfig);
    const adapter = new StorageAdapter(new MongoFSBackend({ db, logger: this.logger }));
    if (!this.fileStorageCache) this.fileStorageCache = new Map();
    this.fileStorageCache.set(instanceId, adapter);
    return adapter;
  }

  /**
   * Get the ioredis client from RedisStateBackend; returns null for a non-Redis backend.
   */
  private getSharedIoRedisClient(): SkillAgentTaskQueueRedisLike | null {
    if (!this.stateBackend) return null;
    // duck-type: only RedisStateBackend has getClient()
    const maybe = this.stateBackend as unknown as { getClient?: () => unknown };
    if (typeof maybe.getClient !== "function") return null;
    try {
      return maybe.getClient() as SkillAgentTaskQueueRedisLike;
    } catch {
      return null;
    }
  }

  /**
   * Build a TaskExecutor that bridges Pipeline tasks to WamfCore's existing L1/L2/L3 runners.
   *
   * Multi-instance aware: each task carries a instanceId in task.data.
   * The executor resolves the per-instance store config from InstanceConfigProvider,
   * then obtains the corresponding Store from StorePool before running the task.
   */
  private buildTaskExecutor(): TaskExecutor {
    const core = this.core;
    const storePool = this.storePool!;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const gateway = this;

    const resolveStore = async (task: TaskPayload) => {
      const instanceId = typeof task.data?.instanceId === "string" ? task.data.instanceId : undefined;
      if (!instanceId) {
        throw new Error(`Task ${task.id} missing instanceId in service mode (task.data.instanceId is required)`);
      }
      const { mongoConfig } = await gateway.resolveStoreBackendConfigs(instanceId);
      return storePool.getStore(instanceId, mongoConfig);
    };

    const resolveStorage = async (task: TaskPayload) => {
      const instanceId = typeof task.data?.instanceId === "string" ? task.data.instanceId : undefined;
      if (!instanceId) {
        throw new Error(`Task ${task.id} missing instanceId in service mode (task.data.instanceId is required)`);
      }

      // Go uniformly through resolveStorageForInstance -- the single-point switch for the FS dimension
      // (local/rowfs); the worker and the v2 data plane must hit the same assembly path.
      return gateway.resolveStorageForInstance(instanceId);
    };

    /**
     * Build the cross-node mutex lock for the checkpoint.
     *
     * Why it is needed: the checkpoint of the same instance is **one and the same** storage object
     * (`{instance root}/.metadata/checkpoint.json`), writeRaw overwrites the whole object,
     * and the storage backends offer no compare-and-swap conditional write.
     * Meanwhile L1's task lock is session-level, so different sessions / different agents can legitimately run
     * concurrently on multiple nodes -- without extra mutual exclusion, a later writer would overwrite the runner_states already committed by an earlier writer with an old snapshot,
     * causing L1 cursors to be lost and extraction to repeat forever.
     *
     * lockKey uses instanceId: one-to-one with the checkpoint object; the granularity cannot be finer
     * (finer would not protect the shared object), nor does it need to be coarser.
     *
     * Returns undefined when stateBackend is missing (standalone single process),
     * in which case CheckpointManager only uses the in-process withFileLock, behaving as before.
     */
    const resolveCheckpointLock = (
      instanceId: string,
    ): import("../utils/checkpoint.js").CheckpointLockOptions | undefined => {
      const backend = gateway.stateBackend;
      if (!backend) return undefined;
      return {
        lock: {
          acquireLock: (key, ownerId, ttlMs) => backend.acquireLock(key, ownerId, ttlMs),
          renewLock: (key, ownerId, ttlMs) => backend.renewLock(key, ownerId, ttlMs),
          releaseLock: (key, ownerId) => backend.releaseLock(key, ownerId),
        },
        lockKey: instanceId,
        metrics: {
          onRequeueRequired: (key, waitedMs) => {
            gateway.logger.warn(
              `[checkpoint-lock] acquire timeout key=${key} waited=${waitedMs}ms → task will be requeued`,
            );
          },
          onBackendError: (key, err) => {
            gateway.logger.warn(
              `[checkpoint-lock] backend error key=${key}: ${err instanceof Error ? err.message : String(err)}`,
            );
          },
          onLockLost: (key) => {
            gateway.logger.warn(`[checkpoint-lock] lock lost during critical section key=${key}`);
          },
        },
      };
    };

    return {
      async executeL1(task: TaskPayload, signal?: AbortSignal) {
        const instanceId = typeof task.data?.instanceId === "string" ? task.data.instanceId : undefined;
        if (!instanceId) throw new Error(`L1 task ${task.id} missing instanceId`);
        const teamId = task.teamId ?? (typeof task.data?.teamId === "string" ? task.data.teamId : undefined);
        const agentId = task.agentId ?? (typeof task.data?.agentId === "string" ? task.data.agentId : undefined);

        // H-11 Step 2: early abort check — if pipeline-worker already lost its lock
        // before we even started, bail out without doing any work.
        if (signal?.aborted) throw signal.reason ?? new Error("executeL1: aborted before start");

        // Dedup: if triggered by timer but session already processed (count=0), skip
        if (task.data?.triggeredBy === "timer_scanner" && gateway.stateBackend) {
          const state = await gateway.stateBackend.getSessionState(instanceId, task.sessionId, teamId, agentId);
          if (state && state.conversation_count === 0) {
            gateway.logger.debug?.(`[executor] L1 skipped: session ${task.sessionId} already processed (count=0)`);
            return;
          }
        }

        // Credit quota check before LLM call
        if (gateway.quotaManager) {
          const check = await gateway.quotaManager.checkCreditQuota(instanceId);
          if (!check.allowed) {
            gateway.logger.warn(`[executor] L1 skipped: credit limit exceeded (instance=${instanceId}, current=${check.current}, limit=${check.limit})`);
            return;
          }
        }

        // H-11 Step 2: check again after async quota call before launching LLM
        if (signal?.aborted) throw signal.reason ?? new Error("executeL1: aborted before LLM");

        core.setInstanceId(instanceId);
        const { store, embedding } = await resolveStore(task);
        const storage = await resolveStorage(task);
        const result = await core.runL1WithStore(
          task.sessionId,
          store,
          embedding,
          storage ?? undefined,
          resolveCheckpointLock(instanceId),
        );

        (task as any)._l2ProfileScopes = result.profileScopes;

        // Report usage after L1: memory added + credit consumed
        // With provider=proxy the credit is reported by context_proxy; here only the memory delta is reported.
        if (gateway.quotaManager) {
          const { storedCount, creditUsed } = result;
          const reportCredit = gateway.reportedCreditFor(creditUsed, "L1");
          if (storedCount > 0 || reportCredit > 0) {
            gateway.quotaManager.reportUsage(instanceId, storedCount, reportCredit, "L1").catch(() => {});
          }
        }

        // ── L0 backlog drain (mirrors standalone MemoryPipelineManager.runL1) ──
        //
        // The runner over-fetched 2N L0 rows but processed at most N. If
        // `hasFullBacklog`, DB is likely far from drained — enqueue another
        // L1 task right away. If only `hasMore`, defer to the standard
        // L1_idle timer so a later notifyConversation can co-trigger.
        // See pipeline-factory.ts createL1Runner for the full state machine.
        if (gateway.statefulPipelineManager) {
          if (result.hasFullBacklog) {
            gateway.statefulPipelineManager.enqueueL1Drain(task.sessionId, instanceId, teamId, agentId).catch((err) => {
              gateway.logger.warn(`[executor] L1 drain enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          } else if (result.hasMore) {
            gateway.statefulPipelineManager.armL1IdleAfterDrain(task.sessionId, instanceId, teamId, agentId).catch((err) => {
              gateway.logger.warn(`[executor] L1 idle arm failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        }
      },
      async executeL2(task: TaskPayload, signal?: AbortSignal) {
        const instanceId = typeof task.data?.instanceId === "string" ? task.data.instanceId : undefined;
        if (!instanceId) throw new Error(`L2 task ${task.id} missing instanceId`);
        const teamId = task.teamId ?? (typeof task.data?.teamId === "string" ? task.data.teamId : undefined);
        const agentId = task.agentId ?? (typeof task.data?.agentId === "string" ? task.data.agentId : undefined);

        if (signal?.aborted) throw signal.reason ?? new Error("executeL2: aborted before start");

        // Credit quota check before LLM call
        if (gateway.quotaManager) {
          const check = await gateway.quotaManager.checkCreditQuota(instanceId);
          if (!check.allowed) {
            gateway.logger.warn(`[executor] L2 skipped: credit limit exceeded (instance=${instanceId})`);
            return;
          }
        }

        // Read L2 cursor from session state (l2_last_extraction_time)
        // This ensures L2 only processes L1 records created after the last extraction.
        let cursor: string | undefined;
        if (gateway.stateBackend) {
          const state = await gateway.stateBackend.getSessionState(instanceId, task.sessionId, teamId, agentId);
          if (state?.l2_last_extraction_time) {
            cursor = state.l2_last_extraction_time;
          }
        }

        if (signal?.aborted) throw signal.reason ?? new Error("executeL2: aborted before LLM");

        core.setInstanceId(instanceId);
        const { store } = await resolveStore(task);
        const storage = await resolveStorage(task);

        // Count scenes before L2 to detect new scene creation
        let sceneCountBefore = 0;
        if (storage) {
          try {
            const { StoragePaths } = await import("../core/storage/types.js");
            const idx = await storage.readFile(StoragePaths.sceneIndex);
            if (idx) sceneCountBefore = JSON.parse(idx).length;
          } catch { /* ok */ }
        }

        const result = await core.runL2WithStore(task.sessionId, store, storage ?? undefined, cursor);

        // Mark task as skipped if L2 had no new records to process
        if (result.skipped) {
          (task as any)._l2Skipped = true;
        }

        // Report credit + new scenes as memory
        if (gateway.quotaManager && !result.skipped) {
          const { creditUsed } = result;
          let newScenes = 0;
          if (storage) {
            try {
              const { StoragePaths } = await import("../core/storage/types.js");
              const idx = await storage.readFile(StoragePaths.sceneIndex);
              if (idx) newScenes = Math.max(0, JSON.parse(idx).length - sceneCountBefore);
            } catch { /* ok */ }
          }
          // With provider=proxy the credit is reported by context_proxy; here only the memory delta is reported.
          const reportCredit = gateway.reportedCreditFor(creditUsed, "L2");
          if (reportCredit > 0 || newScenes > 0) {
            gateway.quotaManager.reportUsage(instanceId, newScenes, reportCredit, "L2").catch(() => {});
          }
        }
      },
      async executeL3(task: TaskPayload, signal?: AbortSignal) {
        const instanceId = typeof task.data?.instanceId === "string" ? task.data.instanceId : undefined;
        if (!instanceId) throw new Error(`L3 task ${task.id} missing instanceId`);

        if (signal?.aborted) throw signal.reason ?? new Error("executeL3: aborted before start");

        // Credit quota check before LLM call
        if (gateway.quotaManager) {
          const check = await gateway.quotaManager.checkCreditQuota(instanceId);
          if (!check.allowed) {
            gateway.logger.warn(`[executor] L3 skipped: credit limit exceeded (instance=${instanceId})`);
            return;
          }
        }

        if (signal?.aborted) throw signal.reason ?? new Error("executeL3: aborted before LLM");

        // Check if persona exists before L3 (to detect first creation)
        let personaExistedBefore = false;
        const storage = await resolveStorage(task);
        if (storage) {
          try {
            const { StoragePaths } = await import("../core/storage/types.js");
            personaExistedBefore = await storage.exists(StoragePaths.persona);
          } catch { /* ok */ }
        }

        core.setInstanceId(instanceId);
        const { store } = await resolveStore(task);
        const result = await core.runL3WithStore(store, storage ?? undefined);

        // Report credit + memory (only +1 on first persona creation)
        // With provider=proxy the credit is reported by context_proxy; here only the memory delta is reported.
        if (gateway.quotaManager) {
          const { creditUsed } = result;
          const memoryDelta = (!personaExistedBefore && storage) ? 1 : 0;
          const reportCredit = gateway.reportedCreditFor(creditUsed, "L3");
          if (reportCredit > 0 || memoryDelta > 0) {
            gateway.quotaManager.reportUsage(instanceId, memoryDelta, reportCredit, "L3").catch(() => {});
          }
        }
      },
      async executeFlush(task: TaskPayload) {
        await core.handleSessionEnd(task.sessionId);
      },

      // ── Offload executors (L1 summary, L1.5 task judgment, L2 MMD update) ──
      async executeOffloadL1(task: TaskPayload, signal?: AbortSignal) {
        if (signal?.aborted) return;
        const { OffloadTaskExecutor } = await import("../offload_server/offload-task-executor.js");
        const storage = await resolveStorage(task);
        if (!storage) return;
        const llmClient = gateway.buildOffloadLlmClient(task.instanceId);
        if (!llmClient) {
          gateway.logger.warn(`[executor] offload-l1 skipped: no LLM client available`);
          return;
        }
        const executor = new OffloadTaskExecutor({
          resolveStorage: async () => storage,
          llmClient,
          stateBackend: gateway.stateBackend!,
          config: { ...gateway.config.offload, l1Model: "", l15Model: "", l2Model: "" },
          logger: gateway.logger,
        });
        await executor.executeOffloadL1(task, signal);
      },
      async executeOffloadL15(task: TaskPayload, signal?: AbortSignal) {
        if (signal?.aborted) return;
        const { OffloadTaskExecutor } = await import("../offload_server/offload-task-executor.js");
        const storage = await resolveStorage(task);
        if (!storage) return;
        const llmClient = gateway.buildOffloadLlmClient(task.instanceId);
        if (!llmClient) {
          gateway.logger.warn(`[executor] offload-l15 skipped: no LLM client available`);
          return;
        }
        const executor = new OffloadTaskExecutor({
          resolveStorage: async () => storage,
          llmClient,
          stateBackend: gateway.stateBackend!,
          config: { ...gateway.config.offload, l1Model: "", l15Model: "", l2Model: "" },
          logger: gateway.logger,
        });
        await executor.executeOffloadL15(task, signal);
      },
      async executeOffloadL2(task: TaskPayload, signal?: AbortSignal) {
        if (signal?.aborted) return;
        const { OffloadTaskExecutor } = await import("../offload_server/offload-task-executor.js");
        const storage = await resolveStorage(task);
        if (!storage) return;
        const llmClient = gateway.buildOffloadLlmClient(task.instanceId);
        if (!llmClient) {
          gateway.logger.warn(`[executor] offload-l2 skipped: no LLM client available`);
          return;
        }
        const executor = new OffloadTaskExecutor({
          resolveStorage: async () => storage,
          llmClient,
          stateBackend: gateway.stateBackend!,
          config: { ...gateway.config.offload, l1Model: "", l15Model: "", l2Model: "" },
          logger: gateway.logger,
        });
        await executor.executeOffloadL2(task, signal);
      },
    };
  }

  /**
   * The CreditDelta to report: zeroed when provider=proxy (proxy has already reported; avoid double billing),
   * otherwise passed through as is. See quota-credit-policy.ts for details.
   */
  private reportedCreditFor(rawCreditUsed: number, level: "L1" | "L2" | "L3"): number {
    const reported = resolveReportedCredit(rawCreditUsed, this.config.llm.provider);
    if (reported === 0 && rawCreditUsed > 0) {
      this.logger.debug?.(
        `[quota] ${level} creditUsed=${rawCreditUsed} is reported by context_proxy; core skips the credit part`,
      );
    }
    return reported;
  }

  /**
   * Build a simple LLM client for offload executors using gateway's LLM config.
   *
   * instanceId is used in the provider=proxy scenario to build baseUrl into /proxy/<iid>/v1;
   * it may be undefined in the provider=openai scenario.
   */
  private buildOffloadLlmClient(instanceId?: string) {
    const llmCfg = this.config.llm;
    if (!llmCfg.baseUrl || !llmCfg.model) return null;
    // With provider=openai an explicit apiKey is still required; with provider=proxy the apiKey is injected by the resolver from env
    if ((llmCfg.provider ?? "openai") === "openai" && !llmCfg.apiKey) return null;

    let effective: StandaloneLLMConfig;
    try {
      effective = resolveStandaloneLlmForRuntime(llmCfg, instanceId);
    } catch (err) {
      this.logger.warn(
        `[offload-llm] provider resolution failed, skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    const logger = this.logger;

    return {
      async chat(params: {
        model: string;
        messages: Array<{ role: "system" | "user"; content: string }>;
        temperature: number;
        max_tokens: number;
        timeoutMs?: number;
      }): Promise<string> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 30000);
        try {
          const response = await fetch(`${effective.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${effective.apiKey}`,
            },
            body: JSON.stringify({
              model: effective.model || params.model,
              messages: params.messages,
              temperature: params.temperature,
              max_tokens: params.max_tokens,
            }),
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (!response.ok) {
            throw new Error(`LLM API returned ${response.status}: ${await response.text()}`);
          }
          const json = (await response.json()) as any;
          const finishReason = json.choices?.[0]?.finish_reason;
          if (finishReason === "length") {
            const content = json.choices?.[0]?.message?.content ?? "";
            logger.warn(
              `[offload-llm] Response truncated (finish_reason=length, max_tokens=${params.max_tokens}), ` +
              `content=${content.length} chars`,
            );
          }
          return json.choices?.[0]?.message?.content ?? "";
        } catch (err) {
          clearTimeout(timer);
          throw err;
        }
      },
    };
  }
}

// ============================
// CLI entry point
// ============================

/**
 * Start the gateway from the command line.
 * Usage: node --import tsx src/gateway/server.ts
 */
async function main(): Promise<void> {
  const gateway = new WamfGateway();

  // Graceful shutdown. A *deliberate* second signal (impatient Ctrl+C) forces
  // immediate exit. We debounce because a single Ctrl+C under `tsx` arrives
  // twice (TTY delivers to the process group AND tsx forwards it), and those
  // duplicates land within milliseconds — they must not be treated as "again".
  const FORCE_EXIT_DEBOUNCE_MS = 1000;
  let firstSignalAt = 0;
  const shutdown = async (signal: NodeJS.Signals) => {
    const now = Date.now();
    if (firstSignalAt === 0) {
      firstSignalAt = now;
      await gateway.stop();
      process.exit(0);
    }
    // Ignore duplicate deliveries of the same keypress; only a clearly separate
    // signal (after the debounce window) forces an immediate exit.
    if (now - firstSignalAt >= FORCE_EXIT_DEBOUNCE_MS) {
      console.error(`Received ${signal} again — forcing exit.`);
      process.exit(130);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await gateway.start();
}

// Auto-start when run directly
const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) {
  main().catch((err) => {
    console.error("Gateway startup failed:", err);
    process.exit(1);
  });
}
