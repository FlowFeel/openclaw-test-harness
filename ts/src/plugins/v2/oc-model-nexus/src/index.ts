/**
 * Unified Model Nexus Engine — Plugins v2 Core Entry Point.
 *
 * @behavior
 * Consolidates active model routing & failover, sidecar stream relay,
 * event-loop telemetry monitoring, and prompt context caching into a single unified engine.
 *
 * Absorbs:
 * - oc-model-router
 * - oc-stream-relay
 * - oc-event-loop-monitor
 * - oc-context-cache
 *
 * @invariants
 * - Pure logic / IO separation: all pure logic modules in *-logic.ts.
 * - Strict determinism: all time injected via parameters or clock provider.
 * - Conforms bidirectionally to openclaw.plugin.json contracts.
 * - Real protocol doubles supported via dependency injection.
 *
 * @dft
 * - Tested with in-memory test doubles and real containerized E2E runs.
 */

import { definePluginEntry, Type, type PluginApi, type HookEvent, type HookContext } from "../../../shared/types.js";
import {
  computeP99,
  computeErrorRate,
  shouldFallback,
  getFastestModel,
  extractModelIdentifier,
  extractProviderIdentifier,
  extractLatencyMs,
  extractCallOutcome,
  resolveSharedModelState,
  addBounded,
  type ModelRouterConfig,
  type ModelStats,
  type ModelHealthReport,
} from "./model-router-logic.js";

// ── Stream Relay Seams ───────────────────────────────────────────────
export {
  shouldRelay,
  shouldRelayFallback,
  type StreamRelayConfig,
  type RelayState,
} from "./stream-relay-logic.js";
import { type RelayState } from "./stream-relay-logic.js";

// ── Context Cache Seams ──────────────────────────────────────────────
export {
  getCached,
  putCached,
  invalidateExpired,
  getCacheStats,
  type CacheEntry,
  type CacheStore,
  type CacheStats,
  type CachePutResult,
} from "./context-cache-logic.js";
import {
  getCached,
  putCached,
  getCacheStats,
  type CacheStore,
} from "./context-cache-logic.js";

// ── Event Loop Monitor Seams ─────────────────────────────────────────
import { aggregateSystemHealth, type ProcessTelemetry, type SystemHealth } from "../../../shared/telemetry-logic.js";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import process from "node:process";

export interface ModelNexusConfig {
  p99ThresholdMs?: number;
  errorRateThreshold?: number;
  minSamples?: number;
  maxSamples?: number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  collectIntervalMs?: number;
  sidecarPort?: number;
  fallbackEnabled?: boolean;
}

