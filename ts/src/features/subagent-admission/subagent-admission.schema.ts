/**
 * Subagent admission and lifecycle schemas — the domain language.
 *
 * @behavior
 * Defines the data contracts for spawn admission decisions and subagent
 * lifecycle state. These schemas are the source of truth — all TypeScript
 * types are derived from them, never hand-written.
 *
 * @invariants
 * - `SubagentState` is a closed union — impossible states are impossible.
 * - `AdmissionDecision.ok` is always accompanied by evidence.
 * - `AdmissionCap` values map 1:1 to OC config keys.
 *
 * @remarks
 * Effect Schema is used instead of raw TypeScript interfaces because
 * schemas are runtime-validatable and derive their TypeScript types.
 * This means the domain language is authoritative — types follow,
 * not lead. When we patch OC's `child-admission.ts`, the patch
 * imports these schemas so OC's admission logic validates against
 * the same contracts our tests use.
 */

import { Schema } from "effect"

// ── Subagent lifecycle states ──────────────────────────────────

export const SubagentState = Schema.Literal(
  "created",
  "dispatched",
  "running",
  "yielding",
  "completed",
  "failed",
  "timed_out",
  "aborted",
  "archived",
)
export type SubagentState = Schema.Schema.Type<typeof SubagentState>

export const TerminalStates: ReadonlySet<SubagentState> = new Set([
  "completed",
  "failed",
  "timed_out",
  "aborted",
])

// ── Subagent lifecycle events ──────────────────────────────────

export const SubagentEvent = Schema.Literal(
  "dispatch",
  "start",
  "yield",
  "child_done",
  "finish",
  "error",
  "timeout",
  "parent_abort",
  "archive",
)
export type SubagentEvent = Schema.Schema.Type<typeof SubagentEvent>

// ── Admission cap — which limit rejected a spawn ───────────────

export const AdmissionCap = Schema.Literal(
  "subagents.maxSpawnDepth",
  "subagents.maxChildrenPerAgent",
  "subagents.maxConcurrent",
  "subagents.runTimeoutSeconds",
  "tools.swarm.maxTotalPerGroup",
  "tools.swarm.maxChildrenPerGroup",
)
export type AdmissionCap = Schema.Schema.Type<typeof AdmissionCap>

// ── Admission decision result ──────────────────────────────────

export const AdmissionDecision = Schema.Struct({
  ok: Schema.Boolean,
  cap: Schema.optional(AdmissionCap),
  reason: Schema.String,
  evidence: Schema.Record({
    key: Schema.String,
    value: Schema.Unknown,
  }),
})
export type AdmissionDecision = Schema.Schema.Type<typeof AdmissionDecision>

// ── Admission policy — mirrors OC config ───────────────────────

/**
 * @minimum maxSpawnDepth 0
 * @minimum maxChildrenPerAgent 0
 * @minimum maxConcurrent 0
 * @minimum runTimeoutSeconds 1
 */
export const AdmissionPolicy = Schema.Struct({
  maxSpawnDepth: Schema.Number.pipe(Schema.int(), Schema.positive()),
  maxChildrenPerAgent: Schema.Number.pipe(Schema.int(), Schema.positive()),
  maxConcurrent: Schema.Number.pipe(Schema.int(), Schema.positive()),
  runTimeoutSeconds: Schema.Number.pipe(Schema.int(), Schema.positive()),
  maxTotalPerGroup: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.positive()),
  ),
})
export type AdmissionPolicy = Schema.Schema.Type<typeof AdmissionPolicy>

// ── Subagent snapshot — immutable state at a point in time ─────

export const SubagentSnapshot = Schema.Struct({
  sessionKey: Schema.String,
  state: SubagentState,
  spawnedBy: Schema.optional(Schema.String),
  spawnDepth: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  startedAtMs: Schema.optional(Schema.Number),
  endedAtMs: Schema.optional(Schema.Number),
  runtimeMs: Schema.optional(Schema.Number),
  aborted: Schema.optional(Schema.Boolean),
  retryCount: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
})
export type SubagentSnapshot = Schema.Schema.Type<typeof SubagentSnapshot>
