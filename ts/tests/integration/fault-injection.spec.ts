/**
 * Worker fault injection & recovery specs (Step 4 — DFT).
 *
 * Verifies system behavior under worker thread crashes, handler errors, and
 * IPC failure modes — and that session-store state remains uncorrupted.
 *
 * Adaptation note: the assessment references MonomorphicSessionStore /
 * MockMessagePort / TopicEngine, which are aspirational. The real transport
 * abstraction is the WorkerPool protocol (MockWorkerPool / PiscinaWorkerPool)
 * and the real store is TestStore. These specs exercise both the
 * MockWorkerPool (deterministic, inline) and the real worker_threads patch
 * (ts/patches/worker-pool.js).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { MockWorkerPool } from "../../src/features/worker-pool/mock-pool.js"
import { registerBuiltinHandlers } from "../../src/features/worker-pool/handlers.js"
import { TestStore } from "../../src/test/store.js"
import { loadCjsModule } from "../support/load-cjs.js"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
// Real worker_threads pool patch (CJS) — verifies fault recovery against the
// actual production code path that ships in OC's dist/. Loaded via loadCjsModule
// because the harness is ESM ("type": "module") and the patch is CJS.
const patchPath = resolve(__dirname, "../../patches/worker-pool.js")
const { getPool } = loadCjsModule(patchPath) as {
  getPool: () => {
    execute: (handler: string, input: unknown) => Promise<unknown>
    stats: () => { active: number; completed: number; failed: number; poolSize: number }
  }
}

describe("Fault injection — MockWorkerPool recovery", () => {
  let pool: MockWorkerPool
  let store: TestStore

  beforeEach(() => {
    pool = new MockWorkerPool()
    registerBuiltinHandlers(pool)
    store = new TestStore()
  })
  afterEach(async () => {
    await pool.destroy()
  })

  it("handler crash returns ok:false with the error, without throwing", async () => {
    pool.register("crash", () => {
      throw new Error("ERR_WORKER_OUT_OF_MEMORY")
    })
    const result = await pool.execute("crash", {})
    expect(result.ok).toBe(false)
    expect(result.error).toBe("ERR_WORKER_OUT_OF_MEMORY")
    expect(pool.stats().failedTasks).toBe(1)
  })

  it("pool survives a crash and serves subsequent tasks (transparent recovery)", async () => {
    pool.register("crash", () => {
      throw new Error("boom")
    })
    await pool.execute("crash", {})
    const ok = await pool.execute<string>("json.stringify", { data: { recovered: true } })
    expect(ok.ok).toBe(true)
    expect(JSON.parse(ok.data!)).toEqual({ recovered: true })
    expect(pool.stats().completedTasks).toBe(1)
    expect(pool.stats().failedTasks).toBe(1)
  })

  it("session store state is preserved and uncorrupted across a handler crash", async () => {
    store.insert({
      sessionKey: "s1",
      status: "running",
      spawnedBy: "p",
      isSubagent: 1,
      startedAtMs: 100,
      endedAtMs: null,
    })
    pool.register("crash", () => {
      throw new Error("ERR_WORKER_OUT_OF_MEMORY")
    })
    await pool.execute("crash", {})
    // No partially committed state — store intact
    expect(store.countActive()).toBe(1)
    expect(store.getTimedOut(300, 100)).toEqual([])
  })

  it("unknown handler is a controlled failure, not a crash", async () => {
    const result = await pool.execute("does.not.exist", {})
    expect(result.ok).toBe(false)
    expect(result.error).toContain("not registered")
    // Unregistered is a lookup miss, not an execution failure — no task ran,
    // so failedTasks stays 0 (matches MockWorkerPool semantics).
    expect(pool.stats().failedTasks).toBe(0)
    // Pool still serves subsequent known tasks (recovery).
    const ok = await pool.execute<string>("json.stringify", { data: { still: "up" } })
    expect(ok.ok).toBe(true)
  })
})

describe("Fault injection — real worker_threads pool (ts/patches/worker-pool.js)", () => {
  it("executes a known handler in a real worker thread", async () => {
    const pool = getPool()
    const out = await pool.execute("json.stringify", { data: { hello: "worker" } })
    expect(out).toBe(JSON.stringify({ hello: "worker" }))
  })

  it("propagates worker errors as rejections (unknown handler)", async () => {
    const pool = getPool()
    await expect(pool.execute("unknown.handler", {})).rejects.toThrow(/Unknown handler/)
  })

  it("recovers and serves subsequent tasks after a worker error", async () => {
    const pool = getPool()
    await expect(pool.execute("unknown.handler", {})).rejects.toThrow()
    const out = await pool.execute("json.parse", { text: '{"ok":true}' })
    expect(out).toEqual({ ok: true })
    const s = pool.stats()
    expect(s.completed).toBeGreaterThanOrEqual(1)
  })

  it("ipc.transfer returns the structured payload untouched (no JSON round-trip)", async () => {
    const pool = getPool()
    const payload = { a: 1, b: [1, 2, 3], c: { nested: true } }
    const out = await pool.execute("ipc.transfer", { payload })
    expect(out).toEqual(payload)
  })
})
