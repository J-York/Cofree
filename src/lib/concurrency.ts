/**
 * Cofree - AI Programming Cafe
 * File: src/lib/concurrency.ts
 * Description: Concurrency control primitives for parallel sub-agent execution.
 */

/**
 * Counting semaphore that limits the number of concurrent async operations.
 * When the limit is reached, additional callers wait until a slot frees up.
 */
export class Semaphore {
  private current = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {
    if (maxConcurrency < 1) {
      throw new Error("Semaphore maxConcurrency must be >= 1");
    }
  }

  async acquire(): Promise<void> {
    if (this.current < this.maxConcurrency) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    const next = this.waitQueue.shift();
    if (next) {
      next();
    }
  }

  /**
   * Run an async function within the semaphore's concurrency limit.
   * Automatically acquires before and releases after (even on error).
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get activeCount(): number {
    return this.current;
  }

  get waitingCount(): number {
    return this.waitQueue.length;
  }
}

/**
 * Run async tasks with a concurrency limit using Promise.allSettled semantics.
 * Returns results in the same order as the input tasks.
 */
export async function runWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  const semaphore = new Semaphore(maxConcurrency);
  const promises = tasks.map((task) => semaphore.run(task));
  return Promise.allSettled(promises);
}
