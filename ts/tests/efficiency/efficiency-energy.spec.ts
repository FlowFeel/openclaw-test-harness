import { describe, it, expect } from "vitest";
import {
  initTurnEnergy,
  applyEnergyAction,
  evaluateTurnEfficiencyScore,
  resolveTierFromTes,
  updateSessionReputation,
  formatEnergyEnvelopeHeader,
  SessionReputation,
} from "../../src/plugins/shared/efficiency-energy-logic.js";

describe("efficiency-energy-logic (Pure Foundry DFT Tests)", () => {
  describe("initTurnEnergy", () => {
    it("initializes Sovereign tier with 1200 Energy", () => {
      const state = initTurnEnergy("sovereign");
      expect(state.initialEnergy).toBe(1200);
      expect(state.remainingEnergy).toBe(1200);
      expect(state.tier).toBe("sovereign");
      expect(state.isGated).toBe(false);
    });

    it("initializes Standard tier with 1000 Energy", () => {
      const state = initTurnEnergy("standard");
      expect(state.initialEnergy).toBe(1000);
      expect(state.remainingEnergy).toBe(1000);
      expect(state.tier).toBe("standard");
    });

    it("initializes Constrained tier with 600 Energy", () => {
      const state = initTurnEnergy("constrained");
      expect(state.initialEnergy).toBe(600);
      expect(state.remainingEnergy).toBe(600);
      expect(state.tier).toBe("constrained");
    });
  });

  describe("applyEnergyAction", () => {
    it("deducts normal tool execution cost and elapsed seconds", () => {
      const initial = initTurnEnergy("standard");
      const next = applyEnergyAction(initial, {
        toolName: "read",
        durationMs: 2000,
      });

      expect(next.actionsCount).toBe(1);
      expect(next.elapsedSeconds).toBe(2);
      // 1000 - (2s * 1.0 + 15 base) = 983
      expect(next.remainingEnergy).toBe(983);
    });

    it("rewards delegation with energy rebate and habit points", () => {
      const initial = initTurnEnergy("standard");
      const next = applyEnergyAction(initial, {
        toolName: "task_dispatch",
        durationMs: 500,
        isDelegation: true,
      });

      expect(next.delegationCount).toBe(1);
      expect(next.habitPoints).toBe(150);
      // 1000 - (0.5 - 200) = 1199.5
      expect(next.remainingEnergy).toBeGreaterThan(1000);
    });

    it("applies penalty and heavy drain for zero-delta poll", () => {
      const initial = initTurnEnergy("standard");
      const next = applyEnergyAction(initial, {
        toolName: "process",
        durationMs: 1000,
        isPoll: true,
        isZeroDelta: true,
      });

      expect(next.penalties).toBe(120);
      // drain = 1s * 1 + 100 = 101
      expect(next.remainingEnergy).toBe(899);
    });

    it("triggers advisory flag when remaining energy drops below 200", () => {
      let state = initTurnEnergy("constrained"); // 600 E
      state = applyEnergyAction(state, {
        toolName: "exec",
        durationMs: 150000, // 150s -> drain = 150 + 15 + (30 + 300) = 495
      });

      expect(state.remainingEnergy).toBeLessThanOrEqual(200);
      expect(state.advisoryEmitted).toBe(true);
      expect(state.isGated).toBe(false);
    });

    it("gates subsequent tool calls when energy reaches 0", () => {
      let state = initTurnEnergy("constrained"); // 600 E
      // Apply huge drain
      state = applyEnergyAction(state, {
        toolName: "exec",
        durationMs: 300000, // 300s -> drain > 600
      });

      expect(state.remainingEnergy).toBe(0);
      expect(state.isGated).toBe(true);

      // Attempting another action after gating is a no-op
      const afterGated = applyEnergyAction(state, {
        toolName: "read",
        durationMs: 100,
      });
      expect(afterGated.actionsCount).toBe(state.actionsCount);
      expect(afterGated.remainingEnergy).toBe(0);
    });
  });

  describe("evaluateTurnEfficiencyScore", () => {
    it("awards high TES for fast yield and parsimonious delegation", () => {
      let state = initTurnEnergy("standard");
      state = applyEnergyAction(state, {
        toolName: "sessions_spawn",
        durationMs: 1500,
        isDelegation: true,
      });

      const score = evaluateTurnEfficiencyScore(state);
      // 50 + (150 delegation + 100 fast yield + 75 parsimony <=4 tools) / 10 = 50 + 32.5 = 83
      expect(score).toBeGreaterThanOrEqual(80);
    });

    it("penalizes repetitive polling loops with low TES", () => {
      let state = initTurnEnergy("standard");
      for (let i = 0; i < 5; i++) {
        state = applyEnergyAction(state, {
          toolName: "process",
          durationMs: 30000,
          isPoll: true,
          isZeroDelta: true,
        });
      }

      const score = evaluateTurnEfficiencyScore(state);
      expect(score).toBeLessThan(40);
    });
  });

  describe("resolveTierFromTes and updateSessionReputation", () => {
    it("promotes to sovereign tier when rolling score >= 80", () => {
      expect(resolveTierFromTes(85)).toBe("sovereign");
      expect(resolveTierFromTes(55)).toBe("standard");
      expect(resolveTierFromTes(40)).toBe("constrained");
    });

    it("updates rolling reputation smoothly via EMA", () => {
      const rep: SessionReputation = {
        rollingTes: 50,
        tier: "standard",
        maxSubagentSlots: 3,
        queuePriority: "normal",
      };

      const updated = updateSessionReputation(rep, 90, 0.25);
      // 0.25 * 90 + 0.75 * 50 = 22.5 + 37.5 = 60
      expect(updated.rollingTes).toBe(60);
      expect(updated.tier).toBe("standard");

      // Repeated sovereign turns promote session
      const sovereign = updateSessionReputation(
        { ...rep, rollingTes: 78 },
        100,
        0.25,
      );
      // 0.25 * 100 + 0.75 * 78 = 25 + 58.5 = 84 -> sovereign
      expect(sovereign.rollingTes).toBe(84);
      expect(sovereign.tier).toBe("sovereign");
      expect(sovereign.maxSubagentSlots).toBe(6);
      expect(sovereign.queuePriority).toBe("high");
    });
  });

  describe("formatEnergyEnvelopeHeader", () => {
    it("renders compact formatted header", () => {
      const state = initTurnEnergy("sovereign");
      const header = formatEnergyEnvelopeHeader(state);
      expect(header).toBe("[⚡ Energy: 1200/1200 (100%) | Tier: SOVEREIGN | Habits: +0P]");
    });
  });
});
