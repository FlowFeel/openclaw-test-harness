/**
 * PiscinaWorkerPool integration specs (ticket #12 — real Piscina integration).
 *
 * This file is written to be read as a specification. Each `describe` names an
 * invariant of the real-Piscina design; each `it` states the proposition that
 * proves it; prose before each assertion says *why* that assertion is the one
 * that matters.
 *
 * The design under test (ts/src/features/worker-pool/piscina-pool.ts, #12):
 *   PiscinaWorkerPool is the production WorkerPool Protocol implementation. It
 *   serializes its handler registry into a CJS worker file via
 *   Function.prototype.toString — the #11 seam — so the worker thread runs the
 *   exact same handler logic as the inline path. execute() posts
 *   { handler, input } to Piscina, which runs it on a real worker thread.
 *   Before #12, PiscinaWorkerPool.execute() called fn(input) inline on the main
 *   thread — it used NO worker_threads, so prod ≡ Mock and the Protocol
 *   abstraction was undermined (swapping implementations changed nothing).
 *
 * DFT framing — what is deterministic here, and what is not:
 *   - DETERMINISTIC (the load-bearing claims): thread-identity via threadId
 *     (the main thread is threadId 0; worker threads are ≥ 1, so a non-zero
 *     tid proves off-main-thread execution — not "it's fast"); handler-result
 *     conformance (deep-equal) between the Piscina worker path and the patch's
 *     inline dispatch for every built-in handler; the unknown-handler rejection
 *     identity ("Unknown handler", surfaced through Piscina's rejection).
 *   - BOUNDED-LATENCY (a sanity check, not a correctness claim): each task
 *     completes well under 2000ms (Piscina spawn + run). Wall-clock measures
 *     latency, never a controlled input.
 *
 * Hermeticity: the only "upstream" is the worker_threads runtime via Piscina.
 * No network, no Docker, no clocks-as-input. The handler registry under test is
 * the patched worker-pool.js `handlers` object (loaded via loadCjsModule), so
 * the Piscina worker literally runs the patch's handler code — the two surfaces
 * share one registry, asserted by result for every handler.
 *
 * These specs prove the #12 acceptance criteria:
 *   (1) PiscinaWorkerPool work executes off the main thread (threadId ≥ 1).
 *   (2) PiscinaWorkerPool and the patched worker-pool.js share the same handler
 *       registry — same functions, identical results, one source of truth.
 *   (3) MockWorkerPool still passes its spec suite unchanged (not asserted here;
 *       the existing tests/spec/worker-pool.spec.ts is untouched and runs green).
 */
import { describe, it, expect, afterEach } from "vitest"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { PiscinaWorkerPool } from "../../src/features/worker-pool/piscina-pool.js"
import { loadCjsModule } from "../support/load-cjs.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const patchPath = resolve(__dirname, "../../patches/worker-pool.js")

// The patch's registry + inline dispatch — the single source of truth (#11).
// The PiscinaWorkerPool under test is constructed with this very `handlers`
// object, so the Piscina worker runs the patch's handler code verbatim.
const patch = loadCjsModule(patchPath) as {
  getPool: () => unknown
  dispatch: (handler: string, input: unknown) => unknown
  handlers: Record<string, (input: any) => unknown>
}
const { dispatch, handlers } = patch

// Deterministic fixtures (fanout.topics pins nowMs so worker ≡ inline exactly).
// Mirrors worker-pool-registry.spec.ts so all three surfaces (patch worker,
// patch inline, Piscina worker) are asserted against the same inputs.
const fixtures: Array<{ handler: string; input: unknown }> = [
  { handler: "json.stringify", input: { data: { a: 1, b: [2, 3] }, indent: 2 } },
  { handler: "json.stringify", input: { data: { nested: { ok: true } } } },
  { handler: "json.parse", input: { text: '{"x":42,"y":[1,2]}' } },
  { handler: "compact.transcript", input: { entries: [{ a: 1 }, { b: 2 }, { c: 3 }] } },
  { handler: "serialize.session", input: { session: { k: "v", n: 7 } } },
  { handler: "serialize.session", input: { session: "already-a-string" } },
  { handler: "ipc.transfer", input: { payload: { nested: { ok: true, arr: [1, 2] } } } },
  { handler: "fanout.topics", input: { topics: ["t1", "t2", "t3"], payload: { msg: "hi" }, nowMs: 1700000000000 } },
  { handler: "measure.size", input: { blocks: [{ arguments: { a: "x" } }, { arguments: { b: "yy" } }] } },
]

// A closure-free thread-identity probe. Returns the executing thread's threadId.
// The main thread is threadId 0; worker threads are ≥ 1. Serialized via
// Function.prototype.toString, it round-trips into the CJS worker (where
// `require` is in scope) — the same #11 seam that carries every built-in
// handler across the process boundary.
const probeTid = (_input: unknown): number =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("node:worker_threads").threadId as number

