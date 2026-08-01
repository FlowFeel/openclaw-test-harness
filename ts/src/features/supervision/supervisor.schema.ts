/**
 * SubagentSupervisor Protocol — binds the pure lifecycle state machine to real
 * process lifecycle (Phase 2, ticket #15).
 *
 * @behavior
 * The existing `SubagentActor` is self-described as "a lightweight, zero-
 * dependency actor-like wrapper" holding only a `currentState` string — it owns
 * no process, no thread, no IPC. This Protocol is the missing layer: a
 * supervisor that spawns supervised actors, observes their real lifecycle, and
 * applies the pure `transitionSubagent` table to those observations.
 *
 * @invariants
 * - State transitions are delegated to `transitionSubagent` (pure). The
 *   supervisor never invents a transition; it only applies events the table
 *   permits.
 * - The supervisor is the only component that owns real process/thread
 *   lifecycle. The state machine stays pure and I/O-free.
 * - Restart backoff is computed from an injected `Clock` (ticket #7), so
 *   restart timing is deterministic in tests.
 *
 * @remarks
 * Protocol-first: implementations follow. `MockSupervisor` (in-process,
 * deterministic) ships with this scaffold so the Protocol is testable today.
 * `WorkerSupervisor` (worker_threads) and an OC-patch `ProcessSupervisor`
 * (child_process) are ticket #15 follow-ons. The god-process problem (one OC
 * process for all topics/agents) is addressed by per-topic actor isolation
 * (ticket #16), which builds on this Protocol.
 */

import { Schema } from "effect"
import {
  SubagentState as SubagentStateSchema,
  type SubagentState,
  type SubagentEvent,
} from "../subagent-admission/subagent-admission.schema.js"
import type { Clock } from "../../core/test-context.js"

// ── Supervisor event (emitted on real lifecycle observation) ──────

export const SupervisorEventType = Schema.Literal(
  "spawned",
  "started",
  "completed",
  "failed",
  "timed_out",
  "restarted",
  "reaped",
)
export type SupervisorEventType = Schema.Schema.Type<typeof SupervisorEventType>

export const SupervisorEvent = Schema.Struct({
  type: SupervisorEventType,
  sessionKey: Schema.String,
  atMs: Schema.Number,
  retryCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  fromState: Schema.optional(SubagentStateSchema),
  toState: SubagentStateSchema,
})
export type SupervisorEvent = Schema.Schema.Type<typeof SupervisorEvent>

// ── Actor handle (the supervisor's view of a spawned actor) ───────

export const ActorHandle = Schema.Struct({
  sessionKey: Schema.String,
  state: SubagentStateSchema,
  retryCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  /** OS pid / worker thread id, or null for the in-process MockSupervisor. */
  pid: Schema.NullOr(Schema.Number),
  spawnedBy: Schema.optional(Schema.String),
  spawnDepth: Schema.optional(Schema.Number),
})
export type ActorHandle = Schema.Schema.Type<typeof ActorHandle>

// ── Restart policy ────────────────────────────────────────────────

export const RestartPolicy = Schema.Struct({
  maxRetries: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  baseDelayMs: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  maxDelayMs: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  backoffFactor: Schema.Number.pipe(Schema.positive()),
})
export type RestartPolicy = Schema.Schema.Type<typeof RestartPolicy>

export const defaultRestartPolicy: RestartPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffFactor: 2,
}

// ── Supervisor stats ──────────────────────────────────────────────

export interface SupervisorStats {
  active: number
  totalSpawned: number
  totalRestarted: number
  totalReaped: number
  totalFailed: number
}

// ── SubagentSupervisor Protocol ───────────────────────────────────

/**
 * Protocol for supervising subagent lifecycle against real process/thread
 * boundaries. Implementations:
 * - `MockSupervisor` — tests (in-process, deterministic, no real children)
 * - `WorkerSupervisor` — production (worker_threads, ticket #15)
 * - `ProcessSupervisor` — OC patch (child_process, ticket #15)
 */
export interface SubagentSupervisor {
  /**
   * Spawn a supervised actor. The actor starts in `created` and the supervisor
   * immediately applies `dispatch`, so the returned handle is in `dispatched`.
   */
  spawn(input: {
    sessionKey: string
    spawnedBy?: string
    spawnDepth?: number
  }): ActorHandle

  /**
   * Apply a lifecycle event to an actor. Delegates to the pure
   * `transitionSubagent` table — the supervisor never invents a transition.
   * Returns the updated handle, or throws if the actor is unknown.
   */
  signal(sessionKey: string, event: SubagentEvent): ActorHandle

  /**
   * Restart an actor with exponential backoff. Increments `retryCount` and
   * transitions back to `dispatched`. Returns null if `maxRetries` is exceeded
   * (caller should `reap()`).
   */
  restart(sessionKey: string): ActorHandle | null

  /** Terminal cleanup: transition to `archived` and drop the actor. */
  reap(sessionKey: string): void

  /** Subscribe to supervisor lifecycle events. Returns an unsubscribe fn. */
  onEvent(listener: (e: SupervisorEvent) => void): () => void

  /** Aggregate supervisor stats. */
  stats(): SupervisorStats

  /** Look up an actor by key (or null if unknown / reaped). */
  get(sessionKey: string): ActorHandle | null

  /** Shutdown: reap all actors. Idempotent. */
  stop(): void
}
