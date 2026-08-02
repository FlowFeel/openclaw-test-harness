/**
 * Tests for the worker pool — Protocol-based, testable without Piscina.
 *
 * Tests the orthogonal design:
 * - MockWorkerPool works with any registered handler
 * - Handlers are pure functions (input → output)
 * - Stats track execution metrics
 * - Multiple handler types work through the same interface
 * - JSON operations and non-JSON operations use the same pool
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { MockWorkerPool } from "../../src/features/worker-pool/mock-pool.js"
import {
  jsonStringify,
  jsonParse,
  compactContext,
  serializeSession,
  registerBuiltinHandlers,
} from "../../src/features/worker-pool/handlers.js"

describe("MockWorkerPool — Protocol compliance", () => {
  let pool: MockWorkerPool

  beforeEach(() => {
    pool = new MockWorkerPool()
    registerBuiltinHandlers(pool)
  })

  afterEach(async () => {
    await pool.destroy()
  })

  it("executes a registered handler", async () => {
    pool.register("double", (x: number) => x * 2)
    const result = await pool.execute<number>("double", 21)
    expect(result.ok).toBe(true)
    expect(result.data).toBe(42)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("returns error for unregistered handler", async () => {
    const result = await pool.execute("nonexistent", {})
    expect(result.ok).toBe(false)
    expect(result.error).toContain("not registered")
  })

  it("catches handler errors", async () => {
    pool.register("throw", () => { throw new Error("boom") })
    const result = await pool.execute("throw", {})
    expect(result.ok).toBe(false)
    expect(result.error).toBe("boom")
  })

  it("tracks completion stats", async () => {
    pool.register("noop", () => null)
    await pool.execute("noop", {})
    await pool.execute("noop", {})
    await pool.execute("noop", {})
    const s = pool.stats()
    expect(s.completedTasks).toBe(3)
    expect(s.failedTasks).toBe(0)
  })

  it("tracks failure stats", async () => {
    pool.register("fail", () => { throw new Error("err") })
    await pool.execute("fail", {})
    await pool.execute("fail", {})
    const s = pool.stats()
    expect(s.completedTasks).toBe(0)
    expect(s.failedTasks).toBe(2)
  })
})

describe("Built-in handlers — JSON operations", () => {
  let pool: MockWorkerPool

  beforeEach(() => {
    pool = new MockWorkerPool()
    registerBuiltinHandlers(pool)
  })

  afterEach(async () => {
    await pool.destroy()
  })

  it("stringifies JSON off main thread", async () => {
    const data = { name: "test", items: [1, 2, 3], nested: { a: true } }
    const result = await pool.execute<string>("json.stringify", { data, indent: 2 })
    expect(result.ok).toBe(true)
    expect(result.data).toBe(JSON.stringify(data, null, 2))
  })

  it("parses JSON off main thread", async () => {
    const text = '{"name":"test","items":[1,2,3]}'
    const result = await pool.execute("json.parse", { text })
    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ name: "test", items: [1, 2, 3] })
  })

  it("handles large JSON without blocking", async () => {
    const large = { data: "x".repeat(100000) }
    const result = await pool.execute<string>("json.stringify", { data: large })
    expect(result.ok).toBe(true)
    expect(result.data?.length).toBeGreaterThan(100000)
  })
})

describe("Built-in handlers — context compaction", () => {
  let pool: MockWorkerPool

  beforeEach(() => {
    pool = new MockWorkerPool()
    registerBuiltinHandlers(pool)
  })

  afterEach(async () => {
    await pool.destroy()
  })

  it("compacts oversized context", async () => {
    const transcript = "message\n\n".repeat(10000) // ~80KB
    const result = await pool.execute("compact.context", {
      transcript,
      maxBytes: 10000,
    })
    expect(result.ok).toBe(true)
    const data = result.data as { compacted: string; originalSize: number; compactedSize: number }
    expect(data.originalSize).toBeGreaterThan(10000)
    expect(data.compactedSize).toBeLessThan(data.originalSize)
    expect(data.compacted).toContain("compacted")
  })

  it("passes through context under max", async () => {
    const transcript = "small"
    const result = await pool.execute("compact.context", {
      transcript,
      maxBytes: 10000,
    })
    expect(result.ok).toBe(true)
    const data = result.data as { compacted: string; originalSize: number }
    expect(data.compacted).toBe("small")
  })
})

describe("Built-in handlers — session serialization", () => {
  let pool: MockWorkerPool

  beforeEach(() => {
    pool = new MockWorkerPool()
    registerBuiltinHandlers(pool)
  })

  afterEach(async () => {
    await pool.destroy()
  })

  it("serializes session state off main thread", async () => {
    const session = { key: "test", messages: [{ role: "user", content: "hi" }] }
    const result = await pool.execute<string>("serialize.session", { session })
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.data!)).toEqual(session)
  })

  it("transfers structured objects directly via IPC without JSON stringification", async () => {
    const complexObj = { key: "test", count: 42, active: true, nested: { items: [1, 2, 3] } }
    const result = await pool.execute<typeof complexObj>("ipc.transfer", { payload: complexObj })
    expect(result.ok).toBe(true)
    expect(result.data).toEqual(complexObj)
  })

  it("parallelizes topic fan-out payload formatting off main thread", async () => {
    const topics = ["topic-1", "topic-2", "topic-3", "topic-4", "topic-5", "topic-6"]
    const payload = { event: "broadcast", data: "test payload" }
    const result = await pool.execute<Array<{ topic: string; payload: string; formattedAt: number }>>("fanout.topics", {
      topics,
      payload
    })

    expect(result.ok).toBe(true)
    expect(result.data?.length).toBe(6)
    expect(result.data?.[0].topic).toBe("topic-1")
    expect(JSON.parse((result.data?.[0] as any).payload)).toEqual(payload)
  })
})

describe("Orthogonality — multiple handler types in one pool", () => {
  let pool: MockWorkerPool

  beforeEach(() => {
    pool = new MockWorkerPool()
    registerBuiltinHandlers(pool)
    // Register a non-JSON custom handler too
    pool.register("calculate.hash", (input: { text: string }) => {
      let hash = 0
      for (let i = 0; i < input.text.length; i++) {
        hash = ((hash << 5) - hash) + input.text.charCodeAt(i)
        hash |= 0
      }
      return hash
    })
  })

  afterEach(async () => {
    await pool.destroy()
  })

  it("executes JSON, compaction, and custom handlers through same pool", async () => {
    const jsonResult = await pool.execute<string>("json.stringify", { data: { a: 1 } })
    const compactResult = await pool.execute("compact.context", {
      transcript: "x".repeat(20000),
      maxBytes: 1000,
    })
    const hashResult = await pool.execute<number>("calculate.hash", { text: "test" })

    expect(jsonResult.ok).toBe(true)
    expect(compactResult.ok).toBe(true)
    expect(hashResult.ok).toBe(true)
    expect(hashResult.data).toBeTypeOf("number")

    const s = pool.stats()
    expect(s.completedTasks).toBe(3)
  })

  it("stats accumulate across different handlers", async () => {
    await pool.execute("json.stringify", { data: {} })
    await pool.execute("json.parse", { text: "{}" })
    await pool.execute("serialize.session", { session: {} })

    const s = pool.stats()
    expect(s.completedTasks).toBe(3)
    expect(s.failedTasks).toBe(0)
    expect(s.averageDurationMs).toBeGreaterThanOrEqual(0)
  })
})
