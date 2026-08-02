/**
 * ProcessSupervisor — real child_process SubagentSupervisor (ticket #15 follow-on).
 *
 * @behavior
 * Binds the pure `transitionSubagent` table to REAL child_process lifecycle.
 * `doSpawn` spawns a child per actor and wires its OS events back into
 * `apply()` (the BaseSupervisor seam): `'spawn'` → `start` (running),
 * `'exit'` code 0 → `finish` (completed), `'exit'` non-zero / `'error'` →
 * `error` (failed). The child's OS `pid` is the actor's `pid`. `doTerminate`
 * detaches listeners and sends `SIGKILL`.
 *
 * @invariants
 * - Every transition still delegates to `transitionSubagent` via BaseSupervisor.
 *   The supervisor binds real OS events to the table; it never invents a transition.
 * - A real child process exists per spawned actor (pid ≥ 1). This is the
 *   deterministic proof of real-process execution.
 * - `restart()` creates a NEW process (different pid). `reap()` kills the process.
 * - Listeners are detached in `doTerminate` BEFORE killing, so a reap/restart
 *   cannot re-enter `apply()` via the dying process's terminal `'exit'`.
 *
 * @remarks
 * The actor entry is a command + args — constructor-injected so the supervisor
 * is testable in isolation (the spec injects `node -e 'process.exit(0)'` etc.;
 * production injects the real OC subagent command). Mirrors #12's
 * constructor-injected registry.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { BaseSupervisor, type InternalActor } from "./base-supervisor.js"
import { TerminalStates } from "../subagent-admission/subagent-admission.schema.js"
import type { Clock } from "../../core/test-context.js"
import type { RestartPolicy } from "./supervisor.schema.js"

export interface ProcessActorEntry {
  command: string
  args: string[]
}

/** A process that exits 0 — the happy-path actor entry. */
export const HAPPY_PROCESS_ENTRY: ProcessActorEntry = {
  command: process.execPath,
  args: ["-e", "process.exit(0)"],
}

/** A process that exits 1 — the crash-path actor entry. */
export const CRASH_PROCESS_ENTRY: ProcessActorEntry = {
  command: process.execPath,
  args: ["-e", "process.exit(1)"],
}

/** A process that stays alive — for reap/signal tests. */
export const SLOW_PROCESS_ENTRY: ProcessActorEntry = {
  command: process.execPath,
  args: ["-e", "setInterval(() => {}, 1000)"],
}

export interface ProcessSupervisorOptions {
  clock?: Clock
  policy?: RestartPolicy
  /** Command + args to spawn per actor. Default: HAPPY_PROCESS_ENTRY. */
  actorEntry?: ProcessActorEntry
}

export class ProcessSupervisor extends BaseSupervisor {
  private readonly entry: ProcessActorEntry

  constructor(opts: ProcessSupervisorOptions = {}) {
    super({ clock: opts.clock, policy: opts.policy })
    this.entry = opts.actorEntry ?? HAPPY_PROCESS_ENTRY
  }

  protected doSpawn(actor: InternalActor): number | null {
    // Spawn a real child process. Its OS events drive `apply()` — the
    // BaseSupervisor seam — so the pure table is bound to real process lifecycle.
    const child = spawn(this.entry.command, this.entry.args, {
      stdio: ["ignore", "pipe", "pipe"],
    })
    actor.resource = child
    const key = actor.sessionKey

    // 'spawn' fires when the child process is created → start (running).
    child.on("spawn", () => {
      const a = this.actors.get(key)
      if (!a) return
      this.apply(a, "start", "started")
    })

    // A spawn failure (e.g. command not found) surfaces as 'error' → failed.
    child.on("error", () => {
      const a = this.actors.get(key)
      if (!a) return
      if (!TerminalStates.has(a.state)) this.apply(a, "error", "failed")
    })

    // 'exit' is the terminal observer. code 0 → completed; non-zero → failed.
    // (A real actor's exit code is its success/failure signal — the process
    // equivalent of the worker's { ok: true } message.)
    child.on("exit", (code) => {
      const a = this.actors.get(key)
      if (!a) return
      if (TerminalStates.has(a.state)) return
      if (code === 0) this.apply(a, "finish", "completed")
      else this.apply(a, "error", "failed")
    })

    return child.pid ?? null
  }

  protected doTerminate(actor: InternalActor): void {
    const child = actor.resource as ChildProcess | undefined
    if (!child) return
    // Detach listeners BEFORE killing so the dying process's terminal 'exit'
    // cannot re-enter apply() during a reap/restart.
    child.removeAllListeners()
    try {
      if (!child.killed) child.kill("SIGKILL")
    } catch {
      /* already dead — kill() throws on a reaped process */
    }
  }
}
