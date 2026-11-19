/**
 * Subagent Watchdog Pure Logic — evaluates active/stale subagent health snapshot.
 *
 * @invariants
 * - Pure logic: zero I/O, zero Date.now(), nowMs injected explicitly (A1, A2, A6).
 *
 * @dft
 * - Tested via slices/subagent-watchdog/tests/logic.spec.ts.
 */

import { detectStale, getActiveCount } from "../../subagent-tracker.js";
import type { SubagentWatchdogConfig, SubagentWatchdogState } from "./state.js";

export function evaluateSubagentHealth(
  state: SubagentWatchdogState,
  config: SubagentWatchdogConfig,
  nowMs: number,
) {
  const { result } = detectStale(state.subagents, config.timeoutSeconds, nowMs);
  return {
    ok: true,
    activeCount: getActiveCount(state.subagents),
    staleCount: result.staleKeys.length,
    staleKeys: result.staleKeys,
    timeoutSeconds: config.timeoutSeconds,
  };
}
