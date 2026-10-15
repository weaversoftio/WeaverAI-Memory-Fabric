/**
 * WAMF Gateway — Configuration management.
 *
 * Reads gateway configuration from:
 * 1. `wamf-gateway.yaml` (or JSON) in CWD or data dir
 * 2. Environment variables (override individual fields)
 *
 * Minimal config: just LLM API credentials. Everything else has sensible defaults.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getEnv } from "../utils/env.js";
import { parseConfig as parseMemoryConfig } from "../config.js";
import type { MemoryWamfConfig } from "../config.js";
import type { StandaloneLLMConfig } from "../adapters/standalone/llm-runner.js";
import { REMOVED_DB_KINDS, REMOVED_FS_KINDS, removedBackendError } from "../core/backend-selection/removed.js";

// ============================
// Gateway config types
// ============================

/**
 * Deployment mode determines how the system manages state and coordination:
 *
 * - "standalone": Open-source single-node mode.
 *     Pipeline state lives in-process (Map/setTimeout/SerialQueue).
 *     No external dependencies beyond LLM API and optional MongoDB.
 *     Suitable for single-machine / sidecar / developer setups.
 *
 * - "service": Cloud service (multi-tenant) mode.
 *     Pipeline state is externalized through IStateBackend.
 *     Timer Scanner + Pipeline Worker run inside the gateway process.
 *     Supports multi-replica coordination and HA.
 *     May require deployment-specific remote backends.
 */
export type DeployMode = "standalone" | "service";

/**
 * FS-dimension backend selection (dimension ②, symmetric to STORE_MODE for DB).
 *
 * - `local` — LocalStorageBackend (filesystem under data.baseDir)
 * - `rowfs` — ProfileRowStorageBackend over a profile-row-capable store
 *             (requires STORE_MODE whose store serves profile rows; the
 *             combination is validated at assembly, not here)
 *
 * env: `FILE_STORE_MODE`; yaml: `data.fileStore`. Default by deploy mode
 * (§5.3.1): service → rowfs, standalone → local.
 */
export type FileStoreMode = "local" | "rowfs";

/**
 * Backend for the composite's non-profile key space ("others") when
 * `fileStore === "rowfs"` (env `FILE_STORE_OTHERS` / yaml
 * `data.fileStoreOthers`). `mongofs` keeps every byte in the instance's
 * Mongo database (the zero-disk form) and is only legal with
 * STORE_MODE=mongodb — validated by the selection layer, not here.
 */
export type FileStoreOthersMode = "local" | "mongofs";

/**
 * Data-plane (DB) backend selection (env `STORE_MODE`).
 * Default by deploy mode: service → mongodb, standalone → sqlite.
 */
export type StoreMode = "sqlite" | "mongodb";

/**
 * Resolve the P9 kill switch (`WAMF_BACKEND_RESOLVER` / `features.backendResolver`).
 *
 * Default `true`: the assembly layer resolves backends through the
 * `BackendResolver` selection layer. Set to `off`/`false`/`0` to fall back to
 * the legacy global-mode branches (R1 mitigation: keep the old-branch switch). Invalid values
 * fail fast, consistent with {@link resolveFileStoreMode}.
 */
export function resolveBackendResolverFlag(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === "off" || v === "false" || v === "0") return false;
  if (v === "on" || v === "true" || v === "1") return true;
  throw new Error(
    `invalid WAMF_BACKEND_RESOLVER/features.backendResolver: ${JSON.stringify(raw)} (expected on/off)`,
  );
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  keyPrefix: string;
}

/** Per-instance config/store cache sizing (env `CONFIG_MAX_INSTANCES` / yaml `instanceCache.maxInstances`). */
export interface InstanceCacheConfig {
  maxInstances: number;
}

export interface ScannerConfig {
  instances: string;
  intervalMs: number;
  nodeId?: string;
}

export interface WorkerConfig {
  pollMs: number;
  /** Number of concurrent consumer coroutines (default: 60) */
  concurrency: number;
  /** Distributed execution lock TTL. */
  lockTtlMs?: number;
  /** Idle time before a PEL message can be taken over; must be greater than lockTtlMs. */
  pendingStaleMs?: number;
  /** PEL stale scan interval. */
  pendingRecoveryIntervalMs?: number;
  /** PEL heartbeat interval for parked/lock-free in-flight tasks. */
  parkedClaimHeartbeatMs?: number;
  /** Upper limit of scopes retrying lock acquisition at the same time. */
  lockRetryConcurrency?: number;
  /** Upper limit of lock-conflict parking; when unset, PipelineWorker computes it from the concurrency. */
  maxParkedTasks?: number;
}

export interface KafkaConfig {
  /** Whether to enable Kafka (default: false) */
  enabled: boolean;
  /** Kafka broker list (comma-separated) */
  brokers: string;
  /** Topic name (default: "memory_monitor") */
  topic: string;
  /** Consumer group ID (used by Consumers only, e.g. Monitor) */
  groupId?: string;
  /** Total number of partitions (used by Producers only, for hash partitioning) */
  totalPartitions?: number;
}

export interface OTelConfig {
  /** Whether to enable the OTel SDK (default: false) */
  enabled: boolean;
  /** Collector endpoint (default: http://localhost:4317) */
  endpoint: string;
  /** Protocol: "grpc" | "http/protobuf" (default: "grpc") */
  protocol: "grpc" | "http/protobuf";
  /** OTLP request headers, used for auth etc., in key=value format, comma-separated */
  headers?: string;
  /** Service name (default: "core") */
  serviceName: string;
  /** Service version */
  serviceVersion: string;
  /** Instance identifier */
  instanceId?: string;
  /** Zhiyan APM tenant ID */
  tenantId: string;
  /** Metric export interval (seconds, default: 60) */
  metricExportInterval?: number;
  /** Log export interval (seconds, default: 5) */
  logExportInterval: number;
}

