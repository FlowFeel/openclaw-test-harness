/**
 * ProcessSupervisor integration specs (ticket #15 follow-on — real child_process).
 *
 * This file is written to be read as a specification. Each `describe` names an
 * invariant of the real-process binding; each `it` states the proposition that
 * proves it; prose before each assertion says *why* that assertion is the one
 * that matters.
 *
 * The design under test (ts/src/features/supervision/process-supervisor.ts):
 *   ProcessSupervisor binds the pure `transitionSubagent` table to REAL
 *   child_process lifecycle. doSpawn spawns a child per actor and wires its OS
 *   events into apply() (the BaseSupervisor seam): 'spawn' → start (running),
 *   'exit' code 0 → finish (completed), 'exit' non-zero / 'error' → error
 *   (failed). The child's OS pid is the actor's pid.
 *
 * DFT framing — what is deterministic here, and what is not:
 *   - DETERMINISTIC (the load-bearing claims): a real process exists (pid ≥ 1)
 *     — proof of real-process execution, not "it's fast"; the event SEQUENCE
 *     [spawned, started, completed] / [spawned, started, failed] — proving the
 *     started/completed/failed came from the child's REAL 'spawn'/'exit' events,
 *     not from caller signal(); the transition identities match
 *     transitionSubagent; restart produces a DIFFERENT pid (fresh spawn);
 *     retryCount increments.
 *   - BOUNDED-LATENCY (a sanity guard, not a correctness claim): each task
 *     settles well under 3000ms (process spawn is heavier than threads). Wall-
 *     clock measures latency, never a controlled input.
 *
 * Hermeticity: the only "upstream" is the OS process runtime via child_process.
 * No network, no Docker. The actor entry is an injected `node -e` command
 * (happy/crash/slow) — a trivial script, not OC's real subagent logic. The pure
 * table (transitionSubagent) is the shared contract.
 */
import { describe, it, expect, afterEach } from "vitest"
import {
  ProcessSupervisor,
  HAPPY_PROCESS_ENTRY,
  CRASH_PROCESS_ENTRY,
  SLOW_PROCESS_ENTRY,
} from "../../src/features/supervision/process-supervisor.js"
import type { SupervisorEvent, RestartPolicy } from "../../src/features/supervision/supervisor.schema.js"

const testPolicy: RestartPolicy = {
  maxRetries: 3,
  baseDelayMs: 1,
  maxDelayMs: 10,
  backoffFactor: 2,
}

function collectEvents(supervisor: ProcessSupervisor): {
  events: SupervisorEvent[]
  off: () => void
} {
  const events: SupervisorEvent[] = []
  const off = supervisor.onEvent((e) => events.push(e))
  return { events, off }
}

