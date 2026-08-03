/**
 * BDD tests for #20: Telemetry-Driven Adaptive Admission.
 */

import { describe, it, expect } from "vitest";
import {
  classifyHealth,
  computeEffectiveMax,
  getAdmissionDecision,
  shouldRestoreCapacity,
  DEFAULT_THRESHOLDS,
  type SystemHealthSnapshot,
  type AdmissionThresholds,
} from "../../src/plugins/shared/adaptive-admission.js";

const healthy: SystemHealthSnapshot = {
  status: "healthy",
  eventLoopP99Ms: 5,
  eventLoopUtilization: 0.05,
  usedHeapSize: 50 * 1024 * 1024,
  cpuRatio: 0.01,
};

const degraded: SystemHealthSnapshot = {
  status: "degraded",
  eventLoopP99Ms: 100,
  eventLoopUtilization: 0.5,
  usedHeapSize: 200 * 1024 * 1024,
  cpuRatio: 0.3,
};

const critical: SystemHealthSnapshot = {
  status: "critical",
  eventLoopP99Ms: 500,
  eventLoopUtilization: 0.85,
  usedHeapSize: 600 * 1024 * 1024,
  cpuRatio: 0.9,
};

// ═══════════════════════════════════════════════════════════════

describe("Feature: Health Classification", () => {
  it("Scenario: Low P99 + low util = healthy", () => {
    expect(classifyHealth(5, 0.05, 50, DEFAULT_THRESHOLDS)).toBe("healthy");
  });

  it("Scenario: P99 > 50ms = degraded", () => {
    expect(classifyHealth(100, 0.1, 50, DEFAULT_THRESHOLDS)).toBe("degraded");
  });

  it("Scenario: P99 > 200ms = critical", () => {
    expect(classifyHealth(500, 0.1, 50, DEFAULT_THRESHOLDS)).toBe("critical");
  });

  it("Scenario: Utilization > 0.7 = critical even with low P99", () => {
    expect(classifyHealth(10, 0.8, 50, DEFAULT_THRESHOLDS)).toBe("critical");
  });

  it("Scenario: Heap > 500MB = critical", () => {
    expect(classifyHealth(5, 0.05, 600, DEFAULT_THRESHOLDS)).toBe("critical");
  });

  it("Scenario: Custom thresholds change the boundaries", () => {
    const custom: AdmissionThresholds = {
      ...DEFAULT_THRESHOLDS,
      p99HealthyMs: 100,
      p99DegradedMs: 500,
    };
    expect(classifyHealth(200, 0.1, 50, custom)).toBe("degraded");
    expect(classifyHealth(600, 0.1, 50, custom)).toBe("critical");
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: Effective Max Concurrent", () => {
  it("Scenario: Healthy allows full configured max", () => {
    expect(computeEffectiveMax(6, "healthy")).toBe(6);
  });

  it("Scenario: Degraded reduces by 2", () => {
    expect(computeEffectiveMax(6, "degraded")).toBe(4);
  });

  it("Scenario: Critical sets to 0 (block all)", () => {
    expect(computeEffectiveMax(6, "critical")).toBe(0);
  });

  it("Scenario: Degraded floors at 1", () => {
    expect(computeEffectiveMax(2, "degraded")).toBe(1);
  });

  it("Scenario: Custom degraded reduction", () => {
    const custom: AdmissionThresholds = {
      ...DEFAULT_THRESHOLDS,
      degradedReduction: 4,
    };
    expect(computeEffectiveMax(6, "degraded", custom)).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: Admission Decision", () => {
  it("Scenario: Healthy + slots available = allowed", () => {
    const decision = getAdmissionDecision(healthy, 2, 6);
    expect(decision.allowed).toBe(true);
    expect(decision.effectiveMaxConcurrent).toBe(6);
    expect(decision.reason).toContain("ok");
  });

  it("Scenario: Healthy + slots full = blocked", () => {
    const decision = getAdmissionDecision(healthy, 6, 6);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("6/6 slots used");
  });

  it("Scenario: Degraded throttles to effective max 4", () => {
    const decision = getAdmissionDecision(degraded, 3, 6);
    expect(decision.effectiveMaxConcurrent).toBe(4);
    expect(decision.allowed).toBe(true); // 3 < 4
    expect(decision.reason).toContain("throttled");
  });

  it("Scenario: Degraded blocks at effective max 4", () => {
    const decision = getAdmissionDecision(degraded, 4, 6);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("4/4 slots");
  });

  it("Scenario: Critical blocks all spawning", () => {
    const decision = getAdmissionDecision(critical, 0, 6);
    expect(decision.allowed).toBe(false);
    expect(decision.effectiveMaxConcurrent).toBe(0);
    expect(decision.reason).toContain("blocked");
    expect(decision.reason).toContain("critical");
  });

  it("Scenario: Decision includes health metrics in reason", () => {
    const decision = getAdmissionDecision(critical, 0, 6);
    expect(decision.reason).toContain("P99");
    expect(decision.reason).toContain("util");
    expect(decision.reason).toContain("heap");
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: Capacity Recovery", () => {
  it("Scenario: Healthy for 30s+ restores capacity", () => {
    expect(shouldRestoreCapacity("healthy", 1_000_000, 1_030_001)).toBe(true);
  });

  it("Scenario: Healthy for < 30s does not restore yet", () => {
    expect(shouldRestoreCapacity("healthy", 1_000_000, 1_020_000)).toBe(false);
  });

  it("Scenario: Degraded status does not restore", () => {
    expect(shouldRestoreCapacity("degraded", 1_000_000, 1_040_000)).toBe(false);
  });

  it("Scenario: Critical status does not restore", () => {
    expect(shouldRestoreCapacity("critical", 1_000_000, 1_040_000)).toBe(false);
  });

  it("Scenario: Custom recovery period", () => {
    expect(shouldRestoreCapacity("healthy", 1_000_000, 1_005_001, 5_000)).toBe(true);
  });
});
