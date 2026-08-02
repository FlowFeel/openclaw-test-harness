/**
 * WorkerSupervisor integration specs (ticket #15 follow-on — real worker_threads).
 *
 * This file is written to be read as a specification. Each `describe` names an
 * invariant of the real-worker binding; each `it` states the proposition that
 * proves it; prose before each assertion says *why* that assertion is the one
 * that matters.
 *
 * The design under test (ts/src/features/supervision/worker-supervisor.ts):
 *   WorkerSupervisor binds the pure `transitionSubagent` table to REAL
 *   worker_threads lifecycle. doSpawn creates a Worker per actor and wires its
 *   runtime events into apply() (the BaseSupervisor seam): 'online' → start
 *   (running), 'message'{ok:true} → finish (completed), 'error'/non-zero 'exit'
 *   → error (failed). The worker's threadId is the actor's pid.
 *
 * DFT framing — what is deterministic here, and what is not:
 *   - DETERMINISTIC (the load-bearing claims): a real thread exists (threadId
 *     ≥ 1; the main thread is 0) — proof of real-thread execution, not "it's
 *     fast"; the event SEQUENCE [spawned, started, completed] / [spawned,
 *     started, failed] — proving the started/completed/failed came from the
 *     worker's REAL 'online'/'message'/'error' events, not from caller signal();
 *     the transition identities match transitionSubagent; restart produces a
 *     DIFFERENT threadId (fresh spawn, not reuse); retryCount increments.
 *   - BOUNDED-LATENCY (a sanity guard, not a correctness claim): each task
 *     settles well under 2000ms. Wall-clock measures latency, never a
 *     controlled input — the assertions are on state identities, not timeouts.
 *
 * Hermeticity: the only "upstream" is the worker_threads runtime. No network,
 * no Docker. The actor entry is an injected source string (happy/crash/slow) —
 * a trivial script, not OC's real subagent logic — so the supervisor is tested
 * in isolation. The pure table (transitionSubagent) is the shared contract;
 * these specs prove the real binding honors it.
 */
import { describe, it, expect, afterEach } from "vitest"
import {
  WorkerSupervisor,
  HAPPY_WORKER_ENTRY,
  CRASH_WORKER_ENTRY,
  SLOW_WORKER_ENTRY,
} from "../../src/features/supervision/worker-supervisor.js"
import type { SupervisorEvent, RestartPolicy } from "../../src/features/supervision/supervisor.schema.js"

const testPolicy: RestartPolicy = {
  maxRetries: 3,
  baseDelayMs: 1,
  maxDelayMs: 10,
  backoffFactor: 2,
}

/** Collect every supervisor event into an array. */
function collectEvents(supervisor: WorkerSupervisor): {
  events: SupervisorEvent[]
  off: () => void
} {
  const events: SupervisorEvent[] = []
  const off = supervisor.onEvent((e) => events.push(e))
  return { events, off }
}

