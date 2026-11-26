/**
 * Tier 3 BDD Spec: Incentive-Based Energy Budgeting & OWA Cognitive Economics
 *
 * @dft Verified against efficiency-energy-logic, oc-lane-supervisor, and oc-session-guard.
 * @see team/care-packages/care-package-plugins-team-topic-83272-incentive-energy-budgeting.md
 * @see team/specs/incentive-energy-budgeting-architecture.md
 */

import { describe, it, expect } from "vitest";
import {
  initTurnEnergy,
  applyEnergyAction,
  DEFAULT_ENERGY_CONFIG,
} from "../../src/plugins/shared/efficiency-energy-logic.js";
import pluginDef from "../../src/plugins/v2/oc-lane-supervisor/src/index.js";
import sessionGuardPlugin from "../../src/plugins/oc-session-guard/src/index.js";
import { InMemoryPluginApi } from "../doubles/in-memory-plugin-api.js";

describe("Feature: Incentive-Based Energy Budgeting & OWA Cognitive Economics", () => {
  it("Scenario: Zero turn energy does not block tool execution (Strict OWA Non-Gating)", async () => {
    const api = new InMemoryPluginApi();
    pluginDef.register(api, { initialSessionTier: "constrained" });

    const ctx = { sessionId: "s-zero-energy" };
    await api.dispatchHook("before_agent_run", { prompt: "Deep research" }, ctx);

    // Drain energy to 0 by recording heavy/multiple actions
    for (let i = 0; i < 7; i++) {
      await api.dispatchHook(
        "tool_result_persist",
        {
          toolName: "process",
          message: { role: "toolResult", toolName: "process", content: [{ type: "text", text: "(no new output)" }] },
        },
        ctx,
      );
    }

    // Check before_tool_call: MUST NOT block under pure OWA
    const [gate] = await api.dispatchHook("before_tool_call", { toolName: "exec", params: { command: "ls" } }, ctx);
    expect((gate as { block?: boolean } | undefined)?.block).not.toBe(true);

    // Also verify session guard
    const guardApi = new InMemoryPluginApi();
    sessionGuardPlugin.register(guardApi, { initialSessionTier: "constrained", enableEnergyBudget: true });
    await guardApi.dispatchHook("before_agent_run", { prompt: "Debug bug" }, ctx);
    for (let i = 0; i < 7; i++) {
      await guardApi.dispatchHook(
        "tool_result_persist",
        {
          toolName: "process",
          message: { role: "toolResult", toolName: "process", content: [{ type: "text", text: "(no new output)" }] },
        },
        ctx,
      );
    }
    const [guardGate] = await guardApi.dispatchHook("before_tool_call", { toolName: "exec", params: { command: "ls" } }, ctx);
    expect((guardGate as { block?: boolean } | undefined)?.block).not.toBe(true);
  });

  it("Scenario: Delegation grants immediate energy rebate and clears low-energy advisory", () => {
    let state = initTurnEnergy("constrained"); // 600E
    // Burn down into advisory zone (remaining <= 200)
    state = applyEnergyAction(state, {
      toolName: "exec",
      durationMs: 150000, // 150s -> burns ~495E, leaving ~105E
    });
    expect(state.remainingEnergy).toBeLessThanOrEqual(200);
    expect(state.advisoryEmitted).toBe(true);

    const beforeDelegationEnergy = state.remainingEnergy;

    // Delegate via sessions_spawn
    state = applyEnergyAction(state, {
      toolName: "sessions_spawn",
      durationMs: 500,
      isDelegation: true,
    });

    // Assert rebate added +250E
    expect(state.remainingEnergy).toBe(beforeDelegationEnergy + 250);
    // Advisory reset so agent can deliver visible reply cleanly
    expect(state.advisoryEmitted).toBe(false);
    expect(state.habitPoints).toBeGreaterThanOrEqual(150);
    expect(state.delegationCount).toBe(1);
  });

  it("Scenario: Pipeline execution drains flat baseline energy and awards habit bonus", () => {
    const state = initTurnEnergy("standard"); // 1000E

    const next = applyEnergyAction(state, {
      toolName: "exec_pipeline",
      durationMs: 1000, // 1s
    });

    // Flat drain: 1s * 1.0 (idle) + 15 (flat tool) = 16E drain -> 984E
    expect(next.remainingEnergy).toBe(984);
    // Pipeline batch bonus: +50 points
    expect(next.habitPoints).toBeGreaterThanOrEqual(50);

    // And verify serial friction penalty beyond 8 unbatched exec calls
    let serialState = initTurnEnergy("standard");
    for (let i = 0; i < 8; i++) {
      serialState = applyEnergyAction(serialState, {
        toolName: "exec",
        durationMs: 1000,
      });
    }
    const energyAt8 = serialState.remainingEnergy;
    serialState = applyEnergyAction(serialState, {
      toolName: "exec",
      durationMs: 1000,
    });
    expect(energyAt8 - serialState.remainingEnergy).toBe(21);
  });

  it("Scenario: High action density injects throttled actionable bridge without nagging", async () => {
    const api = new InMemoryPluginApi();
    sessionGuardPlugin.register(api, { initialSessionTier: "standard", enableEnergyBudget: true });

    const ctx = { sessionId: "s-bridge-test" };
    await api.dispatchHook("before_agent_run", { prompt: "Refactor" }, ctx);

    // Perform 14 consecutive tool results
    for (let i = 1; i <= 14; i++) {
      const [res] = await api.dispatchHook(
        "tool_result_persist",
        {
          toolName: "exec",
          message: { role: "toolResult", toolName: "exec", content: [{ type: "text", text: `output ${i}` }] },
        },
        ctx,
      );
      const msg = (res as { message?: { content?: Array<{ type: string; text: string }> } })?.message;
      const textParts = msg?.content?.map((c) => c.text).join("\n") ?? "";

      // Never emit negative nagging
      expect(textParts).not.toContain("Turn energy budget exhausted");
      expect(textParts).not.toContain("Synthesize visible answer immediately");

      if (i === 12) {
        // Action 12 triggers actionable bridge
        expect(textParts).toContain("Turn density high");
        expect(textParts).toContain("sessions_spawn");
      } else if (i === 13) {
        // Action 13 is throttled (less than 5 actions since action 12)
        expect(textParts).not.toContain("Turn density high");
      }
    }
  });

  it("Scenario: Lane supervisor v2 emits throttled actionable bridges and resets throttle across turns", async () => {
    const api = new InMemoryPluginApi();
    pluginDef.register(api, { initialSessionTier: "standard", enableEnergyBudget: true });

    const ctx = { sessionId: "v2-bdd-bridge", channelId: "telegram" };
    await api.dispatchHook("before_agent_run", { prompt: "Turn 1", channelId: "telegram" }, ctx);

    const turn1Emits: number[] = [];
    for (let i = 1; i <= 17; i++) {
      const [res] = await api.dispatchHook(
        "tool_result_persist",
        {
          toolName: "read",
          message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: `t1-${i}` }] },
        },
        ctx,
      );
      const text =
        (res as { message?: { content?: Array<{ text: string }> } })?.message?.content
          ?.map((c) => c.text)
          .join("\n") ?? "";
      if (text.includes("Turn density high")) turn1Emits.push(i);
    }
    expect(turn1Emits).toEqual([12, 17]);

    await api.dispatchHook("before_agent_run", { prompt: "Turn 2", channelId: "telegram" }, ctx);
    const turn2Emits: number[] = [];
    for (let i = 1; i <= 12; i++) {
      const [res] = await api.dispatchHook(
        "tool_result_persist",
        {
          toolName: "read",
          message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: `t2-${i}` }] },
        },
        ctx,
      );
      const text =
        (res as { message?: { content?: Array<{ text: string }> } })?.message?.content
          ?.map((c) => c.text)
          .join("\n") ?? "";
      if (text.includes("Turn density high")) turn2Emits.push(i);
    }
    expect(turn2Emits).toEqual([12]);
  });

  it("Scenario: Durable spawn grants maximal energy rebate and points", () => {
    let state = initTurnEnergy("constrained"); // 600E
    // Burn down into advisory zone (remaining <= 200)
    state = applyEnergyAction(state, {
      toolName: "exec",
      durationMs: 150000,
    });
    expect(state.remainingEnergy).toBeLessThanOrEqual(200);
    expect(state.advisoryEmitted).toBe(true);

    const beforeEnergy = state.remainingEnergy;

    // Delegate via durable_spawn
    state = applyEnergyAction(state, {
      toolName: "durable_spawn",
      durationMs: 500,
      isDelegation: true,
    });

    // Assert rebate added +350E
    expect(state.remainingEnergy).toBe(beforeEnergy + 350);
    expect(state.advisoryEmitted).toBe(false);
    expect(state.habitPoints).toBeGreaterThanOrEqual(200);
    expect(state.delegationCount).toBe(1);
  });

});
