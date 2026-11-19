/**
 * Model Routing Pure Transition Algebra — deterministic P99 latency, error rate,
 * fallback evaluation, and call recording transitions.
 *
 * @invariants
 * - Pure logic: zero Node.js I/O, zero Date.now(), zero void mutators (Axioms A1, A2, A6).
 * - All state transitions return explicit CheckResult / TransitionResult containers.
 *
 * @dft
 * - Tested in slices/model-routing/tests/logic.spec.ts with inline fixtures.
 */

import type { HookEvent, HookContext } from "../../../../../shared/types.js";
import type { ModelRoutingState, ModelStats, ModelStatsMap, ModelRouterConfig } from "./state.js";

export type FallbackStatus = "healthy" | "degraded" | "critical";

export interface ModelHealthReport {
  model: string;
  provider?: string;
  p99Ms: number;
  errorRate: number;
  totalCalls: number;
  status: FallbackStatus;
  timeouts: number;
}

export interface BoundedAddResult {
  added: boolean;
  evicted?: string;
  size: number;
}

const SEEN_CALL_IDS_CAP = 4096;

export function addBounded(set: Set<string>, id: string, cap = SEEN_CALL_IDS_CAP): BoundedAddResult {
  let evicted: string | undefined;
  if (set.size >= cap && !set.has(id)) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) {
      set.delete(oldest);
      evicted = oldest;
    }
  }
  const existed = set.has(id);
  set.add(id);
  return { added: !existed, evicted, size: set.size };
}

export function computeP99(latencies: number[]): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.99) - 1;
  return sorted[Math.max(0, idx)];
}

export function computeErrorRate(total: number, errors: number): number {
  return total <= 0 ? 0 : errors / total;
}

export function shouldFallback(
  p99: number,
  errorRate: number,
  thresholds: Pick<ModelRouterConfig, "p99ThresholdMs" | "errorRateThreshold" | "minSamples">,
  totalCalls: number,
): FallbackStatus {
  const { p99ThresholdMs, errorRateThreshold, minSamples } = thresholds;
  if (totalCalls < minSamples) return "healthy";

  const p99Bad = p99 > p99ThresholdMs;
  const errorRateBad = errorRate > errorRateThreshold;
  const p99Critical = p99 > p99ThresholdMs * 3;
  const errorRateCritical = errorRate > errorRateThreshold * 3;

  if ((p99Bad && errorRateBad) || p99Critical || errorRateCritical) return "critical";
  if (p99Bad || errorRateBad) return "degraded";
  return "healthy";
}

export function getFastestModel(
  stats: ModelStatsMap,
  thresholds?: Pick<ModelRouterConfig, "p99ThresholdMs" | "errorRateThreshold" | "minSamples">,
): string | null {
  let fastest: string | null = null;
  let lowestAvg = Infinity;

  for (const [model, modelStats] of stats) {
    if (modelStats.latencies.length === 0) continue;
    if (thresholds) {
      const p99 = computeP99(modelStats.latencies);
      const errorRate = computeErrorRate(modelStats.total, modelStats.errors);
      if (shouldFallback(p99, errorRate, thresholds, modelStats.total) !== "healthy") continue;
    }
    const avg = modelStats.latencies.reduce((a, b) => a + b, 0) / modelStats.latencies.length;
    if (avg < lowestAvg) {
      lowestAvg = avg;
      fastest = model;
    }
  }

  return !fastest && thresholds ? getFastestModel(stats) : fastest;
}

export function extractModelIdentifier(event?: HookEvent, ctx?: HookContext): string {
  if (!event && !ctx) return "";
  const fromEvent =
    (typeof event?.model === "string" && event.model.trim()) ||
    (typeof event?.modelId === "string" && event.modelId.trim()) ||
    "";
  if (fromEvent) return fromEvent;
  return (typeof ctx?.modelId === "string" && ctx.modelId.trim()) || "";
}

export function extractProviderIdentifier(event?: HookEvent, ctx?: HookContext): string | undefined {
  if (!event && !ctx) return undefined;
  const fromEvent =
    (typeof event?.provider === "string" && event.provider.trim()) ||
    (typeof event?.modelProviderId === "string" && event.modelProviderId.trim()) ||
    undefined;
  if (fromEvent) return fromEvent;
  return (typeof ctx?.modelProviderId === "string" && ctx.modelProviderId.trim()) || undefined;
}

export function extractLatencyMs(event?: HookEvent): number {
  if (typeof event?.durationMs === "number" && !Number.isNaN(event.durationMs) && event.durationMs >= 0) {
    return event.durationMs;
  }
  if (typeof event?.latencyMs === "number" && !Number.isNaN(event.latencyMs) && event.latencyMs >= 0) {
    return event.latencyMs;
  }
  return 0;
}

