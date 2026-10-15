/**
 * WorkerPermitPool -- concurrency semaphore of the memory PipelineWorker.
 *
 * History: it was once shared across modules (memory PipelineWorker + the old skill V2 worker);
 * after the 2026-07-17 skill rework the skill side uses the agent-level extract-lock for its concurrency limit
 * and no longer depends on the semaphore. This pool now has only one consumer, the memory pipeline,
 * kept because the memory side still needs it for queuing when concurrency > 1.
 *
 * Semantics:
 *   - capacity is a hard upper limit
 *   - acquire queues when full; release wakes in FIFO order
 *   - more releases than acquires throws (helps locate unpaired bugs)
 *   - destroy wakes all waiters and makes them reject (for graceful shutdown)
 */

const TAG = "[worker-permit-pool]";

export class WorkerPermitPool {
  readonly capacity: number;
  private _inFlight = 0;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  private destroyed = false;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`${TAG} capacity must be a positive integer, got: ${capacity}`);
    }
    this.capacity = capacity;
  }

  /**
   * Acquire a permit. If in-flight has reached capacity, suspend until a release() wakes it.
   * After destroy, acquire rejects immediately.
   */
  acquire(): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error(`${TAG} pool destroyed`));
    }
    if (this._inFlight < this.capacity) {
      this._inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * Return a permit. If there is a waiter, dequeue and resolve it (in-flight count unchanged);
   * otherwise decrement in-flight.
   *
   * More releases than acquires is treated as a programming error and thrown to help locate leak points.
   */
  release(): void {
    if (this._inFlight <= 0 && this.waiters.length === 0) {
      throw new Error(`${TAG} release() called with no in-flight permit (unbalanced acquire/release)`);
    }
    const next = this.waiters.shift();
    if (next) {
      // Hand the in-flight over to the waiter, count unchanged
      next.resolve();
    } else {
      this._inFlight--;
    }
  }

  /** Number of permits currently held. */
  inFlight(): number {
    return this._inFlight;
  }

  /** Number of permits that can be obtained immediately. */
  available(): number {
    return Math.max(0, this.capacity - this._inFlight);
  }

  /** Number of acquires currently queued and waiting. */
  waiting(): number {
    return this.waiters.length;
  }

  /**
   * Destroy the pool: reject all waiters; afterwards acquire rejects immediately.
   * Idempotent.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const err = new Error(`${TAG} pool destroyed`);
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w?.reject(err);
    }
  }
}
