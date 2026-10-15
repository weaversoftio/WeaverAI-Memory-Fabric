/**
 * pending-writes -- tracks in-flight L0 writes + provides a SIGTERM flush hook + retries.
 *
 * Background: in streaming scenarios recordWamfTurn must be fire-and-forget (it cannot block the SSE
 * stream close, otherwise the wrap-up after the first token feels slow). But fire-and-forget has two loss scenarios:
 *   1. when a pod rolling update receives SIGTERM, promises in the event loop have not been flushed
 *      -> the node process exits directly -> L0 lost
 *   2. the wamf kernel has a brief 503 / network jitter -> a single POST fails with no retry -> L0 lost
 *
 * This module has two countermeasures:
 *   - `trackWrite(promise)`: registers an in-flight promise in the pending set and removes it on settle.
 *     `flushPendingWrites(deadlineMs)` waits until all in-flight writes finish or time out.
 *     The index.ts SIGTERM handler calls it once before shutdown.
 *   - `withL0Retry(fn)`: wraps a single write in up to 3 exponential-backoff retries. Shields against brief kernel outages.
 *
 * What does not change:
 *   - the non-streaming path still awaits (this module's track also works with await, with no extra overhead).
 *   - when `recordWamfTurn(client, identity=null | userMessage=null)`, the client side returns
 *     directly and this module does not get involved.
 *
 * Duplicate write risk: if the first POST already reached the wamf kernel but the client retries after reading a 5xx timeout,
 * the kernel may receive two L0 entries with identical content (wamf `/v3/conversation/add` currently has no
 * idempotency-key). Acceptable: better duplicated than lost; and the two retried POST payloads are exactly
 * identical, the L1/L2/L3 distillation pipeline is idempotent (one entry per hash), so only L0 is redundant in observation.
 */

const pendingWrites = new Set<Promise<unknown>>();

/**
 * Register an in-flight write. Returns the same promise for easy chaining.
 * Removed from the set automatically on settle.
 *
 * Note: `.finally` returns a new promise; if the original p is rejected and the new chain has no catch,
 * Node reports UnhandledRejection (and under --unhandled-rejections=strict even
 * makes the process exit). Use catch(noop) to swallow the cleanup chain; the original p is left for the caller
 * to catch (the handler side does .catch with pipe.error("WAMF_L0", ...)).
 */
export function trackWrite<T>(p: Promise<T>): Promise<T> {
  pendingWrites.add(p);
  p.finally(() => pendingWrites.delete(p)).catch(() => { /* caller owns rejection */ });
  return p;
}

/** Current number of in-flight writes (for observation / tests). */
export function pendingWriteCount(): number {
  return pendingWrites.size;
}

/**
 * Wait until all in-flight writes finish or the deadline expires.
 * Called by the SIGTERM handler; after a timeout it returns the number unfinished for log observation (does not block exit).
 */
export async function flushPendingWrites(deadlineMs: number = 10_000): Promise<{
  drained: boolean;
  remaining: number;
}> {
  if (pendingWrites.size === 0) return { drained: true, remaining: 0 };
  const snapshot = [...pendingWrites];
  const settled = Promise.allSettled(snapshot);
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), deadlineMs));
  const outcome = await Promise.race([settled.then(() => "ok" as const), timeout]);
  return { drained: outcome === "ok", remaining: pendingWrites.size };
}

/**
 * Exponential-backoff retry wrapper. Used for brief wamf kernel outages.
 *
 * Default parameters: 3 total attempts, with intervals 500ms -> 1s -> 2s (with jitter).
 * Total at most ~3.5s; the pod SIGTERM grace period is usually 30s, and flushPendingWrites
 * has a default 10s fallback, enough to finish 3 retries.
 *
 * Only retry "worth retrying" errors (network, 5xx, 408, 429); 4xx client errors are thrown directly.
 */
export async function withL0Retry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      const wait = baseMs * (2 ** i) + Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * Simple decision: network errors, 5xx, 408/429 are worth retrying; others (400/401/403/404/422) are given up on directly.
 * WamfClient's errors currently take the form `throw new Error(\`wamf POST ... HTTP <code>: <body>\`)`,
 * and a regex fishes out the status code. If none can be found (network down / timeout), retry by default.
 */
function isRetryable(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  // Network class: AbortError / ENOTFOUND / ECONNRESET / ETIMEDOUT / fetch failed
  if (/abort|econnreset|enotfound|etimedout|fetch failed|network|timeout/i.test(msg)) return true;
  // HTTP status code class
  const m = msg.match(/HTTP (\d{3})/);
  if (!m) return true; // no status code info -> conservative retry
  const code = Number(m[1]);
  return code >= 500 || code === 408 || code === 429;
}
