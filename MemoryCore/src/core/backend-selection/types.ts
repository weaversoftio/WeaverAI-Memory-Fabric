/**
 * Backend selection layer (Workstream 5 / full implementation design §4.2) — types only.
 *
 * A resolution answers "which backend + which connection" for one instance,
 * per dimension (DB / FS). It carries no connection behavior; the assembly
 * layer (server.ts, P9) consumes it to instantiate stores/backends.
 *
 * `kind` is explicit — replacing today's implicit "whichever config is
 * non-empty" inference (store-pool.ts getStore). The discriminated unions
 * make illegal kind/conn pairings unrepresentable at compile time (D8
 * layer 1); `validateResolution` re-checks at runtime for data that crosses
 * process boundaries.
 */

import type { MongoConfig } from "../instance-config-provider.js";

export type DbKind = "sqlite" | "mongodb";

/**
 * Env-surface vocabulary for `FILE_STORE_MODE` (input side of the two-axis model final §5 mapping).
 * `rowfs` is the composite form: profile keys as rows + an others leg.
 */
export type FsKind = "local" | "rowfs";

/**
 * Two-axis FS model (two-axis model final, 2026-09-02): an instance's file plane is two
 * orthogonal questions, not one enum.
 *
 * - `profile`: do profile keys (`persona.md`, `scene_blocks/*.md`, i.e. L2/L3)
 *   stay files, or become rows in the DB store?
 * - `others`: which backend serves every other key (conversations/ archives,
 *   .metadata/ checkpoints, offload/ artifacts, skill resources, …)?
 *
 * `profile="files"` → the others backend serves ALL keys (single-backend
 * assembly, the pre-rowfs form). `profile="rows"` → CompositeStorageBackend(
 * ProfileRowStorageBackend, others). `rows` requires `db.kind="mongodb"`.
 */
export type FsProfileMode = "files" | "rows";

/**
 * The others-leg backend kind. `mongofs` keeps every byte in the instance's
 * own Mongo database (zero disk), and is therefore only legal when
 * `db.kind === "mongodb"` (validate.ts).
 */
export type FsOthersKind = "local" | "mongofs";

/**
 * sqlite/local/mongofs carry `conn: null` on purpose:
 * - sqlite/local connection info is process-level (dataDir/baseDir), not per-instance;
 * - mongofs reuses the DB dimension's MongoConfig (its chunks live in the same
 *   instance database as the memory store).
 */
export type DbChoice =
  | { kind: "sqlite"; conn: null }
  | { kind: "mongodb"; conn: MongoConfig };

export type FsOthersChoice =
  | { kind: "local"; conn: null }
  | { kind: "mongofs"; conn: null };

export interface FsChoice {
  profile: FsProfileMode;
  others: FsOthersChoice;
}

export interface BackendResolution {
  db: DbChoice;
  fs: FsChoice;
}

/**
 * Source of per-instance connection configs. Structurally matches
 * `InstanceConfigProvider` (which adds caching/fail-loud semantics), so the
 * provider can be passed directly while tests substitute a fake.
 */
export interface BackendConfigSource {
  resolveMongo(instanceId: string): Promise<MongoConfig>;
}

/**
 * The resolver is an interface so alternative config sources can be plugged
 * in; `LocalBackendResolver` resolves from params/env (STORE_MODE /
 * FILE_STORE_MODE).
 */
export interface BackendResolver {
  resolve(instanceId: string): Promise<BackendResolution>;
}