export interface ClickHouseConfig {
  /** Whether to enable ClickHouse dual-write (default: false) */
  enabled: boolean;
  /** ClickHouse HTTP endpoint */
  endpoint: string;
  /** Username */
  username: string;
  /** Password */
  password: string;
  /** Database name */
  database: string;
  /** Target table name to write to (used by Monitor; other components may leave it empty) */
  table?: string;
  /** Maximum number of rows per batch write */
  maxBatchSize?: number;
  /** Flush interval (seconds) */
  flushInterval?: number;
  /** Maximum length of the buffer queue; data is dropped when exceeded */
  maxQueueSize?: number;
}

export interface LangfuseConfig {
  /** Whether to enable Langfuse LLM trace reporting (default: false) */
  enabled: boolean;
  /** Langfuse instance address (e.g. http://langfuse.example.local:3000) */
  host: string;
  /** Langfuse public key */
  publicKey: string;
  /** Langfuse secret key */
  secretKey: string;
}

/**
 * Observability config (unified format, shared by the four components).
 * Each component enables the sub-configs it needs; unused sub-configs just stay at enabled=false.
 *
 * Sub-configs are enabled per deployment needs; unused sub-configs just stay at enabled=false.
 *
 * yaml example:
 * ```yaml
 * observability:
 *   otel:
 *     enabled: true
 *     endpoint: "http://otel.example.com:4317"
 *     protocol: "grpc"
 *     serviceName: "core"
 *     serviceVersion: "1.0.0"
 *     tenantId: "<APM_TENANT_ID>"
 *     metricExportInterval: 60
 *     logExportInterval: 5
 *   clickhouse:
 *     enabled: true
 *     endpoint: "http://clickhouse.example.local:8123"
 *     username: "default"
 *     password: "xxx"
 *     database: "wamf_eval"
 *     maxBatchSize: 1000
 *     flushInterval: 5
 *     maxQueueSize: 10000
 *   kafka:
 *     enabled: true
 *     brokers: "kafka.example.local:9092"
 *     topic: "memory_monitor"
 *     totalPartitions: 32
 *   langfuse:
 *     enabled: true
 *     host: "http://langfuse.example.local:3000"
 *     publicKey: "pk-lf-xxx"
 *     secretKey: "sk-lf-yyy"
 * ```
 */
export interface ObservabilityConfig {
  /** OTel SDK config (Trace + Log). */
  otel: OTelConfig;
  /** ClickHouse dual-write config. */
  clickhouse: ClickHouseConfig;
  /** Kafka config. */
  kafka: KafkaConfig;
  /** Barad cloud monitoring reporting config. */
  barad?: BaradConfig;
  /** Zhiyan Monitor Metric reporting config. */
  zhiyan?: ZhiYanConfig;
  /** Langfuse LLM trace reporting config. */
  langfuse: LangfuseConfig;
}

/** Barad cloud monitoring reporting config. */
export interface BaradConfig {
  /** Whether to enable Barad reporting (default: false) */
  enabled: boolean;
  /** Reporting region, e.g. us-east-1 or your-region */
  region: string;
  /** Namespace (default: "qce/memory") */
  namespace: string;
  /** Reporting frequency (seconds) (default: 60) */
  freq: number;
  /** Test-environment reporting address (overrides the default region-based address) */
  testEndpoint?: string;
  /** Test-environment query address (used by integration tests to verify data) */
  testQueryEndpoint?: string;
  /** Collection interval (seconds) (default: 10) */
  collectInterval?: number;
}

/** Zhiyan Monitor Metric reporting config. Components used: Monitor (yes) */
export interface ZhiYanConfig {
  /** Whether to enable Zhiyan Metric reporting (default: false) */
  enabled: boolean;
  /** Zhiyan Monitor reporting address */
  endpoint: string;
  /** Application identifier (required by Zhiyan Monitor), format: {business ID}_{app ID}_{app name} */
  appMark: string;
  /** Group name (default: "default") */
  group: string;
  /** Environment identifier, e.g. dev/test/prod */
  env: string;
  /** Metric namespace prefix (default: "memory") */
  namespace: string;
  /** Reporting interval (seconds) (default: 60) */
  exportInterval: number;
}

export interface GatewayConfig {
  /**
   * Deployment mode. Default: "standalone".
   *
   * env: WAMF_DEPLOY_MODE=standalone|service
   * yaml: deployMode: service
   */
  deployMode: DeployMode;
  server: {
    port: number;
    host: string;
    /**
     * Optional API token for HTTP authentication.
     *
     * When set (non-empty string), every route except `GET /health` and CORS
     * preflight (`OPTIONS *`) requires an `Authorization: Bearer <apiKey>`
     * header. Requests without a valid token receive HTTP 401.
     *
     * **Default: undefined** — authentication is disabled, all routes are
     * open (preserves legacy behaviour). A WARN is emitted at startup if the
     * gateway binds to a non-loopback host without an API key set, to avoid
     * silently exposing an unauthenticated endpoint to the network.
     *
     * env: `WAMF_GATEWAY_API_KEY`
     * yaml: `server.apiKey`
     */
    apiKey?: string;
    /**
     * Optional CORS allow-list.
     *
     * When empty (default), the gateway sends **no** `Access-Control-Allow-*`
     * headers and rejects CORS preflight (`OPTIONS`) with 403 if an `Origin`
     * header is present — browsers will then block all cross-origin requests
     * via same-origin policy.
     *
     * When set, each request's `Origin` is matched against this list and
     * `Access-Control-Allow-Origin` is echoed back only on match. Use the
     * single entry `"*"` to restore the legacy permissive behaviour (only
     * appropriate for local development).
     *
     * env: `WAMF_CORS_ORIGINS` (comma-separated)
     * yaml: `server.corsOrigins` (string[])
     */
    corsOrigins: string[];
  };
  data: {
    /** Base directory for WAMF data storage. */
    baseDir: string;
    /**
     * FS-dimension backend switch (env `FILE_STORE_MODE` / yaml `data.fileStore`).
     * Always resolved (default applied by deploy mode, §5.3.1).
     */
    fileStore: FileStoreMode;
    /**
     * Rowfs "others" switch (env `FILE_STORE_OTHERS` / yaml
     * `data.fileStoreOthers`). Always resolved; only consumed when
     * `fileStore === "rowfs"`.
     */
    fileStoreOthers: FileStoreOthersMode;
  };
  features: {
    /**
     * P9: route store/storage assembly through the BackendResolver selection
     * layer. `false` → legacy global-mode branches (rollback switch).
     *
     * env: `WAMF_BACKEND_RESOLVER` (on/off); yaml: `features.backendResolver`.
     * Default: true.
     */
    backendResolver: boolean;
  };
  llm: StandaloneLLMConfig;
  /** Parsed memory-wamf plugin config (recall, capture, extraction, pipeline, etc.). */
  memory: MemoryWamfConfig;

