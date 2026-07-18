/**
 * Per-key serialization lock.
 *
 * Only one `run` call per key executes at a time. Calls with the same key
 * are queued and execute sequentially. Rejected operations do not poison
 * later queued operations.
 *
 * The map entry is deleted in a `finally` handler only when the chain-tail
 * promise matches the stored entry, so mid-chain rejections don't leave
 * stale references.
 */
export class KeyedLock {
  private locks = new Map<string, Promise<unknown>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();

    // Swallow rejections from the previous operation so the next one
    // always runs regardless of the previous outcome.
    const next = prev
      .catch(() => {})
      .then(() => operation());

    // Register the new tail before it settles.
    this.locks.set(key, next);

    // Clean up the map entry only when `next` is still the current tail.
    // Use both handlers instead of finally() to avoid an unhandled rejection
    // on the finally-produced promise when operation() rejects.
    next.then(
      () => {
        if (this.locks.get(key) === next) this.locks.delete(key);
      },
      () => {
        if (this.locks.get(key) === next) this.locks.delete(key);
      },
    );

    return next;
  }
}
