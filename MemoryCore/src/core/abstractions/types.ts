/**
 * Edition-neutral abstraction types.
 *
 * IMPORTANT: This file MUST NOT import anything deployment-specific.
 * Keep these contracts vendor-neutral and implementation-neutral.
 *
 * Other interfaces (IStorageBackend) already live alongside their consumers
 * in src/core/storage/types.ts and are re-used as-is.
 */

import type { MongoConfig } from "../instance-config-provider.js";

// ════════════════════════════════════════════════════════
// IConfigSource — per-instance data-plane config provider
// ════════════════════════════════════════════════════════

/**
 * Source of instance configuration (MongoDB connection per instanceId).
 * Implementations decide where the data comes from (env vars, local file,
 * in-memory mock).
 *
 * The default implementation (LocalConfigSource) reads local environment
 * variables.
 */
export interface IConfigSource {
  /** Fetch MongoDB connection info for a given instance. */
  fetchMongo(instanceId: string): Promise<MongoConfig>;
}

// ════════════════════════════════════════════════════════
// IQuotaReporter — outbound usage reporting
// ════════════════════════════════════════════════════════

/**
 * Snapshot of quota limits + current usage for a given instance.
 * Returned by IQuotaReporter.fetchQuota() so QuotaManager can perform
 * quota checks without knowing the data source.
 */
export interface QuotaSnapshot {
  memoryLimit: number;
  creditLimit: number;
  memoryUsage: number;
  creditUsage: number;
}

/**
 * Reporter for memory + credit usage. Implementations decide what to do
 * with reported deltas (post to remote billing, write to log, drop).
 *
 * Default implementations may drop all reports and return unlimited quota.
 * Other deployments may provide a remote quota reporter.
 *
 * Contract notes:
 *   - reportUsage() MUST NOT throw on transport errors; implementations
 *     should swallow and log so business code is never blocked by billing.
 *   - fetchQuota() MAY throw; QuotaManager will fall back to defaults.
 */
export interface IQuotaReporter {
  /**
   * Fetch the current quota snapshot for an instance.
   *
   * @returns null if this reporter does not track quotas (default mode, no quota tracking).
   *          QuotaManager interprets null as "unlimited".
   */
  fetchQuota(instanceId: string): Promise<QuotaSnapshot | null>;

  /**
   * Report a usage delta. Must never throw — failures are logged and
   * swallowed internally by the implementation.
   *
   * @param memoryDelta  +N for newly added memories, -N for deletions
   * @param creditDelta  positive for credit consumption
   * @param level        which memory layer the delta applies to
   */
  reportUsage(
    instanceId: string,
    memoryDelta: number,
    creditDelta: number,
    level: "L0" | "L1" | "L2" | "L3" | "Skill",
  ): Promise<void>;
}
