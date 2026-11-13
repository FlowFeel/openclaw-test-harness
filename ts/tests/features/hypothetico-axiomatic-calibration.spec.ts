/**
 * BDD Step Definitions & Executable Specs for Hypothetico-Axiomatic Empirical Calibration.
 *
 * Implements the Gherkin contract defined in tests/features/hypothetico-axiomatic-calibration.feature
 * adhering to :bdd.principle/declarative and Braithwaite's hypothetico-axiomatic schema.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  calibrateEconomicParameters,
  DEFAULT_ENERGY_CONFIG,
  type TurnEnergyConfig,
  type EmpiricalCalibrationProfile,
} from "../../src/plugins/shared/efficiency-energy-logic.js";

describe("Feature: Hypothetico-Axiomatic Empirical Feedback and Dynamic Calibration", () => {
  let baselineConfig: TurnEnergyConfig;

  beforeEach(() => {
    baselineConfig = { ...DEFAULT_ENERGY_CONFIG, rates: { ...DEFAULT_ENERGY_CONFIG.rates } };
  });

  describe("Rule: Elevate advisory threshold when empirical yield latency approaches critical ceiling", () => {
    it("Scenario: Elevate advisory threshold when empirical yield latency approaches critical ceiling", () => {
      // Given a baseline energy config with advisory threshold 200 units
      expect(baselineConfig.advisoryThreshold).toBe(200);

      // When an empirical profile reports high critical ceiling hit rate of 0.35 and p99 latency 52 seconds
      const empirical: EmpiricalCalibrationProfile = {
        p99YieldLatencySec: 52,
        zeroDeltaBurstRate: 0.04,
        delegationOffloadRatio: 0.55,
        criticalCeilingHitRate: 0.35,
        meanTurnTes: 68,
      };

      const calibrated = calibrateEconomicParameters(baselineConfig, empirical);

      // Then the calibrated advisory threshold should be elevated to 250 units
      expect(calibrated.advisoryThreshold).toBe(250);
      // And the baseline safety buffer should be strengthened
      expect(calibrated.advisoryThreshold).toBeGreaterThan(baselineConfig.advisoryThreshold);
    });
  });

  describe("Rule: Increase delegation rebate when empirical offload adoption is sluggish", () => {
    it("Scenario: Increase delegation rebate when empirical offload adoption is sluggish", () => {
      // Given a baseline energy config with delegation rebate 200 units and 150 habit points
      expect(baselineConfig.rates.delegationRebate).toBe(200);
      expect(baselineConfig.rates.delegationPoints).toBe(150);

      // When an empirical profile reports a sluggish delegation offload ratio of 0.18
      const empirical: EmpiricalCalibrationProfile = {
        p99YieldLatencySec: 22,
        zeroDeltaBurstRate: 0.05,
        delegationOffloadRatio: 0.18,
        criticalCeilingHitRate: 0.08,
        meanTurnTes: 62,
      };

      const calibrated = calibrateEconomicParameters(baselineConfig, empirical);

      // Then the calibrated delegation rebate should increase to 250 units
      expect(calibrated.rates.delegationRebate).toBe(250);
      // And the habit reward points should increase to 175 points
      expect(calibrated.rates.delegationPoints).toBe(175);
    });
  });

  describe("Rule: Steepen zero-delta penalties when empirical poll burst rate remains elevated", () => {
    it("Scenario: Steepen zero-delta penalties when empirical poll burst rate remains elevated", () => {
      // Given a baseline energy config with zero-delta penalty drain of 100 units
      expect(baselineConfig.rates.zeroDeltaPenaltyDrain).toBe(100);

      // When an empirical profile reports an elevated zero-delta burst rate of 0.22
      const empirical: EmpiricalCalibrationProfile = {
        p99YieldLatencySec: 20,
        zeroDeltaBurstRate: 0.22,
        delegationOffloadRatio: 0.45,
        criticalCeilingHitRate: 0.05,
        meanTurnTes: 58,
      };

      const calibrated = calibrateEconomicParameters(baselineConfig, empirical);

      // Then the calibrated zero-delta penalty drain should steepen to 150 units
      expect(calibrated.rates.zeroDeltaPenaltyDrain).toBe(150);
      // And the penalty points should increase to 150 points
      expect(calibrated.rates.zeroDeltaPenaltyPoints).toBe(150);
    });
  });
});
