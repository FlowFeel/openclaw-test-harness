/**
 * Event loop delay probe — a reusable instrument for Tier 3 efficiency tests.
 *
 * @dft
 * - Deterministic in structure: the probe measures real event loop gaps.
 * - No I/O — only setTimeout + performance.now().
 * - The probe is the instrument; the test provides the workload.
 *
 * @derivation
 * Derived from Axiom A1 (pure-io-separation): because the I/O cost is isolable
 * from the logic cost, we can measure the event-loop impact of an I/O operation
 * by scheduling a sentinel timer before the operation. If the operation blocks
 * the loop (sync I/O), the timer fires late. If it yields (async I/O), it
 * doesn't.
 *
 * @approach
 * We use setTimeout(0) as a sentinel, not setInterval. The sentinel is
 * scheduled BEFORE the blocking work. During a sync block, the event loop
 * is frozen — the timer can't fire. After the block, the timer fires, and
 * the elapsed time reveals how long the loop was blocked.
 */

/**
 * Measure how long the event loop is blocked during a sync operation.
 *
 * Schedules a setTimeout(0) sentinel, then runs the sync work. The sentinel
 * can't fire during the sync block. The elapsed time = block time + ~1ms
 * (the minimum setTimeout clamp in Node.js).
 *
 * @param blockFn - A synchronous function that may block the event loop.
 * @returns The delay (ms) — how long the sentinel took to fire.
 */
export async function measureSyncBlock(blockFn: () => void): Promise<number> {
  let fireTime = 0;
  const start = performance.now();
  const timer = setTimeout(() => { fireTime = performance.now(); }, 0);

  // Sync work — blocks the event loop. The timer can't fire during this.
  blockFn();

  // Wait for the timer to fire (it fires now that the loop is free)
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (fireTime > 0) {
        clearInterval(check);
        resolve();
      }
    }, 0);
  });

  clearTimeout(timer);
  return fireTime - start;
}

/**
 * Measure how long a setTimeout(0) sentinel takes to fire during an async
 * operation. If the operation yields to the event loop, the sentinel fires
 * in ~1ms. If the operation blocks (shouldn't for async), it fires late.
 *
 * @param asyncFn - An async function that should yield to the event loop.
 * @returns The delay (ms) — how long the sentinel took to fire.
 */
export async function measureAsyncYield(asyncFn: () => Promise<void>): Promise<number> {
  let fireTime = 0;
  const start = performance.now();
  const timer = setTimeout(() => { fireTime = performance.now(); }, 0);

  // Async work — should yield to the event loop, allowing the timer to fire
  await asyncFn();

  // Wait for the timer to fire
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (fireTime > 0) {
        clearInterval(check);
        resolve();
      }
    }, 0);
  });

  clearTimeout(timer);
  return fireTime - start;
}
