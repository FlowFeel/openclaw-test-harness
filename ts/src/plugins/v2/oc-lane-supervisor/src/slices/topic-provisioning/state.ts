/**
 * Topic Provisioning State Slice.
 *
 * @invariants
 * - Pure data contract: tracks provisioned topics in-memory to prevent repeated filesystem probes.
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
}

export function createTopicProvisioningSliceState(): TopicProvisioningSliceState {
  return {
    provisionedTopicIds: new Set<number>(),
  };
}

export function markTopicProvisioned(
  state: TopicProvisioningSliceState,
  topicId: number,
): TopicProvisioningSliceState {
  const next = new Set<number>(state.provisionedTopicIds);
  next.add(topicId);
  return {
    provisionedTopicIds: next,
  };
}
