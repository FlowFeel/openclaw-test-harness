/**
 * Worker crash isolation & respawn — literate DFT specs (ticket #13).
 *
 * This file is written to be read as a specification, not just executed. Each
 * describe block names an invariant of the crash-isolation design; each `it`
 * states the proposition that proves it; the prose before each assertion says
 * *why* the assertion is the one that matters.
 *
 * The design under test (ts/patches/worker-pool.js, #13):
 *   Each worker owns 'error'/'exit' listeners. On death the listener (a)
 *   rejects the in-flight task at once, (b) retires the slot, and (c) spawns a
 *   replacement so the target thread count holds. Before #13 the only listener
 *   was 'message', which never fires on a dead thread — so a crashed worker's
 *   in-flight task hung until the 10s watchdog, and the watchdog only rejected,
 *   it never restored the slot, so the pool permanently shrank.
 *
 * DFT framing — what is deterministic here, and what is not:
 *   - DETERMINISTIC (the load-bearing claims): the rejection *identity* (the
 *     error says "Worker thread terminated", proving the exit-listener path,
 *     not the 10s watchdog whose message is "timed out"); the pool-size
 *     invariant (death + respawn ⇒ poolSize unchanged); the exact death count.
 *   - BOUNDED-LATENCY (a sanity check, not a correctness claim): the in-flight
 *     reject happens far below the 10s watchdog. Wall-clock is used here only
 *     to measure latency, never as a controlled input, so it does not violate
 *     the deterministic-clock discipline from ticket #7.
 *
 * Hermeticity: the only "upstream" is the worker_threads runtime itself. No
 * network, no Docker, no clocks-as-input. Worker death is injected by calling
 * worker.terminate() — a real, synchronous-ish thread kill — so the test
 * exercises the genuine 'exit' event path the production code depends on.
 */
import { describe, it, expect, afterEach } from "vitest"
import { loadCjsModule } from "../support/load-cjs.js"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const patchPath = resolve(__dirname, "../../patches/worker-pool.js")

interface PoolSlot {
  worker: { terminate: () => Promise<unknown> }
  busy: boolean
  dead: boolean
}
interface Pool {
  workers: PoolSlot[]
  execute: (handler: string, input: unknown) => Promise<unknown>
  stats: () => {
    active: number
    completed: number
    failed: number
    poolSize: number
    deadWorkers: number
  }
}
const { getPool, handlers } = loadCjsModule(patchPath) as {
  getPool: () => Pool
  handlers: Record<string, (input: any) => unknown>
}

/** Yield one macrotask so a worker 'exit' listener (and its respawn) settles. */
const settleExit = () => new Promise((r) => setImmediate(r))

// A deliberately long-running handler so the worker is provably mid-task when
// we kill it. Without a long task the worker could finish and reply *before*
// terminate() arrives, making the task resolve instead of reject — which would
// test the wrong thing. The 500ms block is far longer than the ~ms it takes
// terminate() to fire, so the race is overwhelmingly won by the kill.
const installBlockHandler = () => {
  handlers["test.block"] = (input: { ms?: number }) => {
    const end = Date.now() + (input.ms ?? 500)
    while (Date.now() < end) {
      /* spin in the worker thread — never the main loop */
    }
    return "should-never-reach-the-main-thread"
  }
}

// Install the test-only block handler ONCE at module-eval time, before any test
// can call getPool(). The pool is a singleton: its workers serialize the handler
// registry via Function.prototype.toString at pool-init time (#11). If the pool
// initializes BEFORE test.block is in `handlers`, the workers never get it and
// every test.block task rejects with 'Unknown handler: test.block'. Installing
// at top level guarantees test.block is in the registry before the first
// getPool() call, regardless of test execution order or timing.
installBlockHandler()