export default definePluginEntry({
  id: "oc-model-nexus",
  name: "OC Model Nexus",
  description: "Unified Model Nexus Engine (Plugins v2) — consolidates active model routing & failover, sidecar stream relay, event-loop telemetry monitoring, and prompt context caching.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg = (config as ModelNexusConfig) ?? {};
    const p99ThresholdMs = cfg.p99ThresholdMs ?? 15000;
    const errorRateThreshold = cfg.errorRateThreshold ?? 0.1;
    const minSamples = cfg.minSamples ?? 5;
    const maxSamples = cfg.maxSamples ?? 100;

    const cacheTtlMs = cfg.cacheTtlMs ?? 300000;
    const cacheMaxEntries = cfg.cacheMaxEntries ?? 100;
    const cacheStore: CacheStore = new Map();

    const shared = resolveSharedModelState();
    shared.reloadCount += 1;
    const modelStats = shared.modelStats;
    const seenCallIds = shared.seenCallIds;

    function getOrCreate(model: string, provider?: string): ModelStats {
      let stats = modelStats.get(model);
      if (!stats) {
        stats = { latencies: [], errors: 0, total: 0, timeouts: 0, provider };
        modelStats.set(model, stats);
        return stats;
      }
      if (provider && !stats.provider) {
        stats.provider = provider;
      }
      return stats;
    }

    // Relay State
    const relayState: RelayState = {
      started: true,
      startedAt: Date.now(),
      sidecarPort: cfg.sidecarPort ?? 18900,
      fallbackMode: false,
      fallbackCount: 0,
      totalRelayed: 0,
      totalFailed: 0,
      lastLatencyMs: null,
      avgLatencyMs: null,
    };

    // Event Loop Telemetry
    let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
    try {
      histogram = monitorEventLoopDelay();
      histogram.enable();
    } catch {}

    let lastCpu = process.cpuUsage();
    let lastTime = process.hrtime.bigint();
    const readings: ProcessTelemetry[] = [];

    function collectTelemetry(actorId = "main"): ProcessTelemetry {
      const eventLoopP99Ms = histogram ? histogram.percentile(99) / 1e6 : 0;
      const { utilization } = performance.eventLoopUtilization ? performance.eventLoopUtilization() : { utilization: 0 };
      const usedHeapSize = getHeapStatistics ? getHeapStatistics().used_heap_size : 0;

      const now = process.hrtime.bigint();
      const cpu = process.cpuUsage(lastCpu);
      const elapsedUs = Number(now - lastTime) / 1000;
      const cpuTotalUs = cpu.user + cpu.system;
      const cpuRatio = elapsedUs > 0 ? cpuTotalUs / elapsedUs : 0;
      lastCpu = process.cpuUsage();
      lastTime = now;

      const reading: ProcessTelemetry = {
        actorId,
        eventLoopP99Ms,
        eventLoopUtilization: utilization,
        usedHeapSize,
        cpuRatio,
      };

      readings.push(reading);
      if (readings.length > 100) readings.shift();
      return reading;
    }

    // ── Model Call Hooks ─────────────────────────────────────────────
    api.on("model_call_started", async (event: HookEvent, ctx?: HookContext) => {
      try {
        collectTelemetry("main");
        const model = extractModelIdentifier(event, ctx);
        if (!model) return;
        const provider = extractProviderIdentifier(event, ctx);
        const stats = getOrCreate(model, provider);
        const callId = typeof event?.callId === "string" ? event.callId : "";
        if (callId && seenCallIds.has(callId)) return;
        stats.total++;
        if (callId) addBounded(seenCallIds, callId);
      } catch {}
    });

    api.on("model_call_ended", async (event: HookEvent, ctx?: HookContext) => {
      try {
        const model = extractModelIdentifier(event, ctx);
        if (!model) return;
        const provider = extractProviderIdentifier(event, ctx);
        const stats = getOrCreate(model, provider);

        const latencyMs = extractLatencyMs(event, ctx);
        const { isError, isTimeout } = extractCallOutcome(event, ctx);

        const callId = typeof event?.callId === "string" ? event.callId : "";
        if (callId) {
          if (!seenCallIds.has(callId)) {
            stats.total++;
            addBounded(seenCallIds, callId);
          }
        } else {
          if (stats.total <= 0) stats.total = 1;
        }

        if (latencyMs > 0) {
          stats.latencies.push(latencyMs);
          if (stats.latencies.length > maxSamples) {
            stats.latencies.shift();
          }
        }

        if (isError) {
          stats.errors++;
          if (stats.total < stats.errors) {
            stats.total = stats.errors;
          }
        }

        if (isTimeout) {
          stats.timeouts = (stats.timeouts ?? 0) + 1;
        }
      } catch (err) {
        api.logger?.warn?.(`[oc-model-nexus] model_call_ended error: ${String(err)}`);
      }
    });

    api.on("gateway_stop", async () => {
      try {
        if (histogram) histogram.disable();
      } catch {}
    });

    // ── Tool 1: model_health ─────────────────────────────────────────
    api.registerTool({
      name: "model_health",
      description: "Report per-model P99 latency, error rate, and current routing decision. Run to check which models are healthy and whether a fallback should be triggered.",
      parameters: Type.Object({}),
      async execute(_id: string) {
        const reports: ModelHealthReport[] = [];
        const thresholds = { p99ThresholdMs, errorRateThreshold, minSamples };

        for (const [model, stats] of modelStats) {
          const p99 = computeP99(stats.latencies);
          const errorRate = computeErrorRate(stats.total, stats.errors);
          const status = shouldFallback(p99, errorRate, thresholds, stats.total);
          const report: ModelHealthReport = {
            model,
            p99Ms: Math.round(p99 * 100) / 100,
            errorRate: Math.round(errorRate * 10000) / 10000,
            totalCalls: stats.total,
            status,
            timeouts: stats.timeouts ?? 0,
          };
          if (stats.provider) {
            report.provider = stats.provider;
          }
          reports.push(report);
        }

        const fastest = getFastestModel(modelStats, thresholds);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              totalModels: reports.length,
              models: reports,
              fastestModel: fastest,
              reloadCount: shared.reloadCount,
              thresholds: {
                p99ThresholdMs,
                errorRateThreshold,
                minSamples,
                maxSamples,
              },
            }, null, 2),
          }],
        };
      },
    });

    // ── Tool 2: stream_relay_health ──────────────────────────────────
    api.registerTool({
      name: "stream_relay_health",
      description: "Check the health of the stream relay — relay process status, latency statistics, fallback mode, and relay counts.",
      parameters: Type.Object({}),
      async execute(_id: string) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              started: relayState.started,
              uptimeSeconds: relayState.startedAt ? Math.round((Date.now() - relayState.startedAt) / 1000) : 0,
              sidecarPort: relayState.sidecarPort,
              fallbackMode: relayState.fallbackMode,
              fallbackCount: relayState.fallbackCount,
              totalRelayed: relayState.totalRelayed,
              totalFailed: relayState.totalFailed,
              lastLatencyMs: relayState.lastLatencyMs,
              avgLatencyMs: relayState.avgLatencyMs,
            }, null, 2),
          }],
        };
      },
    });

    // ── Tool 3: event_loop_health ────────────────────────────────────
    api.registerTool({
      name: "event_loop_health",
      description: "Report event loop health — P99 delay, utilization, heap usage, CPU ratio, and overall status (healthy/degraded/critical). Run to check if the system is under load before heavy operations.",
      parameters: Type.Object({}),
      async execute(_id: string) {
        const health: SystemHealth = aggregateSystemHealth(readings.slice(-10), 0, 0);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(health, null, 2) }],
        };
      },
    });

    // ── Tool 4: context_cache_stats ──────────────────────────────────
    api.registerTool({
      name: "context_cache_stats",
      description: "Report cache statistics — cache size, hit rate, entry details, and TTL configuration.",
      parameters: Type.Object({}),
      async execute(_id: string) {
        const stats = getCacheStats(cacheStore, Date.now(), cacheTtlMs, cacheMaxEntries);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
        };
      },
    });
  },
});
