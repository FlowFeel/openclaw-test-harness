/**
 * Tier 1 Unit Spec: oc-lane-supervisor / tool-hygiene slice.
 *
 * @dft Pure unit tests — verifies truncation, error circuit breaker, and burst rollup.
 */

import { describe, it, expect } from "vitest";
import { createToolHygieneSliceState } from "../state.js";
import {
  checkToolCircuitBreaker,
  applyToolResultHygiene,
  finalizeSessionRollup,
} from "../logic.js";

describe("oc-lane-supervisor / slices/tool-hygiene (Tier 1 Unit)", () => {
  it("applies tool result truncation and finalizes session rollup cleanly", () => {
    const cfg = {
      truncation: { maxToolResultChars: 100, headChars: 30, tailChars: 30 },
      circuitBreaker: { maxConsecutiveIdenticalErrors: 2, enableErrorCircuitBreaker: true },
      rollupEnabled: true,
      rollup: { minBurstSize: 4 },
    };
    let state = createToolHygieneSliceState();
    expect(checkToolCircuitBreaker(state, cfg, "exec", { cmd: "ls" }).blocked).toBe(false);

    const res = applyToolResultHygiene(state, cfg, {
      sessionId: "s1",
      toolName: "exec",
      message: {
        role: "toolResult",
        toolName: "exec",
        content: [{ type: "text", text: "A".repeat(500) }],
      },
    });
    state = res.nextState;
    expect(res.truncated).toBe(true);

    const summary = finalizeSessionRollup(state, cfg, "s1");
    expect(summary.squashedCount).toBe(0);
  });
});

