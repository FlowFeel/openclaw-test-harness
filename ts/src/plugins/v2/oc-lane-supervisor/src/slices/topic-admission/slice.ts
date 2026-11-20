/**
 * Topic Admission Slice Adapter — binds real subagent_spawning / subagent_ended semaphore tracking.
 *
 * @invariants
 * - Owns only TopicAdmissionSliceState; zero no-op stubs.
 *
 * @dft
 * - Tested via oc-lane-supervisor integration specs with InMemoryPluginApi.
 */

import type { PluginApi, HookEvent } from "../../../../../shared/types.js";
import { createTopicAdmissionState, type TopicAdmissionSliceConfig } from "./state.js";
import { onSubagentSpawnTransition, onSubagentEndTransition } from "./logic.js";

export interface TopicAdmissionSliceHandle {
  onSubagentSpawning: (event: HookEvent) => HookEvent;
  onSubagentEnded: (event: HookEvent) => HookEvent;
  getActiveSubagentCount: () => number;
}

export function bindTopicAdmissionSlice(
  api: PluginApi,
  config: TopicAdmissionSliceConfig,
): TopicAdmissionSliceHandle {
  let state = createTopicAdmissionState(config);

  return {
    onSubagentSpawning(event: HookEvent) {
      const id = String(event.subagentId ?? event.sessionKey ?? `sub-${state.activeSubagents.size + 1}`);
      const res = onSubagentSpawnTransition(state, id);
      state = res.nextState;
      if (!res.admitted) {
        api.logger?.warn?.(`[oc-lane-supervisor] subagent pool saturated (${res.activeCount} active) for ${id}`);
      }
      return event;
    },
    onSubagentEnded(event: HookEvent) {
      const id = String(event.subagentId ?? event.sessionKey ?? "");
      if (id) {
        state = onSubagentEndTransition(state, id).nextState;
      }
      return event;
    },
    getActiveSubagentCount: () => state.activeSubagents.size,
  };
}

