/**
 * H3 + H4: Semaphore concurrency enforcement (Tier 2 — runtime-deterministic).
 *
 * @derivation
 * Derived from:
 *   A1 (pure-io-separation) — the semaphore state machine is pure; the
 *     AsyncSemaphore wrapper is the only impure part (Promise plumbing).
 *   A2 (determinism) — the state transitions are deterministic. The concurrency
 *     limit is NOT a performance target — it is an invariant guaranteed by the
 *     state machine. The semaphore never exceeds maxConcurrent because the
 *     state machine forbids it, not because "it's usually fast enough."
 *
 * The hold time (10ms) creates overlap to exercise the queue. The assertion
 * is structural (peak ≤ max), not timing-based. This is CI-safe because the
 * invariant is guaranteed by construction (A2), not by the scheduler.
 */
import { describe, it, expect } from "vitest";
import { createAsyncSemaphore } from "../../src/plugins/oc-topic-worker-pool/src/index.js";

// ── H3: Semaphore never exceeds maxConcurrent ────────────────

describe("H3: semaphore never exceeds maxConcurrent", () => {
  it("single semaphore: peak active ≤ max with 10 concurrent acquires", async () => {
    const MAX = 3;
    const sem = createAsyncSemaphore(MAX);

    let active = 0;
    let peak = 0;
    const completed: number[] = [];

    // Fire 10 concurrent acquires, each holding for 10ms
    const promises = Array.from({ length: 10 }, (_, i) =>
      (async () => {
        await sem.acquire();
        active++;
        if (active > peak) peak = active;
        await hold(10); // simulate work
        active--;
        sem.release();
        completed.push(i);
      })(),
    );

    await Promise.all(promises);

    // The invariant: peak never exceeded MAX
    expect(peak).toBeLessThanOrEqual(MAX);
    expect(peak).toBe(MAX); // it should have reached the limit
    // All 10 completed (no leaked promises, no starvation)
    expect(completed).toHaveLength(10);
    expect(sem.getStats().active).toBe(0);
  });

  it("peak is exactly max when demand exceeds supply", async () => {
    const MAX = 5;
    const sem = createAsyncSemaphore(MAX);
    let peak = 0;
    let active = 0;

    const promises = Array.from({ length: 20 }, () =>
      (async () => {
        await sem.acquire();
        active++;
        if (active > peak) peak = active;
        await hold(5);
        active--;
        sem.release();
      })(),
    );

    await Promise.all(promises);
    expect(peak).toBe(MAX);
  });

  it("maxConcurrent=1 serializes all acquires", async () => {
    const sem = createAsyncSemaphore(1);
    const order: number[] = [];
    let active = 0;
    let peak = 0;

    const promises = Array.from({ length: 5 }, (_, i) =>
      (async () => {
        await sem.acquire();
        active++;
        if (active > peak) peak = active;
        order.push(i);
        await hold(5);
        active--;
        sem.release();
      })(),
    );

    await Promise.all(promises);
    expect(peak).toBe(1); // strictly serialized
    expect(order).toEqual([0, 1, 2, 3, 4]); // FIFO order
  });

  it("release wakes exactly one waiter (no over-release)", async () => {
    const sem = createAsyncSemaphore(1);
    await sem.acquire(); // fill the pool

    let waiter1Resolved = false;
    let waiter2Resolved = false;

    const p1 = sem.acquire().then(() => { waiter1Resolved = true; });
    const p2 = sem.acquire().then(() => { waiter2Resolved = true; });

    // Neither waiter has resolved yet (pool is full)
    await microtask();
    expect(waiter1Resolved).toBe(false);
    expect(waiter2Resolved).toBe(false);

    sem.release();
    await microtask();
    expect(waiter1Resolved).toBe(true);
    expect(waiter2Resolved).toBe(false);

    sem.release();
    await microtask();
    expect(waiter2Resolved).toBe(true);
  });

  it("getStats reports correct counters after full lifecycle", async () => {
    const sem = createAsyncSemaphore(2);

    // 3 acquires → 2 acquired, 1 queued
    const a1 = sem.acquire();
    const a2 = sem.acquire();
    const a3 = sem.acquire();

    await Promise.all([a1, a2]);
    await microtask();

    const statsWhileWaiting = sem.getStats();
    expect(statsWhileWaiting.active).toBe(2);
    expect(statsWhileWaiting.peakActive).toBe(2);

    sem.release();
    await a3;
    sem.release();
    sem.release();

    const statsAfter = sem.getStats();
    expect(statsAfter.active).toBe(0);
    expect(statsAfter.totalAcquired).toBe(3);
    expect(statsAfter.totalReleased).toBe(3);
  });
});

