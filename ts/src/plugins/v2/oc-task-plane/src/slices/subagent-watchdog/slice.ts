/**
 * Subagent Watchdog Slice Adapter — binds subagent_health tool.
 *
 * @invariants
 * - Owns only SubagentWatchdogState.
 *
 * @dft
 * - Tested via oc-task-plane integration & manifest specs.
 */

import { Type, type PluginApi } from "../../../../../shared/types.js";
import { createSubagentWatchdogState, type SubagentWatchdogConfig } from "./state.js";
import { evaluateSubagentHealth } from "./logic.js";

export function bindSubagentWatchdogSlice(
  api: PluginApi,
  config: SubagentWatchdogConfig,
  clock: () => number = () => Date.now(),
): void {
  const state = createSubagentWatchdogState();

  api.registerTool({
    name: "subagent_health",
    description: "Check active subagents and identify any hung/timed-out workers.",
    parameters: Type.Object({}),
    async execute() {
      const report = evaluateSubagentHealth(state, config, clock());
      return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
    },
  });
}

