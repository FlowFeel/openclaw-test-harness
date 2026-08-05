/**
 * OC Event Loop Monitor — live telemetry plugin.
 *
 * @behavior
 * Hooks into model_call_started/ended to collect real runtime metrics.
 * Uses perf_hooks (monitorEventLoopDelay, eventLoopUtilization) and
 * v8.getHeapStatistics to measure event loop health.
 *
 * The aggregation logic is pure (shared/telemetry-logic.ts).
 * The collection (I/O) is here.
 *
 * @dft
 * - Aggregation logic is pure (shared/telemetry-logic.ts) — testable without perf_hooks.
 * - Collection is I/O (perf_hooks) — separated from logic seam.
 * - Hook handlers are thin: collect → aggregate → expose via tool.
 */

import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";
import { aggregateSystemHealth, type ProcessTelemetry, type SystemHealth } from "../../shared/telemetry-logic.js";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import process from "node:process";

export interface MonitorConfig {
  collectIntervalMs?: number;
  p99HealthyMs?: number;
  p99DegradedMs?: number;
  utilHealthy?: number;
  utilDegraded?: number;
  heapCriticalMb?: number;
}

class TelemetryCollector {
  private readonly histogram = monitorEventLoopDelay();
  private lastCpu = process.cpuUsage();
  private lastTime = process.hrtime.bigint();
  private readings: ProcessTelemetry[] = [];
  private maxReadings = 100;

  constructor() {
    this.histogram.enable();
  }

  collect(actorId: string): ProcessTelemetry {
    const eventLoopP99Ms = this.histogram.percentile(99) / 1e6;
    const { utilization } = performance.eventLoopUtilization();
    const usedHeapSize = getHeapStatistics().used_heap_size;

    const now = process.hrtime.bigint();
    const cpu = process.cpuUsage(this.lastCpu);
    const elapsedUs = Number(now - this.lastTime) / 1000;
    const cpuTotalUs = cpu.user + cpu.system;
    const cpuRatio = elapsedUs > 0 ? cpuTotalUs / elapsedUs : 0;
    this.lastCpu = process.cpuUsage();
    this.lastTime = now;

    const reading: ProcessTelemetry = {
      actorId,
      eventLoopP99Ms,
      eventLoopUtilization: utilization,
      usedHeapSize,
      cpuRatio,
    };

    this.readings.push(reading);
    if (this.readings.length > this.maxReadings) {
      this.readings.shift();
    }

    return reading;
  }

  getHealth(activeSubagents: number, staleSubagents: number): SystemHealth {
    return aggregateSystemHealth(this.readings.slice(-10), activeSubagents, staleSubagents);
  }

  reset() {
    this.histogram.reset();
    this.readings = [];
  }

  stop() {
    this.histogram.disable();
  }
}

export default definePluginEntry({
  id: "oc-event-loop-monitor",
  name: "OC Event Loop Monitor",
  description: "Live telemetry — event loop delay, heap usage, CPU ratio.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg: MonitorConfig = (config as MonitorConfig) ?? {};
    const collector = new TelemetryCollector();

    // ── Hook: model_call_started — collect telemetry ────────
    api.on("model_call_started", async () => {
      try {
        collector.collect("main");
      } catch {
        // Non-fatal
      }
    });

    // ── Hook: model_call_ended — collect post-call metrics ───
    api.on("model_call_ended", async () => {
      try {
        collector.collect("main");
      } catch {
        // Non-fatal
      }
    });

    // ── Hook: gateway_stop — cleanup ─────────────────────────
    api.on("gateway_stop", async () => {
      collector.stop();
    });

    // ── Tool: event_loop_health ──────────────────────────────
    api.registerTool({
      name: "event_loop_health",
      description:
        "Report event loop health — P99 delay, utilization, heap usage, " +
        "CPU ratio, and overall status (healthy/degraded/critical). " +
        "Run to check if the system is under load before heavy operations.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        try {
          const reading = collector.collect("main");
          const health = collector.getHealth(0, 0);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                status: health.status,
                eventLoopP99Ms: Math.round(health.eventLoopP99Ms * 100) / 100,
                eventLoopUtilization: Math.round(health.eventLoopUtilization * 1000) / 1000,
                usedHeapMB: Math.round(health.usedHeapSize / (1024 * 1024)),
                cpuRatio: Math.round(health.cpuRatio * 1000) / 1000,
                uptime: process.uptime(),
              }, null, 2),
            }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Telemetry failed: ${String(err)}` }],
          };
        }
      },
    });
  },
});
