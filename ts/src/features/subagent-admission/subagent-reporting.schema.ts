/**
 * Subagent self-reporting protocol — subagents report their own status
 * instead of the parent polling a JSON blob.
 *
 * @behavior
 * Subagents write their status directly to a shared store (SQLite)
 * on a cadence. The parent reads status from the store (indexed, fast).
 * No JSON blob, no event loop pressure, no polling.
 *
 * @invariants
 * - Every subagent has a progress contract: report every N seconds
 *   or be considered stale.
 * - Stale subagents are not killed — they are marked for yielding,
 *   which lets them checkpoint and exit gracefully.
 * - The system adapts spawn limits based on real-time health metrics,
 *   not static config caps.
 *
 * @remarks
 * OC's current model is: parent spawns → subagent runs → parent polls
 * sessions.json to check status. This is backwards. The subagent knows
 * its own status — let it report directly.
 *
 * The protocol is:
 * 1. Parent spawns subagent, assigns a progress contract (report interval)
 * 2. Subagent writes status to SQLite every N seconds
 * 3. Parent reads from SQLite (indexed lookup, microseconds)
 * 4. If subagent misses a report, it's marked stale (not killed)
 * 5. Stale subagents are yielded to, allowing graceful checkpoint
 *
 * This replaces: maxConcurrent guards, runTimeoutSeconds guards,
 * JSON blob polling, and the entire sessions.json registry.
 */

import { Schema } from "effect"

// ── Subagent self-reported status ──────────────────────────────

export const SubagentReport = Schema.Struct({
  sessionKey: Schema.String,
  state: Schema.Literal(
    "running",
    "yielding",
    "done",
    "error",
    "stale",
  ),
  progress: Schema.Number,
  estimatedRemainingMs: Schema.optional(Schema.Number),
  lastReportAtMs: Schema.Number,
  tokenBudgetUsed: Schema.optional(Schema.Number),
  tokenBudgetTotal: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String),
})
export type SubagentReport = Schema.Schema.Type<typeof SubagentReport>

// ── Progress contract ──────────────────────────────────────────

export const ProgressContract = Schema.Struct({
  reportIntervalMs: Schema.Number,
  staleAfterMs: Schema.Number,
  checkpointOnStale: Schema.Boolean,
  gracefulYieldTimeout: Schema.optional(Schema.Number),
})
export type ProgressContract = Schema.Schema.Type<typeof ProgressContract>

// ── System health signals ──────────────────────────────────────

/**
 * Real-time system health signals used for adaptive spawning.
 * Instead of static maxConcurrent, the system checks these
 * signals before allowing a spawn.
 */
export const SystemHealth = Schema.Struct({
  eventLoopP99Ms: Schema.Number,
  eventLoopUtilization: Schema.Number,
  cpuCoreRatio: Schema.Number,
  activeSubagents: Schema.Number,
  staleSubagents: Schema.Number,
  registrySizeBytes: Schema.optional(Schema.Number),
})
export type SystemHealth = Schema.Schema.Type<typeof SystemHealth>

// ── Adaptive spawn decision ─────────────────────────────────────

export const SpawnDecision = Schema.Struct({
  admitted: Schema.Boolean,
  reason: Schema.String,
  suggestedDelayMs: Schema.optional(Schema.Number),
  healthSnapshot: SystemHealth,
  blockingSubagents: Schema.optional(Schema.Array(Schema.String)),
})
export type SpawnDecision = Schema.Schema.Type<typeof SpawnDecision>

// ── Adaptive policy ────────────────────────────────────────────

/**
 * Instead of static caps, the policy defines thresholds.
 * The system adapts based on real-time health.
 */
export const AdaptivePolicy = Schema.Struct({
  // Hard limits (safety net)
  maxAbsolute: Schema.Number,
  // Soft limit — above this, spawning requires health check
  softLimit: Schema.Number,
  // Health thresholds for adaptive decisions
  eventLoopP99Threshold: Schema.Number,
  eventLoopUtilizationThreshold: Schema.Number,
  cpuCoreRatioThreshold: Schema.Number,
  // Progress contract defaults
  defaultReportIntervalMs: Schema.Number,
  defaultStaleAfterMs: Schema.Number,
})
export type AdaptivePolicy = Schema.Schema.Type<typeof AdaptivePolicy>
