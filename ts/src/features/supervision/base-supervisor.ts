/**
 * BaseSupervisor — shared lifecycle logic for the SubagentSupervisor Protocol.
 *
 * @behavior
 * Holds the supervisor state every implementation shares: the actor map, the
 * event listeners, the injected Clock (#7), the RestartPolicy, and the
 * spawn/restart/reap/stats counters. All state transitions delegate to the
 * pure `transitionSubagent` table — the supervisor never invents a transition;
 * it only applies events the table permits. This is the #15 invariant: the
 * state machine stays pure and I/O-free; the supervisor is the only component
 * that owns real process/thread lifecycle.
 *
 * @invariants
 * - Every transition goes through `apply()` → `transitionSubagent`. No path
 *   invents a state change. Invalid transitions are no-ops (the table returns
 *   the current state), so an impossible event can never corrupt an actor.
 * - Restart backoff timestamps come from the injected `Clock`, so restart
 *   timing is deterministic in tests (ticket #7's clock discipline).
 * - `doSpawn` / `doTerminate` are the only seams. `MockSupervisor` no-ops
 *   them (in-process, no real children). `WorkerSupervisor` / `ProcessSupervisor`
 *   bind them to real worker_threads / child_process lifecycle (#15 follow-on).
 *
 * @remarks
 * Extracted from MockSupervisor so the three implementations share one
 * lifecycle spine — the same "Protocol-first, one contract" convention as the
 * WorkerPool. The MockSupervisor specs (tests/spec/supervisor.spec.ts) guard
 * this extraction: they must pass unchanged against the base.
 */

import type {
  SubagentSupervisor,
  ActorHandle,
  SupervisorEvent,
  SupervisorStats,
  RestartPolicy,
} from "./supervisor.schema.js"
import type { SubagentEvent, SubagentState } from "../subagent-admission/subagent-admission.schema.js"
import { TerminalStates } from "../subagent-admission/subagent-admission.schema.js"
import { transitionSubagent } from "../subagent-admission/subagent-admission.machine.js"
import type { Clock } from "../../core/test-context.js"
import { SystemClock } from "../../core/test-context.js"
import { defaultRestartPolicy } from "./supervisor.schema.js"

/** The supervisor's internal view of a spawned actor. `resource` holds the real
 * worker thread / child process (undefined for the in-process MockSupervisor). */
export interface InternalActor {
  sessionKey: string
  state: SubagentState
  retryCount: number
  pid: number | null
  spawnedBy?: string
  spawnDepth?: number
  /** The real Worker / ChildProcess, if any (null for MockSupervisor). */
  resource?: unknown
}

export abstract class BaseSupervisor implements SubagentSupervisor {
  protected actors = new Map<string, InternalActor>()
  private listeners = new Set<(e: SupervisorEvent) => void>()
  protected readonly clock: Clock
  protected readonly policy: RestartPolicy
  protected totalSpawned = 0
  protected totalRestarted = 0
  protected totalReaped = 0
  protected totalFailed = 0

  constructor(opts: { clock?: Clock; policy?: RestartPolicy } = {}) {
    this.clock = opts.clock ?? new SystemClock()
    this.policy = opts.policy ?? defaultRestartPolicy
  }

  spawn(input: {
    sessionKey: string
    spawnedBy?: string
    spawnDepth?: number
  }): ActorHandle {
    if (this.actors.has(input.sessionKey)) {
      throw new Error(`Actor already spawned: ${input.sessionKey}`)
    }
    const actor: InternalActor = {
      sessionKey: input.sessionKey,
      state: "created",
      retryCount: 0,
      pid: null,
      spawnedBy: input.spawnedBy,
      spawnDepth: input.spawnDepth ?? 0,
    }
    this.actors.set(input.sessionKey, actor)
    this.totalSpawned++
    // Immediately apply dispatch — a spawned actor is dispatched. The returned
    // handle is in `dispatched`; the real resource (if any) comes online async.
    this.apply(actor, "dispatch", "spawned")
    actor.pid = this.doSpawn(actor)
    return this.snapshot(actor)
  }

  signal(sessionKey: string, event: SubagentEvent): ActorHandle {
    const actor = this.require(sessionKey)
    const mapped = this.mapEvent(event)
    this.apply(actor, event, mapped)
    return this.snapshot(actor)
  }

