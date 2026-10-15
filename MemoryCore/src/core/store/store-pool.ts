/**
 * StorePool — per-instanceId pool of Store instances
 *
 * Dual-mode support:
 *   - sqlite: SQLite local storage (one SQLite file per instanceId)
 *   - mongodb: MongoDB (one per-instance database, shared MongoClient per endpoint)
 *
 * Works with InstanceConfigProvider:
 *   1. When a request arrives, get the Mongo config of that instanceId from InstanceConfigProvider
 *   2. Create/reuse a Store instance with that config
 *   3. Pooled management, to avoid creating connections repeatedly
 *
 * In sqlite mode:
 *   - no MongoConfig → create a SQLite Store
 *   - a fixed "default" instanceId, behavior consistent with the original createStoreBundle
 */

import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { MemoryWamfConfig } from "../../config.js";
import type { IMemoryStore, StoreLogger } from "./types.js";
import type { EmbeddingService } from "./embedding.js";
import { createEmbeddingService, NoopEmbeddingService } from "./embedding.js";
import { VectorStore } from "./sqlite/memory-store.js";
import { MongoMemoryStore } from "./mongodb/memory-store.js";
import { MongoSkillStore } from "./mongodb/skill-store.js";
import { getSharedMongoClientPool } from "./mongodb/client-pool.js";
import type { MongoClientPool } from "./mongodb/client-pool.js";
import type { MongoConfig } from "../instance-config-provider.js";
import type { ISkillStore } from "../skill/skill-store.interface.js";
import { metricProducer } from "../report/kafka-metric-producer.js";
import { isSafeInstanceId } from "../../utils/instance-id.js";

const TAG = "[store-pool]";

// ════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════

export interface PooledStore {
  store: IMemoryStore;
  embedding: EmbeddingService;
}

interface PoolEntry {
  pooledStore: PooledStore;
  /** Backend config fingerprint, used to detect config changes */
  configFingerprint: string;
  lastAccessedAt: number;
}

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export type StoreMode = "sqlite" | "mongodb";

export interface KafkaMetricOptions {
  /** Kafka Broker list (comma-separated or an array) */
  brokers?: string[] | string;
  /** Topic name (default: "memory_monitor") */
  topic?: string;
  /** Whether enabled (default: auto-decided by whether brokers is non-empty) */
  enabled?: boolean;
}

export interface StorePoolOptions {
  /** Storage mode: "sqlite" (local file) or "mongodb" (remote database) */
  mode: StoreMode;
  /** Memory plugin config (used for embedding settings) */
  memoryCfg: MemoryWamfConfig;
  /** Data directory (used in SQLite mode) */
  dataDir?: string;
  /** Max number of pooled instances (Memory store), default 100 */
  maxStores?: number;
  /** Max number of Skill store cache entries, default 100 */
  maxSkillStores?: number;
  /** Kafka metric reporting config (optional; not reported if not configured) */
  kafka?: KafkaMetricOptions;
  logger: Logger;
}

// ════════════════════════════════════════════════════════
// StorePool
// ════════════════════════════════════════════════════════

export class StorePool {
  private pool = new Map<string, PoolEntry>();
  private maxStores: number;
  readonly mode: StoreMode;
  private memoryCfg: MemoryWamfConfig;
  private dataDir: string;
  private logger: Logger;
  /** Shared MongoClient connection pool (mongodb backend; one client reused per endpoint). */
  private mongoPool: MongoClientPool | undefined;

  /** Skill store cache cap */
  private maxSkillStores: number;
  /** Last access time of the Skill store (used for LRU eviction) */
  private skillStoreAccessTimes = new Map<string, number>();



  /**
   * Grace-close tracking: entries already removed from the pool but whose underlying close is deferred.
   * CR-5 mitigation (2026-05-19): evict / config-change does not close the underlying store immediately,
   * but closes it after a delay of graceCloseDelayMs, giving in-flight requests (synchronous recall/capture paths
   * <100ms; the asynchronous worker L1/L2/L3 paths are backed by maxRetries=3 + exponential backoff) time to finish.
   */
  private pendingCloses = new Set<Promise<void>>();
  /** Grace period default 30s, far larger than the synchronous path wall clock (recall ~49ms / capture ~54ms),
   *  and even if the worker path hits it there is a reEnqueue retry mechanism (5s/15s/45s). */
  private graceCloseDelayMs = 30_000;

