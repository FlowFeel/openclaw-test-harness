/**
 * Programmatic V8 memory invariant assertions.
 *
 * Replaces manual --trace-gc / --trace-ic flag inspection with in-test
 * heap-bound assertions that fail CI on hidden memory leaks. Captures V8
 * heap snapshots before/after a workload and asserts bounded growth.
 *
 * @invariants
 * - captureV8Snapshot() reads node:v8.getHeapStatistics() once (no GC forced).
 * - assertV8HeapStability() fails when used_heap growth exceeds the budget.
 * - Snapshots are plain objects (monomorphic shape) for stable ICs.
 */

import { getHeapStatistics } from "node:v8"
import { strict as assert } from "node:assert"

export interface V8Snapshot {
  usedHeapSize: number
  totalHeapSize: number
  mallocedMemory: number
}

/** Capture a point-in-time V8 heap snapshot. */
export function captureV8Snapshot(): V8Snapshot {
  const stats = getHeapStatistics()
  return {
    usedHeapSize: stats.used_heap_size,
    totalHeapSize: stats.total_heap_size,
    mallocedMemory: stats.malloced_memory,
  }
}

/**
 * Assert that V8 used-heap growth between two snapshots is within budget.
 *
 * @param before Snapshot taken before the workload.
 * @param after Snapshot taken after the workload.
 * @param maxAllowedGrowthBytes Fail if growth exceeds this (default 1 MiB).
 */
export function assertV8HeapStability(
  before: V8Snapshot,
  after: V8Snapshot,
  maxAllowedGrowthBytes: number = 1024 * 1024,
): void {
  const heapGrowth = after.usedHeapSize - before.usedHeapSize
  assert.ok(
    heapGrowth <= maxAllowedGrowthBytes,
    `V8 Heap leaked ${heapGrowth} bytes (Max allowed: ${maxAllowedGrowthBytes} bytes)`,
  )
}
