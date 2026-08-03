/**
 * Adaptive Admission — pure logic for telemetry-driven spawn throttling.
 *
 * #20: Wires the oc-event-loop-monitor's telemetry into spawn decisions.
 * When the event loop is under load, reduce effective maxConcurrent.
 * When critical, block spawning entirely.
 *
 * @behavior
 * Takes a SystemHealth snapshot + current subagent counts → returns
 * an admission decision (allow/deny + reason + effective maxConcurrent).
 *
 * @invariants
 * - Pure: no I/O, no Date.now(), no Math.random()
 * - Immutable: returns new values, never mutates
 * - Deterministic: same input → same output
 *
 * @dft
 * - All functions testable with inline data
 * - Thresholds are configurable (injectable)
 */

// ── Types ─────────────────────────────────────────────────────

export type HealthStatus = "healthy" | "degraded" | "critical";

export interface SystemHealthSnapshot {
  status: HealthStatus;
  eventLoopP99Ms: number;
  eventLoopUtilization: number;
  usedHeapSize: number;
  cpuRatio: number;
}

export interface AdmissionThresholds {
  p99HealthyMs: number;
  p99DegradedMs: number;
  utilHealthy: number;
  utilDegraded: number;
  heapCriticalMb: number;
  degradedReduction: number;  // how many slots to subtract when degraded
  criticalMaxConcurrent: number;  // always 0 (block all)
}

export interface AdmissionDecision {
  allowed: boolean;
  effectiveMaxConcurrent: number;
  reason: string;
  healthStatus: HealthStatus;
  activeCount: number;
  eventLoopP99Ms: number;
}

// ── Default thresholds (match the oc-event-loop-monitor config) ─

export const DEFAULT_THRESHOLDS: AdmissionThresholds = {
  p99HealthyMs: 50,
  p99DegradedMs: 200,
  utilHealthy: 0.3,
  utilDegraded: 0.7,
  heapCriticalMb: 500,
  degradedReduction: 2,
  criticalMaxConcurrent: 0,
};

// ── Pure logic ────────────────────────────────────────────────

/**
 * Classify a raw telemetry reading into a health status.
 */
export function classifyHealth(
  p99Ms: number,
  utilization: number,
  usedHeapMb: number,
  thresholds: AdmissionThresholds = DEFAULT_THRESHOLDS
): HealthStatus {
  // Critical takes priority
  if (
    p99Ms > thresholds.p99DegradedMs ||
    utilization > thresholds.utilDegraded ||
    usedHeapMb > thresholds.heapCriticalMb
  ) {
    return "critical";
  }

  // Degraded
  if (
    p99Ms > thresholds.p99HealthyMs ||
    utilization > thresholds.utilHealthy
  ) {
    return "degraded";
  }

  return "healthy";
}

/**
 * Compute the effective maxConcurrent given health status.
 */
export function computeEffectiveMax(
  configured: number,
  status: HealthStatus,
  thresholds: AdmissionThresholds = DEFAULT_THRESHOLDS
): number {
  switch (status) {
    case "healthy":
      return configured;
    case "degraded":
      return Math.max(1, configured - thresholds.degradedReduction);
    case "critical":
      return thresholds.criticalMaxConcurrent;
  }
}

/**
 * Full admission decision: should we allow a new spawn?
 */
export function getAdmissionDecision(
  health: SystemHealthSnapshot,
  activeCount: number,
  configuredMaxConcurrent: number,
  thresholds: AdmissionThresholds = DEFAULT_THRESHOLDS
): AdmissionDecision {
  const effectiveMax = computeEffectiveMax(
    configuredMaxConcurrent,
    health.status,
    thresholds
  );

  const allowed = activeCount < effectiveMax;

  let reason: string;
  if (health.status === "critical") {
    reason = `blocked: event loop ${health.status} (P99 ${Math.round(health.eventLoopP99Ms)}ms, util ${Math.round(health.eventLoopUtilization * 100)}%, heap ${Math.round(health.usedHeapSize / (1024 * 1024))}MB)`;
  } else if (!allowed) {
    reason = `blocked: ${activeCount}/${effectiveMax} slots used (effective max ${effectiveMax}/${configuredMaxConcurrent}${health.status === "degraded" ? ", throttled" : ""})`;
  } else if (health.status === "degraded") {
    reason = `throttled: effective max ${effectiveMax}/${configuredMaxConcurrent} (P99 ${Math.round(health.eventLoopP99Ms)}ms > ${thresholds.p99HealthyMs}ms)`;
  } else {
    reason = `ok: ${activeCount}/${effectiveMax} slots used`;
  }

  return {
    allowed,
    effectiveMaxConcurrent: effectiveMax,
    reason,
    healthStatus: health.status,
    activeCount,
    eventLoopP99Ms: health.eventLoopP99Ms,
  };
}

/**
 * Check if recovery from degraded/critical should restore full capacity.
 * Called periodically — if health has been healthy for `recoveryPeriodsMs`,
 * restore the configured maxConcurrent.
 */
export function shouldRestoreCapacity(
  currentStatus: HealthStatus,
  healthySinceMs: number,
  nowMs: number,
  recoveryPeriodsMs: number = 30_000
): boolean {
  if (currentStatus !== "healthy") return false;
  return (nowMs - healthySinceMs) >= recoveryPeriodsMs;
}
