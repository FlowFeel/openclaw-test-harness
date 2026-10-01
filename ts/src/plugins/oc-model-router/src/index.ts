/**
 * OC Model Router — model fallback chain optimization.
 *
 * @behavior
 * Tracks per-model latency and error rates in-memory using the
 * model_call_started/ended hooks. Exposes a model_health tool that
 * reports per-model P99, error rate, timeouts, and the current routing decision.
 *
 * Pure logic functions (computeP99, computeErrorRate, shouldFallback,
 * getFastestModel, extractModelIdentifier, extractProviderIdentifier,
 * extractLatencyMs, extractCallOutcome) are exported for testing.
 *
 * @dft
 * - Pure logic functions are exported for testing.
 * - In-memory state tracking is the only I/O — no file or network access.
 * - Hook handlers are thin: extract timing & error signals → aggregate → expose via tool.
 * - Bounded memory: rolling latency window capped at maxSamples.
 */

import { definePluginEntry, Type, type PluginApi, type HookEvent, type HookContext } from "../../shared/types.js";

// ── Types ─────────────────────────────────────────────────────

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

// ── Pure Logic ────────────────────────────────────────────────

/**
 * Compute the 99th percentile latency from a sorted array of latencies.
 * Returns 0 for empty arrays.
 */
export function computeP99(latencies: number[]): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.99) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Compute the error rate as errors / total.
 * Returns 0 when total is 0.
 */
export function computeErrorRate(total: number, errors: number): number {
  if (total <= 0) return 0;
  return errors / total;
}

/**
 * Determine the fallback status for a model based on its P99 latency
 * and error rate against configured thresholds.
 *
 * - "healthy": P99 below threshold AND error rate below threshold
 * - "degraded": P99 above threshold OR error rate above threshold,
 *   but only when `minSamples` have been collected
 * - "critical": Both P99 AND error rate above thresholds,
 *   or P99 is 3x the threshold, or error rate is 3x the threshold
 * - "healthy": Insufficient samples (below minSamples) — treat as
 *   unknown/healthy to avoid premature fallback
 */
export function shouldFallback(
  p99: number,
  errorRate: number,
  thresholds: { p99ThresholdMs: number; errorRateThreshold: number; minSamples: number },
  totalCalls: number,
): FallbackStatus {
  const { p99ThresholdMs, errorRateThreshold, minSamples } = thresholds;

  // Not enough data to make a decision — treat as healthy
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

/**
 * Find the model with the lowest average latency from the stats map.
 * Returns null if the map is empty or all models have no latencies.
 * When thresholds are provided, prioritizes models with a "healthy" status.
 */
export function getFastestModel(
  stats: ModelStatsMap,
  thresholds?: { p99ThresholdMs: number; errorRateThreshold: number; minSamples: number },
): string | null {
  let fastest: string | null = null;
  let lowestAvg = Infinity;

  // First pass: consider only healthy models if thresholds are supplied
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

  // Fallback pass: if thresholds filtered all models out, select fastest overall
  if (!fastest && thresholds) {
    return getFastestModel(stats);
  }

  return fastest;
}

/**
 * Extract model identifier from either event payload (upstream OpenClaw or harness)
 * or the hook context.
 */
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

/**
 * Extract provider identifier from either event payload or hook context.
 */
export function extractProviderIdentifier(event?: HookEvent, ctx?: HookContext): string | undefined {
  if (!event && !ctx) return undefined;
  const fromEvent = (typeof event?.provider === "string" && event.provider.trim()) || "";
  if (fromEvent) return fromEvent;
  const fromCtx = (typeof ctx?.modelProviderId === "string" && ctx.modelProviderId.trim()) || "";
  return fromCtx || undefined;
}

/**
 * Extract duration / latency in milliseconds from event payload.
 */
export function extractLatencyMs(event?: HookEvent): number {
  if (typeof event?.durationMs === "number" && !isNaN(event.durationMs) && event.durationMs >= 0) {
    return event.durationMs;
  }
  if (typeof event?.latencyMs === "number" && !isNaN(event.latencyMs) && event.latencyMs >= 0) {
    return event.latencyMs;
  }
  return 0;
}

/**
 * Extract outcome and detect timeout errors across upstream OpenClaw and harness conventions.
 */
export function extractCallOutcome(event?: HookEvent): { isError: boolean; isTimeout: boolean } {
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

// ── Plugin Entry ──────────────────────────────────────────────

export default definePluginEntry({
  id: "oc-model-router",
  name: "OC Model Router",
  description: "Model fallback chain optimization — per-model P99, error rate, routing decisions.",
  register(api: PluginApi, config?: Record<string, unknown>) {
    const cfg: ModelRouterConfig = (config as ModelRouterConfig) ?? {};
    const p99ThresholdMs = cfg.p99ThresholdMs ?? 15000;
    const errorRateThreshold = cfg.errorRateThreshold ?? 0.1;
    const minSamples = cfg.minSamples ?? 5;
    const maxSamples = cfg.maxSamples ?? 100;

    // ── In-memory per-model tracking ──────────────────────────
    const modelStats: ModelStatsMap = new Map();

    function getOrCreate(model: string, provider?: string): ModelStats {
      let stats = modelStats.get(model);
      if (!stats) {
        stats = { latencies: [], errors: 0, total: 0, timeouts: 0, provider };
        modelStats.set(model, stats);
      } else if (provider && !stats.provider) {
        stats.provider = provider;
      }
      return stats;
    }

    // ── Hook: model_call_started — track start time ───────────
    api.on("model_call_started", async (event: HookEvent, ctx?: HookContext) => {
      try {
        const model = extractModelIdentifier(event, ctx);
        if (!model) return;
        const provider = extractProviderIdentifier(event, ctx);
        const stats = getOrCreate(model, provider);
        stats.total++;
      } catch {
        // Non-fatal
      }
    });

    // ── Hook: model_call_ended — record latency and errors ────
    api.on("model_call_ended", async (event: HookEvent, ctx?: HookContext) => {
      try {
        const model = extractModelIdentifier(event, ctx);
        if (!model) return;
        const provider = extractProviderIdentifier(event, ctx);
        const stats = getOrCreate(model, provider);

        const latencyMs = extractLatencyMs(event);
        const { isError, isTimeout } = extractCallOutcome(event);

        if (stats.total <= 0) {
          stats.total = 1;
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
      } catch {
        // Non-fatal
      }
    });

    // ── Tool: model_health ────────────────────────────────────
    api.registerTool({
      name: "model_health",
      description:
        "Report per-model P99 latency, error rate, and current routing " +
        "decision. Run to check which models are healthy and whether a " +
        "fallback should be triggered.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: Record<string, unknown>) {
        try {
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
                models: reports,
                fastestModel: fastest,
                thresholds: {
                  p99ThresholdMs,
                  errorRateThreshold,
                  minSamples,
                  maxSamples,
                },
              }, null, 2),
            }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Model health check failed: ${String(err)}` }],
          };
        }
      },
    });
  },
});