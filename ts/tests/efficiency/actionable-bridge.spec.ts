/**
 * Tier 1 Unit Spec: actionable-bridge-logic.ts (Bridge Policy, Throttle & Decoration).
 *
 * @dft Pure unit tests — verifies trigger thresholds, 5-action throttle cadence,
 *      clean per-turn reset, actionable copy formatting, and immutable decoration.
 */

import { describe, it, expect } from "vitest";
import {
  initTurnEnergy,
  applyEnergyAction,
  formatEnergyEnvelopeHeader,
} from "../../src/plugins/shared/efficiency-energy-logic.js";
import {
  createBridgeThrottleState,
  evaluateBridgeTrigger,
  renderActionableBridge,
  appendNoticeToToolMessage,
} from "../../src/plugins/shared/actionable-bridge-logic.js";

describe("actionable-bridge-logic (Tier 1 Pure Unit)", () => {
  it("evaluates density/energy triggers, enforces 5-action cooldown, and resets cleanly across turns", () => {
    let energy = initTurnEnergy("standard");
    let throttle = createBridgeThrottleState();

    // Actions 1..11 -> below threshold
    for (let i = 0; i < 11; i++) {
      energy = applyEnergyAction(energy, { toolName: "read", durationMs: 100 });
      const res = evaluateBridgeTrigger(energy, throttle);
      expect(res.shouldEmit).toBe(false);
      expect(res.reason).toBe("below_threshold");
      throttle = res.nextThrottle;
    }

    // Action 12 -> triggers high_density
    energy = applyEnergyAction(energy, { toolName: "read", durationMs: 100 });
    const first = evaluateBridgeTrigger(energy, throttle);
    expect(first.shouldEmit).toBe(true);
    expect(first.reason).toBe("high_density");
    throttle = first.nextThrottle;

    // Actions 13..16 -> throttled
    for (let i = 0; i < 4; i++) {
      energy = applyEnergyAction(energy, { toolName: "read", durationMs: 100 });
      const suppressed = evaluateBridgeTrigger(energy, throttle);
      expect(suppressed.shouldEmit).toBe(false);
      expect(suppressed.reason).toBe("throttled");
      throttle = suppressed.nextThrottle;
    }

    // Action 17 (5 actions later) -> emits again
    energy = applyEnergyAction(energy, { toolName: "read", durationMs: 100 });
    const second = evaluateBridgeTrigger(energy, throttle);
    expect(second.shouldEmit).toBe(true);

    // Fresh turn throttle state resets cleanly (no cross-turn leakage)
    let turn2Energy = initTurnEnergy("constrained");
    const turn2Throttle = createBridgeThrottleState();
    for (let i = 0; i < 12; i++) {
      turn2Energy = applyEnergyAction(turn2Energy, { toolName: "read", durationMs: 100 });
    }
    const turn2Bridge = evaluateBridgeTrigger(turn2Energy, turn2Throttle);
    expect(turn2Bridge.shouldEmit).toBe(true);
  });

  it("renders constructive guidance without nagging and decorates tool messages immutably", () => {
    let energy = initTurnEnergy("standard");
    for (let i = 0; i < 12; i++) {
      energy = applyEnergyAction(energy, { toolName: "read", durationMs: 100 });
    }
    const notice = renderActionableBridge(energy, formatEnergyEnvelopeHeader(energy));
    expect(notice).toContain("sessions_spawn");
    expect(notice).toContain("exec_pipeline");
    expect(notice).not.toContain("🛑");

    const origArrayMsg = { role: "toolResult", content: [{ type: "text", text: "ok" }] };
    const decoratedArray = appendNoticeToToolMessage(origArrayMsg, notice) as {
      content: Array<{ text: string }>;
    };
    expect(origArrayMsg.content).toHaveLength(1);
    expect(decoratedArray.content).toHaveLength(2);
    expect(decoratedArray.content[1].text).toBe(notice);

    const origStringMsg = { role: "toolResult", content: "ok" };
    const decoratedString = appendNoticeToToolMessage(origStringMsg, notice) as {
      content: string;
    };
    expect(origStringMsg.content).toBe("ok");
    expect(decoratedString.content).toBe(`ok${notice}`);
  });
});
