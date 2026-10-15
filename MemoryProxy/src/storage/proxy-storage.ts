/**
 * ProxyStorage -- unified KV abstraction, replacing the direct Redis calls previously scattered across the injection layer / Skill layer.
 *
 * Semantics:
 *   - key is a relative path string such as "short/inj-sess/abc.json". Absolute paths / path traversal are forbidden
 *   - putJSON/putText overwrite; a successful write is equivalent to "renewal" (updates lastModified, only meaningful for the ttl bucket)
 *   - putJSONIfAbsent/putTextIfAbsent CAS: write only if the key does not exist, return whether the write succeeded
 *   - getJSON/getText return null when not found, never throw
 *   - delPrefix is used by clearBySession -- each backend implements it itself
 *   - listNames returns the basenames of all objects under prefix (without the prefix)
 *
 * All methods are async; overwriting writes may be fire-and-forget (`.catch(() => {})`).
 * putIfAbsent must be awaited (the return value decides the following branch).
 */
export type ProxyStorageType = "sqlite" | "fs" | "memory";

export interface ProxyStorage {
  readonly type: ProxyStorageType;

  putJSON(key: string, value: unknown): Promise<void>;
  putText(key: string, value: string): Promise<void>;

  /** Atomic "put if absent". Returns true if this call wrote successfully; false if the key already exists. */
  putJSONIfAbsent(key: string, value: unknown): Promise<boolean>;
  putTextIfAbsent(key: string, value: string): Promise<boolean>;

  getJSON<T>(key: string): Promise<T | null>;
  getText(key: string): Promise<string | null>;
  exists(key: string): Promise<boolean>;

  del(key: string): Promise<void>;
  delPrefix(prefix: string): Promise<number>;

  listNames(prefix: string): Promise<string[]>;
}

/** Determine which bucket a key belongs to -- used by the sweeper and the lifecycle rule generator. */
export function bucketOf(key: string): "ttl" | "nottl" {
  return key.startsWith("ttl/") ? "ttl" : "nottl";
}
