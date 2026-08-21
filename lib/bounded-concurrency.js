/**
 * A small abort-aware semaphore for expensive browser work. Tasks waiting for a
 * permit are rejected immediately when their signal is canceled, while permits
 * are always returned after a running task settles.
 *
 * @param {number} maximumConcurrency
 */
export function createConcurrencyGate(maximumConcurrency) {
  if (!Number.isInteger(maximumConcurrency) || maximumConcurrency < 1) {
    throw new RangeError("maximumConcurrency must be a positive integer.");
  }

  let activeCount = 0;
  const queue = [];

  const abortError = () => new DOMException("Processing canceled.", "AbortError");

  function drain() {
    while (activeCount < maximumConcurrency && queue.length > 0) {
      const entry = queue.shift();
      if (!entry) return;
      if (entry.signal?.aborted) {
        entry.reject(abortError());
        continue;
      }
      activeCount += 1;
      entry.signal?.removeEventListener("abort", entry.onAbort);
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        activeCount -= 1;
        drain();
      });
    }
  }

  /**
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<() => void>}
   */
  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          reject(abortError());
        },
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      queue.push(entry);
      drain();
    });
  }

  return {
    /**
     * @template Result
     * @param {() => Promise<Result> | Result} task
     * @param {AbortSignal} [signal]
     * @returns {Promise<Result>}
     */
    async run(task, signal) {
      const release = await acquire(signal);
      try {
        return await task();
      } finally {
        release();
      }
    },
    get activeCount() {
      return activeCount;
    },
    get pendingCount() {
      return queue.length;
    },
  };
}
