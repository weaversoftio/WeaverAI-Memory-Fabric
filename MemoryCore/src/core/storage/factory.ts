/**
 * Storage Backend Factory — creates the appropriate IStorageBackend
 * based on configuration.
 *
 * Only the `local` backend can be created from plain config. The MongoDB-backed
 * file stores (mongofs / rowfs) are assembled by the gateway because they need a
 * live per-instance database handle.
 */

import type { IStorageBackend, StorageBackendConfig, StorageLogger } from "./types.js";
import { LocalStorageBackend } from "./local-backend.js";
import { REMOVED_FS_KINDS, removedBackendError } from "../backend-selection/removed.js";

const TAG = "[storage][factory]";

/**
 * Create a storage backend instance based on configuration.
 *
 * Async for API stability (callers already await it).
 *
 * @param config Backend configuration (type + backend-specific options)
 * @param logger Optional logger
 * @returns IStorageBackend instance
 */
export async function createStorageBackend(
  config: StorageBackendConfig,
  logger?: StorageLogger,
): Promise<IStorageBackend> {
  const type: string = config.type;
  if (REMOVED_FS_KINDS.includes(type)) {
    throw removedBackendError("storage type", type, "fs");
  }
  const rootDir = config.localRootDir ?? "./data/storage";
  logger?.info(`${TAG} Creating local storage backend: rootDir=${rootDir}`);
  return new LocalStorageBackend({
    rootDir,
    logger,
  });
}

/**
 * Create a local storage backend for development.
 * Convenience helper for quick local setup.
 */
export function createLocalStorageBackend(
  rootDir: string,
  logger?: StorageLogger,
): IStorageBackend {
  return new LocalStorageBackend({ rootDir, logger });
}
