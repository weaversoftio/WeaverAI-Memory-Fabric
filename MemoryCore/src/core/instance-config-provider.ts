/**
 * InstanceConfigProvider — instance-level configuration management
 *
 * Design notes:
 *   - Mongo config: per-instance (each instanceId may have its own MongoDB connection info), with a TTL cache
 *   - Config sources are provided through an injected IConfigSource:
 *     - default: LocalConfigSource (built into this file, reads from env vars)
 *     - tests / custom deployments: any other IConfigSource implementation
 *
 * Data model:
 *   Core process
 *     └── Mongo pool (Map<instanceId, MongoConfig>):
 *         ├── inst-001 → { endpoint: mongo-1, database: db1 }
 *         └── inst-002 → { endpoint: mongo-1, database: db2 }
 */

import type { IConfigSource } from "./abstractions/index.js";
import { readMongoEnvConfig } from "../utils/env-config.js";

// ════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════

/**
 * Per-instance MongoDB connection info (data-plane backend).
 *
 * `database` is delivered verbatim (never derived from instanceId):
 * one per-instance database, collections are bare-named inside it.
 */
export interface MongoConfig {
  endpoint: string;
  user: string;
  password: string;
  database: string;
}

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

// Re-export interface for backward compatibility (consumers may still
// import IConfigSource from this module — the canonical location is now
// src/core/abstractions/).
export type { IConfigSource };

// ════════════════════════════════════════════════════════
// LocalConfigSource — default implementation
// ════════════════════════════════════════════════════════
//
// Reads Mongo config from process environment variables. Suited to self-hosted setups without a control plane.
//
// Environment variables:
//   MONGODB_ENDPOINT, MONGODB_USER, MONGODB_PASSWORD, MONGODB_DATABASE

export class LocalConfigSource implements IConfigSource {
  // Logger kept for future diagnostic logging; constructor signature mirrors
  // other sources so callers can swap implementations interchangeably.
  constructor(private readonly _logger: Logger) {
    void this._logger;
  }

  async fetchMongo(_instanceId: string): Promise<MongoConfig> {
    return readMongoEnvConfig();
  }
}

// ════════════════════════════════════════════════════════
// Cache entry
// ════════════════════════════════════════════════════════

interface MongoCacheEntry {
  config: MongoConfig;
  expiresAt: number;
  lastAccessedAt: number;
}

// ════════════════════════════════════════════════════════
// InstanceConfigProvider
// ════════════════════════════════════════════════════════

export interface InstanceConfigProviderOptions {
  /**
   * Pre-constructed config source for the current deployment.
   */
  source: IConfigSource;
  /** Config cache TTL (ms), default 5 minutes */
  ttlMs?: number;
  /** Max cached instances; LRU eviction beyond this, default 1000 */
  maxInstances?: number;
  logger: Logger;
}

export class InstanceConfigProvider {
  private source: IConfigSource;
  private logger: Logger;
  private ttlMs: number;
  private maxInstances: number;

  // ── Mongo: per-instance cache ──
  private mongoPool = new Map<string, MongoCacheEntry>();
  /**
   * Per-instance in-flight fetch dedupe (H-2 fix):
   * When the same instanceId is first accessed concurrently, reuse a single fetch Promise
   * to avoid sending N simultaneous requests to the source.
   */
  private mongoFetchPromises = new Map<string, Promise<MongoConfig>>();

  constructor(opts: InstanceConfigProviderOptions) {
    this.logger = opts.logger;
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.maxInstances = opts.maxInstances ?? 1000;
    this.source = opts.source;
    this.logger.info(`[instance-config] InstanceConfigProvider initialized (source=${opts.source.constructor.name})`);
  }

  // ════════════════════════════════════════════════════════
  // Public API
  // ════════════════════════════════════════════════════════

  /**
   * Get the Mongo config of the given instance (cached).
   *
   * Strategy:
   * 1. Cache hit and not expired → return directly (and refresh the LRU position)
   * 2. Cache empty or expired → fetch from source (concurrent requests for the same instanceId are de-duplicated in flight)
   * 3. Source returns empty/error → throw and log (empty values are not cached)
   */
  async resolveMongo(instanceId: string): Promise<MongoConfig> {
    const now = Date.now();
    const cached = this.mongoPool.get(instanceId);

    if (cached && now < cached.expiresAt) {
      cached.lastAccessedAt = now;
      // LRU reorder (H-3): move the entry to the end of the Map so the first element is the LRU on eviction.
      this.mongoPool.delete(instanceId);
      this.mongoPool.set(instanceId, cached);
      return cached.config;
    }

    const inflight = this.mongoFetchPromises.get(instanceId);
    if (inflight) {
      this.logger.debug?.(`[instance-config] Mongo fetch in-flight for ${instanceId}, awaiting...`);
      return inflight;
    }

    this.logger.debug?.(`[instance-config] Mongo cache ${cached ? "expired" : "miss"} for ${instanceId}, fetching...`);
    const fetchPromise = this.fetchAndStoreMongo(instanceId);
    this.mongoFetchPromises.set(instanceId, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      // Clear the in-flight marker even if fetch throws, otherwise a single failure
      // would leave that instanceId stuck forever.
      this.mongoFetchPromises.delete(instanceId);
    }
  }

  private async fetchAndStoreMongo(instanceId: string): Promise<MongoConfig> {
    const config = await this.source.fetchMongo(instanceId);

    if (!config || !config.endpoint || !config.database) {
      const msg = `[instance-config] Config source returned incomplete Mongo config for instanceId="${instanceId}" (endpoint=${config?.endpoint}, database=${config?.database})`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    if (this.mongoPool.size >= this.maxInstances && !this.mongoPool.has(instanceId)) {
      this.evictMongoLru();
    }

    const now = Date.now();
    this.mongoPool.set(instanceId, {
      config,
      expiresAt: now + this.ttlMs,
      lastAccessedAt: now,
    });

    return config;
  }

  /** Clear the Mongo cache of the given instance (called when the instance goes offline). */
  evictMongo(instanceId: string): void {
    this.mongoPool.delete(instanceId);
    this.logger.debug?.(`[instance-config] Evicted Mongo cache for ${instanceId}`);
  }

  /**
   * Clear all caches
   */
  clear(): void {
    this.mongoPool.clear();
    this.logger.info(`[instance-config] All caches cleared`);
  }

  /**
   * Number of currently cached instances
   */
  get poolSize(): number {
    return this.mongoPool.size;
  }

  // ════════════════════════════════════════════════════════
  // Internal
  // ════════════════════════════════════════════════════════

  /**
   * LRU eviction: remove the least recently accessed instance.
   *
   * Relies on the Map insertion order being the access order — resolveMongo, on a cache hit,
   * already does delete+set to move the hot key to the end of the Map, so the first key is the LRU, O(1).
   */
  private evictMongoLru(): void {
    const firstKey = this.mongoPool.keys().next().value;
    if (firstKey !== undefined) {
      this.mongoPool.delete(firstKey);
      this.logger.debug?.(`[instance-config] LRU evicted Mongo cache for ${firstKey}`);
    }
  }
}
