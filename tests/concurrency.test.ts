import { describe, expect, it } from "vitest";
import { Semaphore, runWithConcurrencyLimit } from "../src/lib/concurrency";

describe("Semaphore", () => {
  it("allows up to maxConcurrency parallel tasks", async () => {
    const sem = new Semaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      await sem.acquire();
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      sem.release();
    };

    await Promise.all([task(), task(), task(), task()]);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(concurrent).toBe(0);
  });

  it("run method auto-acquires and releases", async () => {
    const sem = new Semaphore(1);
    const results: number[] = [];

    await Promise.all([
      sem.run(async () => {
        results.push(1);
        await new Promise((r) => setTimeout(r, 10));
      }),
      sem.run(async () => {
        results.push(2);
      }),
    ]);

    expect(results).toHaveLength(2);
    expect(results).toContain(1);
    expect(results).toContain(2);
  });

  it("releases on error", async () => {
    const sem = new Semaphore(1);

    try {
      await sem.run(async () => {
        throw new Error("test error");
      });
    } catch {
      // Expected
    }

    expect(sem.activeCount).toBe(0);

    // Should be able to acquire again after error release
    const result = await sem.run(async () => "ok");
    expect(result).toBe("ok");
  });

  it("throws for maxConcurrency < 1", () => {
    expect(() => new Semaphore(0)).toThrow("maxConcurrency must be >= 1");
  });

  it("tracks activeCount and waitingCount", async () => {
    const sem = new Semaphore(1);
    expect(sem.activeCount).toBe(0);
    expect(sem.waitingCount).toBe(0);

    await sem.acquire();
    expect(sem.activeCount).toBe(1);

    const waitPromise = sem.acquire();
    expect(sem.waitingCount).toBe(1);

    sem.release();
    await waitPromise;
    expect(sem.activeCount).toBe(1);
    expect(sem.waitingCount).toBe(0);

    sem.release();
    expect(sem.activeCount).toBe(0);
  });
});

describe("runWithConcurrencyLimit", () => {
  it("runs all tasks and returns results in order", async () => {
    const results = await runWithConcurrencyLimit(
      [
        async () => "a",
        async () => "b",
        async () => "c",
      ],
      2,
    );

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ status: "fulfilled", value: "a" });
    expect(results[1]).toEqual({ status: "fulfilled", value: "b" });
    expect(results[2]).toEqual({ status: "fulfilled", value: "c" });
  });

  it("limits concurrency", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeTask = (id: number) => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
      return id;
    };

    const results = await runWithConcurrencyLimit(
      [makeTask(1), makeTask(2), makeTask(3), makeTask(4), makeTask(5)],
      3,
    );

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
  });

  it("handles failures without affecting other tasks", async () => {
    const results = await runWithConcurrencyLimit(
      [
        async () => "ok",
        async () => { throw new Error("fail"); },
        async () => "also ok",
      ],
      2,
    );

    expect(results[0]).toEqual({ status: "fulfilled", value: "ok" });
    expect(results[1].status).toBe("rejected");
    expect(results[2]).toEqual({ status: "fulfilled", value: "also ok" });
  });

  it("works with empty task list", async () => {
    const results = await runWithConcurrencyLimit([], 3);
    expect(results).toHaveLength(0);
  });

  it("works with single task", async () => {
    const results = await runWithConcurrencyLimit(
      [async () => 42],
      3,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ status: "fulfilled", value: 42 });
  });
});