  /**
   * Optional Skill module config — passed through to MemoryWamfConfig.skill
   * at load time. Kept at the top level here so gateway-only deployments
   * can configure skills without nesting under `memory.skill`. The loader
   * shallow-merges this onto `memory.skill` (yaml top-level wins).
   */
  skill?: import("../core/skill/types.js").SkillConfigInput;

  // ── Service-mode config (also settable via env vars, env takes priority) ──

  /** State backend type. env: STATE_BACKEND. yaml: stateBackend */
  stateBackend?: "redis" | "local";
  /** Default instance ID for standalone pipeline. env: WAMF_INSTANCE_ID. yaml: instanceId */
  instanceId: string;
  redis: RedisConfig;
  instanceCache: InstanceCacheConfig;
  scanner: ScannerConfig;
  worker: WorkerConfig;
  /** Observability config (yaml: observability, env: KAFKA_METRIC_*) */
  observability: ObservabilityConfig;
  /**
   * Metadata module config (env takes precedence over yaml; see applyMetadataEnvFromGatewayConfig).
   * yaml: metadata.*
   * env: WAMF_METADATA_*
   */
  metadata: GatewayMetadataConfig;
  /**
   * Analytics query module config (reads usage/session/tool-call data from the Proxy-side ClickHouse).
   * Fully independent of observability.clickhouse (OTel export to wamf_eval).
   *
   * env: ANALYTICS_CLICKHOUSE_*
   * yaml: analytics.clickhouse.*
   */
  analytics?: {
    clickhouse: ClickHouseConfig;
  };
  /** Offload server executor config (yaml: offload) */
  offload: {
    forceTriggerThreshold: number;
    pendingMaxAgeSeconds: number;
    l1Temperature: number;
    l1MaxTokens: number;
    l1TimeoutMs: number;
    l15Temperature: number;
    l15MaxTokens: number;
    l15TimeoutMs: number;
    l2Temperature: number;
    l2MaxTokens: number;
    l2TimeoutMs: number;
    l2NullThreshold: number;
    mildOffloadRatio: number;
    aggressiveCompressRatio: number;
    emergencyCompressRatio: number;
    maxRetries: number;
  };
}

/** v3 metadata Gateway yaml config (section 6.3). */
export interface GatewayMetadataStoreConfig {
  sqliteBaseDir?: string;
  mongoUri?: string;
  mongoTransactions?: boolean;
  storeCacheMaxInstances?: number;
  /** Metadata database name prefix, default wamf_metadata; database name is {prefix}_{instance_id} */
  mongoDbPrefix?: string;
}

export interface GatewayMemorySystemUserConfig {
  userId?: string;
  displayName?: string;
  userKey?: string;
}

export interface GatewayMetadataSystemUserConfig {
  memory?: GatewayMemorySystemUserConfig;
}

export interface GatewayMetadataConfig {
  maxUsersPerInstance: number;
  maxTeamsPerInstance: number;
  configParamsFile?: string;
  store?: GatewayMetadataStoreConfig;
  /** Internal static system user (auth/verify only; not persisted). */
  systemUser?: GatewayMetadataSystemUserConfig;
}

// ============================
// Config loading
// ============================

// ============================
// Utility Functions
// ============================

/**
 * Convert the Kafka brokers config value into a string[] array.
 *
 * Background: in the gateway config KafkaConfig.brokers is typed as string (comma-separated),
 * but MetricBackendConfig.brokers expects string[]. If the string is passed directly,
 * KafkaJS parses it per character and the port number becomes NaN.
 *
 * @param brokers - comma-separated broker address string, or already a string[] array
 * @returns array of broker addresses (trimmed, empty elements filtered out)
 */
export function parseBrokers(brokers: string | string[]): string[] {
  if (Array.isArray(brokers)) return brokers;
  if (!brokers) return [];
  return brokers.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Resolve the FS-dimension switch (`FILE_STORE_MODE` / `data.fileStore`).
 *
 * Semantics (design doc §5.3.1, finalized 2026-08-31):
 * - unset → default by deploy mode: service → `rowfs`, standalone → `local`;
 * - set to a valid value → that value wins over the default;
 * - set to a removed backend → fail-fast with a "backend removed" error;
 * - set to anything else → config parse failure, fail-fast (throw).
 */
export function resolveFileStoreMode(
  raw: string | undefined,
  deployMode: DeployMode,
): FileStoreMode {
  if (raw === undefined) return deployMode === "service" ? "rowfs" : "local";
  if (raw === "local" || raw === "rowfs") return raw;
  if (REMOVED_FS_KINDS.includes(raw)) {
    throw removedBackendError("FILE_STORE_MODE/data.fileStore", raw, "fs");
  }
  throw new Error(
    `invalid FILE_STORE_MODE/data.fileStore: ${JSON.stringify(raw)} (expected "local" | "rowfs")`,
  );
}

/**
 * Resolve the rowfs "others" switch (`FILE_STORE_OTHERS` /
 * `data.fileStoreOthers`). Only meaningful with `fileStore === "rowfs"`;
 * same semantics as {@link resolveFileStoreMode}: unset → per-mode default,
 * invalid → fail-fast. The `mongofs × STORE_MODE` legality check happens in
 * the selection layer (`validateResolution`), not here.
 */
export function resolveFileStoreOthersMode(
  raw: string | undefined,
  deployMode: DeployMode,
): FileStoreOthersMode {
  if (raw === undefined) return deployMode === "service" ? "mongofs" : "local";
  if (raw === "local" || raw === "mongofs") return raw;
  if (REMOVED_FS_KINDS.includes(raw)) {
    throw removedBackendError("FILE_STORE_OTHERS/data.fileStoreOthers", raw, "fs", `"local" (default) or "mongofs"`);
  }
  throw new Error(
    `invalid FILE_STORE_OTHERS/data.fileStoreOthers: ${JSON.stringify(raw)} (expected "local" | "mongofs")`,
  );
}

/**
 * Resolve the explicit data-plane override (`STORE_MODE`).
 *
 * - unset / empty → `undefined` (the caller applies the deploy-mode default);
 * - `sqlite` / `mongodb` → that value;
 * - a removed backend → fail-fast with a "backend removed" error;
 * - anything else → fail-fast (throw).
 */
export function resolveStoreModeOverride(raw: string | undefined): StoreMode | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  if (v === "sqlite" || v === "mongodb") return v;
  if (REMOVED_DB_KINDS.includes(v)) {
    throw removedBackendError("STORE_MODE", v, "db");
  }
  throw new Error(`invalid STORE_MODE: ${JSON.stringify(raw)} (expected "sqlite" | "mongodb")`);
}