async function waitFor(
  supervisor: ProcessSupervisor,
  key: string,
  state: string,
  ms = 3000,
): Promise<void> {
  const deadline = Date.now() + ms
  while (supervisor.get(key)?.state !== state) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${state}; got ${supervisor.get(key)?.state}`)
    }
    await new Promise((r) => setImmediate(r))
  }
}

describe("ProcessSupervisor (#15) — real child processes, not in-process", () => {
  let supervisor: ProcessSupervisor

  afterEach(async () => {
    if (supervisor) supervisor.stop()
    await new Promise((r) => setImmediate(r))
  })

  it("spawn() creates a real child process (pid ≥ 1) in dispatched state", () => {
    // The load-bearing claim of #15's real binding: a real process exists. A
    // non-zero pid is deterministic proof the actor is backed by a real OS
    // process — not "it didn't block." spawn() is synchronous, so the handle is
    // `dispatched` (spawn→running fires async).
    supervisor = new ProcessSupervisor({ actorEntry: SLOW_PROCESS_ENTRY, policy: testPolicy })
    const actor = supervisor.spawn({ sessionKey: "p:1" })
    expect(actor.state).toBe("dispatched")
    expect(actor.pid).not.toBeNull()
    expect(actor.pid!).toBeGreaterThanOrEqual(1)
  })

  it("binds real process lifecycle: spawn→running, exit 0→completed (event sequence proves real binding)", async () => {
    // The event SEQUENCE is the proof: 'spawned' comes from spawn()'s dispatch,
    // but 'started' comes from the child's REAL 'spawn' event and 'completed'
    // from its REAL 'exit' (code 0). A caller never called signal().
    supervisor = new ProcessSupervisor({ actorEntry: HAPPY_PROCESS_ENTRY, policy: testPolicy })
    const { events } = collectEvents(supervisor)
    supervisor.spawn({ sessionKey: "p:1" })
    await waitFor(supervisor, "p:1", "completed")
    expect(supervisor.get("p:1")?.state).toBe("completed")
    expect(events.map((e) => e.type)).toEqual(["spawned", "started", "completed"])
  })

  it("binds real process crash: spawn→running, exit 1→failed (crash drives the failure)", async () => {
    // The crash process exits 1. The 'failed' transition must come from the
    // child's REAL 'exit' (non-zero), not a caller signal.
    supervisor = new ProcessSupervisor({ actorEntry: CRASH_PROCESS_ENTRY, policy: testPolicy })
    const { events } = collectEvents(supervisor)
    supervisor.spawn({ sessionKey: "p:1" })
    await waitFor(supervisor, "p:1", "failed")
    expect(events.map((e) => e.type)).toEqual(["spawned", "started", "failed"])
  })

  it("restart() spawns a NEW process (different pid, retryCount+1)", async () => {
    // The deterministic claim: restart creates a fresh process, not reuse. The
    // new actor's pid differs from the old, and retryCount increments.
    supervisor = new ProcessSupervisor({ actorEntry: HAPPY_PROCESS_ENTRY, policy: testPolicy })
    supervisor.spawn({ sessionKey: "p:1" })
    await waitFor(supervisor, "p:1", "completed")
    const oldPid = supervisor.get("p:1")!.pid
    const restarted = supervisor.restart("p:1")!
    expect(restarted.retryCount).toBe(1)
    expect(restarted.state).toBe("dispatched")
    expect(restarted.pid).not.toBeNull()
    expect(restarted.pid).not.toBe(oldPid)
  })

  it("restart() returns null when maxRetries is exceeded (caller must reap)", async () => {
    supervisor = new ProcessSupervisor({
      actorEntry: HAPPY_PROCESS_ENTRY,
      policy: { ...testPolicy, maxRetries: 1 },
    })
    supervisor.spawn({ sessionKey: "p:1" })
    await waitFor(supervisor, "p:1", "completed")
    expect(supervisor.restart("p:1")!.retryCount).toBe(1) // 1 == maxRetries, allowed
    await waitFor(supervisor, "p:1", "completed")
    expect(supervisor.restart("p:1")).toBeNull() // retryCount 1 >= 1, exceeded
  })

  it("reap() terminates the process and drops the actor", async () => {
    // A SLOW process stays running. reap() must kill it (doTerminate → SIGKILL)
    // and drop the record. Supervisor-level invariant: get() → null, totalReaped.
    supervisor = new ProcessSupervisor({ actorEntry: SLOW_PROCESS_ENTRY, policy: testPolicy })
    supervisor.spawn({ sessionKey: "p:1" })
    await waitFor(supervisor, "p:1", "running")
    supervisor.reap("p:1")
    expect(supervisor.get("p:1")).toBeNull()
    expect(supervisor.stats().totalReaped).toBe(1)
  })

  it("signal() still applies caller-driven events (timeout) — real binding does not replace the caller path", async () => {
    supervisor = new ProcessSupervisor({ actorEntry: SLOW_PROCESS_ENTRY, policy: testPolicy })
    supervisor.spawn({ sessionKey: "p:1" })
    await waitFor(supervisor, "p:1", "running")
    supervisor.signal("p:1", "timeout")
    expect(supervisor.get("p:1")?.state).toBe("timed_out")
  })

  it("never invents a transition — invalid signal is a no-op (delegates to transitionSubagent)", async () => {
    supervisor = new ProcessSupervisor({ actorEntry: SLOW_PROCESS_ENTRY, policy: testPolicy })
    supervisor.spawn({ sessionKey: "p:1" })
    await waitFor(supervisor, "p:1", "running")
    supervisor.signal("p:1", "archive")
    expect(supervisor.get("p:1")?.state).toBe("running")
  })

  it("stats() tracks spawn/restart/reap across real lifecycle", async () => {
    supervisor = new ProcessSupervisor({ actorEntry: HAPPY_PROCESS_ENTRY, policy: testPolicy })
    supervisor.spawn({ sessionKey: "p:1" })
    supervisor.spawn({ sessionKey: "p:2" })
    await waitFor(supervisor, "p:1", "completed")
    await waitFor(supervisor, "p:2", "completed")
    supervisor.restart("p:1")
    supervisor.reap("p:2")
    const s = supervisor.stats()
    expect(s.totalSpawned).toBe(2)
    expect(s.totalRestarted).toBe(1)
    expect(s.totalReaped).toBe(1)
  })
})
