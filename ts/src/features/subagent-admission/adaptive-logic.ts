/**
 * Adaptive spawn logic — replaces static guards with health-aware decisions.
 *
 * @behavior
 * Instead of hard maxConcurrent and runTimeoutSeconds guards, the system
 * checks real-time health signals before allowing a spawn. When the system
 * is healthy, it allows more subagents. When it's stressed, it slows down.
 *
 * Subagents self-report their status via a progress contract. If they miss
 * a report, they're marked stale — not killed. Stale subagents are yielded
 * to, allowing graceful checkpoint and exit.
 *
 * @invariants
 * - Hard max is never exceeded (safety net).
 * - Above soft limit, health check is required.
 * - Stale subagents are yielded to, not force-killed.
 * - The system never spawns into a saturated state.
 *
 * @remarks
 * This replaces OC's static config guards with an adaptive system.
 * The key insight: subagents know their own status. Let them report it.
 * The parent reads reports (from SQLite, indexed) instead of polling
 * a JSON blob. When a subagent is stale, the parent yields to it,
 * letting it checkpoint and exit gracefully — rather than killing it
 * and losing work.
 */

import type {
  AdaptivePolicy,
  SpawnDecision,
  SubagentReport,
  SystemHealth,
} from "./subagent-reporting.schema.js"

/**
 * Evaluate whether a spawn should be admitted based on system health.
 *
 * Pure function — no side effects. Takes a health snapshot and policy,
 * returns a decision with the reason and suggested delay.
 *
 * Decision logic:
 * 1. If active >= hard max → reject (safety net)
 * 2. If active >= soft limit → check health signals
 *    - If event loop P99 > threshold → reject, suggest delay
 *    - If utilization > threshold → reject, suggest delay
 *    - If CPU > threshold → reject, suggest delay
 *    - If stale subagents exist → yield to them first
 * 3. If under soft limit → admit (system has capacity)
 */
export function evaluateAdaptiveSpawn(
  health: SystemHealth,
  policy: AdaptivePolicy,
  staleSubagents: ReadonlyArray<string> = [],
): SpawnDecision {
  // Safety net: hard max is never exceeded
  if (health.activeSubagents >= policy.maxAbsolute) {
    return {
      admitted: false,
      reason: `Hard limit reached (${health.activeSubagents}/${policy.maxAbsolute})`,
      healthSnapshot: health,
      blockingSubagents: staleSubagents.length > 0 ? staleSubagents : undefined,
    }
  }

  // Above soft limit — check health signals
  if (health.activeSubagents >= policy.softLimit) {
    // Stale subagents take priority — yield to them before spawning
    if (staleSubagents.length > 0) {
      return {
        admitted: false,
        reason: `${staleSubagents.length} stale subagent(s) need yielding before spawn`,
        suggestedDelayMs: policy.defaultReportIntervalMs,
        healthSnapshot: health,
        blockingSubagents: staleSubagents,
      }
    }

    // Event loop health check
    if (health.eventLoopP99Ms > policy.eventLoopP99Threshold) {
      const delay = Math.ceil(health.eventLoopP99Ms)
      return {
        admitted: false,
        reason: `Event loop P99 ${health.eventLoopP99Ms.toFixed(0)}ms exceeds threshold ${policy.eventLoopP99Threshold}ms`,
        suggestedDelayMs: delay,
        healthSnapshot: health,
      }
    }

    // Utilization check
    if (health.eventLoopUtilization > policy.eventLoopUtilizationThreshold) {
      return {
        admitted: false,
        reason: `Event loop utilization ${(health.eventLoopUtilization * 100).toFixed(0)}% exceeds threshold ${(policy.eventLoopUtilizationThreshold * 100).toFixed(0)}%`,
        suggestedDelayMs: 2000,
        healthSnapshot: health,
      }
    }

    // CPU check
    if (health.cpuCoreRatio > policy.cpuCoreRatioThreshold) {
      return {
        admitted: false,
        reason: `CPU ${health.cpuCoreRatio.toFixed(2)} cores exceeds threshold ${policy.cpuCoreRatioThreshold}`,
        suggestedDelayMs: 3000,
        healthSnapshot: health,
      }
    }
  }

  // Under soft limit and healthy — admit
  return {
    admitted: true,
    reason: `Admitted: ${health.activeSubagents} active, P99 ${health.eventLoopP99Ms.toFixed(0)}ms, util ${(health.eventLoopUtilization * 100).toFixed(0)}%`,
    healthSnapshot: health,
  }
}

/**
 * Check if a subagent is stale (missed its progress report).
 *
 * Pure function — compares last report time against the contract.
 */
export function isStale(
  report: SubagentReport,
  contract: { staleAfterMs: number },
  nowMs: number,
): boolean {
  if (report.state !== "running") return false
  return (nowMs - report.lastReportAtMs) > contract.staleAfterMs
}

/**
 * Collect stale subagent keys from a set of reports.
 *
 * Pure function — returns the keys of subagents that have missed
 * their progress reports.
 */
export function collectStale(
  reports: ReadonlyArray<SubagentReport>,
  contract: { staleAfterMs: number },
  nowMs: number,
): string[] {
  return reports
    .filter((r) => r.state === "running" && isStale(r, contract, nowMs))
    .map((r) => r.sessionKey)
}

/**
 * Calculate the effective concurrency based on health.
 *
 * Instead of a static maxConcurrent, the system adjusts the effective
 * limit based on current health. When healthy, allow more. When stressed,
 * allow fewer.
 *
 * @returns The number of additional subagents that can be admitted.
 */
export function calculateEffectiveCapacity(
  health: SystemHealth,
  policy: AdaptivePolicy,
): number {
  // Start with hard max
  let effective = policy.maxAbsolute - health.activeSubagents

  // If above soft limit, reduce based on health
  if (health.activeSubagents >= policy.softLimit) {
    // If event loop is stressed, reduce to 0 (no new spawns)
    if (health.eventLoopP99Ms > policy.eventLoopP99Threshold) {
      effective = 0
    } else if (health.eventLoopUtilization > policy.eventLoopUtilizationThreshold) {
      effective = 0
    } else if (health.cpuCoreRatio > policy.cpuCoreRatioThreshold) {
      effective = 0
    } else {
      // Above soft limit but healthy — allow 1 more
      effective = Math.min(effective, 1)
    }
  }

  return Math.max(0, effective)
}
