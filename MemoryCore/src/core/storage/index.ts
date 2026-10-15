/**
 * Storage — barrel re-export for the storage abstraction layer.
 *
 * This file is the open-source / standalone surface of the storage layer.
 * It only re-exports the interface and the local backend.
 */

// Types & interfaces
export type {
  IStorageBackend,
  StorageBackendConfig,
  StorageObject,
  PutObjectOptions,
  ListObjectsOptions,
  ListResult,
  ListEntry,
  StorageLogger,
} from "./types.js";
export { StoragePaths } from "./types.js";

// Default implementation (always available)
export { LocalStorageBackend } from "./local-backend.js";
export type { LocalStorageBackendOptions } from "./local-backend.js";
export { StorageAdapter } from "./adapter.js";

// Factory
export {
  createStorageBackend,
  createLocalStorageBackend,
} from "./factory.js";
