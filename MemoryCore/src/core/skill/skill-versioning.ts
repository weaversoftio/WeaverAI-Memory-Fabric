/**
 * skill-versioning — transaction orchestration for version increments
 *
 * Wraps the skill-store's `appendVersion` and the storage's `copyTree` into a set of "append a new version" primitives.
 * Simplifies the implementation of the 6 manage actions for SkillCore (Phase 6).
 *
 * One complete "add a version" action:
 *   1. Get head (if any)
 *   2. Validate: owner / version / whether the content changed
 *   3. storage copies head's version directory to the new version directory (if there is a head)
 *   4. Apply this resource change (write/remove) on the new version directory
 *   5. store.appendVersion writes the DB (inside a transaction)
 *   6. On failure, try to clean up the storage copy already written (best-effort)
 */

import { createHash } from "node:crypto";

import type { ISkillStore } from "./skill-store.interface.js";
import { IdempotentNoOpError, SkillStoreError } from "./skill-store.interface.js";
import { SkillResourceStore, SkillResourceError, type SkillResourcePayload } from "./skill-resource-store.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { SkillManifestEntry, Skill } from "./types.js";

function computeContentHash(content: string): string {
  return createHash("md5").update(content, "utf-8").digest("hex");
}

export interface AppendVersionContext {
  user_id?: string;
  team_id?: string;
  agent_id?: string;
  task_id?: string;
}

export interface AppendVersionMutation {
  /** Full text of SKILL.md (including frontmatter). Needed by all write paths (hash check for idempotency). */
  content: string;
  /** name / description extracted from the frontmatter after parsing. */
  name: string;
  description: string;
  /** Resource change: files newly added / overwritten this time. */
  resourcesToWrite?: SkillResourcePayload[];
  /** Resource change: relative paths deleted this time. */
  resourcesToRemove?: string[];
  /** Optional: override metadata_json directly (the previous version is kept by default). */
  metadata_json?: string;
}

export interface SkillVersioningOptions {
  store: ISkillStore;
  resources: SkillResourceStore;
  storage: StorageAdapter;
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  /**
   * Skill row count change callback (for reporting usage to the quota reporter).
   * Triggered after each successful store.appendVersion / store.deleteVersion.
   * @param delta +1 means one skill row was added, -N means N were deleted.
   */
  onSkillRowsChanged?: (delta: number) => void;
  /**
   * Asset registration hook for the first creation of v1.
   *
   * Contract:
   *  - `await`ed before storage and DB writes (up-front consistency protection)
   *  - throwing = createNewSkill fails, neither storage nor DB is written
   *  - the upper-layer implementation must be idempotent (multiple calls for the same skill_id should succeed with no side effects)
   *  - triggered only by `createNewSkill`; neither `appendNextVersion` nor TTL cleanup triggers it
   *    (an asset has nothing to do with versions, it only recognizes skill_id)
   */
  onSkillCreated?: (params: {
    skill_id: string;
    team_id?: string;
    agent_id?: string;
    user_id?: string;
    name: string;
    description: string;
  }) => Promise<void>;
}

export class SkillVersioning {
  private readonly store: ISkillStore;
  private readonly resources: SkillResourceStore;
  private readonly storage: StorageAdapter;
  private readonly logger?: SkillVersioningOptions["logger"];
  private readonly onSkillRowsChanged?: (delta: number) => void;
  private readonly onSkillCreated?: SkillVersioningOptions["onSkillCreated"];

  constructor(opts: SkillVersioningOptions) {
    this.store = opts.store;
    this.resources = opts.resources;
    this.storage = opts.storage;
    this.logger = opts.logger;
    this.onSkillRowsChanged = opts.onSkillRowsChanged;
    this.onSkillCreated = opts.onSkillCreated;
  }

