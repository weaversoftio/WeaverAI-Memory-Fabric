/**
 * ProxyStorage factory -- singleton + degradation chain.
 *
 * Supported backends: sqlite, fs, memory. All of them are process-local, so the degradation chain
 * sqlite -> fs -> memory is kept for local / single-node deployments:
 *   - each degradation logs one `!!! DEGRADED !!!` via console.error
 *   - `/health` exposes requested vs effective via `getEffectiveBackend()`
 *   - memory never fails but explicitly does not persist; it is only a fallback to keep the process from crashing.
 *
 * An unknown backend name (including removed backends) throws immediately so the process cannot start.
 */
import { createRequire } from "node:module";
import type { ProxyStorage, ProxyStorageType } from "./proxy-storage.js";
import { MemoryStorage } from "./memory-storage.js";
import { FsStorage } from "./fs-storage.js";
import { SqliteStorage } from "./sqlite-storage.js";

const TAG = "[storage]";
const _require = createRequire(import.meta.url);

const SUPPORTED_BACKENDS: readonly ProxyStorageType[] = ["sqlite", "fs", "memory"];

export interface StorageConfig {
  backend: ProxyStorageType;
  /** Lifetime (days) of objects under the `ttl/` prefix. Only effective for the ttl prefix. */
  ttlDays: number;

  sqlite: {
    /** empty = use getDb() default (~/.wamf-memory-proxy/proxy.db) */
    dbPath: string;
  };

  fs: {
    fsRoot: string;
  };
}

let _instance: ProxyStorage | null = null;
let _requested: ProxyStorageType = "memory";
let _effective: ProxyStorageType = "memory";
let _lastError: string | undefined;
let _sweepTimer: NodeJS.Timeout | null = null;

/** Called once at process start. Kept async for call-site compatibility. */
export async function initProxyStorage(config: StorageConfig): Promise<ProxyStorage> {
  return getProxyStorage(config);
}

export function getProxyStorage(config: StorageConfig): ProxyStorage {
  if (_instance) return _instance;
  _requested = config.backend;

  if (!SUPPORTED_BACKENDS.includes(config.backend)) {
    throw new Error(
      `${TAG} storage backend "${String(config.backend)}" is not supported (supported: ${SUPPORTED_BACKENDS.join(", ")})`,
    );
  }

  const chain: ProxyStorageType[] = orderFrom(config.backend);
  for (const backend of chain) {
    try {
      const created = tryCreate(backend, config);
      if (!created) continue;
      if (backend !== _requested) {
        // Degradation = a high-risk event, use error level (old code used warn, which got drowned out)
        console.error(
          `${TAG} !!! DEGRADED !!! backend ${_requested} unavailable — using ${backend} instead${_lastError ? ` (${_lastError})` : ""}`,
        );
        console.error(
          `${TAG} !!! MULTI-NODE HAZARD !!! effective backend=${backend} is process-local;`
          + ` other proxy nodes have their own copy — cross-node reads WILL miss.`,
        );
      } else {
        console.log(`${TAG} activated ${backend} backend`);
      }
      _effective = backend;
      _instance = created;
      startSweeperIfNeeded(created, config);
      return created;
    } catch (err) {
      _lastError = err instanceof Error ? err.message : String(err);
      // Assembly failure is also escalated to error (previously warn)
      console.error(`${TAG} backend ${backend} init failed: ${_lastError}`);
    }
  }

  // Theoretically unreachable -- MemoryStorage does not throw
  console.error(
    `${TAG} !!! LAST-RESORT !!! all backends failed; falling back to in-process memory.`
    + ` Data will NOT persist across restarts and will NOT be visible to other nodes.`,
  );
  _instance = new MemoryStorage();
  _effective = "memory";
  return _instance;
}

export function getEffectiveBackend(): { requested: string; effective: string; error?: string } {
  return { requested: _requested, effective: _effective, error: _lastError };
}

/** Test only -- reset the singleton + stop the sweeper. */
export function __resetProxyStorageForTests(): void {
  _instance = null;
  _requested = "memory";
  _effective = "memory";
  _lastError = undefined;
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
}

// ── internals ──────────────────────────────────────────────────────────────

function orderFrom(preferred: ProxyStorageType): ProxyStorageType[] {
  const all: ProxyStorageType[] = [...SUPPORTED_BACKENDS];
  const start = all.indexOf(preferred);
  if (start < 0) return all;
  return all.slice(start);
}

function tryCreate(backend: ProxyStorageType, config: StorageConfig): ProxyStorage | null {
  switch (backend) {
    case "memory":
      return new MemoryStorage();
    case "fs": {
      if (!config.fs?.fsRoot) throw new Error("fs.fsRoot not configured");
      return new FsStorage(config.fs.fsRoot);
    }
    case "sqlite": {
      const db = openSqliteDb(config.sqlite?.dbPath);
      return new SqliteStorage(db);
    }
    default:
      throw new Error(`unsupported storage backend: ${String(backend)}`);
  }
}

function openSqliteDb(dbPath: string): any {
  // Lazy require -- better-sqlite3 is an optional dependency, and loading may fail on some images.
  let Database: any;
  try {
    Database = _require("better-sqlite3");
  } catch (err) {
    throw new Error(`better-sqlite3 unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (dbPath && dbPath.trim().length > 0) return new Database(dbPath);
  // The default path reuses the resolveDbPath logic of db/index.ts: env var > ~/.wamf-memory-proxy/proxy.db.
  // Not via require ../db/index.js -- ESM fails under tsx -- inline it once directly.
  const os = _require("node:os");
  const path = _require("node:path");
  const fs = _require("node:fs");
  const fromEnv = process.env.PROXY_DB_PATH;
  const resolved =
    fromEnv && fromEnv.trim().length > 0
      ? fromEnv.trim()
      : path.join(os.homedir(), ".wamf-memory-proxy", "proxy.db");
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  return new Database(resolved);
}

function startSweeperIfNeeded(storage: ProxyStorage, config: StorageConfig): void {
  if (storage.type !== "sqlite") return;
  if (_sweepTimer) return; // already running
  const ttlMs = config.ttlDays * 86400 * 1000;
  const run = () => {
    try {
      // Only clear the ttl bucket; nottl is kept permanently.
      (storage as SqliteStorage).sweep({ ttlMs });
    } catch (err) {
      console.warn(`${TAG} sweeper error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  _sweepTimer = setInterval(run, 5 * 60 * 1000);
  // don't hold the event loop just for the sweeper
  if (typeof _sweepTimer.unref === "function") _sweepTimer.unref();
}
