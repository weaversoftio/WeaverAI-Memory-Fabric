/**
 * wire.ts — handler wiring entry for skill conversation-add.
 *
 * After the pooling refactor on 2026-07-30:
 *   - The old wireConversationAdd (per-instance handler + per-instance worker) has been removed.
 *   - For each instance the gateway calls wireConversationAddHandler, which only builds handler/trigger/sink/buffer,
 *     and the workers are managed by the process-wide singleton SkillWorkerPool.
 */

import type { StorageAdapter } from "../../storage/adapter.js";
import type { ISkillExtractor, ExtractorLogger } from "../queue/types.js";

import { SkillBufferStorage } from "./buffer-storage.js";
import {
  LocalSkillAgentTaskQueue,
  RedisSkillAgentTaskQueue,
  type ISkillAgentTaskQueue,
  type RedisLike as AgentQueueRedisLike,
} from "./agent-task-queue.js";
import { SkillTriggerService } from "./trigger-service.js";
import { SkillConversationAddHandler, type HandlerThresholds } from "./add-handler.js";
import type { CompressOptions } from "./message-compressor.js";
import type { OversizeOptions } from "./oversize-strategy.js";
import type { SkillCandidatesSink } from "./extract-worker.js";
import { SkillCoreSink, type MetadataServiceLike } from "./skill-core-sink.js";

export interface WireConversationAddDeps {
  storage: StorageAdapter;
  /** Production: ioredis client; tests: LocalSkillAgentTaskQueue is injected directly into `queue` to override */
  redis?: AgentQueueRedisLike;
  /** Queue injected by tests; if not passed, a RedisSkillAgentTaskQueue is built from redis */
  queue?: ISkillAgentTaskQueue;
  /** Redis key prefix, default "skill" - aligned with design doc §5 */
  redisKeyPrefix?: string;

  /**
   * The metadata service the sink needs for fallback skill asset registration (idempotent).
   * When not passed the sink is a no-op - the skill was already persisted by the extractor's tool-call,
   * the frontend management page just may not see it (in standalone mode there is no onSkillCreated hook).
   */
  metadataService?: MetadataServiceLike;

  /**
   * Field kept for compatibility with the old signature (wireConversationAddHandler does not use the extractor internally;
   * the real extraction is fetched on demand by SkillWorkerPool's resolveExtractor). The gateway side currently
   * passes a noop placeholder.
   */
  extractor: ISkillExtractor;

  logger: ExtractorLogger;

  /** Handler threshold overrides */
  thresholds?: Partial<HandlerThresholds>;

  /** Per-tool-message head/tail compression rule overrides (corresponds to SkillConfig.compress). */
  compressOptions?: Partial<CompressOptions>;

  /** Fallback splitting parameter overrides (corresponds to chunkMaxBytes / headKeepBytes / tailKeepBytes derived from SkillConfig.extraction). */
  oversizeOptions?: Partial<OversizeOptions>;

  /** Storage subpath (default "skill_buffer") */
  bufferSubPath?: string;
}

/**
 * Builds only the 4 pieces the handler needs (handler / trigger / sink / buffer) +
 * the queue (dispatched to redis/in-memory if not injected). **Does not start workers**.
 *
 * The process-wide workers are managed uniformly by SkillWorkerPool; on the first access of each instance
 * the gateway calls this function to get the handler bundle, puts it into the in-flight cache, and reuses it afterwards.
 */
export interface WiredConversationAddHandler {
  handler: SkillConversationAddHandler;
  trigger: SkillTriggerService;
  sink: SkillCandidatesSink;
  queue: ISkillAgentTaskQueue;
  buffer: SkillBufferStorage;
}

export function wireConversationAddHandler(
  deps: WireConversationAddDeps,
): WiredConversationAddHandler {
  const buffer = new SkillBufferStorage({
    storage: deps.storage,
    subPath: deps.bufferSubPath,
  });

  let queue: ISkillAgentTaskQueue;
  if (deps.queue) {
    queue = deps.queue;
  } else if (deps.redis) {
    queue = new RedisSkillAgentTaskQueue({
      client: deps.redis,
      keyPrefix: deps.redisKeyPrefix ?? "skill",
    });
  } else {
    // Degradation without Redis: usable only in the standalone single-machine scenario
    queue = new LocalSkillAgentTaskQueue();
    deps.logger.warn(
      "[skill-conversation-add] no redis nor queue injected — falling back to in-memory queue (single-node only)",
    );
  }

  const trigger = new SkillTriggerService({ buffer, queue });
  const handler = new SkillConversationAddHandler({
    buffer,
    trigger,
    thresholds: deps.thresholds,
    compressOptions: deps.compressOptions,
    oversizeOptions: deps.oversizeOptions,
  });

  const sink = new SkillCoreSink({
    metadata: deps.metadataService,
    logger: deps.logger,
  });

  return { handler, trigger, sink, queue, buffer };
}
