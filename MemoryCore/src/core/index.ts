/**
 * WAMF Core — barrel re-export for core types and service facade.
 *
 * This module exports ONLY the host-neutral interfaces and the WamfCore facade.
 * Host-specific adapters live in `../adapters/`.
 */

// Types & interfaces
export type {
  Logger,
  RuntimeContext,
  LLMRunParams,
  LLMRunner,
  LLMRunnerCreateOptions,
  LLMRunnerFactory,
  HostAdapter,
  CompletedTurn,
  RecallResult,
  CaptureResult,
  MemorySearchParams,
  ConversationSearchParams,
} from "./types.js";

// WamfCore service facade
export { WamfCore } from "./wamf-core.js";
export type { WamfCoreOptions } from "./wamf-core.js";

// Instance config provider (per-instance Mongo config pool).
// LocalConfigSource lives inline in instance-config-provider.ts; other
// deployments may provide their own IConfigSource implementation.
export {
  InstanceConfigProvider,
  LocalConfigSource,
} from "./instance-config-provider.js";
export type {
  MongoConfig,
  IConfigSource,
  InstanceConfigProviderOptions,
} from "./instance-config-provider.js";

// Store pool (per-instanceId Store instances)
export { StorePool } from "./store/store-pool.js";
export type { PooledStore, StorePoolOptions, StoreMode } from "./store/store-pool.js";

// Storage backend (unified file/object abstraction).
export {
  LocalStorageBackend,
  StoragePaths,
  StorageAdapter,
  createStorageBackend,
  createLocalStorageBackend,
} from "./storage/index.js";
export type {
  IStorageBackend,
  StorageBackendConfig,
  StorageObject,
  PutObjectOptions,
  ListObjectsOptions,
  ListResult,
  ListEntry,
  StorageLogger,
} from "./storage/index.js";
