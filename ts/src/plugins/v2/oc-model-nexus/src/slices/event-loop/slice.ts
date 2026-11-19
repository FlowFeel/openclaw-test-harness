/**
 * Event Loop Slice Adapter — binds event_loop_health tool and sampling/disposal hooks.
 *
 * @invariants
 * - Isolates EventLoopSliceState; accepts injected TelemetrySampler for deterministic testing.
 *
 * @dft
 * - Tested via oc-model-nexus integration & manifest specs.
 */

import { Type, type PluginApi } from "../../../../../shared/types.js";
import { createEventLoopState } from "./state.js";
import { recordTelemetryReading, evaluateEventLoopHealth } from "./logic.js";
import { createNodeTelemetrySampler, type TelemetrySampler } from "./io.js";

export interface EventLoopSliceHandle {
  collect: (processId?: string) => void;
  stop: () => void;
}

export function bindEventLoopSlice(
  api: PluginApi,
  sampler?: TelemetrySampler,
): EventLoopSliceHandle {
  let state = createEventLoopState(60);
  const activeSampler = sampler ?? createNodeTelemetrySampler();

  api.registerTool({
    name: "event_loop_health",
    description:
      "Report event loop health — P99 delay, utilization, heap usage, CPU ratio, and overall status (healthy/degraded/critical).",
    parameters: Type.Object({}),
    async execute() {
      const health = evaluateEventLoopHealth(state, 10);
      return { content: [{ type: "text" as const, text: JSON.stringify(health, null, 2) }] };
    },
  });

  return {
    collect(processId = "main") {
      try {
        const reading = activeSampler.sample(processId);
        state = recordTelemetryReading(state, reading).nextState;
      } catch (err) {
        api.logger?.warn?.(`[oc-model-nexus] telemetry sample failed: ${String(err)}`);
      }
    },
    stop() {
      try {
        activeSampler.dispose();
      } catch (err) {
        api.logger?.warn?.(`[oc-model-nexus] telemetry dispose failed: ${String(err)}`);
      }
    },
  };
}

