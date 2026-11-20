/**
 * Tier 1 Unit Spec: oc-lane-supervisor / poll-hygiene slice.
 *
 * @dft Pure unit tests — verifies zero-delta poll collapsing and turn poll budget.
 */

import { describe, it, expect } from "vitest";
import { createPollHygieneSliceState } from "../state.js";
import { processToolResultPoll, evaluatePollWriteSuppression } from "../logic.js";

describe("oc-lane-supervisor / slices/poll-hygiene (Tier 1 Unit)", () => {
  it("collapses zero-delta poll messages and flags isZeroDeltaPoll", () => {
    const cfg = {
      enablePollDeduplication: true,
      enableTurnPollBudget: true,
      turnPollBudgetMs: 90_000,
    };
    const state = createPollHygieneSliceState();
    const res = processToolResultPoll(state, cfg, {
      sessionId: "s1",
      toolName: "process",
      message: {
        role: "toolResult",
        toolName: "process",
        content: [{ type: "text", text: "(no new output)" }],
      },
      nowMs: 1000,
    });
    expect(res.isZeroDeltaPoll).toBe(true);
    const wr = evaluatePollWriteSuppression(res.nextState, cfg, { role: "assistant", content: "hi" });
    expect(wr.suppress).toBe(false);
  });
});

