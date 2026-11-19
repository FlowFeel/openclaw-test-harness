/**
 * Topic Admission & Subagent Semaphore State Slice.
 *
 * @invariants
 * - Owns mainPool and subagentPool SemaphoreState + active subagent slot tracking.
 *
 * @dft
 * - Tested directly via slices/topic-admission/tests/logic.spec.ts.
 */

import { createSemaphore, type SemaphoreState } from "../../topic-worker-pool-logic.js";

export interface TopicAdmissionSliceConfig {
  mainPoolMax: number;
  subPoolMax: number;
}

export interface TopicAdmissionSliceState {
  readonly mainPool: SemaphoreState;
  readonly subPool: SemaphoreState;
  readonly activeSubagents: ReadonlySet<string>;
}

export function createTopicAdmissionState(
  config: TopicAdmissionSliceConfig = { mainPoolMax: 4, subPoolMax: 6 },
): TopicAdmissionSliceState {
  return {
    mainPool: createSemaphore(config.mainPoolMax),
    subPool: createSemaphore(config.subPoolMax),
    activeSubagents: new Set(),
  };
}