/**
 * Overrides accepted by {@link loadGatewayConfig} / the WamfGateway constructor.
 *
 * `server` / `data` / `llm` are merged one level deep onto the parsed base
 * (see the merge at the end of loadGatewayConfig), so callers may pass partial
 * nested blocks — e.g. `data: { baseDir }` keeps the resolved `fileStore`
 * default. Typing them as nested Partial makes the type match the runtime
 * merge behaviour.
 */
export type GatewayConfigOverrides = Omit<Partial<GatewayConfig>, "server" | "data" | "llm" | "features"> & {
  server?: Partial<GatewayConfig["server"]>;
  data?: Partial<GatewayConfig["data"]>;
  features?: Partial<GatewayConfig["features"]>;
  llm?: Partial<GatewayConfig["llm"]>;
};

/**
 * Load gateway config from file + environment variables.
 *
 * Resolution order for config file:
 * 1. `WAMF_GATEWAY_CONFIG` env var (explicit path)
 * 2. `./wamf-gateway.yaml` or `./wamf-gateway.json` in CWD
 * 3. `<dataDir>/wamf-gateway.yaml` or `<dataDir>/wamf-gateway.json`
 * 4. Pure environment-variable config (no file)
 */
export function loadGatewayConfig(overrides?: GatewayConfigOverrides): GatewayConfig {
  let fileConfig: Record<string, unknown> = {};

  // Try to load config file
  const configPath = resolveConfigPath();
  if (configPath) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      if (configPath.endsWith(".json")) {
        fileConfig = JSON.parse(raw);
      } else {
      // Full YAML support (arbitrary nesting, anchors, lists, multi-line).
        // We still postprocess ${VAR} env-var interpolation on string leaves
        // below so existing configs that relied on the previous simple parser
        // keep working.
        const parsed = YAML.parse(raw);
        fileConfig = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          ? parsed as Record<string, unknown>
          : {};
      }
      fileConfig = expandEnvVars(fileConfig) as Record<string, unknown>;
    } catch {
      // Config file is optional — malformed files fall back to env-only config.
    }
  }

  // Server config
  const serverConfig = obj(fileConfig, "server");
  const port = envInt("WAMF_GATEWAY_PORT") ?? num(serverConfig, "port") ?? 8420;
  const host = env("WAMF_GATEWAY_HOST") ?? str(serverConfig, "host") ?? "127.0.0.1";

  // Optional auth / CORS — both default to "disabled" so existing setups keep
  // working unchanged. When unset the gateway behaves exactly like before this
  // change (open v1 routes, permissive CORS *will not* be re-introduced — see
  // resolveCorsOrigins below: empty list means "send no CORS headers").
  const apiKey = env("WAMF_GATEWAY_API_KEY") ?? str(serverConfig, "apiKey");
  const corsOrigins = resolveCorsOrigins(serverConfig);

  // Data config (expand leading ~ to $HOME so Node.js fs/path can resolve it)
  const dataConfig = obj(fileConfig, "data");
  const rawBaseDir = env("WAMF_DATA_DIR") ?? str(dataConfig, "baseDir") ?? resolveDefaultDataDir();
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";
  const baseDir = rawBaseDir.startsWith("~/") ? path.join(home, rawBaseDir.slice(2)) : rawBaseDir;

  // LLM config
  //
  // provider supports two modes:
  //   - "openai" (default): connect directly to an OpenAI-compatible service
  //   - "proxy": go through context_proxy; at runtime baseUrl is assembled into `${baseUrl}/proxy/<iid>/v1`,
  //             Authorization uses the memory system-user key. The gateway layer does the final resolution,
  //             see resolveEffectiveLlmConfig in src/gateway/llm-resolver.ts.
  const llmConfig = obj(fileConfig, "llm");
  const llmProxyConfig = obj(llmConfig, "proxy");
  const rawLlmProvider = env("WAMF_LLM_PROVIDER") ?? str(llmConfig, "provider");
  const llmProvider: "openai" | "proxy" =
    rawLlmProvider === "proxy" ? "proxy" : "openai";
  const llm: StandaloneLLMConfig = {
    baseUrl: env("WAMF_LLM_BASE_URL") ?? str(llmConfig, "baseUrl") ?? "https://api.openai.com/v1",
    apiKey: env("WAMF_LLM_API_KEY") ?? str(llmConfig, "apiKey") ?? "",
    model: env("WAMF_LLM_MODEL") ?? str(llmConfig, "model") ?? "gpt-4o",
    maxTokens: envInt("WAMF_LLM_MAX_TOKENS") ?? num(llmConfig, "maxTokens") ?? 4096,
    timeoutMs: envInt("WAMF_LLM_TIMEOUT_MS") ?? num(llmConfig, "timeoutMs") ?? 120_000,
    provider: llmProvider,
    proxy: {
      useMemorySystemUserKey: bool(llmProxyConfig, "useMemorySystemUserKey") ?? true,
    },
    // When env is present, use env directly (yaml can be explicitly disabled);
    // only fall back to yaml when env is unset, consistent with other LLM fields.
    stream: (() => {
      const envVal = env("WAMF_LLM_STREAM");
      if (envVal !== undefined) return envVal === "true";
      return bool(llmConfig, "stream") ?? false;
    })(),
  };

  // Memory config (reuse the plugin's parseConfig for full compatibility)
  const memoryRaw = obj(fileConfig, "memory");
  const topLevelPromptMode = str(fileConfig, "promptMode") ?? str(obj(fileConfig, "prompts"), "mode");
  const memoryCompatRaw: Record<string, unknown> = { ...memoryRaw };
  if (!str(memoryCompatRaw, "promptMode") && topLevelPromptMode) {
    memoryCompatRaw.promptMode = topLevelPromptMode;
  }
  const memory = parseMemoryConfig(memoryCompatRaw);

  // ── Standalone LLM override pass-through to MemoryWamfConfig.llm ──
  // The gateway has its own top-level `llm` block (read above into the
  // `llm` variable), and `parseMemoryConfig` ALSO has a `memory.llm` block
  // that defaults to enabled=false. When the gateway's top-level llm is
  // configured (baseUrl + apiKey), splice it onto memory.llm so the
  // SkillExtractor / L1 / L2 / L3 runners see a usable runner without
  // requiring the user to duplicate the block under `memory.llm`.
  // In provider=proxy mode, splice even if apiKey is empty -- because the final apiKey is provided by
  // memory systemUser.userKey; llm.apiKey is only an explicit config when provider=openai.
  const shouldSpliceLlm =
    !memory.llm.enabled && llm.baseUrl && (llm.apiKey || llm.provider === "proxy");
  if (shouldSpliceLlm) {
    memory.llm = {
      enabled: true,
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: llm.model,
      maxTokens: llm.maxTokens ?? 4096,
      timeoutMs: llm.timeoutMs ?? 120_000,
      provider: llm.provider,
      proxy: {
        useMemorySystemUserKey: llm.proxy?.useMemorySystemUserKey ?? true,
      },
    };
  }

  // ── Standalone embedding override pass-through ──
  // Some existing gateway configs place `embedding` at the top level next to
  // `llm`. The memory parser expects it under `memory.embedding`, so splice the
  // top-level block into MemoryWamfConfig for backward compatibility.
  const topLevelEmbedding = obj(fileConfig, "embedding");
  if (topLevelEmbedding) {
    memory.embedding = {
      ...memory.embedding,
      enabled: bool(topLevelEmbedding, "enabled") ?? memory.embedding.enabled,
      provider: str(topLevelEmbedding, "provider") ?? memory.embedding.provider,
      baseUrl: str(topLevelEmbedding, "baseUrl") ?? memory.embedding.baseUrl,
      apiKey: str(topLevelEmbedding, "apiKey") ?? memory.embedding.apiKey,
      model: str(topLevelEmbedding, "model") ?? memory.embedding.model,
      dimensions: num(topLevelEmbedding, "dimensions") ?? memory.embedding.dimensions,
      sendDimensions: bool(topLevelEmbedding, "sendDimensions") ?? memory.embedding.sendDimensions,
      conflictRecallTopK: num(topLevelEmbedding, "conflictRecallTopK") ?? memory.embedding.conflictRecallTopK,
      maxInputChars: num(topLevelEmbedding, "maxInputChars") ?? memory.embedding.maxInputChars,
      timeoutMs: num(topLevelEmbedding, "timeoutMs") ?? memory.embedding.timeoutMs,
      recallTimeoutMs: num(topLevelEmbedding, "recallTimeoutMs") ?? memory.embedding.recallTimeoutMs,
      captureTimeoutMs: num(topLevelEmbedding, "captureTimeoutMs") ?? memory.embedding.captureTimeoutMs,
      proxyUrl: str(topLevelEmbedding, "proxyUrl") ?? memory.embedding.proxyUrl,
    };
  }

  // ── Skill module config ──
  // Resolution order:
  //   1. Top-level `skill` block in yaml (preferred — skill is a top-level
  //      gateway feature, not buried under `memory`).
  //   2. `memory.skill` (if user nested it under memory by accident).
  //   3. env var WAMF_SKILL_ENABLED forces enabled=true so a one-line
  //      shell flag opts in without touching yaml.
  // The result is *also* spliced onto memory.skill so WamfCore (which reads
  // from cfg.skill in its config) sees it regardless of which path wired it.
  const topLevelSkill = (fileConfig.skill && typeof fileConfig.skill === "object" && !Array.isArray(fileConfig.skill))
    ? (fileConfig.skill as import("../core/skill/types.js").SkillConfigInput)
    : undefined;
  const envSkillEnabled = env("WAMF_SKILL_ENABLED");
  const skillFromAnywhere: import("../core/skill/types.js").SkillConfigInput | undefined =
    topLevelSkill ?? memory.skill ?? (envSkillEnabled === "true" || envSkillEnabled === "1" ? { enabled: true } : undefined);
  if (skillFromAnywhere) {
    // Last write wins: env-only override forces enabled=true on top of yaml.
    if (envSkillEnabled === "true" || envSkillEnabled === "1") {
      skillFromAnywhere.enabled = true;
    }
    memory.skill = skillFromAnywhere;
  }

  // Deploy mode: "standalone" (open-source single-node) or "service" (cloud multi-tenant)
  const rawMode = env("WAMF_DEPLOY_MODE") ?? str(fileConfig, "deployMode") ?? "standalone";
  const deployMode: DeployMode = rawMode === "service" ? "service" : "standalone";

  // FS-dimension switch (dimension ②). env > yaml > deploy-mode default.
  // An explicitly-set but invalid value is a config parse failure → fail-fast
  // (§5.3.1 rule 2); the rowfs × store-mode combination check happens at
  // assembly time (D8③), not here.
  const fileStore = resolveFileStoreMode(
    env("FILE_STORE_MODE") ?? str(dataConfig, "fileStore"),
    deployMode,
  );
  const fileStoreOthers = resolveFileStoreOthersMode(
    env("FILE_STORE_OTHERS") ?? str(dataConfig, "fileStoreOthers"),
    deployMode,
  );

  // P9 kill switch: assembly via BackendResolver (default) vs legacy branches.
  const featuresConfig = obj(fileConfig, "features");
  const backendResolver = resolveBackendResolverFlag(
    env("WAMF_BACKEND_RESOLVER") ?? (bool(featuresConfig, "backendResolver") === false ? "off" : undefined),
  );

  // State backend (env > yaml > auto from deployMode)
  const rawBackend = env("STATE_BACKEND") ?? str(fileConfig, "stateBackend");
  const stateBackend = rawBackend === "redis" || rawBackend === "local" ? rawBackend : undefined;

  // Instance ID: service mode requires explicit instanceId from request headers (x-wamf-service-id),
  // standalone mode uses configured or defaults to "default".
  const instanceId = env("WAMF_INSTANCE_ID") ?? str(fileConfig, "instanceId")
    ?? (deployMode === "standalone" ? "default" : undefined);

  // Remote state backend config
  const redisConfig = obj(fileConfig, "redis");
  const redis: RedisConfig = {
    host: env("REDIS_HOST") ?? str(redisConfig, "host") ?? "127.0.0.1",
    port: envInt("REDIS_PORT") ?? num(redisConfig, "port") ?? 6379,
    password: env("REDIS_PASSWORD") ?? str(redisConfig, "password"),
    db: envInt("REDIS_DB") ?? num(redisConfig, "db") ?? 0,
    // v2 default prefix: physically isolated from the pre-upgrade "wamf_memory".
    // Reason for the upgrade: the hash tag of sk/bk went from {p:inst} to {p:inst:tid:aid},
    // old keys and new keys are not mutually exclusive, and mixed running would break the lock mutual-exclusion semantics; switching prefix isolates them physically,
    // and old data is discarded. If pending tasks in redis must be preserved on upgrade, stop the service first + wait for the queue to drain.
    keyPrefix: env("REDIS_KEY_PREFIX") ?? str(redisConfig, "keyPrefix") ?? "wamf_memory_v2",
  };

  // Per-instance cache sizing
  const instanceCacheConfig = obj(fileConfig, "instanceCache");
  const instanceCache: InstanceCacheConfig = {
    maxInstances: envInt("CONFIG_MAX_INSTANCES") ?? num(instanceCacheConfig, "maxInstances") ?? 1000,
  };

  // Scanner config
  const scannerConfig = obj(fileConfig, "scanner");
  const scanner: ScannerConfig = {
    instances: env("SCANNER_INSTANCES") ?? str(scannerConfig, "instances") ?? "default",
    intervalMs: envInt("SCANNER_INTERVAL_MS") ?? num(scannerConfig, "intervalMs") ?? 500,
    nodeId: env("SCANNER_NODE_ID") ?? str(scannerConfig, "nodeId"),
  };

  // Worker config
  const workerConfig = obj(fileConfig, "worker");
  const worker: WorkerConfig = {
    pollMs: envInt("WORKER_POLL_MS") ?? num(workerConfig, "pollMs") ?? 200,
    concurrency: envInt("WORKER_CONCURRENCY") ?? num(workerConfig, "concurrency") ?? 60,
    lockTtlMs: envInt("WORKER_LOCK_TTL_MS") ?? num(workerConfig, "lockTtlMs"),
    pendingStaleMs: envInt("WORKER_PENDING_STALE_MS") ?? num(workerConfig, "pendingStaleMs"),
    pendingRecoveryIntervalMs: envInt("WORKER_PENDING_RECOVERY_INTERVAL_MS") ?? num(workerConfig, "pendingRecoveryIntervalMs"),
    parkedClaimHeartbeatMs: envInt("WORKER_PARKED_HEARTBEAT_MS") ?? num(workerConfig, "parkedClaimHeartbeatMs"),
    lockRetryConcurrency: envInt("WORKER_LOCK_RETRY_CONCURRENCY") ?? num(workerConfig, "lockRetryConcurrency"),
    maxParkedTasks: envInt("WORKER_MAX_PARKED_TASKS") ?? num(workerConfig, "maxParkedTasks"),
  };

  // Observability config (yaml: observability.{otel,clickhouse,kafka}, env fallback)
  const observabilityConfig = obj(fileConfig, "observability");

  // OTel config
  const otelConfig = obj(observabilityConfig, "otel");
  const otel: OTelConfig = {
    enabled: otelConfig.enabled !== undefined
      ? Boolean(otelConfig.enabled)
      : env("WAMF_OTEL_ENABLED") === "true",
    endpoint: str(otelConfig, "endpoint") ?? env("OTEL_EXPORTER_OTLP_ENDPOINT") ?? "http://localhost:4317",
    protocol: (str(otelConfig, "protocol") ?? env("OTEL_EXPORTER_OTLP_PROTOCOL") ?? "grpc") as "grpc" | "http/protobuf",
    serviceName: str(otelConfig, "serviceName") ?? env("OTEL_SERVICE_NAME") ?? "core",
    serviceVersion: str(otelConfig, "serviceVersion") ?? "1.0.0",
    tenantId: str(otelConfig, "tenantId") ?? env("OTEL_TENANT_ID") ?? "",
    logExportInterval: num(otelConfig, "logExportInterval") ?? envInt("OTEL_LOG_EXPORT_INTERVAL") ?? 5,
  };

  // ClickHouse config
  const chConfig = obj(observabilityConfig, "clickhouse");
  const clickhouse: ClickHouseConfig = {
    enabled: chConfig.enabled !== undefined
      ? Boolean(chConfig.enabled)
      : env("CLICKHOUSE_ENABLED") === "true",
    endpoint: str(chConfig, "endpoint") ?? env("CLICKHOUSE_ENDPOINT") ?? "",
    username: str(chConfig, "username") ?? env("CLICKHOUSE_USERNAME") ?? "default",
    password: str(chConfig, "password") ?? env("CLICKHOUSE_PASSWORD") ?? "",
    database: str(chConfig, "database") ?? env("CLICKHOUSE_DATABASE") ?? "wamf_eval",
  };

  // Analytics ClickHouse config (reads Proxy CH — independent from observability CH)
  const analyticsYaml = obj(fileConfig, "analytics");
  const analyticsChYaml = obj(analyticsYaml, "clickhouse");
  const analyticsChEnabledEnv = env("ANALYTICS_CLICKHOUSE_ENABLED");
  const analyticsClickhouse: ClickHouseConfig = {
    enabled: analyticsChEnabledEnv !== undefined
      ? analyticsChEnabledEnv === "true"
      : analyticsChYaml.enabled !== undefined
        ? Boolean(analyticsChYaml.enabled)
        : false,
    endpoint: env("ANALYTICS_CLICKHOUSE_ENDPOINT") ?? str(analyticsChYaml, "endpoint") ?? "",
    username: env("ANALYTICS_CLICKHOUSE_USERNAME") ?? str(analyticsChYaml, "username") ?? "default",
    password: env("ANALYTICS_CLICKHOUSE_PASSWORD") ?? str(analyticsChYaml, "password") ?? "",
    database: env("ANALYTICS_CLICKHOUSE_DATABASE") ?? str(analyticsChYaml, "database") ?? "context_proxy",
  };

  // Kafka config
  const kafkaConfig = obj(observabilityConfig, "kafka");
  const kafka: KafkaConfig = {
    brokers: str(kafkaConfig, "brokers") ?? env("KAFKA_METRIC_BROKERS") ?? "",
    topic: str(kafkaConfig, "topic") ?? env("KAFKA_METRIC_TOPIC") ?? "memory_monitor",
    enabled: kafkaConfig.enabled !== undefined
      ? Boolean(kafkaConfig.enabled)
      : (env("KAFKA_METRIC_ENABLED") === "true" || Boolean(str(kafkaConfig, "brokers") ?? env("KAFKA_METRIC_BROKERS"))),
  };

  // Langfuse config
  const langfuseConfig = obj(observabilityConfig, "langfuse");
  const langfuse: LangfuseConfig = {
    enabled: langfuseConfig.enabled !== undefined
      ? Boolean(langfuseConfig.enabled)
      : env("LANGFUSE_ENABLED") === "true",
    host: str(langfuseConfig, "host") ?? env("LANGFUSE_HOST") ?? "",
    publicKey: str(langfuseConfig, "publicKey") ?? env("LANGFUSE_PUBLIC_KEY") ?? "",
    secretKey: str(langfuseConfig, "secretKey") ?? env("LANGFUSE_SECRET_KEY") ?? "",
  };

  const observability: ObservabilityConfig = { otel, clickhouse, kafka, langfuse };

  // Offload executor config (yaml: offload)
  const metadataConfig = obj(fileConfig, "metadata");
  const storeYaml = obj(metadataConfig, "store");
  const systemUserYaml = obj(metadataConfig, "systemUser");
  const memorySystemUserYaml = obj(systemUserYaml, "memory");
  const metadataStore: GatewayMetadataStoreConfig | undefined =
    str(storeYaml, "sqliteBaseDir") || str(storeYaml, "mongoUri") ||
    str(storeYaml, "mongoDbPrefix") ||
    bool(storeYaml, "mongoTransactions") !== undefined || num(storeYaml, "storeCacheMaxInstances") !== undefined
      ? {
          sqliteBaseDir: str(storeYaml, "sqliteBaseDir"),
          mongoUri: str(storeYaml, "mongoUri"),
          mongoTransactions: bool(storeYaml, "mongoTransactions") ?? true,
          storeCacheMaxInstances: num(storeYaml, "storeCacheMaxInstances"),
          mongoDbPrefix: str(storeYaml, "mongoDbPrefix"),
        }
      : undefined;
  const metadata: GatewayMetadataConfig = {
    maxUsersPerInstance: positiveQuotaLimit(
      envInt("WAMF_METADATA_MAX_USERS") ?? num(metadataConfig, "maxUsersPerInstance"),
      500,
    ),
    maxTeamsPerInstance: positiveQuotaLimit(
      envInt("WAMF_METADATA_MAX_TEAMS") ?? num(metadataConfig, "maxTeamsPerInstance"),
      100,
    ),
    configParamsFile: process.env.WAMF_METADATA_CONFIG_PARAMS_FILE || str(metadataConfig, "configParamsFile") || undefined,
    store: metadataStore,
    systemUser: str(memorySystemUserYaml, "userId") || str(memorySystemUserYaml, "userKey") ||
      str(memorySystemUserYaml, "displayName")
      ? {
          memory: {
            userId: str(memorySystemUserYaml, "userId"),
            displayName: str(memorySystemUserYaml, "displayName"),
            userKey: str(memorySystemUserYaml, "userKey"),
          },
        }
      : undefined,
  };

  const offloadConfig = obj(fileConfig, "offload");
  const offload = {
    forceTriggerThreshold: num(offloadConfig, "forceTriggerThreshold") ?? 4,
    pendingMaxAgeSeconds: num(offloadConfig, "pendingMaxAgeSeconds") ?? 30,
    l1Temperature: num(offloadConfig, "l1Temperature") ?? 0.3,
    l1MaxTokens: num(offloadConfig, "l1MaxTokens") ?? 8000,
    l1TimeoutMs: num(offloadConfig, "l1TimeoutMs") ?? 120_000,
    l15Temperature: num(offloadConfig, "l15Temperature") ?? 0.2,
    l15MaxTokens: num(offloadConfig, "l15MaxTokens") ?? 3000,
    l15TimeoutMs: num(offloadConfig, "l15TimeoutMs") ?? 120_000,
    l2Temperature: num(offloadConfig, "l2Temperature") ?? 0.4,
    l2MaxTokens: num(offloadConfig, "l2MaxTokens") ?? 16000,
    l2TimeoutMs: num(offloadConfig, "l2TimeoutMs") ?? 120_000,
    l2NullThreshold: num(offloadConfig, "l2NullThreshold") ?? 6,
    mildOffloadRatio: num(offloadConfig, "mildOffloadRatio") ?? 0.5,
    aggressiveCompressRatio: num(offloadConfig, "aggressiveCompressRatio") ?? 0.85,
    emergencyCompressRatio: num(offloadConfig, "emergencyCompressRatio") ?? 0.95,
    maxRetries: num(offloadConfig, "maxRetries") ?? 3,
  };

  const base: GatewayConfig = {
    deployMode,
    stateBackend,
    instanceId,
    server: { port, host, apiKey, corsOrigins },
    data: { baseDir, fileStore, fileStoreOthers },
    features: { backendResolver },
    llm,
    memory,
    redis,
    instanceCache,
    scanner,
    worker,
    observability,
    analytics: { clickhouse: analyticsClickhouse },
    metadata,
    offload,
    skill: skillFromAnywhere,
  };

  // Merge overrides one level deep so partial `server`/`data`/`llm` patches
  // (frequently used by e2e tests) don't accidentally drop sibling fields
  // such as `corsOrigins` introduced after they were written.
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    server: { ...base.server, ...(overrides.server ?? {}) },
    data: { ...base.data, ...(overrides.data ?? {}) },
    features: { ...base.features, ...(overrides.features ?? {}) },
    llm: { ...base.llm, ...(overrides.llm ?? {}) },
  };
}