// ── H4: Sub-pool doesn't starve main pool ────────────────────

describe("H4: sub-pool doesn't starve main pool", () => {
  it("saturated sub-pool does not block main pool acquire", async () => {
    const mainPool = createAsyncSemaphore(3);
    const subPool = createAsyncSemaphore(1);

    // Saturate the sub-pool: acquire the 1 slot, don't release
    await subPool.acquire();

    // Queue 5 waiters on the sub-pool (all blocked)
    const subPromises = Array.from({ length: 5 }, () =>
      subPool.acquire().then(async () => {
        await hold(5);
        subPool.release();
      }),
    );
    await microtask();

    // Main pool should be completely unaffected — acquire succeeds immediately
    const mainStart = performance.now();
    await mainPool.acquire();
    const mainElapsed = performance.now() - mainStart;

    // Main pool acquire should be near-instant (not blocked behind sub-pool)
    expect(mainElapsed).toBeLessThan(50); // generous bound — structural point is it's not queued
    expect(mainPool.getStats().active).toBe(1);

    // Cleanup
    mainPool.release();
    subPool.release();
    await Promise.all(subPromises);
  });

  it("main pool fills independently of sub pool", async () => {
    const mainPool = createAsyncSemaphore(3);
    const subPool = createAsyncSemaphore(2);

    let mainPeak = 0;
    let mainActive = 0;
    let subPeak = 0;
    let subActive = 0;

    // Fire 6 main + 4 sub concurrently
    const mainPromises = Array.from({ length: 6 }, () =>
      (async () => {
        await mainPool.acquire();
        mainActive++;
        if (mainActive > mainPeak) mainPeak = mainActive;
        await hold(10);
        mainActive--;
        mainPool.release();
      })(),
    );

    const subPromises = Array.from({ length: 4 }, () =>
      (async () => {
        await subPool.acquire();
        subActive++;
        if (subActive > subPeak) subPeak = subActive;
        await hold(10);
        subActive--;
        subPool.release();
      })(),
    );

    await Promise.all([...mainPromises, ...subPromises]);

    // Each pool respected its own limit independently
    expect(mainPeak).toBeLessThanOrEqual(3);
    expect(subPeak).toBeLessThanOrEqual(2);
    expect(mainPool.getStats().active).toBe(0);
    expect(subPool.getStats().active).toBe(0);
  });

  it("20 subagent acquires don't starve main pool (the starvation scenario)", async () => {
    const mainPool = createAsyncSemaphore(3);
    const subPool = createAsyncSemaphore(2);

    let mainPeak = 0;
    let mainActive = 0;

    // Fire 20 subagent acquires (would starve a single-pool design)
    const subPromises = Array.from({ length: 20 }, () =>
      (async () => {
        await subPool.acquire();
        await hold(5);
        subPool.release();
      })(),
    );

    // Concurrently fire 5 main pool acquires
    const mainPromises = Array.from({ length: 5 }, () =>
      (async () => {
        await mainPool.acquire();
        mainActive++;
        if (mainActive > mainPeak) mainPeak = mainActive;
        await hold(10);
        mainActive--;
        mainPool.release();
      })(),
    );

    await Promise.all([...mainPromises, ...subPromises]);

    // Main pool completed without being starved
    expect(mainPeak).toBeLessThanOrEqual(3);
    expect(mainPeak).toBe(3); // reached capacity
    expect(mainPool.getStats().totalAcquired).toBe(5);
  });
});

// ── Helpers ──────────────────────────────────────────────────

function hold(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function microtask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
