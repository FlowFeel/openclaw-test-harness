/**
 * TopicRouter — per-topic actor isolation (ticket #16).
 *
 * @behavior
 * Each active topic runs as an ISOLATED supervised actor — a dedicated
 * worker_thread (long-lived, RPC-capable) — so a pathological topic (runaway
 * subagent, crash) is contained: it cannot take down the event loop for sibling
 * topics. The main process becomes a thin router: `dispatch(topic, request)`
 * routes to the owning topic's actor, awaits the reply.
 *
 * Builds on #15's Protocol: `TopicRouter extends BaseSupervisor`, reusing the
 * lifecycle spine (actor map, injected Clock, RestartPolicy, apply()→
 * transitionSubagent, restart, reap, stats, events). The ONLY specialization is
 * `doSpawn`/`doTerminate`: #16's actors are long-lived RPC workers (many
 * request/reply pairs), not #15's one-shot observe-and-exit actors. So the
 * `'message'` listener routes RPC replies by id (it does NOT drive `finish` —
 * the actor stays alive across many requests).
 *
 * @invariants
 * - Every lifecycle transition delegates to `transitionSubagent` via
 *   BaseSupervisor.apply(). The router binds real worker events to the table; it
 *   never invents a transition.
 * - `dispatch(topic, request)` is lazy-spawn: no actor → spawn; terminal actor →
 *   restart (self-healing); live actor → route. The route-vs-spawn-vs-restart
 *   decision composes the pure `selectActorForTopic` + `TerminalStates`.
 * - Crash containment: a crash of topic A's worker rejects A's in-flight
 *   dispatch (via the 'exit'/'error' listener) but B's worker is a SEPARATE
 *   thread — B continues serving. The pure `crashContainment` makes this
 *   guarantee explicit; the integration test proves it with real workers.
 * - Per-topic attribution: `topicStats()` returns per-topic state/retryCount/
 *   active via the pure `aggregateTopicStats` (acceptance #2).
 * - Listeners detach BEFORE terminating (in doTerminate) so a reap/restart
 *   cannot re-enter apply() via the dying worker's terminal 'exit'. Pending RPC
 *   requests for the terminated topic are rejected (no leaked promises).
 *
 * @remarks
 * The actor entry is a constructor-injected worker source string (eval'd) —
 * mirrors #12/#15. The test injects an echo/crash entry; production injects the
 * real OC topic-handler entry. The entry is a long-lived RPC worker: it listens
 * for `{ id, request }` and posts `{ id, ok, result }` / `{ id, ok:false, error }`.
 */

import { Worker } from "node:worker_threads"
import { BaseSupervisor, type InternalActor } from "../supervision/base-supervisor.js"
import { TerminalStates } from "../subagent-admission/subagent-admission.schema.js"
import type { Clock } from "../../core/test-context.js"
import type { RestartPolicy } from "../supervision/supervisor.schema.js"
import {
  aggregateTopicStats,
  crashContainment,
  type TopicStat,
  type CrashContainment,
} from "./topic-router-logic.js"

/**
 * A long-lived RPC topic actor that echoes its request. If `request.crash` is
 * truthy, the worker hard-exits (process.exit(1)) — simulating a topic actor
 * crash for the containment test. The test dispatches `{ crash: true }` to
 * crash a topic on demand; dispatching to a sibling then proves isolation.
 */
export const ECHO_TOPIC_ENTRY = `const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, request }) => {
  if (request && request.crash) process.exit(1);
  parentPort.postMessage({ id, ok: true, result: request });
});`

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  topic: string
}

export interface TopicRouterOptions {
  clock?: Clock
  policy?: RestartPolicy
  /** Worker source string (eval'd). Default: ECHO_TOPIC_ENTRY. */
  actorEntry?: string
}

export class TopicRouter extends BaseSupervisor {
  private readonly actorEntry: string
  private readonly pending = new Map<string, PendingRequest>()
  private requestCounter = 0

  constructor(opts: TopicRouterOptions = {}) {
    super({ clock: opts.clock, policy: opts.policy })
    this.actorEntry = opts.actorEntry ?? ECHO_TOPIC_ENTRY
  }

  // ── The RPC layer (#16) ─────────────────────────────────────────────

