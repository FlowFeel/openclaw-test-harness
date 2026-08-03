/**
 * Telemetry logic — pure functions for aggregating process health.
 *
 * @behavior
 * Reads runtime signals (event loop delay, heap, CPU) and produces
 * a SystemHealth summary. The collector (I/O) is in the server;
 * the aggregation (pure) is here.
 *
 * @invariants
 * - `aggregateSystemHealth` is pure: takes readings, returns summary.
 * - No `Date.now()` or `Math.random()` — deterministic.
 * - No I/O — no perf_hooks, no process.cpuUsage.
 *
 * @dft
 * - All functions testable with inline data.
 * - Deterministic: injected timestamps.
 */

export interface ProcessTelemetry {
  actorId: string;
  eventLoopP99Ms: number;
  eventLoopUtilization: number;
  usedHeapSize: number;
  cpuRatio: number;
}

export interface SystemHealth {
  status: "healthy" | "degraded" | "critical";
  eventLoopP99Ms: number;
  eventLoopUtilization: number;
  usedHeapSize: number;
  cpuRatio: number;
  activeSubagents: number;
  staleSubagents: number;
  readings: number;
}

// Thresholds
const EL_P99_HEALTHY = 50;
const EL_P99_DEGRADED = 200;
const EL_UTIL_HEALTHY = 0.3;
const EL_UTIL_DEGRADED = 0.7;
const HEAP_CRITICAL = 500 * 1024 * 1024; // 500MB

/**
 * Aggregate per-actor telemetry readings into a SystemHealth summary.
 * Pure: no I/O, no Date.now().
 */
export function aggregateSystemHealth(
  readings: ProcessTelemetry[],
  activeSubagents: number,
  staleSubagents: number
): SystemHealth {
  if (readings.length === 0) {
    return {
      status: "healthy",
      eventLoopP99Ms: 0,
      eventLoopUtilization: 0,
      usedHeapSize: 0,
      cpuRatio: 0,
      activeSubagents,
      staleSubagents,
      readings: 0,
    };
  }

  // Take the max across all readings (worst case)
  const maxP99 = Math.max(...readings.map((r) => r.eventLoopP99Ms));
  const maxUtil = Math.max(...readings.map((r) => r.eventLoopUtilization));
  const maxHeap = Math.max(...readings.map((r) => r.usedHeapSize));
  const avgCpu =
    readings.reduce((sum, r) => sum + r.cpuRatio, 0) / readings.length;

  // Determine status
  let status: SystemHealth["status"] = "healthy";
  if (maxP99 > EL_P99_DEGRADED || maxUtil > EL_UTIL_DEGRADED || maxHeap > HEAP_CRITICAL) {
    status = "critical";
  } else if (maxP99 > EL_P99_HEALTHY || maxUtil > EL_UTIL_HEALTHY) {
    status = "degraded";
  }

  return {
    status,
    eventLoopP99Ms: maxP99,
    eventLoopUtilization: maxUtil,
    usedHeapSize: maxHeap,
    cpuRatio: avgCpu,
    activeSubagents,
    staleSubagents,
    readings: readings.length,
  };
}
