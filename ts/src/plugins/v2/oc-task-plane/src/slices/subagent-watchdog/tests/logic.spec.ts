/**
 * Tier 1 Unit Spec: oc-task-plane / subagent-watchdog slice.
 *
 * @dft Pure unit tests — verifies stale subagent detection.
 */

import { describe, it, expect } from "vitest";
import { createSubagentWatchdogState } from "../state.js";
import { evaluateSubagentHealth } from "../logic.js";

describe("oc-task-plane / slices/subagent-watchdog (Tier 1 Unit)", () => {
  it("detects stale active subagents past timeout threshold", () => {
    const state = createSubagentWatchdogState();
    state.subagents.set("sub-1", {
      sessionKey: "sub-1",
      startedAtMs: 1000,
      status: "active",
    });

    const healthy = evaluateSubagentHealth(state, { timeoutSeconds: 60 }, 20_000);
    expect(healthy.activeCount).toBe(1);
    expect(healthy.staleCount).toBe(0);

    const stale = evaluateSubagentHealth(state, { timeoutSeconds: 60 }, 100_000);
    expect(stale.staleCount).toBe(1);
    expect(stale.staleKeys).toEqual(["sub-1"]);
  });
});
