/**
 * AutoSyncScheduler — periodically pulls git repos and updates the codegraph index.
 *
 * Model: FIFO queue + fixed-size worker pool.
 *   - Scanner: scans all ready repos once every scanIntervalMs;
 *     de-duplicates with a Set (skipping those already queued or being handled by a worker) before pushing onto the in-memory queue.
 *   - Workers: maxConcurrentSyncs resident coroutines take tasks from the queue in FIFO order and call
 *     CodeGraphService.sync(); they poll while the queue is empty and exit naturally after stop.
 *
 * Per-repo sync frequency = max(duration of one sync, scanIntervalMs). There is no extra cooldown field --
 * to control the frequency, simply tune SCAN_INTERVAL_MIN.
 *
 * Design goals (from the requirements):
 *   1. Periodically detect git repo updates, automatically pull the latest code and rebuild the codegraph index
 *   2. Use a task queue to prevent bursts of pulls from overwhelming the service (concurrency is hard-limited by the worker count)
 *   3. Repos that are queued or in progress are not enqueued again (Set de-duplication; queue size upper bound = number of repos)
 *   4. A sync failure of one repo does not affect the others (workers swallow exceptions and keep consuming)
 *   5. Reuse the existing busy/not_found rejection semantics of CodeGraphService.sync()
 *
 * Environment variable configuration:
 *   - KNOWLEDGE_AUTO_SYNC_ENABLED: enable switch (default: false)
 *   - KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN: scan period in minutes (default: 10)
 *   - KNOWLEDGE_AUTO_SYNC_MAX_CONCURRENT: global maximum number of concurrent syncs (default: 3)
 */

import { createLogger } from "../logger.js";
import type { CodeGraphService, SyncResult } from "./code-graph-service.js";
import type { IKnowledgeStore, CodeGraphRow } from "./types.js";

const log = createLogger("auto-sync-scheduler");

// ───────────────────────── Configuration ─────────────────────────

export interface AutoSyncConfig {
  /** Whether auto-sync is enabled. Default false (must be turned on explicitly). */
  enabled: boolean;
  /** Main-loop scan period (milliseconds). Default 10 minutes. */
  scanIntervalMs: number;
  /** Global maximum number of concurrent syncs (= number of workers). Default 3. */
  maxConcurrentSyncs: number;
}

const MIN_MS = 60 * 1000;
/** Polling interval (ms) when a worker is idle. Can also be advanced under fake timers in tests. */
const WORKER_IDLE_POLL_MS = 100;

/**
 * Parse config from environment variables, with fallback defaults.
 * All numeric fields are clamped to prevent unreasonable configs.
 */
export function resolveAutoSyncConfig(env: Record<string, string | undefined> = process.env): AutoSyncConfig {
  const enabled = parseBoolean(env.KNOWLEDGE_AUTO_SYNC_ENABLED, false);
  const scanIntervalMin = clamp(parseFloat(env.KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN ?? "") || 10, 1, 60);
  const maxConcurrent = clamp(parseInt(env.KNOWLEDGE_AUTO_SYNC_MAX_CONCURRENT ?? "") || 3, 1, 20);

  return {
    enabled,
    scanIntervalMs: scanIntervalMin * MIN_MS,
    maxConcurrentSyncs: maxConcurrent,
  };
}

// ───────────────────────── Scheduler ─────────────────────────

export interface AutoSyncSchedulerDeps {
  store: IKnowledgeStore;
  cgService: CodeGraphService;
  config: AutoSyncConfig;
}

export interface AutoSyncStatus {
  /** Whether the scheduler has been started (and not stopped). */
  running: boolean;
  /** Number of sync tasks currently being executed by workers. */
  activeSyncs: number;
  /** Number of repos waiting in the queue. */
  queueLength: number;
  /** Whether the previous scan round is still in progress (avoids re-entry). */
  scanning: boolean;
}