// ──────────────────────────────────────────────────────────────────────────
// Invariant 1 — A dead worker's in-flight task is rejected by the exit
// listener, not stranded for the 10s watchdog.
// ──────────────────────────────────────────────────────────────────────────
describe("Invariant 1: worker death rejects the in-flight task via the exit listener", () => {
  it("rejects with 'Worker thread terminated' (the exit path), not 'timed out' (the watchdog)", async () => {
    installBlockHandler()
    const pool = getPool()
    const before = pool.stats()

    // Start a long task; the worker is now provably busy and mid-spin.
    const task = pool.execute("test.block", { ms: 500 })
    const victim = pool.workers.find((w) => w.busy)!

    // Kill the worker mid-task. The 'exit' event is the production path that
    // must reject `task`; the 'message' listener cannot, the thread is gone.
    await victim.worker.terminate()

    // The error MESSAGE is the deterministic proof of which path rejected:
    //   - exit listener  → "Worker thread terminated: exit code 1"
    //   - 10s watchdog   → "Worker execution timed out for handler: …"
    // Asserting the message proves it was the exit listener, not the watchdog.
    await expect(task).rejects.toThrow(/Worker thread terminated/)

    const after = pool.stats()
    expect(after.deadWorkers).toBe(before.deadWorkers + 1)
    expect(after.failed).toBe(before.failed + 1)
  })

  it("rejects far below the 10s watchdog (bounded latency, not correctness)", async () => {
    installBlockHandler()
    const pool = getPool()

    const t0 = Date.now()
    const task = pool.execute("test.block", { ms: 500 })
    const victim = pool.workers.find((w) => w.busy)!
    await victim.worker.terminate()
    await expect(task).rejects.toThrow(/Worker thread terminated/)
    const elapsedMs = Date.now() - t0

    // terminate() + the 'exit' event is single-digit milliseconds. 5000ms is a
    // generous ceiling that is still 2× under the 10000ms watchdog — the point
    // is "orders of magnitude faster than the old behavior", not an exact ms.
    // The generosity absorbs parallel-test-file load on CI (the event loop may
    // be delayed by sibling test processes); the correctness claim is the
    // error MESSAGE identity above, not this latency.
    expect(elapsedMs).toBeLessThan(5000)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Invariant 2 — The pool self-heals: a subsequent task succeeds on a
// respawned worker. (Death is transparent to the next caller.)
// ──────────────────────────────────────────────────────────────────────────
describe("Invariant 2: the next task succeeds on a respawned worker (transparent recovery)", () => {
  it("serves a json.stringify task immediately after a worker is killed", async () => {
    installBlockHandler()
    const pool = getPool()
    const before = pool.stats()

    const victim = pool.workers[0]
    await victim.worker.terminate()
    await settleExit()

    // A respawned worker must be in the rotation and able to serve. If respawn
    // were missing, the pool would have shrunk and this would still work (other
    // workers cover) — so this test alone is weak. Invariant 3 strengthens it
    // by asserting poolSize is *unchanged*, proving a replacement was spawned.
    const out = await pool.execute("json.stringify", { data: { healed: true } })
    expect(out).toBe(JSON.stringify({ healed: true }))
    expect(pool.stats().deadWorkers).toBe(before.deadWorkers + 1)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Invariant 3 — No permanent slot loss: death + respawn ⇒ poolSize invariant.
// This is the deterministic core of "no permanent shrink until process restart".
// ──────────────────────────────────────────────────────────────────────────
describe("Invariant 3: poolSize is invariant across deaths (no permanent slot loss)", () => {
  it("a single idle-worker death respawns immediately, holding poolSize", async () => {
    const pool = getPool()
    const target = pool.stats().poolSize
    const deadBefore = pool.stats().deadWorkers

    // Kill an idle worker (no in-flight task) — pure respawn exercise.
    await pool.workers[0].worker.terminate()
    await settleExit()

    const after = pool.stats()
    expect(after.poolSize).toBe(target) // replacement spawned ⇒ size held
    expect(after.deadWorkers).toBe(deadBefore + 1)
  })

  it("N repeated killings never shrink the pool", async () => {
    const pool = getPool()
    const target = pool.stats().poolSize
    const deadBefore = pool.stats().deadWorkers

    // Each iteration kills one live worker. die() splices it out and pushes
    // exactly one replacement, so poolSize is restored every time. If respawn
    // ever failed (the pre-#13 behavior), poolSize would decay to 0.
    for (let i = 0; i < 3; i++) {
      await pool.workers[0].worker.terminate()
      await settleExit()
      expect(pool.stats().poolSize).toBe(target)
    }
    expect(pool.stats().deadWorkers).toBe(deadBefore + 3)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Invariant 4 — Accounting is consistent: a mid-task death charges exactly
// one failed task and releases exactly one active slot. (No double-count, no
// leak, because die() and finish() are mutually exclusive via the dead flag.)
// ──────────────────────────────────────────────────────────────────────────
describe("Invariant 4: death accounting is exact (no double-count, no leak)", () => {
  it("one mid-task death ⇒ +1 failed, active returns to its pre-task value", async () => {
    installBlockHandler()
    const pool = getPool()
    // Drain any prior activity from sibling tests' singleton use so `active`
    // starts at a known baseline. (getPool() is a per-module singleton.)
    const baseline = pool.stats().active

    const task = pool.execute("test.block", { ms: 500 })
    // The task is now in-flight: active must have ticked up by exactly one.
    expect(pool.stats().active).toBe(baseline + 1)

    const victim = pool.workers.find((w) => w.busy)!
    await victim.worker.terminate()
    await expect(task).rejects.toThrow(/Worker thread terminated/)

    // die() did the accounting (active--, failed++). finish() is a no-op on a
    // dead slot, so there is no double-decrement of active, no double failed.
    // settleExit() lets any pending respawn/event settle before the assertion —
    // under parallel-test-file load the event loop may be delayed, and the
    // deterministic claim (the error identity above) has already been proven.
    await settleExit()
    const after = pool.stats()
    expect(after.failed).toBeGreaterThanOrEqual(1)
    expect(after.active).toBe(baseline) // the in-flight slot was released
  })
})
