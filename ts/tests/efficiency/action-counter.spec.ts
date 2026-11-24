/**
 * Tier 1 Unit Spec: action-counter-logic.ts (Pure Action Counter Algebra).
 *
 * @dft Pure unit tests — zero I/O, zero clocks, deterministic value transitions.
 */

import { describe, it, expect } from "vitest";
import {
  createTurnActionCounters,
  recordTurnAction,
  serialExecOverflow,
  exceedsActionDensity,
  actionsSince,
} from "../../src/plugins/shared/action-counter-logic.js";

describe("action-counter-logic (Tier 1 Pure Unit)", () => {
  it("tracks total actions, category counts, and serial exec streak with immutable resets", () => {
    let c = createTurnActionCounters();
    expect(c.totalActions).toBe(0);
    expect(actionsSince(c, null)).toBeNull();

    for (let i = 0; i < 10; i++) {
      c = recordTurnAction(c, "serial_exec");
    }
    expect(c.totalActions).toBe(10);
    expect(c.serialExecStreak).toBe(10);
    expect(serialExecOverflow(c, 8)).toBe(2);
    expect(exceedsActionDensity(c, 12)).toBe(false);

    // Pipeline resets serial exec streak while incrementing total & pipeline counts
    c = recordTurnAction(c, "pipeline");
    expect(c.totalActions).toBe(11);
    expect(c.pipelineActions).toBe(1);
    expect(c.serialExecStreak).toBe(0);
    expect(serialExecOverflow(c, 8)).toBe(0);

    // Delegation increments delegationActions and crosses density threshold 12
    c = recordTurnAction(c, "delegation");
    expect(c.totalActions).toBe(12);
    expect(c.delegationActions).toBe(1);
    expect(exceedsActionDensity(c, 12)).toBe(true);
    expect(actionsSince(c, 10)).toBe(2);

    // Zero-delta poll increments zeroDeltaPolls
    c = recordTurnAction(c, "zero_delta_poll");
    expect(c.zeroDeltaPolls).toBe(1);
  });
});
