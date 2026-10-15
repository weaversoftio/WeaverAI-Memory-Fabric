/**
 * Backfill the Gateway yaml `metadata` block into process.env (only when env is unset).
 *
 * Resolution priority: process.env > yaml (consistent with WAMF_METADATA_MAX_USERS).
 * factory.ts still reads env only, so no call signature needs to change.
 */

import type { GatewayMetadataConfig } from "./config.js";

function setEnvIfEmpty(key: string, value: string | undefined): void {
  if (value?.trim() && !process.env[key]?.trim()) {
    process.env[key] = value.trim();
  }
}

/**
 * Call before validateMetadataStartupConfig / ensureMetadataStore.
 */
export function applyMetadataEnvFromGatewayConfig(metadata: GatewayMetadataConfig): void {
  const store = metadata.store;
  if (store) {
    setEnvIfEmpty("WAMF_METADATA_SQLITE_BASE_DIR", store.sqliteBaseDir);
    setEnvIfEmpty("WAMF_METADATA_MONGO_URI", store.mongoUri);
    setEnvIfEmpty("WAMF_METADATA_MONGO_DB_PREFIX", store.mongoDbPrefix);
    if (store.mongoTransactions === false && !process.env.WAMF_METADATA_MONGO_TRANSACTIONS?.trim()) {
      process.env.WAMF_METADATA_MONGO_TRANSACTIONS = "false";
    }
    if (
      store.storeCacheMaxInstances != null &&
      !process.env.WAMF_METADATA_STORE_CACHE_MAX?.trim()
    ) {
      process.env.WAMF_METADATA_STORE_CACHE_MAX = String(store.storeCacheMaxInstances);
    }
  }

  const memory = metadata.systemUser?.memory;
  if (memory) {
    setEnvIfEmpty("WAMF_MEMORY_SYSTEM_USER_ID", memory.userId);
    setEnvIfEmpty("WAMF_MEMORY_SYSTEM_USER_NAME", memory.displayName);
    setEnvIfEmpty("WAMF_MEMORY_SYSTEM_USER_KEY", memory.userKey);
  }
}
