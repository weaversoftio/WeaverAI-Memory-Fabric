/**
 * Panel API call audit -- optional ClickHouse reporting.
 *
 * - enabled=false or url empty -> return a NoOp instance, zero overhead and zero side effects
 * - enabled=true + valid url -> connect to CH, auto-create tables + schema self-healing, buffered batch writes
 * - write failures do not block requests; re-enqueue + overflow protection
 *
 * ## Schema self-healing (dynamic fields)
 * On every startup, ensureSchema() in initialize() will:
 *   1. `DESCRIBE {table}` to get the existing columns
 *   2. compare with EXPECTED_COLUMNS and add missing columns (ALTER ADD COLUMN IF NOT EXISTS)
 *   3. ALTER is a lightweight metadata change in CH, completes in seconds, and does not rewrite data
 * To add a field later, just append a row to EXPECTED_COLUMNS; it takes effect automatically on restart.
 *
 * ## Historical user_id backfill
 * After initialize(), maybeBackfillUserId() runs asynchronously:
 *   - the telemetry_meta table records backfill_version_user_id
 *   - it only runs when the version is behind CURRENT_BACKFILL_VERSION
 *   - scan DISTINCT user_key WHERE user_id='' -> look up the cache one by one -> ALTER TABLE UPDATE
 *   - after completion, write the version number; skipped on the next startup
 *
 * Follows the raw fetch pattern of MemoryKnowledge/src/clickhouse-telemetry.ts, with no external dependencies.
 */

import type { PanelClickHouseConfig } from '../config/panel-config.js';
import type { Logger } from './logger.js';
import type { PanelUserIdResolver, UserIdResolveCtx } from './user-id-resolver.js';

// -- Data row --------------------------------------------------------------

export interface ApiCallLogRow {
  timestamp: string;
  instance_id: string;
  user_key: string;
  user_id: string;
  endpoint: string;
  http_method: string;
  http_status: number;
  duration_ms: number;
  request_id: string;
  host: string;
}

// -- Schema self-healing ---------------------------------------------------

/**
 * List of expected table columns. ensureSchema compares it with the DESCRIBE result and adds whatever is missing.
 * **To add a field, just append a row**: write name + a ddl fragment (without a comma),
 * and ensureSchema assembles `ALTER TABLE ... ADD COLUMN IF NOT EXISTS <name> <ddl>`.
 */
export const EXPECTED_COLUMNS: Array<{ name: string; ddl: string }> = [
  // user_id has existed since the first version of the table; it is listed to prevent omissions; skipped by ensureSchema when it already exists
  { name: 'user_id', ddl: "String DEFAULT ''" },
];

/** Current version number of the user_id backfill stored in telemetry_meta(key, value). Bump it to rerun once. */
const CURRENT_BACKFILL_VERSION = '1';
const BACKFILL_VERSION_KEY = 'backfill_version_user_id';

// -- Interface -------------------------------------------------------------

export interface PanelApiCallTelemetry {
  /** Create tables (idempotent) + schema self-healing + start the periodic flush. Non-blocking; failures only warn. */
  initialize(): Promise<void>;
  /**
   * After table creation + schema self-healing complete, optionally run the historical user_id backfill in the background.
   * A separate method for ease of testing; main() calls it once, fire-and-forget, after initialize.
   */
  runBackfillIfNeeded(resolver: PanelUserIdResolver): Promise<void>;
  /** Record one row. Synchronous, non-blocking, never throws. */
  record(row: ApiCallLogRow): void;
  /** Graceful shutdown: flush the remainder + clear the timer. */
  shutdown(): Promise<void>;
}

// -- NoOp implementation ---------------------------------------------------

class DisabledPanelApiCallTelemetry implements PanelApiCallTelemetry {
  async initialize(): Promise<void> { /* noop */ }
  async runBackfillIfNeeded(_resolver: PanelUserIdResolver): Promise<void> { /* noop */ }
  record(_row: ApiCallLogRow): void { /* noop */ }
  async shutdown(): Promise<void> { /* noop */ }
}

// -- ClickHouse implementation ---------------------------------------------

const MAX_BUFFER_ROWS = 10_000;
const RETAINED_BUFFER_ROWS = 5_000;