/** Poll until an actor reaches a state (bounded-latency guard, not a claim). */
async function waitFor(
  supervisor: WorkerSupervisor,
  key: string,
  state: string,
  ms = 2000,
): Promise<void> {
  const deadline = Date.now() + ms
  while (supervisor.get(key)?.state !== state) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${state}; got ${supervisor.get(key)?.state}`)
    }
    await new Promise((r) => setImmediate(r))
  }
}

describe("WorkerSupervisor (#15) — real worker threads, not in-process", () => {
  let supervisor: WorkerSupervisor

  afterEach(async () => {
    if (supervisor) supervisor.stop()
    // yield so terminate() / exit listeners settle before the next test
    await new Promise((r) => setImmediate(r))
  })

  it("spawn() creates a real worker thread (threadId ≥ 1) in dispatched state", () => {
    // The load-bearing claim of #15's real binding: a real thread exists. The
    // main thread is threadId 0; a non-zero tid is deterministic proof the actor
    // is backed by a real worker thread — not "it didn't block." spawn() is
    // synchronous, so the handle is `dispatched` (online→running fires async).
    supervisor = new WorkerSupervisor({ actorEntry: SLOW_WORKER_ENTRY, policy: testPolicy })
    const actor = supervisor.spawn({ sessionKey: "w:1" })
    expect(actor.state).toBe("dispatched")
    expect(actor.pid).not.toBeNull()
    expect(actor.pid!).toBeGreaterThanOrEqual(1)
  })

  it("binds real worker lifecycle: online→running, message→completed (event sequence proves real binding)", async () => {
    // The event SEQUENCE is the proof: 'spawned' comes from spawn()'s dispatch,
    // but 'started' comes from the worker's REAL 'online' event and 'completed'
    // from its REAL 'message'{ok:true}. A caller never called signal() — the
    // transitions were driven by the worker thread's actual lifecycle.
    supervisor = new WorkerSupervisor({ actorEntry: HAPPY_WORKER_ENTRY, policy: testPolicy })
    const { events } = collectEvents(supervisor)
    supervisor.spawn({ sessionKey: "w:1" })
    await waitFor(supervisor, "w:1", "completed")
    expect(supervisor.get("w:1")?.state).toBe("completed")
    expect(events.map((e) => e.type)).toEqual(["spawned", "started", "completed"])
  })

  it("binds real worker crash: online→running, error→failed (crash drives the failure)", async () => {
    // The crash worker throws on startup. The 'failed' transition must come from
    // the worker's REAL 'error' event (uncaught throw), not a caller signal.
    supervisor = new WorkerSupervisor({ actorEntry: CRASH_WORKER_ENTRY, policy: testPolicy })
    const { events } = collectEvents(supervisor)
    supervisor.spawn({ sessionKey: "w:1" })
    await waitFor(supervisor, "w:1", "failed")
    expect(events.map((e) => e.type)).toEqual(["spawned", "started", "failed"])
  })

  it("restart() spawns a NEW worker thread (different threadId, retryCount+1)", async () => {
    // The deterministic claim: restart creates a fresh thread, not reuse. The
    // new actor's threadId differs from the old, and retryCount increments.
    supervisor = new WorkerSupervisor({ actorEntry: HAPPY_WORKER_ENTRY, policy: testPolicy })
    supervisor.spawn({ sessionKey: "w:1" })
    await waitFor(supervisor, "w:1", "completed")
    const oldPid = supervisor.get("w:1")!.pid
    const restarted = supervisor.restart("w:1")!
    expect(restarted.retryCount).toBe(1)
    expect(restarted.state).toBe("dispatched")
    expect(restarted.pid).not.toBeNull()
    expect(restarted.pid).not.toBe(oldPid)
  })

  it("restart() returns null when maxRetries is exceeded (caller must reap)", async () => {
    supervisor = new WorkerSupervisor({
      actorEntry: HAPPY_WORKER_ENTRY,
      policy: { ...testPolicy, maxRetries: 1 },
    })
    supervisor.spawn({ sessionKey: "w:1" })
    await waitFor(supervisor, "w:1", "completed")
    expect(supervisor.restart("w:1")!.retryCount).toBe(1) // 1 == maxRetries, allowed
    await waitFor(supervisor, "w:1", "completed")
    expect(supervisor.restart("w:1")).toBeNull() // retryCount 1 >= 1, exceeded
  })

  it("reap() terminates the worker and drops the actor", async () => {
    // A SLOW worker stays running (never completes). reap() must terminate it
    // (doTerminate → worker.terminate()) and drop the record. The supervisor-
    // level invariant: get() → null, totalReaped incremented.
    supervisor = new WorkerSupervisor({ actorEntry: SLOW_WORKER_ENTRY, policy: testPolicy })
    supervisor.spawn({ sessionKey: "w:1" })
    await waitFor(supervisor, "w:1", "running")
    supervisor.reap("w:1")
    expect(supervisor.get("w:1")).toBeNull()
    expect(supervisor.stats().totalReaped).toBe(1)
  })

  it("signal() still applies caller-driven events (timeout) — real binding does not replace the caller path", async () => {
    // The real supervisor auto-applies observed events BUT still honors caller-
    // driven signal() (e.g. a watchdog timeout). The SLOW worker never exits on
    // its own; the caller drives `timeout` → timed_out.
    supervisor = new WorkerSupervisor({ actorEntry: SLOW_WORKER_ENTRY, policy: testPolicy })
    supervisor.spawn({ sessionKey: "w:1" })
    await waitFor(supervisor, "w:1", "running")
    supervisor.signal("w:1", "timeout")
    expect(supervisor.get("w:1")?.state).toBe("timed_out")
  })

  it("never invents a transition — invalid signal is a no-op (delegates to transitionSubagent)", async () => {
    // The #15 invariant: the supervisor binds real events to the table but never
    // invents a transition. 'archive' from `running` is invalid (archive is only
    // valid from terminal states), so it must be a no-op — the state stays running.
    supervisor = new WorkerSupervisor({ actorEntry: SLOW_WORKER_ENTRY, policy: testPolicy })
    supervisor.spawn({ sessionKey: "w:1" })
    await waitFor(supervisor, "w:1", "running")
    supervisor.signal("w:1", "archive")
    expect(supervisor.get("w:1")?.state).toBe("running")
  })

  it("stats() tracks spawn/restart/reap across real lifecycle", async () => {
    supervisor = new WorkerSupervisor({ actorEntry: HAPPY_WORKER_ENTRY, policy: testPolicy })
    supervisor.spawn({ sessionKey: "w:1" })
    supervisor.spawn({ sessionKey: "w:2" })
    await waitFor(supervisor, "w:1", "completed")
    await waitFor(supervisor, "w:2", "completed")
    supervisor.restart("w:1")
    supervisor.reap("w:2")
    const s = supervisor.stats()
    expect(s.totalSpawned).toBe(2)
    expect(s.totalRestarted).toBe(1)
    expect(s.totalReaped).toBe(1)
  })
})
