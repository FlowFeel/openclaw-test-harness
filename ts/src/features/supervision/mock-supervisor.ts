/**
 * MockSupervisor — in-process, deterministic SubagentSupervisor for tests.
 *
 * No real worker_threads / child_process: actors are plain records and
 * lifecycle is driven explicitly via `signal()`. State transitions delegate to
 * the pure `transitionSubagent` table (via BaseSupervisor.apply), so the
 * supervisor never invents a transition. Backoff timestamps are computed from
 * an injected `Clock` (ticket #7) so restart timing is deterministic.
 *
 * The lifecycle spine lives in BaseSupervisor; MockSupervisor is the no-op seam
 * (doSpawn returns null, doTerminate is a no-op). The real-resource seams are
 * WorkerSupervisor (worker_threads) and ProcessSupervisor (child_process).
 */

import { BaseSupervisor, type InternalActor } from "./base-supervisor.js"

export class MockSupervisor extends BaseSupervisor {
  /** No real resource — the in-process double owns no thread/process. */
  protected doSpawn(_actor: InternalActor): number | null {
    return null
  }

  /** Nothing to terminate — the actor is a plain record. */
  protected doTerminate(_actor: InternalActor): void {
    // no-op
  }
}