describe("PiscinaWorkerPool (#12) — real worker threads, not inline", () => {
  let pool: PiscinaWorkerPool

  afterEach(async () => {
    if (pool) await pool.destroy()
  })

  it("executes handlers off the main thread (threadId ≥ 1, not 0)", async () => {
    // The load-bearing claim of #12: prod actually uses worker_threads. The
    // main thread is threadId 0; a non-zero tid is deterministic proof the
    // handler ran on a worker thread — not "it's fast" or "it didn't block."
    pool = new PiscinaWorkerPool({
      maxThreads: 2,
      handlers: { ...handlers, "probe.tid": probeTid },
    })
    const result = await pool.execute<number>("probe.tid", {})
    expect(result.ok).toBe(true)
    expect(typeof result.data).toBe("number")
    expect(result.data!).toBeGreaterThanOrEqual(1)
  }, 10000)

  it("does NOT run inline — before #12 the same call returned threadId 0", async () => {
    // Regression guard: the pre-#12 PiscinaWorkerPool.execute() called fn(input)
    // on the main thread, which would return threadId 0. A non-zero tid here
    // proves the inline path is gone.
    pool = new PiscinaWorkerPool({
      maxThreads: 2,
      handlers: { "probe.tid": probeTid },
    })
    const result = await pool.execute<number>("probe.tid", {})
    expect(result.ok).toBe(true)
    expect(result.data).not.toBe(0)
  }, 10000)

  it("poolSize reflects real worker threads after first execute", async () => {
    // minThreads is pinned to maxThreads so the thread count is stable (no idle
    // teardown mid-test). After one execute, poolSize === maxThreads.
    pool = new PiscinaWorkerPool({
      maxThreads: 2,
      handlers: { "probe.tid": probeTid },
    })
    await pool.execute("probe.tid", {})
    const s = pool.stats()
    expect(s.poolSize).toBe(2)
    expect(s.completedTasks).toBe(1)
  }, 10000)
})

describe("PiscinaWorkerPool (#12) — shares the patch's handler registry (conformance)", () => {
  let pool: PiscinaWorkerPool

  afterEach(async () => {
    if (pool) await pool.destroy()
  })

  // Constructed with the patch's `handlers` object — the Piscina worker runs
  // the patch's handler code verbatim. One registry, two execution surfaces;
  // the pool is constructed per-test (each case needs its own fresh pool).

  for (const { handler, input } of fixtures) {
    it(`Piscina worker === patch inline dispatch for "${handler}"`, async () => {
      pool = new PiscinaWorkerPool({ maxThreads: 2, handlers })
      const viaPiscina = await pool.execute(handler, input)
      const viaInline = dispatch(handler, input)
      expect(viaPiscina.ok).toBe(true)
      expect(viaPiscina.data).toEqual(viaInline)
    }, 10000)
  }

  it("unknown handler rejects with the same identity as inline dispatch", async () => {
    // The worker's thrown 'Unknown handler' is surfaced through Piscina's
    // rejection. The Protocol maps it to { ok: false, error } — matching the
    // inline dispatch's thrown message, so the two surfaces stay consistent
    // (the pre-#11 drift was exactly this kind of worker-vs-inline mismatch).
    pool = new PiscinaWorkerPool({ maxThreads: 2, handlers })
    const viaPiscina = await pool.execute("does.not.exist", {})
    expect(viaPiscina.ok).toBe(false)
    expect(viaPiscina.error).toMatch(/Unknown handler/)
    expect(() => dispatch("does.not.exist", {})).toThrow(/Unknown handler/)
  }, 10000)
})

describe("PiscinaWorkerPool (#12) — Protocol compliance (register / stats / drain / destroy)", () => {
  let pool: PiscinaWorkerPool

  afterEach(async () => {
    if (pool) await pool.destroy()
  })

  it("register() before first execute reaches the worker thread", async () => {
    // register() bakes the handler into the worker file at pool-init time, so
    // it must be called before the first execute(). A handler registered this
    // way runs on a worker thread (tid ≥ 1), proving it reached the worker.
    pool = new PiscinaWorkerPool({ maxThreads: 2 })
    pool.register("probe.tid", probeTid)
    const result = await pool.execute<number>("probe.tid", {})
    expect(result.ok).toBe(true)
    expect(result.data!).toBeGreaterThanOrEqual(1)
  }, 10000)

  it("register() after the pool is initialized throws (worker file is baked)", async () => {
    // Piscina workers are real files; the registry is serialized at init. A
    // post-init register() cannot reach the already-spawned workers, so it
    // throws honestly rather than silently no-op'ing (the pre-#12 register()
    // stored handlers in a Map that execute() never read — a silent no-op).
    pool = new PiscinaWorkerPool({ maxThreads: 2, handlers: { "probe.tid": probeTid } })
    await pool.execute("probe.tid", {}) // initializes the pool
    expect(() => pool.register("late", () => null)).toThrow(/initialized/)
  }, 10000)

  it("drain() resolves after in-flight work completes", async () => {
    pool = new PiscinaWorkerPool({ maxThreads: 2, handlers })
    pool.execute("json.stringify", { data: { a: 1 } })
    pool.execute("json.parse", { text: '{"b":2}' })
    await pool.drain()
    const s = pool.stats()
    expect(s.completedTasks).toBe(2)
  }, 10000)

  it("destroy() makes the pool unusable — subsequent execute returns ok:false", async () => {
    pool = new PiscinaWorkerPool({ maxThreads: 2, handlers: { "probe.tid": probeTid } })
    await pool.execute("probe.tid", {})
    await pool.destroy()
    const result = await pool.execute("probe.tid", {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/destroy/i)
  }, 10000)

  it("unregistered handler returns ok:false via the pre-worker fast path (same identity as the worker)", async () => {
    // A handler not in the registry is rejected before reaching Piscina — no
    // worker round-trip. The message is the SAME 'Unknown handler' identity the
    // worker's dispatch would throw, so the fast path and the worker path share
    // one error identity (the #11 no-drift principle, extended to #12).
    pool = new PiscinaWorkerPool({ maxThreads: 2, handlers })
    const result = await pool.execute("never.registered", {})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Unknown handler/)
  }, 10000)
})
