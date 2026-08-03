/**
 * BDD tests for #19: Nested Subagent Chains (depth 2+).
 *
 * @dft
 * - Pure logic only — no sessions_spawn, no I/O
 * - Deterministic: no clock, no random
 * - All data inline
 * - Tests run in <5ms
 *
 * Pattern: Feature/Scenario
 */

import { describe, it, expect } from "vitest";
import {
  canSpawnAtDepth,
  getDepthDecision,
  getTimeoutForDepth,
  getArchiveAfterForDepth,
  canNestFurther,
  getCleanupPolicyForDepth,
  validateDepthConfig,
  DEFAULT_DEPTH_CONFIG,
  type DepthConfig,
} from "../../src/plugins/shared/depth-limiter.js";

// ═══════════════════════════════════════════════════════════════
// Feature: Depth-Limited Spawning
// ═══════════════════════════════════════════════════════════════

describe("Feature: Depth-Limited Spawning", () => {
  it("Scenario: Depth 0 (main) can spawn at depth 1", () => {
    expect(canSpawnAtDepth(0, DEFAULT_DEPTH_CONFIG)).toBe(true);
  });

  it("Scenario: Depth 1 can spawn at depth 2 (nesting allowed)", () => {
    expect(canSpawnAtDepth(1, DEFAULT_DEPTH_CONFIG)).toBe(true);
  });

  it("Scenario: Depth 2 cannot spawn at depth 3 (blocked)", () => {
    expect(canSpawnAtDepth(2, DEFAULT_DEPTH_CONFIG)).toBe(false);
  });

  it("Scenario: canNestFurther returns false at max depth", () => {
    expect(canNestFurther(2, DEFAULT_DEPTH_CONFIG)).toBe(false);
  });

  it("Scenario: canNestFurther returns true below max depth", () => {
    expect(canNestFurther(0, DEFAULT_DEPTH_CONFIG)).toBe(true);
    expect(canNestFurther(1, DEFAULT_DEPTH_CONFIG)).toBe(true);
  });

  it("Scenario: Custom config with maxSpawnDepth=1 blocks nesting", () => {
    const config: DepthConfig = { ...DEFAULT_DEPTH_CONFIG, maxSpawnDepth: 1 };
    expect(canSpawnAtDepth(0, config)).toBe(true);
    expect(canSpawnAtDepth(1, config)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Depth-Aware Timeouts
// ═══════════════════════════════════════════════════════════════

describe("Feature: Depth-Aware Timeouts", () => {
  it("Scenario: Depth 1 gets the full base timeout (300s)", () => {
    const decision = getDepthDecision(0);
    expect(decision.allowed).toBe(true);
    expect(decision.effectiveDepth).toBe(1);
    expect(decision.timeoutSeconds).toBe(300);
  });

  it("Scenario: Depth 2 gets reduced timeout (180s)", () => {
    const decision = getDepthDecision(1);
    expect(decision.allowed).toBe(true);
    expect(decision.effectiveDepth).toBe(2);
    expect(decision.timeoutSeconds).toBe(180); // 300 - 120
  });

  it("Scenario: Depth 3 is blocked (no timeout)", () => {
    const decision = getDepthDecision(2);
    expect(decision.allowed).toBe(false);
    expect(decision.timeoutSeconds).toBe(0);
    expect(decision.reason).toContain("exceeds maxSpawnDepth");
  });

  it("Scenario: getTimeoutForDepth returns correct values per level", () => {
    expect(getTimeoutForDepth(1)).toBe(300);
    expect(getTimeoutForDepth(2)).toBe(180);
  });

  it("Scenario: Timeout floors at 60s (never lower)", () => {
    const config: DepthConfig = {
      ...DEFAULT_DEPTH_CONFIG,
      baseTimeoutSeconds: 100,
      timeoutReductionPerDepth: 200,
    };
    // Depth 2: 100 - 200 = -100 → floored at 60
    expect(getTimeoutForDepth(2, config)).toBe(60);
  });

  it("Scenario: Custom timeout reduction per depth", () => {
    const config: DepthConfig = {
      ...DEFAULT_DEPTH_CONFIG,
      timeoutReductionPerDepth: 60,
    };
    expect(getTimeoutForDepth(1, config)).toBe(300);
    expect(getTimeoutForDepth(2, config)).toBe(240); // 300 - 60
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Depth-Aware Archive (Cleanup)
// ═══════════════════════════════════════════════════════════════

describe("Feature: Depth-Aware Archive (Cleanup)", () => {
  it("Scenario: Depth 1 gets base archive time (10 min)", () => {
    const decision = getDepthDecision(0);
    expect(decision.archiveAfterMinutes).toBe(10);
  });

  it("Scenario: Depth 2 gets reduced archive time (5 min)", () => {
    const decision = getDepthDecision(1);
    expect(decision.archiveAfterMinutes).toBe(5); // 10 - 5
  });

  it("Scenario: Archive floors at 1 min", () => {
    const config: DepthConfig = {
      ...DEFAULT_DEPTH_CONFIG,
      baseArchiveAfterMinutes: 3,
      archiveReductionPerDepth: 10,
    };
    expect(getArchiveAfterForDepth(2, config)).toBe(1); // 3 - 10 = -7 → floored at 1
  });

  it("Scenario: getArchiveAfterForDepth returns correct values", () => {
    expect(getArchiveAfterForDepth(1)).toBe(10);
    expect(getArchiveAfterForDepth(2)).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Depth-Aware Cleanup Policy
// ═══════════════════════════════════════════════════════════════

describe("Feature: Depth-Aware Cleanup Policy", () => {
  it("Scenario: Depth 1 subagents get normal cleanup (15h, not aggressive)", () => {
    const policy = getCleanupPolicyForDepth(1);
    expect(policy.maxAgeHours).toBe(15);
    expect(policy.aggressive).toBe(false);
  });

  it("Scenario: Depth 2 subagents get aggressive cleanup (5h, aggressive)", () => {
    const policy = getCleanupPolicyForDepth(2);
    expect(policy.maxAgeHours).toBe(5); // 15 / 3 = 5
    expect(policy.aggressive).toBe(true);
  });

  it("Scenario: Depth 3+ gets the most aggressive cleanup", () => {
    const policy = getCleanupPolicyForDepth(3);
    expect(policy.maxAgeHours).toBe(5); // same as depth 2 (floor)
    expect(policy.aggressive).toBe(true);
  });

  it("Scenario: Custom base max age propagates", () => {
    const policy = getCleanupPolicyForDepth(2, 30);
    expect(policy.maxAgeHours).toBe(10); // 30 / 3 = 10
    expect(policy.aggressive).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Config Validation
// ═══════════════════════════════════════════════════════════════

describe("Feature: Config Validation", () => {
  it("Scenario: Default config is valid", () => {
    const errors = validateDepthConfig(DEFAULT_DEPTH_CONFIG);
    expect(errors).toHaveLength(0);
  });

  it("Scenario: maxSpawnDepth < 1 is invalid", () => {
    const errors = validateDepthConfig({ ...DEFAULT_DEPTH_CONFIG, maxSpawnDepth: 0 });
    expect(errors).toContain("maxSpawnDepth must be >= 1");
  });

  it("Scenario: maxSpawnDepth > 2 is invalid (bloat cascade prevention)", () => {
    const errors = validateDepthConfig({ ...DEFAULT_DEPTH_CONFIG, maxSpawnDepth: 3 });
    expect(errors.some((e) => e.includes("depth 3+ caused the original bloat cascade"))).toBe(true);
  });

  it("Scenario: baseTimeoutSeconds < 60 is invalid", () => {
    const errors = validateDepthConfig({ ...DEFAULT_DEPTH_CONFIG, baseTimeoutSeconds: 30 });
    expect(errors).toContain("baseTimeoutSeconds must be >= 60");
  });

  it("Scenario: Negative reduction is invalid", () => {
    const errors = validateDepthConfig({
      ...DEFAULT_DEPTH_CONFIG,
      timeoutReductionPerDepth: -10,
    });
    expect(errors.some((e) => e.includes("timeoutReductionPerDepth"))).toBe(true);
  });

  it("Scenario: Depth 2 timeout relies on 60s floor is flagged", () => {
    const errors = validateDepthConfig({
      ...DEFAULT_DEPTH_CONFIG,
      baseTimeoutSeconds: 150,
      timeoutReductionPerDepth: 200,
    });
    expect(errors.some((e) => e.includes("relies on 60s floor"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Research → Analysis → Synthesis Chain
// ═══════════════════════════════════════════════════════════════

describe("Feature: Research → Analysis → Synthesis Chain", () => {
  it("Scenario: Full 3-level chain is allowed (depth 0 → 1 → 2)", () => {
    // Main (depth 0) spawns research (depth 1)
    expect(canSpawnAtDepth(0, DEFAULT_DEPTH_CONFIG)).toBe(true);
    const depth1 = getDepthDecision(0);
    expect(depth1.timeoutSeconds).toBe(300);

    // Research (depth 1) spawns analysis (depth 2)
    expect(canSpawnAtDepth(1, DEFAULT_DEPTH_CONFIG)).toBe(true);
    const depth2 = getDepthDecision(1);
    expect(depth2.timeoutSeconds).toBe(180);

    // Analysis (depth 2) cannot spawn synthesis (depth 3)
    expect(canSpawnAtDepth(2, DEFAULT_DEPTH_CONFIG)).toBe(false);
    const depth3 = getDepthDecision(2);
    expect(depth3.allowed).toBe(false);
  });

  it("Scenario: Depth 2 subagent has stricter cleanup than depth 1", () => {
    const depth1Cleanup = getCleanupPolicyForDepth(1);
    const depth2Cleanup = getCleanupPolicyForDepth(2);

    expect(depth2Cleanup.maxAgeHours).toBeLessThan(depth1Cleanup.maxAgeHours);
    expect(depth2Cleanup.aggressive).toBe(true);
    expect(depth1Cleanup.aggressive).toBe(false);
  });

  it("Scenario: Depth 2 subagent has shorter timeout than depth 1", () => {
    const depth1Timeout = getTimeoutForDepth(1);
    const depth2Timeout = getTimeoutForDepth(2);

    expect(depth2Timeout).toBeLessThan(depth1Timeout);
    expect(depth2Timeout).toBeGreaterThanOrEqual(60); // floor
  });
});