  /**
   * Create the v1 of a brand-new skill. The head does not exist; the caller is responsible for generating skill_id.
   *
   * Cross-system "transaction" orchestration (file storage + skill DB + meta_assets):
   *
   *   1. writeResource → storage            ← the least reliable, do it first; failure has zero DB side effects
   *   2. store.appendVersion → skill DB    ← on failure: clean storage in reverse (cleanupVersionDir)
   *   3. onSkillCreated → meta_assets      ← on failure: delete the skill DB in reverse (deleteSkill) + clean object storage
   *
   * Why this order: across 3 systems there is no true transaction, only "ordering + compensation". The principle is
   * **do the most failure-prone first, do the zero-side-effect-on-failure first, finish with the reliable**. File storage is the most fragile (network/
   * auth/permissions), the skill DB is a local transaction that almost never fails, and the asset involves agent lookups/team
   * validation/multi-table writes but is also a local DB. The original "asset first" implementation violated this principle: there was once
   * an orphan state where storage auth broke → the skill was not persisted → yet the asset table already had a row.
   *
   * Extreme cases (rollback in steps 2/3 also fails):
   *   - an orphan skill (skill persisted but asset missing) is healed by `onSkillAccessed` self-healing registration on read,
   *     and the user's next get/readFile will fill it in. A closed loop exists.
   *   - orphan storage files only take up space; the read path all goes through the DB, so they will never be read by mistake.
   */
  async createNewSkill(
    skillId: string,
    ownerAgentId: string,
    ctx: AppendVersionContext,
    mut: AppendVersionMutation,
  ): Promise<Skill> {
    const newVersion = 1;
    const storageDir = this.resources.versionDir(skillId, newVersion);

    // Aggregate validation of the whole skill's total size (design §3.5.1: ≤ 50MB) - pure computation, zero side effects.
    if (mut.resourcesToWrite && mut.resourcesToWrite.length > 0) {
      this.resources.assertTotalSize([], mut.resourcesToWrite, []);
    }

    // ── Step 1: write storage (do the most fragile step first, failure has zero side effects) ─────────────────────
    let manifest: SkillManifestEntry[] = [];
    if (mut.resourcesToWrite && mut.resourcesToWrite.length > 0) {
      try {
        for (const p of mut.resourcesToWrite) {
          const entry = await this.resources.writeResource(skillId, newVersion, p);
          manifest.push(entry);
        }
      } catch (e) {
        // Some files may already be written; best-effort cleanup of the whole version directory
        await this.cleanupVersionDir(storageDir).catch(() => { /* ignore */ });
        throw e;
      }
    }

    // ── Step 2: write the skill DB (local transaction, almost never fails; on failure clean storage in reverse) ────
    let row: Skill;
    try {
      row = await this.store.appendVersion({
        user_id: ctx.user_id,
        team_id: ctx.team_id,
        agent_id: ctx.agent_id,
        task_id: ctx.task_id,
        skill_id: skillId,
        name: mut.name,
        description: mut.description,
        content: mut.content,
        content_hash: computeContentHash(mut.content),
        manifest,
        storage_dir: storageDir,
        owner_agent_id: ownerAgentId,
        metadata_json: mut.metadata_json,
      });
    } catch (e) {
      await this.cleanupVersionDir(storageDir).catch(() => { /* ignore */ });
      throw e;
    }

    // ── Step 3: register meta_assets (agent/team validation + createAsset + bind) ──
    //  On failure → delete the skill DB in reverse (deleteSkill) → clean storage in reverse → throw the business error back.
    //  onSkillCreated not injected (e.g. wamf-core did not mount the hook) → skip directly.
    if (this.onSkillCreated) {
      try {
        await this.onSkillCreated({
          skill_id: skillId,
          team_id: ctx.team_id,
          agent_id: ctx.agent_id,
          user_id: ctx.user_id,
          name: mut.name,
          description: mut.description,
        });
      } catch (assetErr) {
        // Delete the skill DB in reverse. deleteSkill itself may also fail (DB down),
        // but the probability is extremely low; even if it fails, onSkillAccessed's self-healing on read can converge the orphan skill.
        // reportRowsDelta=false: +1 was never reported (reported only after step 3); if the rollback
        // reported -1, the quota bookkeeping would show a negative deviation.
        try {
          await this.deleteSkill(skillId, ctx.team_id, { reportRowsDelta: false });
        } catch (rollbackErr) {
          this.logger?.error(
            `[skill-tx] rollback deleteSkill failed for ${skillId} (team=${ctx.team_id ?? "-"}): ` +
              (rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)),
          );
        }
        // The storage directory is already cleaned inside deleteSkill (listVersions → rmdir), not repeated here.
        // But if deleteSkill did not reach the storage cleanup because the DB was down, clean once more as a fallback.
        await this.cleanupVersionDir(storageDir).catch(() => { /* ignore */ });
        throw assetErr;
      }
    }

