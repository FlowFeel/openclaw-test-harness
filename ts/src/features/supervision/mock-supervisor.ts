/**
 * MockSupervisor — in-process, deterministic SubagentSupervisor for tests.
 *
 * No real worker_threads / child_process: actors are plain records and
 * lifecycle is driven explicitly via `signal()`. State transitions delegate to
 * the pure `transitionSubagent` table, so the supervisor never invents a
 * transition. Backoff timestamps are computed from an injected `Clock`
 * (ticket #7) so restart timing is deterministic.
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

interface InternalActor {
  sessionKey: string
  state: SubagentState
  retryCount: number
  pid: number | null
  spawnedBy?: string
  spawnDepth?: number
}

export class MockSupervisor implements SubagentSupervisor {
  private actors = new Map<string, InternalActor>()
  private listeners = new Set<(e: SupervisorEvent) => void>()
  private readonly clock: Clock
  private readonly policy: RestartPolicy
  private totalSpawned = 0
  private totalRestarted = 0
  private totalReaped = 0
  private totalFailed = 0

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
    // Immediately apply dispatch — a spawned actor is dispatched.
    this.apply(actor, "dispatch", "spawned")
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
    if (actor.state === "failed") this.totalFailed++
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

  // ── internals ──────────────────────────────────────────────────

  private require(sessionKey: string): InternalActor {
    const a = this.actors.get(sessionKey)
    if (!a) throw new Error(`Unknown actor: ${sessionKey}`)
    return a
  }

  /** Map a SubagentEvent to the supervisor event type it produces. */
  private mapEvent(event: SubagentEvent): SupervisorEvent["type"] {
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

  private apply(
    actor: InternalActor,
    event: SubagentEvent,
    supervisorType: SupervisorEvent["type"],
  ): void {
    const from = actor.state
    actor.state = transitionSubagent(actor.state, event)
    this.emit({
      type: supervisorType,
      sessionKey: actor.sessionKey,
      atMs: this.clock.now(),
      retryCount: actor.retryCount,
      fromState: from,
      toState: actor.state,
    })
    if (actor.state === "failed") this.totalFailed++
  }

  private emit(e: SupervisorEvent): void {
    for (const l of this.listeners) l(e)
  }

  private snapshot(a: InternalActor): ActorHandle {
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