class ClickHousePanelApiCallTelemetry implements PanelApiCallTelemetry {
  private buffer: ApiCallLogRow[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private initialized = false;

  constructor(
    private readonly config: PanelClickHouseConfig,
    private readonly logger: Logger,
    private readonly instanceCtxProvider: (instanceId: string) => UserIdResolveCtx | null,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async initialize(): Promise<void> {
    try {
      await this.ensureTable();
      await this.ensureSchema();
      await this.ensureMetaTable();
      this.initialized = true;
      this.timer = setInterval(() => void this.flush(), this.config.flushIntervalMs);
      this.timer.unref();
      this.logger.info('[api-call-telemetry] initialized', {
        database: this.config.database,
        table: this.config.table,
      });
    } catch (err) {
      this.logger.warn('[api-call-telemetry] initialize failed (telemetry disabled)', {
        error: (err as Error).message,
      });
    }
  }

  async runBackfillIfNeeded(resolver: PanelUserIdResolver): Promise<void> {
    if (!this.initialized) return;
    try {
      const done = await this.readMeta(BACKFILL_VERSION_KEY);
      if (done === CURRENT_BACKFILL_VERSION) {
        this.logger.debug('[api-call-telemetry] user_id backfill already done', {
          version: done,
        });
        return;
      }
      this.logger.info('[api-call-telemetry] starting user_id backfill', {
        currentVersion: done ?? '(none)',
        targetVersion: CURRENT_BACKFILL_VERSION,
      });
      const changed = await this.backfillUserIds(resolver);
      await this.writeMeta(BACKFILL_VERSION_KEY, CURRENT_BACKFILL_VERSION);
      this.logger.info('[api-call-telemetry] user_id backfill done', {
        version: CURRENT_BACKFILL_VERSION,
        userKeysMigrated: changed,
      });
    } catch (err) {
      this.logger.warn('[api-call-telemetry] user_id backfill failed', {
        error: (err as Error).message,
      });
    }
  }

  record(row: ApiCallLogRow): void {
    if (!this.initialized) return;
    try {
      this.buffer.push(row);
      if (this.buffer.length > MAX_BUFFER_ROWS) {
        this.buffer = this.buffer.slice(-RETAINED_BUFFER_ROWS);
      }
      if (this.buffer.length >= this.config.flushThreshold) {
        void this.flush();
      }
    } catch {
      // Never throw -- auditing must not affect business
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    // New rows may be enqueued during the flush
    if (this.buffer.length > 0) {
      await this.flush();
    }
  }

  // -- Internal --

  private async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.length === 0) return;
    this.flushing = this.doFlush();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  private async doFlush(): Promise<void> {
    const rows = this.buffer.splice(0);
    if (rows.length === 0) return;
    try {
      await this.insertRows(rows);
    } catch (err) {
      this.logger.warn('[api-call-telemetry] flush failed, requeuing', {
        error: (err as Error).message,
        dropped: rows.length,
      });
      // Re-enqueue at the head
      this.buffer.unshift(...rows);
      if (this.buffer.length > MAX_BUFFER_ROWS) {
        this.buffer = this.buffer.slice(-RETAINED_BUFFER_ROWS);
      }
    }
  }

  private async insertRows(rows: ApiCallLogRow[]): Promise<void> {
    const payload = rows.map((r) => JSON.stringify(r)).join('\n');
    const qualifiedTable = `${this.config.database}.${this.config.table}`;
    await this.executeQuery(
      `INSERT INTO ${qualifiedTable} FORMAT JSONEachRow`,
      payload,
    );
  }

  private async ensureTable(): Promise<void> {
    const ttlClause = this.config.ttlDays > 0
      ? `TTL toDateTime(timestamp) + INTERVAL ${this.config.ttlDays} DAY`
      : '';

    const ddl = [
      `CREATE TABLE IF NOT EXISTS ${this.config.database}.${this.config.table} (`,
      "  timestamp DateTime64(3, 'UTC'),",
      '  instance_id String,',
      '  user_key String,',
      "  user_id String DEFAULT '',",
      '  endpoint String,',
      '  http_method LowCardinality(String),',
      '  http_status UInt16 DEFAULT 0,',
      '  duration_ms UInt32 DEFAULT 0,',
      '  request_id String,',
      '  host LowCardinality(String)',
      ') ENGINE = MergeTree()',
      'ORDER BY (instance_id, timestamp)',
      ttlClause,
    ].filter(Boolean).join('\n');

    await this.executeQuery(ddl);
  }

  /**
   * Schema self-healing: align EXPECTED_COLUMNS with the actual columns of the online table, adding whatever is missing.
   * Handles old instances that may lack new fields -- to add fields in the future, just append to EXPECTED_COLUMNS.
   */
  private async ensureSchema(): Promise<void> {
    const existing = await this.queryExistingColumns();
    for (const col of EXPECTED_COLUMNS) {
      if (existing.has(col.name)) continue;
      const alter = `ALTER TABLE ${this.config.database}.${this.config.table} ` +
        `ADD COLUMN IF NOT EXISTS ${col.name} ${col.ddl}`;
      try {
        await this.executeQuery(alter);
        this.logger.info('[api-call-telemetry] added column', {
          column: col.name,
          ddl: col.ddl,
        });
      } catch (err) {
        // An ALTER failure only warns and does not stop: it may be a permission/version difference and does not affect INSERT
        this.logger.warn('[api-call-telemetry] add column failed', {
          column: col.name,
          error: (err as Error).message,
        });
      }
    }
  }

  private async queryExistingColumns(): Promise<Set<string>> {
    const sql = `SELECT name FROM system.columns ` +
      `WHERE database = '${this.config.database}' AND table = '${this.config.table}' ` +
      `FORMAT JSONEachRow`;
    const text = await this.queryText(sql);
    const cols = new Set<string>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { name?: string };
        if (row.name) cols.add(row.name);
      } catch {
        // ignore malformed lines
      }
    }
    return cols;
  }

