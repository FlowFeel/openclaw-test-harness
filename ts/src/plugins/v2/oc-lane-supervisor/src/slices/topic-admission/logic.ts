/**
 * Topic Admission Pure Transition Algebra — real subagent semaphore acquire/release
 * and topic session routing transitions (eliminates no-op subagent hooks).
 *
 * @invariants
 * - Pure logic: zero I/O, zero Date.now(), returns immutable CheckResult snapshots (A1, A2, A6).
 *
 * @dft
 * - Tested via slices/topic-admission/tests/logic.spec.ts.
 */

import {
  acquire,
  release,
  parseTopicSessionKey,
  type ParsedTopicSession,
} from "../../topic-worker-pool-logic.js";
import type { TopicAdmissionSliceState } from "./state.js";

export function onSubagentSpawnTransition(
  state: TopicAdmissionSliceState,
  subagentId: string,
): { nextState: TopicAdmissionSliceState; admitted: boolean; activeCount: number } {
  const nextSubPool = { ...state.subPool };
  const report = acquire(nextSubPool);
  if (report.action !== "acquired") {
    return {
      nextState: { ...state, subPool: nextSubPool },
      admitted: false,
      activeCount: state.activeSubagents.size,
    };
  }
  const nextSet = new Set(state.activeSubagents);
  nextSet.add(subagentId);
  return {
    nextState: { ...state, subPool: nextSubPool, activeSubagents: nextSet },
    admitted: true,
    activeCount: nextSet.size,
  };
}

export function onSubagentEndTransition(
  state: TopicAdmissionSliceState,
  subagentId: string,
): { nextState: TopicAdmissionSliceState; released: boolean; activeCount: number } {
  const nextSet = new Set(state.activeSubagents);
  const existed = nextSet.delete(subagentId);
  if (!existed) {
    return { nextState: state, released: false, activeCount: nextSet.size };
  }
  const nextSubPool = { ...state.subPool };
  const report = release(nextSubPool);
  return {
    nextState: { ...state, subPool: nextSubPool, activeSubagents: nextSet },
    released: report.action === "released",
    activeCount: nextSet.size,
  };
}

export function classifyTopicSession(sessionKey: string): ParsedTopicSession | null {
  return parseTopicSessionKey(sessionKey);
}