  constructor(opts: StorePoolOptions) {
    this.maxStores = opts.maxStores ?? 100;
    this.maxSkillStores = opts.maxSkillStores ?? 100;
    this.mode = opts.mode;
    this.memoryCfg = opts.memoryCfg;
    this.dataDir = opts.dataDir ?? ".";
    this.logger = opts.logger;

    // Initialize the Kafka Metric Producer (async, does not block construction)
    this.initKafkaMetricProducer(opts.kafka);

    this.logger.info(`${TAG} Initialized: mode=${this.mode}, maxStores=${this.maxStores}, maxSkillStores=${this.maxSkillStores}`);
  }

  /**
   * Initialize the Kafka Metric Producer.
   * Runs asynchronously and does not block the StorePool construction. Initialization failures are silently ignored.
   * Config priority: StorePoolOptions.kafka > environment variables (fallback)
   */
  private initKafkaMetricProducer(kafka?: KafkaMetricOptions): void {
    // Config first, environment variables only as a fallback
    const rawBrokers = kafka?.brokers ?? "";
    const brokers = Array.isArray(rawBrokers)
      ? rawBrokers
      : rawBrokers.split(",").map(s => s.trim()).filter(Boolean);

    const enabled = kafka?.enabled ?? brokers.length > 0;
    if (!enabled || brokers.length === 0) {
      this.logger.info(`${TAG} Kafka metric producer disabled (no brokers configured)`);
      return;
    }

    // Async initialization, does not block the business
    metricProducer.initialize({
      brokers,
      topic: kafka?.topic ?? "memory_monitor",
      enabled: true,
    }).catch((err) => {
      // Initialization failures are handled silently and do not affect the business
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${TAG} Kafka metric producer init failed: ${msg}. Metrics disabled.`);
    });
  }

  /**
   * Get the Store instance for the given instanceId
   *
   * - sqlite: mongoConfig is null, create a SQLite Store
   * - mongodb: create a MongoDB Store from mongoConfig
   */
  async getStore(
    instanceId: string,
    mongoConfig?: MongoConfig | null,
  ): Promise<PooledStore> {
    const now = Date.now();
    // D11: backend selected per-instance from the config actually delivered —
    // mongoConfig present → mongodb; else sqlite. `mode` is the process default
    // that drives which config the caller resolves, but the presence check is
    // authoritative here.
    const backend: StoreMode = mongoConfig ? "mongodb" : "sqlite";
    const fingerprint = mongoConfig
      ? this.computeMongoFingerprint(mongoConfig)
      : `sqlite:${instanceId}`;
    const cached = this.pool.get(instanceId);

    // Hit and config unchanged
    if (cached && cached.configFingerprint === fingerprint) {
      cached.lastAccessedAt = now;
      return cached.pooledStore;
    }

    // Config changed → close the old one
    if (cached) {
      this.logger.info(`${TAG} Config changed for ${instanceId}, recreating store`);
      await this.closeEntry(instanceId, cached);
    }

    // LRU eviction
    if (this.pool.size >= this.maxStores) {
      await this.evictLru();
    }

    // Create a new Store
    const pooledStore = mongoConfig
      ? this.createMongoStore(mongoConfig)
      : this.createSqliteStore(instanceId);

    this.pool.set(instanceId, {
      pooledStore,
      configFingerprint: fingerprint,
      lastAccessedAt: now,
    });

    const storeDesc = mongoConfig
      ? `mongodb ${mongoConfig.endpoint} / ${mongoConfig.database}`
      : `sqlite @ ${this.getSqlitePath(instanceId)}`;
    this.logger.info(
      `${TAG} Created ${backend} store for ${instanceId}: ${storeDesc} (pool size: ${this.pool.size})`,
    );

    // Initialize the Store (create tables / check the connection)
    try {
      await pooledStore.store.init();
    } catch (e) {
      this.logger.warn(`${TAG} Store init failed for ${instanceId}: ${e}`);
    }

    return pooledStore;
  }

  /**
   * Remove the Store of the given instance (called when the instance goes offline)
   */
  async evict(instanceId: string): Promise<void> {
    const entry = this.pool.get(instanceId);
    if (entry) {
      await this.closeEntry(instanceId, entry);
    }
  }

  /**
   * Close all Stores
   *
   * CR-5: the original closeAll synchronously closed all stores in the pool, which would crash in-flight requests.
   * Now it is two steps:
   *   1. trigger closeEntry for all entries (delayed close, added to pendingCloses)
   *   2. wait for all pendingCloses to complete (including newly added ones + those left behind by earlier evictions)
   * On process shutdown the caller can choose to shorten the grace time to avoid blocking: setGraceCloseDelay(0)
   */
  async closeAll(): Promise<void> {
    // Close the Memory store pool
    const entries = [...this.pool.entries()];
    this.pool.clear();
    // Trigger delayed close (these promises are automatically added to pendingCloses)
    for (const [id, entry] of entries) {
      await this.closeEntry(id, entry);  // closeEntry does not block internally, returns immediately
    }

    // Close the Skill store cache
    for (const [key, store] of this.skillStoreCache) {
      try {
        store.close();
        this.logger.debug?.(`${TAG} Closed skill store: ${key}`);
      } catch (e) {
        this.logger.warn(`${TAG} Error closing skill store ${key}: ${e}`);
      }
    }
    this.skillStoreCache.clear();
    this.skillStoreAccessTimes.clear();

    // Wait for all pending closes to complete (including this round + those left behind by earlier evictions)
    await Promise.allSettled([...this.pendingCloses]);

    // Close the shared MongoClient connection pool (disconnect only after all stores have released their references)
    if (this.mongoPool) {
      try {
        await this.mongoPool.closeAll();
        this.logger.debug?.(`${TAG} Closed shared MongoClient pool`);
      } catch (e) {
        this.logger.warn(`${TAG} Error closing shared MongoClient pool: ${e}`);
      }
      this.mongoPool = undefined;
    }

    this.logger.info(`${TAG} All stores closed (${entries.length} memory + skill caches cleared)`);
  }

  /**
   * Remove the Skill store of the given instance (called when the instance is destroyed).
   * Calls store.close() to set degraded=true, then removes it from the cache.
   */
  evictSkillStore(instanceId: string): void {
    const key = `skill:${instanceId}`;
    const store = this.skillStoreCache.get(key);
    if (store) {
      try {
        store.close();
      } catch (e) {
        this.logger.warn(`${TAG} Error closing skill store ${key}: ${e}`);
      }
      this.skillStoreCache.delete(key);
      this.skillStoreAccessTimes.delete(key);
      this.logger.info(`${TAG} Evicted skill store for ${instanceId} (cached: ${this.skillStoreCache.size})`);
    }
  }

  /**
   * Set the grace-close delay (milliseconds). Setting 0 closes immediately, losing in-flight protection.
   * Mainly for tests or emergency process exit scenarios.
   */
  setGraceCloseDelay(ms: number): void {
    this.graceCloseDelayMs = Math.max(0, ms);
  }

  get size(): number { return this.pool.size; }
  has(instanceId: string): boolean { return this.pool.has(instanceId); }

  /**
   * Get the Skill Store of the given instanceId (MongoDB).
   *
   * Uses the same Mongo database as getStore(), only different collections.
   * The Skill store has its own cache (skillStoreCache), unaffected by the Memory store pooling management.
   */
  async getSkillStore(
    instanceId: string,
    mongoConfig?: MongoConfig | null,
  ): Promise<ISkillStore> {
    const key = `skill:${instanceId}`;
    const cached = this.skillStoreCache.get(key);
    if (cached) {
      this.skillStoreAccessTimes.set(key, Date.now());
      return cached;
    }

    if (!mongoConfig) {
      throw new Error(`${TAG} getSkillStore(${instanceId}) requires a mongoConfig (mongodb)`);
    }

    // LRU eviction
    if (this.skillStoreCache.size >= this.maxSkillStores) {
      this.evictSkillStoreLru();
    }

    const mongoStore = new MongoSkillStore({
      pool: this.getMongoPool(),
      mongoConfig,
      logger: this.logger as StoreLogger,
    });
    mongoStore.init();
    this.skillStoreCache.set(key, mongoStore);
    this.skillStoreAccessTimes.set(key, Date.now());
    this.logger.info(`${TAG} Created mongo skill store for ${instanceId}: ${mongoConfig.endpoint}/${mongoConfig.database} (cached: ${this.skillStoreCache.size})`);
    return mongoStore;
  }

  private skillStoreCache = new Map<string, ISkillStore>();

  // ════════════════════════════════════════════════════════
  // Internal — MongoDB Store
  // ════════════════════════════════════════════════════════

  /** Lazily create the shared MongoClient pool (one client per endpoint). */
  private getMongoPool(): MongoClientPool {
    if (!this.mongoPool) {
      this.mongoPool = getSharedMongoClientPool(this.logger as StoreLogger);
    }
    return this.mongoPool;
  }

  private createMongoStore(mongoConfig: MongoConfig): PooledStore {
    const store = new MongoMemoryStore({
      pool: this.getMongoPool(),
      mongoConfig,
      logger: this.logger as StoreLogger,
    });
    // Mongo uses native mongot/BM25 — no application-layer embedding.
    return {
      store,
      embedding: new NoopEmbeddingService() as unknown as EmbeddingService,
    };
  }

  private computeMongoFingerprint(mongoConfig: MongoConfig): string {
    return `mongodb:${mongoConfig.endpoint}|${mongoConfig.database}|${mongoConfig.user}`;
  }

  // ════════════════════════════════════════════════════════
  // Internal — SQLite Store
  // ════════════════════════════════════════════════════════

  private createSqliteStore(instanceId: string): PooledStore {
    // Embedding service (remote API, e.g. OpenAI text-embedding)
    let embeddingService: EmbeddingService | undefined;
    const embCfg = this.memoryCfg.embedding;
    if (embCfg.enabled && embCfg.provider !== "local" && embCfg.provider !== "none" && embCfg.apiKey) {
      embeddingService = createEmbeddingService({
        provider: embCfg.provider,
        baseUrl: embCfg.baseUrl,
        apiKey: embCfg.apiKey,
        model: embCfg.model,
        dimensions: embCfg.dimensions,
        maxInputChars: embCfg.maxInputChars,
      }, this.logger as StoreLogger);
    }

    const dims = embCfg.dimensions ?? 0;
    const dbPath = this.getSqlitePath(instanceId);
    // Make sure the database directory exists (for non-default instances)
    const dbDir = path.dirname(dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    const store = new VectorStore(dbPath, dims, this.logger as StoreLogger);

    return {
      store,
      embedding: (embeddingService ?? new NoopEmbeddingService()) as unknown as EmbeddingService,
    };
  }

  /**
   * SQLite file path:
   *   - "default" → dataDir/vectors.db (compatible with the original logic)
   *   - other instanceId → dataDir/instances/{instanceId}/vectors.db
   */
  private getSqlitePath(instanceId: string): string {
    if (instanceId === "default") {
      return path.join(this.dataDir, "vectors.db");
    }
    if (!isSafeInstanceId(instanceId)) throw new Error(`invalid instance id: ${JSON.stringify(instanceId)}`);
    return path.join(this.dataDir, "instances", instanceId, "vectors.db");
  }

  // ════════════════════════════════════════════════════════
  // Internal — Common
  // ════════════════════════════════════════════════════════

  private async closeEntry(instanceId: string, entry: PoolEntry): Promise<void> {
    // CR-5 mitigation: remove from the pool immediately (new requests cannot get this entry and will create a new store),
    // but the underlying store.close() is deferred by graceCloseDelayMs, giving any in-flight request holding a reference
    // to this entry time to finish. No reference counting, to avoid modifying all callers;
    // the worker path has maxRetries=3 retries as a safeguard, and the synchronous path wall clock is far below the grace period: double insurance.
    this.pool.delete(instanceId);

    const closePromise = (async () => {
      // Wait for the grace period
      if (this.graceCloseDelayMs > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.graceCloseDelayMs);
          // unref to avoid blocking process exit (closeAll actively awaits these promises)
          if (typeof (t as { unref?: () => void }).unref === "function") {
            (t as { unref: () => void }).unref();
          }
        });
      }
      try {
        await entry.pooledStore.store.close();
        this.logger.debug?.(`${TAG} Closed store for ${instanceId} (after ${this.graceCloseDelayMs}ms grace)`);
      } catch (e) {
        this.logger.warn(`${TAG} Error closing store for ${instanceId}: ${e}`);
      }
    })();

    this.pendingCloses.add(closePromise);
    closePromise.finally(() => this.pendingCloses.delete(closePromise));
    // No await - the caller returns immediately, and the real close proceeds in the background
  }

  private async evictLru(): Promise<void> {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.pool) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.pool.get(oldestKey)!;
      await this.closeEntry(oldestKey, entry);
      this.logger.debug?.(`${TAG} LRU evicted store for ${oldestKey}`);
    }
  }

  /** Skill store LRU eviction: kick out the entry accessed longest ago. */
  private evictSkillStoreLru(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, time] of this.skillStoreAccessTimes) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const store = this.skillStoreCache.get(oldestKey);
      if (store) {
        try {
          store.close();
        } catch (e) {
          this.logger.warn(`${TAG} Error closing skill store ${oldestKey} during LRU evict: ${e}`);
        }
      }
      this.skillStoreCache.delete(oldestKey);
      this.skillStoreAccessTimes.delete(oldestKey);
      this.logger.debug?.(`${TAG} LRU evicted skill store: ${oldestKey}`);
    }
  }
}