  private async ensureMetaTable(): Promise<void> {
    const ddl = `CREATE TABLE IF NOT EXISTS ${this.config.database}.telemetry_meta (` +
      `key String, ` +
      `value String, ` +
      `updated_at DateTime DEFAULT now()` +
      `) ENGINE = ReplacingMergeTree(updated_at) ORDER BY key`;
    await this.executeQuery(ddl);
  }

  private async readMeta(key: string): Promise<string | null> {
    const sql = `SELECT value FROM ${this.config.database}.telemetry_meta FINAL ` +
      `WHERE key = '${escapeString(key)}' LIMIT 1 FORMAT JSONEachRow`;
    try {
      const text = await this.queryText(sql);
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as { value?: string };
        if (typeof row.value === 'string') return row.value;
      }
    } catch (err) {
      this.logger.debug('[api-call-telemetry] readMeta failed', {
        key,
        error: (err as Error).message,
      });
    }
    return null;
  }

  private async writeMeta(key: string, value: string): Promise<void> {
    const payload = JSON.stringify({
      key,
      value,
      updated_at: formatClickHouseTimestamp(new Date()).split('.')[0],
    });
    await this.executeQuery(
      `INSERT INTO ${this.config.database}.telemetry_meta FORMAT JSONEachRow`,
      payload,
    );
  }

  /**
   * Scan DISTINCT user_key WHERE user_id='' -> try to resolve a user_id for each key ->
   * ALTER TABLE UPDATE to backfill. CH mutations execute asynchronously with serial merges, and do not block queries.
   *
   * Returns: the number of user_keys successfully backfilled (verify failures that were skipped are not counted).
   */
  private async backfillUserIds(resolver: PanelUserIdResolver): Promise<number> {
    const rows = await this.listUnresolvedUserKeys();
    if (rows.length === 0) return 0;

    this.logger.info('[api-call-telemetry] backfill candidates', {
      distinctUserKeys: rows.length,
    });

    let migrated = 0;
    for (const { instance_id, user_key } of rows) {
      if (!user_key || !instance_id) continue;
      // Try to get the gateway params from the registry; skip if missing (the old instance may be offline)
      const ctx = this.pickResolverCtxForInstance(instance_id);
      if (!ctx) {
        this.logger.debug('[api-call-telemetry] backfill skip (no instance ctx)', {
          instanceId: instance_id,
          userKey: user_key,
        });
        continue;
      }
      // trigger cache refresh + wait a short while for auth/verify to return
      resolver.get(user_key, ctx);
      const uid = await waitForUserId(resolver, user_key, ctx, 2000);
      if (!uid) continue;
      try {
        const alter = `ALTER TABLE ${this.config.database}.${this.config.table} ` +
          `UPDATE user_id = '${escapeString(uid)}' ` +
          `WHERE instance_id = '${escapeString(instance_id)}' ` +
          `AND user_key = '${escapeString(user_key)}' ` +
          `AND user_id = ''`;
        await this.executeQuery(alter);
        migrated += 1;
      } catch (err) {
        this.logger.warn('[api-call-telemetry] backfill mutation failed', {
          instanceId: instance_id,
          userKey: user_key,
          error: (err as Error).message,
        });
      }
    }
    return migrated;
  }

  /**
   * The backfill must call auth/verify per instance (the same user_key has different semantics under different instances).
   * Provider injected in the ctor as the fallback: old instance_ids not found in the registry return null and are skipped.
   */
  private pickResolverCtxForInstance(instanceId: string): UserIdResolveCtx | null {
    return this.instanceCtxProvider(instanceId);
  }

  private async listUnresolvedUserKeys(): Promise<
    Array<{ instance_id: string; user_key: string }>
  > {
    const sql = `SELECT instance_id, user_key ` +
      `FROM ${this.config.database}.${this.config.table} ` +
      `WHERE user_id = '' AND user_key != '' ` +
      `GROUP BY instance_id, user_key ` +
      `FORMAT JSONEachRow`;
    const text = await this.queryText(sql);
    const out: Array<{ instance_id: string; user_key: string }> = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { instance_id?: string; user_key?: string };
        if (row.instance_id && row.user_key) {
          out.push({ instance_id: row.instance_id, user_key: row.user_key });
        }
      } catch {
        // ignore
      }
    }
    return out;
  }

  private async executeQuery(query: string, data = ''): Promise<void> {
    const url = new URL(this.config.url);
    url.searchParams.set('query', query);

    const headers: Record<string, string> = {
      'content-type': 'text/plain; charset=utf-8',
    };
    if (this.config.user) headers['x-clickhouse-user'] = this.config.user;
    if (this.config.password) headers['x-clickhouse-key'] = this.config.password;

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: data || undefined,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`ClickHouse HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
  }

  /** SELECT-type queries: use GET with the body returning text. */
  private async queryText(query: string): Promise<string> {
    const url = new URL(this.config.url);
    const headers: Record<string, string> = {
      'content-type': 'text/plain; charset=utf-8',
    };
    if (this.config.user) headers['x-clickhouse-user'] = this.config.user;
    if (this.config.password) headers['x-clickhouse-key'] = this.config.password;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: query,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`ClickHouse HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
    return await response.text();
  }
}