    // All system writes succeeded → report the row delta
    this.onSkillRowsChanged?.(1);
    return row;
  }

  /**
   * Append a new version on top of an existing head. The head must exist (the caller first calls store.getHead to get it).
   *
   * Content unchanged (same content_hash) and no resource change → return head (idempotent, no storage / DB write).
   */
  async appendNextVersion(
    head: Skill,
    ctx: AppendVersionContext,
    mut: AppendVersionMutation,
  ): Promise<Skill> {
    const newVersion = head.version + 1;
    const newStorageDir = this.resources.versionDir(head.skill_id, newVersion);
    const oldStorageDir = head.storage_dir;
    const newContentHash = computeContentHash(mut.content);

    const noContentChange = newContentHash === head.content_hash;
    const noResourceChange =
      (!mut.resourcesToWrite || mut.resourcesToWrite.length === 0) &&
      (!mut.resourcesToRemove || mut.resourcesToRemove.length === 0);

    if (noContentChange && noResourceChange) {
      return head; // idempotent
    }

    // Aggregate validation of the whole skill's total size (design §3.5.1: ≤ 50MB).
    if (
      (mut.resourcesToWrite && mut.resourcesToWrite.length > 0) ||
      (mut.resourcesToRemove && mut.resourcesToRemove.length > 0)
    ) {
      this.resources.assertTotalSize(
        head.manifest,
        mut.resourcesToWrite,
        mut.resourcesToRemove,
      );
    }

    // 1) Copy the old version directory to the new version directory (if the old version has content)
    try {
      await this.storage.copyTree(oldStorageDir, newStorageDir);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // If the old version has no directory at all (the old skill was created without resources), skip the copy
      if (!/STORAGE_NOT_FOUND/.test(msg)) {
        throw e;
      }
    }

    // 2) Apply the resource changes on the new version directory
    let manifest: SkillManifestEntry[] = [...head.manifest];
    try {
      if (mut.resourcesToRemove) {
        for (const p of mut.resourcesToRemove) {
          await this.resources.removeResource(head.skill_id, newVersion, p);
          manifest = manifest.filter((m) => m.path !== p);
        }
      }
      if (mut.resourcesToWrite) {
        for (const p of mut.resourcesToWrite) {
          const entry = await this.resources.writeResource(head.skill_id, newVersion, p);
          // Merge into the manifest (overwrite the same path)
          manifest = manifest.filter((m) => m.path !== entry.path);
          manifest.push(entry);
        }
      }
    } catch (e) {
      await this.cleanupVersionDir(newStorageDir).catch(() => { /* ignore */ });
      throw e;
    }

    // 3) Write the DB (inside a transaction + fts sync)
    try {
      const row = await this.store.appendVersion({
        user_id: ctx.user_id,
        team_id: ctx.team_id,
        agent_id: ctx.agent_id,
        task_id: ctx.task_id,
        skill_id: head.skill_id,
        name: mut.name,
        description: mut.description,
        content: mut.content,
        content_hash: newContentHash,
        manifest,
        storage_dir: newStorageDir,
        owner_agent_id: head.owner_agent_id,
        metadata_json: mut.metadata_json ?? head.metadata_json,
      });
      this.onSkillRowsChanged?.(1);
      return row;
    } catch (e) {
      // DB failure → clean up the new directory just copied
      // Note: store.appendVersion no longer does hash idempotency (handled by this class's early short-circuit),
      // so it will not throw IdempotentNoOpError; the type is still exported so external code can import from one place.
      await this.cleanupVersionDir(newStorageDir).catch(() => { /* ignore */ });
      throw e;
    }
  }

  // ─────────────────────────────────────────────────
  //  helpers
  // ─────────────────────────────────────────────────

  private async cleanupVersionDir(dir: string): Promise<void> {
    if (!dir) return;
    try { await this.storage.rmdir(dir); } catch { /* ignore */ }
  }

  // ─────────────────────────────────────────────────
  //  True delete: delete all versions of a skill in one go (including storage and quota reporting)
  // ─────────────────────────────────────────────────

  /**
   * Physically delete a whole skill (including all version rows + the storage directory of each version).
   *
   * Orchestration semantics:
   *   1. First listVersions to get the storage_dir of all versions (the DB is the authoritative source, read before delete)
   *   2. store.deleteAllVersions - DELETE all version rows in one go + clean fts / vec
   *   3. rmdir storage version by version (failures only warn, no DB rollback)
   *   4. Report `onSkillRowsChanged(-N)` once in aggregate (N = number of rows actually deleted)
   *      - unlike the TTL path, which reports `onSkillRowsChanged(-1)` per row, delete reports in one block,
   *      reducing reporter calls; semantically both accumulate the same delta.
   *
   * Returns the number of rows actually deleted. When the skill does not exist returns 0 and does not report (to avoid false reporting).
   *
   * Permission checks (team_id / owner / expected_version) are done by the caller SkillCore.delete.
   * This method does no business-rule validation, only physical cleanup by (skill_id, team_id).
   */
  async deleteSkill(
    skillId: string,
    teamId?: string,
    opts?: {
      /**
       * Whether to report the row delta. Default true (normal delete path).
       * The rollback path of createNewSkill should pass false - because the corresponding +1 was never reported
       * (+1 is sent only after all three steps of create are green), and reporting -N again in rollback would make
       * the quota bookkeeping show a negative deviation.
       */
      reportRowsDelta?: boolean;
    },
  ): Promise<number> {
    const reportDelta = opts?.reportRowsDelta ?? true;

    // 1. First pull the metadata of all versions (to get storage_dir). listVersions caps at 1000,
    //    and the number of versions of a single skill is far below this under TTL protection + business limits.
    const versions = await this.store.listVersions(skillId, teamId, { limit: 1000, offset: 0 });

    // 2. Physically delete the DB rows
    const deleted = await this.store.deleteAllVersions(skillId, teamId);
    if (deleted <= 0) {
      // Nothing was deleted (skill does not exist / team mismatch) → do not report, do not clean storage
      return 0;
    }

    // 3. Clean the storage directories (failures only warn) - use the dirs obtained from listVersions,
    //    rather than assembling paths, tolerating inconsistent storage_dir naming of historical versions.
    for (const v of versions) {
      if (!v.storage_dir) continue;
      try {
        await this.storage.rmdir(v.storage_dir);
      } catch {
        this.logger?.warn(`[skill-delete] storage rmdir failed for ${v.storage_dir}`);
      }
    }

    // 4. Report to the quota reporter once (-N); not reported on the rollback path (see the opts comment)
    if (reportDelta) {
      this.onSkillRowsChanged?.(-deleted);
    }

    return deleted;
  }

  // ─────────────────────────────────────────────────
  //  TTL: clean expired old versions after a write
  // ─────────────────────────────────────────────────

  private static readonly KEEP_RECENT = 3;

  /**
   * Clean the expired non-head versions of the given skill (delete DB rows first, then storage directories).
   * Called fire-and-forget, never throws.
   */
  async cleanupExpiredVersionsForSkill(
    skillId: string,
    ttlSeconds: number,
    now?: number,
  ): Promise<void> {
    if (ttlSeconds <= 0) return;

    const nowMs = now ?? Date.now();
    const cutoffMs = nowMs - ttlSeconds * 1000;
    const all = await this.store.listVersions(skillId);
    if (!all.length) return;

    // Archived skill is protected as a whole group
    const head = all.find((v) => v.is_head);
    if (!head || head.status === "archived") return;

    // version DESC
    const sorted = [...all].sort((a, b) => b.version - a.version);
    // KEEP_RECENT protects the most recent N non-head versions (even if expired)
    const protectedVersions = new Set(
      sorted.filter((v) => !v.is_head).slice(0, SkillVersioning.KEEP_RECENT).map((v) => v.version),
    );

    for (const v of sorted) {
      if (v.is_head) continue;
      if (protectedVersions.has(v.version)) continue;
      if (v.created_at_ms >= cutoffMs) continue;

      // Delete DB rows first (the data source), then storage directories (the attachment)
      const deleted = await this.store.deleteVersion(v.skill_id, v.version);
      if (!deleted) continue;

      // Report the row deletion (negative value)
      this.onSkillRowsChanged?.(-1);

      // A storage deletion failure is only logged, and does not affect the correctness of the DB
      try {
        await this.storage.rmdir(v.storage_dir);
      } catch {
        this.logger?.warn(`[skill-ttl] storage rmdir failed for ${v.storage_dir}`);
      }
    }
  }

}

// Re-export the error types so upper layers can import from one place
export { IdempotentNoOpError, SkillStoreError, SkillResourceError };
