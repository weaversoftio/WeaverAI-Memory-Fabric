/**
 * `LocalBackendResolver` (P8 / full implementation design §5.3.1): resolve from process
 * parameters/env — the resolver used for both standalone and service deployments.
 *
 * Fallback semantics:
 * - no explicit override → per-deploy-mode default
 *   (standalone: sqlite+local; service: mongodb+rowfs/mongofs);
 * - source throws / returns nothing → fail-fast (resolveMongo already throws;
 *   never silently fall to sqlite).
 *
 * `storeMode` / `fileStore` are the process-level explicit overrides
 * (STORE_MODE / FILE_STORE_MODE).
 */

import type {
  BackendConfigSource,
  BackendResolution,
  BackendResolver,
  DbChoice,
  DbKind,
  FsChoice,
  FsKind,
  FsOthersKind,
} from "./types.js";
import { validateResolution } from "./validate.js";

export interface LocalBackendResolverDeps {
  deployMode: "standalone" | "service";
  /** STORE_MODE explicit override; undefined → per-mode default. */
  storeMode?: DbKind | undefined;
  /** FILE_STORE_MODE explicit override; undefined → per-mode default. */
  fileStore?: FsKind | undefined;
  /**
   * FILE_STORE_OTHERS explicit override (only meaningful with
   * fileStore="rowfs"); undefined → per-mode default (standalone → local,
   * service → mongofs).
   */
  fileStoreOthers?: FsOthersKind | undefined;
  source: BackendConfigSource;
}

export class LocalBackendResolver implements BackendResolver {
  private readonly deps: LocalBackendResolverDeps;

  constructor(deps: LocalBackendResolverDeps) {
    this.deps = deps;
  }

  async resolve(instanceId: string): Promise<BackendResolution> {
    const db = await this.resolveDb(instanceId);
    const fs = this.resolveFs();
    const resolution: BackendResolution = { db, fs };
    validateResolution(resolution);
    return resolution;
  }

  private async resolveDb(instanceId: string): Promise<DbChoice> {
    const kind: DbKind =
      this.deps.storeMode ?? (this.deps.deployMode === "service" ? "mongodb" : "sqlite");
    switch (kind) {
      case "sqlite":
        return { kind, conn: null };
      case "mongodb":
        return { kind, conn: await this.deps.source.resolveMongo(instanceId) };
    }
  }

  private resolveFs(): FsChoice {
    // Env surface (FILE_STORE_MODE / FILE_STORE_OTHERS) → two-axis model
    // (two-axis model final §5 mapping): local is the single-backend form
    // (profile=files, the others leg serves every key); rowfs is the
    // composite form (profile=rows + an others leg).
    const mode: FsKind =
      this.deps.fileStore ?? (this.deps.deployMode === "service" ? "rowfs" : "local");
    switch (mode) {
      case "local":
        return { profile: "files", others: { kind: "local", conn: null } };
      case "rowfs": {
        const othersKind: FsOthersKind =
          this.deps.fileStoreOthers ??
          (this.deps.deployMode === "service" ? "mongofs" : "local");
        switch (othersKind) {
          case "local":
            return { profile: "rows", others: { kind: "local", conn: null } };
          case "mongofs":
            return { profile: "rows", others: { kind: "mongofs", conn: null } };
        }
      }
    }
  }
}