export function extractCallOutcome(event?: HookEvent): { isError: boolean; isTimeout: boolean } {
  if (!event) return { isError: false, isTimeout: false };

  const outcome = typeof event.outcome === "string" ? event.outcome.toLowerCase() : "";
  const failureKind = typeof event.failureKind === "string" ? event.failureKind.toLowerCase() : "";
  const errorCategory = typeof event.errorCategory === "string" ? event.errorCategory.toLowerCase() : "";
  const errString = typeof event.error === "string" ? event.error.toLowerCase() : "";

  const isTimeout =
    failureKind === "timeout" ||
    errorCategory.includes("timeout") ||
    errString.includes("timeout") ||
    (typeof event.message === "string" && event.message.toLowerCase().includes("timeout"));

  const isError =
    outcome === "error" ||
    event.error === true ||
    Boolean(failureKind) ||
    event.success === false ||
    (typeof event.error === "object" && event.error !== null) ||
    Boolean(errString);

  return { isError, isTimeout };
}

function getOrCreateStats(state: ModelRoutingState, model: string, provider?: string): ModelStats {
  let stats = state.modelStats.get(model);
  if (!stats) {
    stats = { latencies: [], errors: 0, total: 0, provider, timeouts: 0 };
    state.modelStats.set(model, stats);
  } else if (provider && !stats.provider) {
    stats.provider = provider;
  }
  return stats;
}

export function recordModelCallStarted(
  state: ModelRoutingState,
  event?: HookEvent,
  ctx?: HookContext,
): { recorded: boolean; model: string } {
  const model = extractModelIdentifier(event, ctx);
  if (!model) return { recorded: false, model: "" };
  const callId = typeof event?.callId === "string" ? event.callId : "";
  if (callId && state.seenCallIds.has(callId)) return { recorded: false, model };

  const stats = getOrCreateStats(state, model, extractProviderIdentifier(event, ctx));
  stats.total += 1;
  if (callId) addBounded(state.seenCallIds, callId);
  return { recorded: true, model };
}

export function recordModelCallEnded(
  state: ModelRoutingState,
  config: ModelRouterConfig,
  event?: HookEvent,
  ctx?: HookContext,
): { recorded: boolean; model: string; status: FallbackStatus; isError: boolean; latencyMs: number } {
  const model = extractModelIdentifier(event, ctx);
  if (!model) return { recorded: false, model: "", status: "healthy", isError: false, latencyMs: 0 };

  const stats = getOrCreateStats(state, model, extractProviderIdentifier(event, ctx));
  const latencyMs = extractLatencyMs(event);
  const { isError, isTimeout } = extractCallOutcome(event);
  const callId = typeof event?.callId === "string" ? event.callId : "";

  if (callId) {
    if (!state.seenCallIds.has(callId)) {
      stats.total += 1;
      addBounded(state.seenCallIds, callId);
    }
  } else if (stats.total <= 0) {
    stats.total = 1;
  }

  if (latencyMs > 0) {
    stats.latencies.push(latencyMs);
    if (stats.latencies.length > config.maxSamples) stats.latencies.shift();
  }
  if (isError) stats.errors += 1;
  if (isTimeout) stats.timeouts += 1;

  const p99 = computeP99(stats.latencies);
  const errorRate = computeErrorRate(stats.total, stats.errors);
  const status = shouldFallback(p99, errorRate, config, stats.total);
  return { recorded: true, model, status, isError, latencyMs };
}

export function buildModelHealthSummary(
  state: ModelRoutingState,
  config: ModelRouterConfig,
): {
  totalModels: number;
  models: ModelHealthReport[];
  recommendedFallback: string | null;
  thresholds: Pick<ModelRouterConfig, "p99ThresholdMs" | "errorRateThreshold" | "minSamples">;
} {
  const reports: ModelHealthReport[] = [];
  for (const [model, stats] of state.modelStats) {
    const p99Ms = computeP99(stats.latencies);
    const errorRate = computeErrorRate(stats.total, stats.errors);
    reports.push({
      model,
      provider: stats.provider,
      p99Ms: Math.round(p99Ms),
      errorRate: Math.round(errorRate * 1000) / 1000,
      totalCalls: stats.total,
      status: shouldFallback(p99Ms, errorRate, config, stats.total),
      timeouts: stats.timeouts,
    });
  }
  return {
    totalModels: reports.length,
    models: reports,
    recommendedFallback: getFastestModel(state.modelStats, config),
    thresholds: {
      p99ThresholdMs: config.p99ThresholdMs,
      errorRateThreshold: config.errorRateThreshold,
      minSamples: config.minSamples,
    },
  };
}