// ============================
// Helpers
// ============================

function resolveConfigPath(): string | null {
  // 1. Explicit env var
  const explicit = getEnv("WAMF_GATEWAY_CONFIG")?.trim();
  if (explicit && fs.existsSync(explicit)) return explicit;

  // 2. CWD
  for (const name of ["wamf-gateway.yaml", "wamf-gateway.json"]) {
    const p = path.join(process.cwd(), name);
    if (fs.existsSync(p)) return p;
  }

  // 3. Default data dir
  const dataDir = resolveDefaultDataDir();
  for (const name of ["wamf-gateway.yaml", "wamf-gateway.json"]) {
    const p = path.join(dataDir, name);
    if (fs.existsSync(p)) return p;
  }

  return null;
}

function resolveDefaultDataDir(): string {
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";

  // New canonical location: everything related to standalone/Hermes-mode WAMF
  // is collected under ~/.weaverai-memory-fabric/ to avoid scattering top-level dirs
  // in $HOME. The Gateway data dir lives at:
  //
  //   ~/.weaverai-memory-fabric/memory-wamf/
  //
  // Note: this only governs the standalone/Hermes fallback. Under the openclaw
  // host the plugin data dir is decided by `resolveStateDir() + "memory-wamf"`
  // (typically ~/.openclaw/memory-wamf/) which is intentionally NOT changed.
  const root = getEnv("MEMORY_WEAVERAI_ROOT") ?? path.join(home, ".memory-weaverai");
  const newDefault = path.join(root, "memory-wamf");

  // Backward compatibility: if the new location does not yet exist but the
  // legacy ~/memory-wamf still has data, keep using the legacy dir so existing
  // users don't silently lose their memory store. The install script
  // (install_hermes_memory_weaverai.sh, Step 0) will migrate it on next run.
  try {
    if (!fs.existsSync(newDefault)) {
      const legacy = path.join(home, "memory-wamf");
      if (fs.existsSync(legacy)) {
        // Stderr-only deprecation hint; doesn't pollute structured logs.
        process.stderr.write(
          `[wamf-gateway] DEPRECATED: using legacy data dir ${legacy}; ` +
          `move it to ${newDefault} (or set WAMF_DATA_DIR / MEMORY_WEAVERAI_ROOT) to silence this warning.\n`,
        );
        return legacy;
      }
    }
  } catch {
    // existsSync should not throw, but guard anyway.
  }

  return newDefault;
}

