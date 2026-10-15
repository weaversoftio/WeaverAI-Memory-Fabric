import type { InstanceEntry } from './config/instance-registry.js';
import type { PanelConfig } from './config/panel-config.js';
import { InstanceRegistry } from './config/instance-registry.js';
import { ConsoleLogger } from './infra/console-logger.js';
import { FetchKernelHttpAdapter } from './kernel/adapters/fetch-kernel-http-adapter.js';
import { FetchMetaKernelAdapter } from './kernel/adapters/fetch-meta-kernel-adapter.js';
import { FetchSkillKernelAdapter } from './kernel/adapters/fetch-skill-kernel-adapter.js';
import { FetchAnalyticsKernelAdapter } from './kernel/adapters/fetch-analytics-kernel-adapter.js';
import type { KernelHttpPort } from './kernel/ports/kernel-http-port.js';
import type { MetaKernelPort } from './kernel/ports/meta-kernel-port.js';
import type { SkillKernelPort } from './kernel/ports/skill-kernel-port.js';
import type { AnalyticsKernelPort } from './kernel/ports/analytics-kernel-port.js';
import type { Logger } from './infra/logger.js';
import type { KnowledgeClientPort } from './kernel/ports/knowledge-client-port.js';
import { HttpKnowledgeClient } from './kernel/adapters/http-knowledge-client.js';
import { KnowledgeTaskRegistry } from './state/knowledge-task-registry.js';
import { IngestProgressStore } from './state/ingest-progress-store.js';
import { createPanelApiCallTelemetry, type PanelApiCallTelemetry } from './infra/api-call-telemetry.js';
import { PanelAuthService } from './auth/service.js';
import { PanelUserIdResolver } from './infra/user-id-resolver.js';

export interface PanelDeps {
  config: PanelConfig;
  logger: Logger;
  instanceRegistry: InstanceRegistry;
  kernelHttp: KernelHttpPort;
  metaKernel: MetaKernelPort;
  /** Build a KS client per request instanceId (x-wamf-service-id = instanceId). */
  knowledgeClientFactory: (instanceId: string) => KnowledgeClientPort;
  skillKernel: SkillKernelPort;
  /** Transparent proxy for the kernel /v3/analytics/* query plane (GET/POST split by action). */
  analyticsKernel: AnalyticsKernelPort;
  /** In-memory state of Knowledge extraction tasks: create stashes the owner key; on callback ready it is taken out to register the meta asset. */
  knowledgeTaskRegistry: KnowledgeTaskRegistry;
  /** Fine-grained Wiki ingest progress (written by the KS ingest_progress callback; read back aggregated by wiki/get). */
  ingestProgressStore: IngestProgressStore;
  /** Optional ClickHouse API call audit. NoOp if not configured, zero overhead. */
  apiCallTelemetry: PanelApiCallTelemetry;
  /** Unified auth service compatible with user_key and optional IdP login. */
  auth: PanelAuthService;
  /** user_key -> user_id cache resolver (used for telemetry instrumentation; refreshed in the background after auth/verify). */
  userIdResolver: PanelUserIdResolver;
}

export function buildPanelDeps(config: PanelConfig): PanelDeps {
  const logger = new ConsoleLogger({
    level: config.log.level,
    format: config.log.format,
  });
  const instanceRegistry = InstanceRegistry.load(config.metadataInstancesConfig);
  const kernelHttp = new FetchKernelHttpAdapter(logger);
  const metaKernel = new FetchMetaKernelAdapter(kernelHttp, config.metadataRemoteTimeoutMs);
  const knowledgeClientFactory = (instanceId: string): KnowledgeClientPort =>
    new HttpKnowledgeClient({
      baseUrl: config.knowledge.baseUrl,
      authToken: config.knowledge.authToken,
      serviceId: instanceId,
      timeoutMs: config.knowledge.timeoutMs,
    });
  const skillKernel = new FetchSkillKernelAdapter(kernelHttp, config.metadataRemoteTimeoutMs);
  const analyticsKernel = new FetchAnalyticsKernelAdapter(kernelHttp, config.metadataRemoteTimeoutMs);
  const knowledgeTaskRegistry = new KnowledgeTaskRegistry();
  const ingestProgressStore = new IngestProgressStore();
  // instance_id -> gateway params: telemetry backfill needs a per-instance auth/verify call
  const instanceCtxProvider = (instanceId: string) => {
    try {
      const entry = instanceRegistry.resolve(instanceId);
      return {
        instanceId: entry.instance_id,
        gatewayEndpoint: entry.gateway_endpoint,
        gatewayApiKey: entry.api_key,
      };
    } catch {
      // instance has been removed from the registry (old CH data references a decommissioned instance) -> skip
      return null;
    }
  };
  const apiCallTelemetry = createPanelApiCallTelemetry(
    config.clickhouse,
    logger,
    instanceCtxProvider,
  );
  const userIdResolver = new PanelUserIdResolver(metaKernel, logger);
  const auth = new PanelAuthService({ config: config.auth, instances: instanceRegistry, metaKernel, logger });
  return {
    config,
    logger,
    instanceRegistry,
    kernelHttp,
    metaKernel,
    knowledgeClientFactory,
    skillKernel,
    analyticsKernel,
    knowledgeTaskRegistry,
    ingestProgressStore,
    apiCallTelemetry,
    auth,
    userIdResolver,
  };
}

export type { InstanceEntry };
