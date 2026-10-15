/**
 * Store Factory — creates the appropriate storage backend and embedding service
 * based on plugin configuration.
 *
 * Supports:
 * - "sqlite" (default): local SQLite + sqlite-vec + FTS5
 * - "mongodb": MongoDB (native full-text / vector search)
 */

import path from "node:path";
import type { MemoryWamfConfig } from "../../config.js";
import type { IMemoryStore, IEmbeddingService, StoreLogger } from "./types.js";
import { VectorStore } from "./sqlite/memory-store.js";
import { MongoMemoryStore } from "./mongodb/memory-store.js";
import { getSharedMongoClientPool } from "./mongodb/client-pool.js";
import { readMongoEnvConfig } from "../../utils/env-config.js";
import { createEmbeddingService, NoopEmbeddingService } from "./embedding.js";
import type { EmbeddingService } from "./embedding.js";

// Re-export for convenience
export type { IMemoryStore, IEmbeddingService, StoreLogger };

const TAG = "[memory-wamf][factory]";

export interface StoreBundle {
  store: IMemoryStore;
  embedding: IEmbeddingService;
  /** Snapshot of current store config for manifest writing. */
  storeSnapshot: import("../../utils/manifest.js").StoreConfigSnapshot;
}

/**
 * Create the storage backend and embedding service based on plugin configuration.
 *
 * @param config       Fully resolved plugin config.
 * @param options.dataDir    Plugin data directory.
 * @param options.logger     Logger instance.
 */
export function createStoreBundle(
  config: MemoryWamfConfig,
  options: { dataDir: string; logger?: StoreLogger },
): StoreBundle {
  const { logger } = options;

  switch (config.storeBackend) {
    case "mongodb": {
      // Singleton/core path Mongo backend. Connection info comes from
      // MONGODB_* env (standalone) — mirrors how the gateway's StorePool
      // resolves per-instance Mongo config. Native mongot/BM25 → no local
      // embedding or bm25 encoder.
      const mongoConfig = readMongoEnvConfig();
      if (!mongoConfig.endpoint || !mongoConfig.database) {
        throw new Error(`${TAG} mongodb backend requires MONGODB_ENDPOINT and MONGODB_DATABASE`);
      }
      const store = new MongoMemoryStore({
        pool: getSharedMongoClientPool(logger),
        mongoConfig,
        logger,
      });

      logger?.debug?.(
        `${TAG} Store created: backend=mongodb, endpoint=${mongoConfig.endpoint}, database=${mongoConfig.database}`,
      );

      return {
        store,
        embedding: new NoopEmbeddingService(),
        storeSnapshot: {
          type: "mongodb",
          mongoEndpoint: mongoConfig.endpoint,
          mongoDatabase: mongoConfig.database,
        },
      };
    }

    case "sqlite":
    default: {
      // ── Embedding service (only when enabled) ──
      let embeddingService: EmbeddingService | undefined;
      if (config.embedding.enabled && config.embedding.provider !== "local" && config.embedding.apiKey) {
        embeddingService = createEmbeddingService({
          provider: config.embedding.provider,
          baseUrl: config.embedding.baseUrl,
          apiKey: config.embedding.apiKey,
          model: config.embedding.model,
          dimensions: config.embedding.dimensions,
          sendDimensions: config.embedding.sendDimensions,
          maxInputChars: config.embedding.maxInputChars,
        }, logger);
      }

      // dimensions from config (0 when provider="none" → vec0 deferred)
      const dims = config.embedding.dimensions;
      const dbPath = path.join(options.dataDir, "vectors.db");
      const store = new VectorStore(dbPath, dims, logger);

      logger?.debug?.(
        `${TAG} Store created: backend=sqlite, dbPath=${dbPath}, dimensions=${dims}, ` +
        `embedding=${embeddingService ? "enabled" : "disabled"}`,
      );

      return {
        store,
        embedding: embeddingService as unknown as IEmbeddingService,
        storeSnapshot: {
          type: "sqlite",
          sqlitePath: path.relative(options.dataDir, dbPath),
        },
      };
    }
  }
}
