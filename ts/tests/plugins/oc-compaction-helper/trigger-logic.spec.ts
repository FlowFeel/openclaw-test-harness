/**
 * Spec: Proactive auto-compaction trigger logic (Axiom 1 & 2 compliant).
 *
 * @dft
 * - Pure: inline objects, zero file I/O, zero network.
 * - Deterministic: all timestamps (nowMs) explicitly passed.
 * - Exhaustive branch coverage: under/at/over threshold, cooldown states, disabled flag.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateCompactionTrigger,
  DEFAULT_AUTO_COMPACT_THRESHOLD_MB,
  DEFAULT_TRIGGER_COOLDOWN_MS,
} from "../../../src/plugins/oc-compaction-helper/src/trigger-logic.js";

describe("evaluateCompactionTrigger (pure DFT decision logic)", () => {
  const MB = 1024 * 1024;

  it("does not trigger when transcript size is below threshold", () => {
    const decision = evaluateCompactionTrigger({
      currentSizeBytes: 1.2 * MB,
      maxTranscriptMb: 2.0,
      lastTriggerMs: 0,
      nowMs: 100_000,
    });

    expect(decision.shouldTrigger).toBe(false);
    expect(decision.currentSizeMb).toBe(1.2);
    expect(decision.thresholdMb).toBe(2.0);
    expect(decision.reason).toContain("below threshold");
  });

  it("triggers when transcript size meets threshold exactly", () => {
    const decision = evaluateCompactionTrigger({
      currentSizeBytes: 2.0 * MB,
      maxTranscriptMb: 2.0,
      lastTriggerMs: 0,
      nowMs: 100_000,
    });

    expect(decision.shouldTrigger).toBe(true);
    expect(decision.currentSizeMb).toBe(2.0);
    expect(decision.reason).toContain("meets or exceeds threshold");
  });

  it("triggers when transcript size exceeds threshold", () => {
    const decision = evaluateCompactionTrigger({
      currentSizeBytes: 4.8 * MB,
      maxTranscriptMb: 2.0,
      lastTriggerMs: 0,
      nowMs: 100_000,
    });

    expect(decision.shouldTrigger).toBe(true);
    expect(decision.currentSizeMb).toBe(4.8);
    expect(decision.reason).toContain("meets or exceeds threshold");
  });

  it("suppresses trigger when active cooldown has not elapsed", () => {
    const lastTrigger = 100_000;
    const now = 130_000; // 30s later; cooldown is 120s
    const decision = evaluateCompactionTrigger({
      currentSizeBytes: 3.5 * MB,
      maxTranscriptMb: 2.0,
      lastTriggerMs: lastTrigger,
      nowMs: now,
      cooldownMs: 120_000,
    });

    expect(decision.shouldTrigger).toBe(false);
    expect(decision.cooldownRemainingMs).toBe(90_000);
    expect(decision.reason).toContain("Compaction cooldown active");
  });

  it("triggers after cooldown elapses if size remains above threshold", () => {
    const lastTrigger = 100_000;
    const now = 230_000; // 130s later; cooldown is 120s
    const decision = evaluateCompactionTrigger({
      currentSizeBytes: 3.5 * MB,
      maxTranscriptMb: 2.0,
      lastTriggerMs: lastTrigger,
      nowMs: now,
      cooldownMs: 120_000,
    });

    expect(decision.shouldTrigger).toBe(true);
    expect(decision.cooldownRemainingMs).toBe(0);
  });

  it("does not trigger when auto-compaction is explicitly disabled", () => {
    const decision = evaluateCompactionTrigger({
      currentSizeBytes: 10.0 * MB,
      maxTranscriptMb: 2.0,
      lastTriggerMs: 0,
      nowMs: 100_000,
      enabled: false,
    });

    expect(decision.shouldTrigger).toBe(false);
    expect(decision.reason).toContain("disabled in configuration");
  });

  it("uses sensible defaults (2 MB threshold, 120s cooldown)", () => {
    expect(DEFAULT_AUTO_COMPACT_THRESHOLD_MB).toBe(2.0);
    expect(DEFAULT_TRIGGER_COOLDOWN_MS).toBe(120_000);
  });
});