export class AutoSyncScheduler {
  private readonly store: IKnowledgeStore;
  private readonly cgService: CodeGraphService;
  private readonly config: AutoSyncConfig;

  /** Timer for the startup delay + periodic scan. */
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  /** Set of timers for idle worker sleeps (cleaned up together on stop). */
  private readonly workerSleepTimers = new Set<ReturnType<typeof setTimeout>>();

  /** FIFO pending queue + de-duplication Set (ids in the queue + in progress). */
  private readonly queue: CodeGraphRow[] = [];
  private readonly inFlight = new Set<string>();

  /** Number of workers currently executing a sync. */
  private activeSyncs = 0;
  /** Number of workers (resident). */
  private workerCount = 0;
  /** Stop flag. After stop the worker loops exit. */
  private stopped = true;
  /** Whether the previous scan round is still in progress. */
  private scanning = false;

  constructor(deps: AutoSyncSchedulerDeps) {
    this.store = deps.store;
    this.cgService = deps.cgService;
    this.config = deps.config;
  }

  /**
   * Start scheduling:
   *   - first scan delayed by 30s (let restore finish first, to avoid contending for disk)
   *   - periodic scan every scanIntervalMs
   *   - start maxConcurrentSyncs resident workers
   */
  start(): void {
    if (!this.config.enabled) {
      log.info("[auto-sync] disabled by config, skipping start");
      return;
    }
    if (!this.stopped) {
      log.warn("[auto-sync] already started");
      return;
    }
    this.stopped = false;
    log.info("[auto-sync] starting scheduler", {
      scanIntervalMs: this.config.scanIntervalMs,
      maxConcurrentSyncs: this.config.maxConcurrentSyncs,
    });

    // Start the resident worker pool
    for (let i = 0; i < this.config.maxConcurrentSyncs; i++) {
      this.workerCount++;
      void this.runWorker(i).finally(() => { this.workerCount--; });
    }

    // Delay the first scan by 30s
    const startupDelay = 30_000;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.stopped) return;
      void this.scan();
      this.scanTimer = setInterval(() => {
        if (this.stopped) return;
        void this.scan();
      }, this.config.scanIntervalMs);
    }, startupDelay);
    log.info(`[auto-sync] first scan in ${startupDelay / 1000}s`);
  }

  /** Stop the scheduler: cancel timers and tell workers to exit (syncs already running finish naturally). */
  stop(): void {
    this.stopped = true;
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.scanTimer !== null) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    for (const t of this.workerSleepTimers) clearTimeout(t);
    this.workerSleepTimers.clear();
    log.info("[auto-sync] stopped");
  }

  /** State snapshot (used by the admin API). */
  getStatus(): AutoSyncStatus {
    return {
      running: !this.stopped,
      activeSyncs: this.activeSyncs,
      queueLength: this.queue.length,
      scanning: this.scanning,
    };
  }

  /** Manually trigger one scan round (used by the admin API). Does not affect the periodic cycle. No-op when disabled. */
  triggerScan(): void {
    if (!this.config.enabled) {
      log.warn("[auto-sync] cannot trigger: scheduler is disabled");
      return;
    }
    log.info("[auto-sync] manual scan triggered");
    void this.scan();
  }

  // ───────────────────────── Core scan loop ─────────────────────────

  /**
   * One scan round:
   *   1. List all code-graphs in ready state
   *   2. De-duplicate with the inFlight Set (those queued / in progress are not enqueued again)
   *   3. FIFO push onto the queue; workers consume automatically
   */
  private async scan(): Promise<void> {
    if (this.scanning) {
      log.debug("[auto-sync] previous scan still running, skip this round");
      return;
    }
    this.scanning = true;
    try {
      log.info("[auto-sync] scan started");

      const candidates = this.listSyncCandidates();
      if (candidates.length === 0) {
        log.info("[auto-sync] no ready repos");
        return;
      }

      let enqueued = 0;
      for (const row of candidates) {
        if (this.stopped) break;
        if (this.inFlight.has(row.code_graph_id)) continue; // already queued or in progress
        this.inFlight.add(row.code_graph_id);
        this.queue.push(row);
        enqueued++;
      }
      log.info(`[auto-sync] enqueued ${enqueued} repo(s) (queue=${this.queue.length}, active=${this.activeSyncs})`);
    } catch (err) {
      log.error(`[auto-sync] scan error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * List the code-graphs that need syncing: pick only those with status = ready.
   * Repos already queued or being handled by a worker are de-duplicated by the inFlight Set in scan() and not enqueued again;
   * the per-repo sync cadence is naturally determined by max(sync duration, scanIntervalMs), no extra cooldown needed.
   */
  private listSyncCandidates(): CodeGraphRow[] {
    const syncedRefs = this.store.listSyncedCodeGraphs();
    if (syncedRefs.length === 0) return [];

    const candidates: CodeGraphRow[] = [];
    for (const ref of syncedRefs) {
      try {
        const row = this.store.getCodeGraph(ref.service_id, ref.team_id, ref.code_graph_id);
        if (!row) continue;
        if (row.status !== "ready") continue;
        candidates.push(row);
      } catch (err) {
        log.warn(`[auto-sync] failed to check ${ref.code_graph_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return candidates;
  }

  // ───────────────────────── Worker pool ─────────────────────────

  /**
   * One resident worker: loops shifting the queue to run syncs; if empty, sleeps briefly and retries.
   * After stop() the loop exits naturally. Exceptions are always swallowed (and logged), so the worker never dies.
   */
  private async runWorker(workerIdx: number): Promise<void> {
    log.debug(`[auto-sync] worker#${workerIdx} started`);
    while (!this.stopped) {
      const row = this.queue.shift();
      if (!row) {
        await this.sleep(WORKER_IDLE_POLL_MS);
        continue;
      }

      this.activeSyncs++;
      try {
        await this.syncOne(row);
      } catch (err) {
        // syncOne already catches internally; this is a fallback
        log.error(`[auto-sync] worker#${workerIdx} unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.activeSyncs--;
        this.inFlight.delete(row.code_graph_id);
      }
    }
    log.debug(`[auto-sync] worker#${workerIdx} exiting`);
  }

  /** Run sync on a single code-graph (reusing the discriminated union of CodeGraphService.sync). */
  private async syncOne(row: CodeGraphRow): Promise<void> {
    const startMs = Date.now();
    log.info(`[auto-sync] sync ${row.code_graph_id} (${row.repo_url}@${row.branch})`);
    try {
      // CodeGraphService.sync currently returns a SyncResult synchronously; await is compatible with a future async change or a test mock.
      const result: SyncResult = await Promise.resolve(
        this.cgService.sync(row.service_id, row.team_id, row.code_graph_id, undefined),
      );
      const durationMs = Date.now() - startMs;
      switch (result.kind) {
        case "ok":
          log.info(`[auto-sync] sync enqueued for ${row.code_graph_id} (took ${durationMs}ms)`);
          break;
        case "busy":
          log.debug(`[auto-sync] skip ${row.code_graph_id}: already ${result.status} (step: ${result.step})`);
          break;
        case "not_found":
          log.warn(`[auto-sync] skip ${row.code_graph_id}: not found (may have been deleted)`);
          break;
      }
    } catch (err) {
      log.error(`[auto-sync] sync failed for ${row.code_graph_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** setTimeout-based sleep, cleaned up together on stop to avoid timer leaks in test environments. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.workerSleepTimers.delete(t);
        resolve();
      }, ms);
      this.workerSleepTimers.add(t);
    });
  }
}

// ───────────────────────── Helpers ─────────────────────────

function parseBoolean(val: string | undefined, fallback: boolean): boolean {
  if (val == null || val.trim() === "") return fallback;
  const v = val.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}
