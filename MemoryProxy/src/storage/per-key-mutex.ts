/**
 * per-key mutex -- serializes async operations on the same key; different keys run fully concurrently.
 *
 * Used for R-M-W operations such as KvBindingRepo.touchLastSeen / KvExtractStore.incrBy,
 * eliminating races **within a single node**. For the cross-node case see the analysis in migration plan section 6.2 (the business accepts the precision loss).
 *
 * Approach: keep a Promise chain per key; withPerKeyLock appends the new task to the tail of the old chain.
 * After the task completes, if it is still the chain tail it is deleted -- avoids holding dead entries long-term.
 */
const inflight = new Map<string, Promise<unknown>>();

export function withPerKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = inflight.get(key) ?? Promise.resolve();
  // Use fn in both positions -- both reject and fulfill must wait serially, so that after one throws
  // later tasks do not leak ahead of the old chain.
  const cur = prev.then(fn, fn) as Promise<T>;
  // tail is used to register the chain tail and for cleanup; convert rejection into resolved to avoid "unhandled rejection" warnings.
  // The real error is still returned to the caller via cur.
  const tail: Promise<void> = cur.then(() => {}, () => {}).finally(() => {
    if (inflight.get(key) === tail) inflight.delete(key);
  });
  inflight.set(key, tail);
  return cur;
}

/** Test only: clear all in-flight locks (does not wait for completion; await them yourself afterwards). */
export function __resetPerKeyLocksForTests(): void {
  inflight.clear();
}