function env(key: string): string | undefined {
  const v = getEnv(key)?.trim();
  return v || undefined;
}

function envInt(key: string): number | undefined {
  const v = env(key);
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function obj(c: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = c[key];
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function str(src: Record<string, unknown>, key: string): string | undefined {
  const v = src[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(src: Record<string, unknown>, key: string): number | undefined {
  const v = src[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function positiveQuotaLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 ? value : fallback;
}

function bool(src: Record<string, unknown>, key: string): boolean | undefined {
  const v = src[key];
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Read `server.corsOrigins` from yaml or `WAMF_CORS_ORIGINS` from env.
 *
 * Accepted yaml shapes (yaml has precedence over env):
 *   server:
 *     corsOrigins: []                              # explicit empty → no CORS
 *     corsOrigins: ["https://app.example.com"]     # array of allowed origins
 *     corsOrigins: "https://a,https://b"           # comma-separated string
 *
 * Env: `WAMF_CORS_ORIGINS="https://a,https://b"`
 *
 * Returns `[]` when nothing is set — the server interprets that as
 * "do not emit any CORS headers" (most restrictive default).
 */
function resolveCorsOrigins(serverConfig: Record<string, unknown>): string[] {
  // 1. YAML takes precedence so an explicit `corsOrigins: []` can mean
  //    "I want CORS off" even when the env var leaks in from the shell.
  const raw = serverConfig["corsOrigins"];
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map(s => s.trim());
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",").map(s => s.trim()).filter(Boolean);
  }

  // 2. Fall back to env. Empty string from env is treated as "not set".
  const envValue = env("WAMF_CORS_ORIGINS");
  if (!envValue) return [];
  return envValue.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Recursively replace ``${VAR_NAME}`` placeholders in string leaves with
 * the corresponding ``process.env`` value. Missing variables expand to an
 * empty string, matching the behaviour of the previous simple YAML parser
 * so existing configs keep working after the switch to the full YAML lib.
 *
 * - Only whole-string matches (``"${VAR}"``) are substituted, preserving
 *   types: numbers/booleans/null pass through unchanged.
 * - Arrays and nested objects are walked in-place (new arrays/objects are
 *   returned; the input is not mutated).
 */
function expandEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    const m = value.match(/^\$\{(\w+)\}$/);
    if (m) {
      return process.env[m[1]!] ?? "";
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(expandEnvVars);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvVars(v);
    }
    return out;
  }
  return value;
}
