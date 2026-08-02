/**
 * WorkerSupervisor — real worker_threads SubagentSupervisor (ticket #15 follow-on).
 *
 * @behavior
 * Binds the pure `transitionSubagent` table to REAL worker_threads lifecycle.
 * `doSpawn` creates a `Worker` per actor and wires its runtime events back into
 * `apply()` (the BaseSupervisor seam): `'online'` → `start` (running),
 * `'message' { ok:true }` → `finish` (completed), `'message' { ok:false }` /
 * `'error'` / non-zero `'exit'` → `error` (failed). The worker's `threadId` is
 * the actor's `pid`. `doTerminate` detaches listeners and calls
 * `worker.terminate()`.
 *
 * @invariants
 * - Every transition still delegates to `transitionSubagent` via BaseSupervisor.
 *   The supervisor binds real events to the table; it never invents a transition.
 * - A real worker thread exists per spawned actor (threadId ≥ 1; the main thread
 *   is 0). This is the deterministic proof of real-thread execution — not "it's
 *   fast."
 * - `restart()` creates a NEW worker (different threadId), proving a fresh spawn
 *   rather than reuse. `reap()` terminates the worker.
 * - Listeners are detached in `doTerminate` BEFORE terminating, so a reap/restart
 *   cannot re-enter `apply()` via the dying worker's terminal `'exit'`.
 *
 * @remarks
 * The actor entry is a worker source string (eval'd) — constructor-injected so
 * the supervisor is testable in isolation (the spec injects a happy/crash/slow
 * entry; production injects the real OC subagent entry). This mirrors #12's
 * constructor-injected handler registry.
 */

import { Worker } from "node:worker_threads"
import { BaseSupervisor, type InternalActor } from "./base-supervisor.js"
import { TerminalStates } from "../subagent-admission/subagent-admission.schema.js"
import type { Clock } from "../../core/test-context.js"
import type { RestartPolicy } from "./supervisor.schema.js"

/** A worker that posts { ok: true } then exits — the happy-path actor entry. */
export const HAPPY_WORKER_ENTRY = `const { parentPort } = require('node:worker_threads'); parentPort.postMessage({ ok: true });`

/** A worker that throws on startup — the crash-path actor entry. */
export const CRASH_WORKER_ENTRY = `throw new Error('actor crashed');`

/** A worker that stays alive (never posts, never exits) — for reap/signal tests. */
export const SLOW_WORKER_ENTRY = `setInterval(() => {}, 1000);`

export interface WorkerSupervisorOptions {
  clock?: Clock
  policy?: RestartPolicy
  /** Worker source string (eval'd). Default: HAPPY_WORKER_ENTRY. */
  actorEntry?: string
}

export class WorkerSupervisor extends BaseSupervisor {
  private readonly actorEntry: string

  constructor(opts: WorkerSupervisorOptions = {}) {
    super({ clock: opts.clock, policy: opts.policy })
    this.actorEntry = opts.actorEntry ?? HAPPY_WORKER_ENTRY
  }

  protected doSpawn(actor: InternalActor): number | null {
    // Create a real worker thread. The worker runs the injected actor entry
    // (source string, eval'd). Its runtime events drive `apply()` — the
    // BaseSupervisor seam — so the pure table is bound to real thread lifecycle.
    const worker = new Worker(this.actorEntry, { eval: true })
    actor.resource = worker
    const key = actor.sessionKey

    // 'online' fires when the worker thread starts executing → start (running).
    worker.on("online", () => {
      const a = this.actors.get(key)
      if (!a) return
      this.apply(a, "start", "started")
    })

    // A success message from the actor → finish (completed). The happy-path
    // entry posts { ok: true }; a real actor would post its result here.
    worker.on("message", (msg: { ok?: boolean }) => {
      const a = this.actors.get(key)
      if (!a) return
      if (msg && msg.ok) this.apply(a, "finish", "completed")
      else this.apply(a, "error", "failed")
    })

    // An uncaught throw in the worker surfaces as 'error' → failed.
    worker.on("error", () => {
      const a = this.actors.get(key)
      if (!a) return
      if (!TerminalStates.has(a.state)) this.apply(a, "error", "failed")
    })

    // 'exit' is the terminal observer. If the worker crashed (non-zero) without
    // posting a message, drive failed. If it exited 0 without posting (rare for
    // the injected entries, but possible for a real actor), drive completed. If
    // already terminal (message/error settled it), no-op.
    worker.on("exit", (code) => {
      const a = this.actors.get(key)
      if (!a) return
      if (TerminalStates.has(a.state)) return
      if (code === 0) this.apply(a, "finish", "completed")
      else this.apply(a, "error", "failed")
    })

    return worker.threadId
  }

  protected doTerminate(actor: InternalActor): void {
    const worker = actor.resource as Worker | undefined
    if (!worker) return
    // Detach listeners BEFORE terminating so the dying worker's terminal 'exit'
    // cannot re-enter apply() during a reap/restart (which would double-settle).
    worker.removeAllListeners()
    void worker.terminate().catch(() => {
      /* already dead — terminate() rejects on a terminated worker */
    })
  }
}
