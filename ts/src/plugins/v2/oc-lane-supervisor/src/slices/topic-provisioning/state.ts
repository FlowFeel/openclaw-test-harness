/**
 * Topic Provisioning State Slice — immutable provisioning registry and pending
 * Turn 0 orientation queue.
 *
 * @invariants
 * - Pure immutable state transitions: zero I/O, zero side-channel mutable maps (A1, A6).
 *
 * @dft
 * - Tested via slices/topic-provisioning/tests/logic.spec.ts and slice.spec.ts.
 */

import type { TopicProvisioningIO } from "./io.js";

export interface TopicProvisioningSliceConfig {
  enabled?: boolean;
  workspaceRoot?: string;
  io?: TopicProvisioningIO;
  clock?: () => number;
}

export interface TopicProvisioningSliceState {
  readonly provisionedTopicIds: ReadonlySet<number>;
  readonly pendingInjections: ReadonlyMap<string, string>;
}

export function createTopicProvisioningSliceState(): TopicProvisioningSliceState {
  return {
    provisionedTopicIds: new Set<number>(),
    pendingInjections: new Map<string, string>(),
  };
}

export function markTopicProvisioned(
  state: TopicProvisioningSliceState,
  topicId: number,
): TopicProvisioningSliceState {
  const nextIds = new Set<number>(state.provisionedTopicIds);
  nextIds.add(topicId);
  return { ...state, provisionedTopicIds: nextIds };
}

export function enqueueOrientationInjection(
  state: TopicProvisioningSliceState,
  injectionKey: string,
  summaryInjection: string,
): TopicProvisioningSliceState {
  const nextPending = new Map<string, string>(state.pendingInjections);
  nextPending.set(injectionKey, summaryInjection);
  return { ...state, pendingInjections: nextPending };
}

export function dequeueOrientationInjection(
  state: TopicProvisioningSliceState,
  injectionKey: string,
): { nextState: TopicProvisioningSliceState; brief?: string } {
  const brief = state.pendingInjections.get(injectionKey);
  if (brief === undefined) {
    return { nextState: state };
  }
  const nextPending = new Map<string, string>(state.pendingInjections);
  nextPending.delete(injectionKey);
  return { nextState: { ...state, pendingInjections: nextPending }, brief };
}
