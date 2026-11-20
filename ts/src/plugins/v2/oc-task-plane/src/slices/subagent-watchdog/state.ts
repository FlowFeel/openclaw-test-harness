/**
 * Subagent Watchdog State Slice — owns tracked subagent records and timeout thresholds.
 *
 * @invariants
 * - Isolated vertical slice state; zero coupling to task-dispatch or durable-proxy slices.
 *
 * @dft
 * - Tested via slices/subagent-watchdog/tests/logic.spec.ts.
 */

import type { SubagentMap } from "../../subagent-tracker.js";

export interface SubagentWatchdogConfig {
  timeoutSeconds: number;
}

export interface SubagentWatchdogState {
  readonly subagents: SubagentMap;
}

export function createSubagentWatchdogState(): SubagentWatchdogState {
  return { subagents: new Map() };
}

