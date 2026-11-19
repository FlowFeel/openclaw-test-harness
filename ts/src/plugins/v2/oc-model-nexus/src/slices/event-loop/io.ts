/**
 * Event Loop Telemetry I/O Protocol — isolates node:perf_hooks, node:v8, and node:process.
 *
 * @invariants
 * - Concrete Node sampler implements TelemetrySampler Protocol; tests inject deterministic doubles.
 * - Zero empty catch blocks; errors surface cleanly.
 *
 * @dft
 * - Protocol boundary for Axiom A1/A5 compliance.
 */

import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import process from "node:process";
import type { ProcessTelemetry } from "../../../../../shared/telemetry-logic.js";

export interface TelemetrySampler {
  sample: (actorId: string) => ProcessTelemetry;
  dispose: () => void;
}

export function createNodeTelemetrySampler(): TelemetrySampler {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let lastCpu = process.cpuUsage();
  let lastTime = performance.now();

  return {
    sample(actorId: string): ProcessTelemetry {
      const now = performance.now();
      const elapsedMs = Math.max(1, now - lastTime);
      const cpuDelta = process.cpuUsage(lastCpu);
      lastCpu = process.cpuUsage();
      lastTime = now;

      const heap = getHeapStatistics();
      const totalCpuMs = (cpuDelta.user + cpuDelta.system) / 1000;
      const cpuRatio = Math.min(1, Math.round((totalCpuMs / elapsedMs) * 1000) / 1000);

      const reading: ProcessTelemetry = {
        actorId,
        eventLoopP99Ms: Math.round((histogram.percentile(99) / 1e6) * 100) / 100,
        eventLoopUtilization: cpuRatio,
        usedHeapSize: heap.used_heap_size,
        cpuRatio,
      };
      histogram.reset();
      return reading;
    },
    dispose() {
      histogram.disable();
    },
  };
}
