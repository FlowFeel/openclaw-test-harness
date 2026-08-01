/**
 * V8 heap invariant assertion specs (Step 3 — DFT).
 *
 * Verifies the programmatic heap-bound helper. Real-heap round-trip uses a
 * generous budget to avoid GC-timing flakiness; pass/fail thresholds are
 * exercised against synthetic snapshots deterministically.
 */
import { describe, it, expect } from "vitest"
import { captureV8Snapshot, assertV8HeapStability } from "../../src/core/v8-assert.js"

describe("captureV8Snapshot", () => {
  it("returns sane, monomorphic V8 heap stats", () => {
    const snap = captureV8Snapshot()
    expect(snap.usedHeapSize).toBeGreaterThan(0)
    expect(snap.totalHeapSize).toBeGreaterThanOrEqual(snap.usedHeapSize)
    expect(snap.mallocedMemory).toBeGreaterThanOrEqual(0)
    // shape stability: fixed key set
    expect(Object.keys(snap).sort()).toEqual([
      "mallocedMemory",
      "totalHeapSize",
      "usedHeapSize",
    ])
  })
})

describe("assertV8HeapStability", () => {
  it("passes when growth is within budget (synthetic)", () => {
    const before = { usedHeapSize: 1_000_000, totalHeapSize: 2_000_000, mallocedMemory: 0 }
    const after = { usedHeapSize: 1_500_000, totalHeapSize: 2_000_000, mallocedMemory: 0 }
    expect(() => assertV8HeapStability(before, after, 1_000_000)).not.toThrow()
  })

  it("throws when growth exceeds budget (synthetic)", () => {
    const before = { usedHeapSize: 1_000_000, totalHeapSize: 2_000_000, mallocedMemory: 0 }
    const after = { usedHeapSize: 3_000_000, totalHeapSize: 4_000_000, mallocedMemory: 0 }
    expect(() => assertV8HeapStability(before, after, 1_000_000)).toThrow(/V8 Heap leaked/)
  })

  it("default budget is 1 MiB", () => {
    const before = { usedHeapSize: 0, totalHeapSize: 0, mallocedMemory: 0 }
    const after = { usedHeapSize: 2_000_000, totalHeapSize: 0, mallocedMemory: 0 } // > 1 MiB
    expect(() => assertV8HeapStability(before, after)).toThrow(/V8 Heap leaked 2000000 bytes/)
  })

  it("real round-trip: non-leaking workload stays within a generous budget", () => {
    const before = captureV8Snapshot()
    // transient allocations — no retained references → no leak
    for (let i = 0; i < 10_000; i++) {
      JSON.stringify({ a: i, b: "x".repeat(100) })
    }
    const after = captureV8Snapshot()
    // generous 64 MiB budget; asserts the helper runs against the real heap
    // without flaking on GC timing.
    expect(() => assertV8HeapStability(before, after, 64 * 1024 * 1024)).not.toThrow()
  })
})