  /**
   * Route a request to the topic's isolated actor and await the reply.
   * Lazy-spawn: no actor → spawn; terminal → restart (self-healing); live →
   * route. A crash of this topic's actor rejects the in-flight dispatch; a
   * sibling topic's actor is unaffected (separate worker thread).
   */
  async dispatch<T>(topic: string, request: unknown): Promise<T> {
    const existing = this.get(topic)
    if (!existing) {
      // Lazy spawn — a topic gets an actor on first dispatch.
      this.spawn({ sessionKey: topic })
    } else if (TerminalStates.has(existing.state)) {
      // Self-healing: a terminal actor is restarted before routing.
      const restarted = this.restart(topic)
      if (!restarted) {
        throw new Error(`topic ${topic} exhausted retries (${existing.retryCount})`)
      }
    }
    // Wait for the actor to reach `running` (the worker's 'online' event drove
    // start). A crash before running rejects via waitForRunning's terminal check.
    await this.waitForRunning(topic)
    const actor = this.require(topic)
    const worker = actor.resource as Worker
    const id = String(++this.requestCounter)
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        topic,
      })
      try {
        worker.postMessage({ id, request })
      } catch (e) {
        this.pending.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  /** Per-topic attribution (acceptance #2). Pure underneath: aggregateTopicStats. */
  topicStats(): TopicStat[] {
    const handles = Array.from(this.actors.values()).map((a) => this.snapshot(a))
    return aggregateTopicStats(handles)
  }

  /**
   * The crash-containment decision for a topic (acceptance #1, pure part).
   * Returns the crashed topic and the topics still serving (live siblings).
   */
  crashContainment(crashedTopic: string): CrashContainment {
    const handles = Array.from(this.actors.values()).map((a) => this.snapshot(a))
    return crashContainment(crashedTopic, handles)
  }

  // ── BaseSupervisor seams: long-lived RPC worker lifecycle ───────────

  protected doSpawn(actor: InternalActor): number | null {
    const worker = new Worker(this.actorEntry, { eval: true })
    actor.resource = worker
    const key = actor.sessionKey

    // 'online' → start (running). The actor is now ready for RPC.
    worker.on("online", () => {
      const a = this.actors.get(key)
      if (a && !TerminalStates.has(a.state)) this.apply(a, "start", "started")
    })

    // RPC reply routing — NOT one-shot completion. The worker posts many
    // { id, ok, result/error } replies over its lifetime; each resolves the
    // matching pending request. The actor stays alive (no finish on message).
    worker.on("message", (msg: { id?: string; ok?: boolean; result?: unknown; error?: string }) => {
      if (!msg || !msg.id) return
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error ?? "topic actor error"))
    })

    // A crash (uncaught throw / process.exit(1)) surfaces as 'error' then 'exit'.
    // Drive the actor to `failed` and reject ALL pending requests for this topic
    // — the crash is contained to this topic; siblings' workers are untouched.
    worker.on("error", () => {
      const a = this.actors.get(key)
      if (a && !TerminalStates.has(a.state)) this.apply(a, "error", "failed")
      this.rejectPendingFor(key, "topic actor crashed")
    })

    worker.on("exit", (code) => {
      const a = this.actors.get(key)
      if (!a) return
      if (TerminalStates.has(a.state)) {
        // 'error' already drove it terminal — just reject any straggling pending.
        this.rejectPendingFor(key, "topic actor exited")
        return
      }
      if (code === 0) this.apply(a, "finish", "completed")
      else this.apply(a, "error", "failed")
      this.rejectPendingFor(key, "topic actor exited")
    })

    return worker.threadId
  }

  protected doTerminate(actor: InternalActor): void {
    const worker = actor.resource as Worker | undefined
    if (!worker) return
    // Detach listeners BEFORE terminating so the dying worker's terminal 'exit'
    // cannot re-enter apply() during a reap/restart (same pattern as #15).
    worker.removeAllListeners()
    // Reject pending RPC requests for this topic — no leaked promises.
    this.rejectPendingFor(actor.sessionKey, "topic actor terminated")
    void worker.terminate().catch(() => {
      /* already dead — terminate() rejects on a terminated worker */
    })
  }

  // ── Internals ──────────────────────────────────────────────────────

  /** Wait for the topic's actor to reach `running` (bounded-latency guard). */
  private async waitForRunning(topic: string, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms
    while (true) {
      const a = this.get(topic)
      if (!a) throw new Error(`actor ${topic} not found`)
      if (a.state === "running") return
      // A crash before reaching running (online never fired) → reject, don't hang.
      if (TerminalStates.has(a.state)) {
        throw new Error(`actor ${topic} is terminal (${a.state}) before reaching running`)
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${topic} to reach running`)
      }
      await new Promise((r) => setImmediate(r))
    }
  }

  /** Reject all pending RPC requests for a topic (crash/terminate containment). */
  private rejectPendingFor(topic: string, reason: string): void {
    for (const [id, p] of this.pending) {
      if (p.topic === topic) {
        this.pending.delete(id)
        p.reject(new Error(reason))
      }
    }
  }
}
