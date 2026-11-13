/**
 * Pure logic and shared state for Model Router (Plugins v2 seam).
 *
 * @behavior
 * Pure logic functions for calculating P99 latencies, error rates, fallback
 * decisions, and extracting model telemetry from hook events.
 *
 * @invariants
 * - Pure logic: all functions are deterministic, taking timing as inputs.
 * - No Node.js I/O or network dependencies.
 *
 * @dft
 * - Tested directly in model-router unit and integration suites.
 */

import type { HookEvent, HookContext } from "../../../shared/types.js";

export interface ModelStats {
  latencies: number[];
  errors: number;
  total: number;
  provider?: string;
  timeouts?: number;
}

export interface ModelRouterConfig {
  p99ThresholdMs?: number;
  errorRateThreshold?: number;
  minSamples?: number;
  maxSamples?: number;
}

export type FallbackStatus = "healthy" | "degraded" | "critical";

export interface ModelHealthReport {
  model: string;
  provider?: string;
  p99Ms: number;
  errorRate: number;
  totalCalls: number;
  status: FallbackStatus;
  timeouts?: number;
}

export type ModelStatsMap = Map<string, ModelStats>;

const STATE_KEY = "__oc_model_router_state__";

export interface SharedModelState {
  modelStats: ModelStatsMap;
  seenCallIds: Set<string>;
  reloadCount: number;
}

const SEEN_CALL_IDS_CAP = 4096;

export function resolveSharedModelState(): SharedModelState {
  const g = globalThis as Record<string, unknown>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      modelStats: new Map(),
      seenCallIds: new Set(),
      reloadCount: 0,
    } as SharedModelState;
  }
  return g[STATE_KEY] as SharedModelState;
}

export function resetSharedModelStateForTests(): void {
  const g = globalThis as Record<string, unknown>;
  delete g[STATE_KEY];
}

export function addBounded(set: Set<string>, id: string): void {
  if (set.size >= SEEN_CALL_IDS_CAP) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(id);
}

export function computeP99(latencies: number[]): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.99) - 1;
  return sorted[Math.max(0, idx)];
}

export function computeErrorRate(total: number, errors: number): number {
  if (total <= 0) return 0;
  return errors / total;
}

export function shouldFallback(
  p99: number,
  errorRate: number,
  thresholds: { p99ThresholdMs: number; errorRateThreshold: number; minSamples: number },
  totalCalls: number,
): FallbackStatus {
  const { p99ThresholdMs, errorRateThreshold, minSamples } = thresholds;

  if (totalCalls < minSamples) {
    return "healthy";
  }

  const p99Bad = p99 > p99ThresholdMs;
  const errorRateBad = errorRate > errorRateThreshold;
  const p99Critical = p99 > p99ThresholdMs * 3;
  const errorRateCritical = errorRate > errorRateThreshold * 3;

  if ((p99Bad && errorRateBad) || p99Critical || errorRateCritical) {
    return "critical";
  }

  if (p99Bad || errorRateBad) {
    return "degraded";
  }

  return "healthy";
}

export function getFastestModel(
  stats: ModelStatsMap,
  thresholds?: { p99ThresholdMs: number; errorRateThreshold: number; minSamples: number },
): string | null {
  let fastest: string | null = null;
  let lowestAvg = Infinity;

  for (const [model, modelStats] of stats) {
    if (modelStats.latencies.length === 0) continue;
    if (thresholds) {
      const p99 = computeP99(modelStats.latencies);
      const errorRate = computeErrorRate(modelStats.total, modelStats.errors);
      const status = shouldFallback(p99, errorRate, thresholds, modelStats.total);
      if (status !== "healthy") continue;
    }
    const avg = modelStats.latencies.reduce((a, b) => a + b, 0) / modelStats.latencies.length;
    if (avg < lowestAvg) {
      lowestAvg = avg;
      fastest = model;
    }
  }

  if (!fastest && thresholds) {
    return getFastestModel(stats);
  }

  return fastest;
}

export function extractModelIdentifier(event?: HookEvent, ctx?: HookContext): string {
  if (!event && !ctx) return "";
  const fromEvent =
    (typeof event?.model === "string" && event.model.trim()) ||
    (typeof event?.modelId === "string" && event.modelId.trim()) ||
    "";
  if (fromEvent) return fromEvent;
  const fromCtx = (typeof ctx?.modelId === "string" && ctx.modelId.trim()) || "";
  return fromCtx;
}

export function extractProviderIdentifier(event?: HookEvent, ctx?: HookContext): string | undefined {
  if (!event && !ctx) return undefined;
  const fromEvent =
    (typeof event?.provider === "string" && event.provider.trim()) ||
    (typeof event?.modelProviderId === "string" && event.modelProviderId.trim()) ||
    undefined;
  if (fromEvent) return fromEvent;
  const fromCtx =
    (typeof ctx?.modelProviderId === "string" && ctx.modelProviderId.trim()) ||
    undefined;
  return fromCtx;
}

export function extractLatencyMs(event?: HookEvent, _ctx?: HookContext): number {
  if (typeof event?.durationMs === "number" && !isNaN(event.durationMs) && event.durationMs >= 0) {
    return event.durationMs;
  }
  if (typeof event?.latencyMs === "number" && !isNaN(event.latencyMs) && event.latencyMs >= 0) {
    return event.latencyMs;
  }
  return 0;
}

export function extractCallOutcome(event?: HookEvent, _ctx?: HookContext): { isError: boolean; isTimeout: boolean } {
  if (!event) return { isError: false, isTimeout: false };

  const outcome = typeof event.outcome === "string" ? event.outcome.toLowerCase() : "";
  const failureKind = typeof event.failureKind === "string" ? event.failureKind.toLowerCase() : "";
  const errorCategory = typeof event.errorCategory === "string" ? event.errorCategory.toLowerCase() : "";
  const errVal = event.error;
  const errString = typeof errVal === "string" ? errVal.toLowerCase() : "";
  const isErrBool = typeof errVal === "boolean" ? errVal : false;
  const successVal = event.success;

  const isTimeout =
    failureKind === "timeout" ||
    errorCategory.includes("timeout") ||
    errString.includes("timeout") ||
    (typeof event.message === "string" && event.message.toLowerCase().includes("timeout"));

  const isError =
    outcome === "error" ||
    isErrBool ||
    Boolean(failureKind) ||
    successVal === false ||
    (typeof errVal === "object" && errVal !== null) ||
    Boolean(errString);

  return { isError, isTimeout };
}
