/**
 * Tier 1 Unit Spec: economic-policy-logic.ts (Delegation, Rebate & Friction Policy).
 *
 * @dft Pure unit tests — verifies canonical tool classification, configurable rebates
 *      (zero hardcoded floors), pipeline incentives, and serial exec friction.
 */

import { describe, it, expect } from "vitest";
import {
  createTurnActionCounters,
  recordTurnAction,
} from "../../src/plugins/shared/action-counter-logic.js";
import {
  DEFAULT_INCENTIVE_RATES,
  isDelegationTool,
  classifyEconomicAction,
  evaluateEconomicAdjustment,
} from "../../src/plugins/shared/economic-policy-logic.js";

describe("economic-policy-logic (Tier 1 Pure Unit)", () => {
  it("classifies canonical delegation, pipeline, serial exec, and read/poll tools", () => {
    expect(isDelegationTool("sessions_spawn")).toBe(true);
    expect(isDelegationTool("task_dispatch")).toBe(true);
    expect(isDelegationTool("durable_spawn")).toBe(true);
    expect(isDelegationTool("exec")).toBe(false);

    expect(classifyEconomicAction({ toolName: "sessions_spawn", durationMs: 100 })).toBe("delegation");
    expect(classifyEconomicAction({ toolName: "exec_pipeline", durationMs: 100 })).toBe("pipeline");
    expect(classifyEconomicAction({ toolName: "exec", durationMs: 100 })).toBe("serial_exec");
    expect(classifyEconomicAction({ toolName: "read", durationMs: 100, isTargetedRead: true })).toBe("targeted_read");
    expect(classifyEconomicAction({ toolName: "process", durationMs: 100, isPoll: true })).toBe("poll");
    expect(classifyEconomicAction({ toolName: "read", durationMs: 100 })).toBe("standard");
    expect(classifyEconomicAction({ toolName: "process", durationMs: 100, isZeroDelta: true })).toBe(
      "zero_delta_poll",
    );
  });

  it("respects custom delegationRebate rates (even < 250) without hardcoded floor overrides", () => {
    const counters = recordTurnAction(createTurnActionCounters(), "delegation");
    const defaultAdj = evaluateEconomicAdjustment(
      "delegation",
      { toolName: "sessions_spawn", durationMs: 100 },
      counters,
      1.0,
      DEFAULT_INCENTIVE_RATES,
    );
    expect(defaultAdj.energyDelta).toBe(250);
    expect(defaultAdj.clearsAdvisory).toBe(true);

    const customAdj = evaluateEconomicAdjustment(
      "delegation",
      { toolName: "sessions_spawn", durationMs: 100 },
      counters,
      1.0,
      { ...DEFAULT_INCENTIVE_RATES, delegationRebate: 120 },
    );
    expect(customAdj.energyDelta).toBe(120);
  });

  it("applies flat pipeline batching bonus and escalating serial exec friction beyond threshold", () => {
    let counters = createTurnActionCounters();
    for (let i = 0; i < 10; i++) {
      counters = recordTurnAction(counters, "serial_exec");
    }
    // 10th serial exec -> overflow = 2 -> base 15 + 2 * 5 = 25 drain
    const execAdj = evaluateEconomicAdjustment(
      "serial_exec",
      { toolName: "exec", durationMs: 0 },
      counters,
      1.0,
      DEFAULT_INCENTIVE_RATES,
    );
    expect(execAdj.energyDelta).toBe(-25);

    const pipeCounters = recordTurnAction(counters, "pipeline");
    const pipeAdj = evaluateEconomicAdjustment(
      "pipeline",
      { toolName: "exec_pipeline", durationMs: 0 },
      pipeCounters,
      1.0,
      DEFAULT_INCENTIVE_RATES,
    );
    expect(pipeAdj.energyDelta).toBe(-15);
    expect(pipeAdj.habitPointsDelta).toBe(50);
  });
});