  restart(sessionKey: string): ActorHandle | null {
    const old = this.require(sessionKey)
    if (old.retryCount >= this.policy.maxRetries) {
      // Exceeded — ensure the actor is terminal, then signal failure to caller.
      if (!TerminalStates.has(old.state)) {
        this.apply(old, "error", "failed")
      }
      return null
    }
    // Terminate the current run if still active (a real supervisor kills the
    // process → exit → terminal). The pure table forbids non-terminal → archive,
    // so we drive `error` first to reach `failed`.
    if (!TerminalStates.has(old.state)) {
      this.apply(old, "error", "failed")
    }
    // Kill the old real resource before discarding it (no-op for Mock).
    this.doTerminate(old)
    // Fresh actor, same key, incremented retry count. The old run is discarded.
    const next: InternalActor = {
      sessionKey: old.sessionKey,
      state: "created",
      retryCount: old.retryCount + 1,
      pid: null,
      spawnedBy: old.spawnedBy,
      spawnDepth: old.spawnDepth,
    }
    this.actors.set(sessionKey, next)
    this.totalRestarted++
    this.apply(next, "dispatch", "restarted")
    next.pid = this.doSpawn(next)
    return this.snapshot(next)
  }

  reap(sessionKey: string): void {
    const actor = this.actors.get(sessionKey)
    if (!actor) return
    const from = actor.state
    actor.state = transitionSubagent(actor.state, "archive")
    this.emit({
      type: "reaped",
      sessionKey,
      atMs: this.clock.now(),
      retryCount: actor.retryCount,
      fromState: from,
      toState: actor.state,
    })
    // Kill the real resource before dropping the record (no-op for Mock).
    this.doTerminate(actor)
    this.actors.delete(sessionKey)
    this.totalReaped++
  }

  onEvent(listener: (e: SupervisorEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  stats(): SupervisorStats {
    let active = 0
    for (const a of this.actors.values()) {
      if (a.state !== "archived") active++
    }
    return {
      active,
      totalSpawned: this.totalSpawned,
      totalRestarted: this.totalRestarted,
      totalReaped: this.totalReaped,
      totalFailed: this.totalFailed,
    }
  }

  get(sessionKey: string): ActorHandle | null {
    const a = this.actors.get(sessionKey)
    return a ? this.snapshot(a) : null
  }

  stop(): void {
    for (const key of Array.from(this.actors.keys())) {
      this.reap(key)
    }
    this.listeners.clear()
  }

  // ── seams: real-resource lifecycle (overridden by Worker/Process) ──────

  /**
   * Create the real resource for an actor and wire its lifecycle events back
   * into `apply()` (online/spawn → start; exit/message → finish/error). Return
   * the resource's identity (OS pid / worker threadId), or null if there is no
   * real resource (MockSupervisor).
   *
   * Called AFTER the actor is registered and dispatched, so the wired listeners
   * can resolve the actor by sessionKey when they fire.
   */
  protected abstract doSpawn(actor: InternalActor): number | null

  /** Terminate the real resource (no-op for MockSupervisor). Must be safe to
   * call on an already-dead resource. Should detach listeners first so the
   * resource's terminal events do not re-enter `apply()` during reap/restart. */
  protected abstract doTerminate(actor: InternalActor): void

  // ── internals ──────────────────────────────────────────────────

  protected require(sessionKey: string): InternalActor {
    const a = this.actors.get(sessionKey)
    if (!a) throw new Error(`Unknown actor: ${sessionKey}`)
    return a
  }

  /** Map a SubagentEvent to the supervisor event type it produces. */
  protected mapEvent(event: SubagentEvent): SupervisorEvent["type"] {
    switch (event) {
      case "start":
        return "started"
      case "finish":
        return "completed"
      case "error":
        return "failed"
      case "timeout":
        return "timed_out"
      default:
        return "started"
    }
  }

  protected apply(
    actor: InternalActor,
    event: SubagentEvent,
    supervisorType: SupervisorEvent["type"],
  ): void {
    const from = actor.state
    const next = transitionSubagent(actor.state, event)
    // Invalid transition (next === from) is a true no-op: no event, no counter.
    // This is what makes the event sequence deterministic under real worker
    // races — e.g. the happy worker's 'message' can fire before 'online' under
    // CI scheduling; without this guard, apply(finish) on 'dispatched' would
    // emit a spurious 'completed' event (finish is invalid from dispatched).
    // The transition table is the authority; an invalid event produces no
    // observable side effect.
    if (next === from) return
    actor.state = next
    this.emit({
      type: supervisorType,
      sessionKey: actor.sessionKey,
      atMs: this.clock.now(),
      retryCount: actor.retryCount,
      fromState: from,
      toState: next,
    })
    if (next === "failed") this.totalFailed++
  }

  protected emit(e: SupervisorEvent): void {
    for (const l of this.listeners) l(e)
  }

  protected snapshot(a: InternalActor): ActorHandle {
    return {
      sessionKey: a.sessionKey,
      state: a.state,
      retryCount: a.retryCount,
      pid: a.pid,
      spawnedBy: a.spawnedBy,
      spawnDepth: a.spawnDepth,
    }
  }
}