// -- Factory ---------------------------------------------------------------

export function createPanelApiCallTelemetry(
  config: PanelClickHouseConfig,
  logger: Logger,
  instanceCtxProvider: (instanceId: string) => UserIdResolveCtx | null,
  fetchImpl?: typeof fetch,
): PanelApiCallTelemetry {
  if (!config.enabled || !config.url) {
    return new DisabledPanelApiCallTelemetry();
  }
  return new ClickHousePanelApiCallTelemetry(config, logger, instanceCtxProvider, fetchImpl);
}

// -- Helpers ---------------------------------------------------------------

/** CH SQL string escaping: single quotes and backslashes. Avoids injection through special characters in user_key. */
function escapeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Wait for the resolver background refresh to get the user_id. Polls every 50ms and returns undefined on timeout.
 * Used only in the backfill scenario (the real request path always goes fire-and-forget and never waits).
 */
async function waitForUserId(
  resolver: PanelUserIdResolver,
  userKey: string,
  ctx: UserIdResolveCtx,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const uid = resolver.get(userKey, ctx);
    if (uid) return uid;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

/** Generate a ClickHouse DateTime64(3)-compatible timestamp string (UTC). */
export function formatClickHouseTimestamp(d: Date): string {
  // ClickHouse DateTime64 accepts ISO format; the timezone is determined by the table definition
  return d.toISOString().replace('T', ' ').replace('Z', '');
}
