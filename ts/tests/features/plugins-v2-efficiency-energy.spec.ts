/**
 * BDD Step Definitions & Executable Specs for Plugins v2 Efficiency & Energy Budgeting.
 *
 * Implements the Gherkin contract defined in tests/features/plugins-v2-efficiency-energy.feature
 * adhering to :bdd.principle/declarative and :bdd.axiom/context-isolation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  initTurnEnergy,
  applyEnergyAction,
  evaluateTurnEfficiencyScore,
  resolveTierFromTes,
  updateSessionReputation,
  formatEnergyEnvelopeHeader,
  formatHabitTelemetryCard,
  type TurnEnergyState,
  type SessionTier,
  type SessionReputation,
} from "../../src/plugins/shared/efficiency-energy-logic.js";

describe("Feature: Plugins v2 Efficiency Scoring, Energy Budgeting and Soft Landing", () => {
  let turnState: TurnEnergyState;
  let reputation: SessionReputation;

  beforeEach(() => {
    reputation = {
      rollingTes: 50,
      tier: "standard",
      maxSubagentSlots: 3,
      queuePriority: "normal",
    };
    turnState = initTurnEnergy("standard");
  });

  describe("Rule: Turn energy pool initial allocation by session tier", () => {
    it("Scenario: Turn energy pool initial allocation by session tier", () => {
      // Given a session with tier "sovereign"
      const tier: SessionTier = "sovereign";

      // When a new turn begins
      turnState = initTurnEnergy(tier);

      // Then the initial energy pool should be 1200 units
      expect(turnState.initialEnergy).toBe(1200);
      expect(turnState.remainingEnergy).toBe(1200);

      // And the session should be in an ungated state
      expect(turnState.isGated).toBe(false);
    });
  });

  describe("Rule: Parsimonious tool execution incurs minimal temporal and baseline drain", () => {
    it("Scenario: Parsimonious tool execution incurs minimal temporal and baseline drain", () => {
      // Given a session with tier "standard" and 1000 initial energy
      turnState = initTurnEnergy("standard");
      expect(turnState.initialEnergy).toBe(1000);

      // When a tool "read" executes for 2000 milliseconds
      turnState = applyEnergyAction(turnState, {
        toolName: "read",
        durationMs: 2000,
      });

      // Then the remaining energy should be reduced by 17 units (2s * 1.0 + 15 base = 17)
      expect(turnState.remainingEnergy).toBe(983);

      // And the action count should be incremented to 1
      expect(turnState.actionsCount).toBe(1);
    });
  });

  describe("Rule: Asynchronous task delegation rewards energy rebate and habit points", () => {
    it("Scenario: Asynchronous task delegation rewards energy rebate and habit points", () => {
      // Given a session with tier "standard"
      turnState = initTurnEnergy("standard");

      // When an asynchronous task is dispatched via "task_dispatch"
      turnState = applyEnergyAction(turnState, {
        toolName: "task_dispatch",
        durationMs: 500,
        isDelegation: true,
      });

      // Then the energy pool should receive a rebate of 200 units (1000 - (0.5 - 200) = 1199.5)
      expect(turnState.remainingEnergy).toBeGreaterThan(1000);

      // And the session should be awarded 150 habit points
      expect(turnState.habitPoints).toBe(150);

      // And the delegation counter should be incremented to 1
      expect(turnState.delegationCount).toBe(1);
    });
  });

  describe("Rule: Zero-delta poll triggers instant drain penalty", () => {
    it("Scenario: Zero-delta poll triggers instant drain penalty", () => {
      // Given a session with tier "standard" and 1000 initial energy
      turnState = initTurnEnergy("standard");

      // When a poll tool "process" returns zero new output
      turnState = applyEnergyAction(turnState, {
        toolName: "process",
        durationMs: 1000,
        isPoll: true,
        isZeroDelta: true,
      });

      // Then the energy pool should suffer an instant drain penalty of 100 units
      // (1000 - (1s * 1.0 + 100 penalty) = 899)
      expect(turnState.remainingEnergy).toBe(899);

      // And the session should accumulate 120 penalty points
      expect(turnState.penalties).toBe(120);
    });
  });

  describe("Rule: Energy advisory notice injected into tool response before critical ceiling", () => {
    it("Scenario: Energy advisory notice injected into tool response before critical ceiling", () => {
      // Given a session with tier "constrained" and 600 initial energy
      turnState = initTurnEnergy("constrained");

      // When a heavy synchronous tool burns energy below the 200 unit threshold
      turnState = applyEnergyAction(turnState, {
        toolName: "exec",
        durationMs: 150000, // 150s
      });

      // Then an energy advisory notice should be appended to the tool result envelope
      expect(turnState.remainingEnergy).toBeLessThanOrEqual(200);
      expect(turnState.advisoryEmitted).toBe(true);

      // And tool execution should remain allowed
      expect(turnState.isGated).toBe(false);
    });
  });

  describe("Rule: Exhausted energy budget enforces soft landing and gates subsequent tools cleanly", () => {
    it("Scenario: Exhausted energy budget enforces soft landing and gates subsequent tools cleanly", () => {
      // Given a session with an exhausted turn energy pool of 0 units
      turnState = initTurnEnergy("constrained");
      turnState = applyEnergyAction(turnState, {
        toolName: "exec",
        durationMs: 300000, // Burns entire 600E pool
      });
      expect(turnState.remainingEnergy).toBe(0);
      expect(turnState.isGated).toBe(true);

      // When the agent attempts to execute another tool call
      const afterAttempt = applyEnergyAction(turnState, {
        toolName: "read",
        durationMs: 100,
      });

      // Then the tool call should be blocked before execution
      expect(afterAttempt.isGated).toBe(true);
      expect(afterAttempt.actionsCount).toBe(turnState.actionsCount);
    });
  });

  describe("Rule: Turn efficiency score updates rolling reputation and promotes session tier", () => {
    it("Scenario: Turn efficiency score updates rolling reputation and promotes session tier", () => {
      // Given a session with rolling efficiency score of 78
      reputation = {
        rollingTes: 78,
        tier: "standard",
        maxSubagentSlots: 3,
        queuePriority: "normal",
      };

      // When a turn completes with a Turn Efficiency Score of 100
      const turnTes = 100;
      reputation = updateSessionReputation(reputation, turnTes, 0.25);

      // Then the rolling efficiency score should update to 84 (0.25 * 100 + 0.75 * 78 = 83.5 -> 84)
      expect(reputation.rollingTes).toBe(84);

      // And the session tier should be promoted to "sovereign"
      expect(reputation.tier).toBe("sovereign");

      // And the subagent concurrency allowance should expand to 6 slots
      expect(reputation.maxSubagentSlots).toBe(6);
      expect(reputation.queuePriority).toBe("high");
    });
  });
});
