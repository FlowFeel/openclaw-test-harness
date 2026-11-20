/**
 * Tier 1 Unit Spec: oc-lane-supervisor / turn-energy slice.
 *
 * @dft Pure unit tests — verifies idle suppression, energy init, zero-delta drain, soft-landing gate, and TES rollup.
 */

import { describe, it, expect } from "vitest";
import { createTurnEnergySliceState } from "../state.js";
import {
  startTurnEnergy,
  evaluateEnergyGate,
  applyToolEnergyDrain,
  finalizeTurnEnergy,
} from "../logic.js";

describe("oc-lane-supervisor / slices/turn-energy (Tier 1 Unit)", () => {
  const cfg = {
    enabled: true,
    enableHeaders: false,
    initialSessionTier: "constrained" as const,
    suppressIdleHeartbeats: true,
  };

  it("suppresses empty/whitespace idle prompts via idle-guard-logic", () => {
    const state = createTurnEnergySliceState();
    const res = startTurnEnergy(state, cfg, "s1", "   ", 1000);
    expect(res.suppressed).toBe(true);

    // Interactive channel messages or redacted (undefined) prompts must NEVER be blocked
    const redacted = startTurnEnergy(state, cfg, "s2", undefined, 1000);
    expect(redacted.suppressed).toBe(false);

    const tgMedia = startTurnEnergy(state, cfg, "s3", "", 1000, { isInteractiveChannel: true });
    expect(tgMedia.suppressed).toBe(false);
  });

  it("drains turn energy on zero-delta polls until soft-landing gate trips", () => {
    const state = createTurnEnergySliceState();
    startTurnEnergy(state, cfg, "s1", "Inspect logs", 1000);
    expect(evaluateEnergyGate(state, cfg, "s1").blocked).toBe(false);

    for (let i = 0; i < 6; i++) {
      applyToolEnergyDrain(state, cfg, {
        sessionId: "s1",
        toolName: "process",
        isZeroDeltaPoll: true,
        payloadBytes: 50,
        nowMs: 2000 + i * 500,
      });
    }

    const gate = evaluateEnergyGate(state, cfg, "s1");
    expect(gate.blocked).toBe(true);
    expect(gate.blockReason).toContain("Turn energy budget exhausted");

    const end = finalizeTurnEnergy(state, cfg, "s1", 10_000, true);
    expect(end.updated).toBe(true);
  });
});

