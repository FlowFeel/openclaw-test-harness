/**
 * Tier 2 Integration Spec: oc-lane-supervisor (Stateful Protocol Doubles, Axiom A5).
 *
 * @dft Zero vi.fn() shims — uses InMemoryPluginApi and InMemorySessionsStore.
 */

import { describe, it, expect } from "vitest";
import pluginDef from "../src/index.js";
import { InMemoryPluginApi } from "../../../../../tests/doubles/in-memory-plugin-api.js";
import { InMemorySessionsStore } from "../../../../../tests/doubles/in-memory-io.js";
import type { SessionsMap } from "../../../../../src/plugins/shared/session-cleanup.js";

describe("oc-lane-supervisor (Tier 2 Integration)", () => {
  it("coordinates poll-hygiene -> turn-energy soft landing, subagent semaphore, and session health", async () => {
    const api = new InMemoryPluginApi();
    const sessions = new InMemorySessionsStore({
      "agent:main:s1": { sessionId: "s1", updatedAt: 1000 } as never,
    });
    let now = 10_000;

    pluginDef.register(api, {
      initialSessionTier: "constrained",
      subPoolMax: 1,
      sessionsReader: sessions.read,
      sessionsWriter: (data: SessionsMap) => sessions.write("/mem/sessions.json", data),
      clock: () => now,
    });

    const ctx = { sessionId: "s1" };
    await api.dispatchHook("before_agent_run", { prompt: "Diagnose failing build" }, ctx);

    for (let i = 0; i < 6; i++) {
      now += 200;
      await api.dispatchHook(
        "tool_result_persist",
        {
          toolName: "process",
          message: {
            role: "toolResult",
            toolName: "process",
            content: [{ type: "text", text: "(no new output)" }],
          },
        },
        ctx,
      );
    }

    const [gate] = await api.dispatchHook("before_tool_call", { toolName: "exec", params: {} }, ctx);
    // Strict OWA Non-Gating: tool execution must not be blocked
    expect((gate as { block?: boolean } | undefined)?.block).not.toBe(true);

    // Subagent semaphore saturation warns on 2nd spawn
    await api.dispatchHook("subagent_spawning", { subagentId: "sub-1" });
    await api.dispatchHook("subagent_spawning", { subagentId: "sub-2" });
    expect(api.logs.some((l) => l.level === "warn" && l.message.includes("subagent pool saturated"))).toBe(true);
    await api.dispatchHook("subagent_ended", { subagentId: "sub-1" });

    // Session health returns real metrics + habit card
    const health = JSON.parse((await api.executeTool("session_health", { sessionId: "s1" })).content[0].text);
    expect(health.ok).toBe(true);
    expect(health.entryCount).toBe(1);
    expect(health.reputation).toBeDefined();
  });

  it("emits throttled actionable bridges in v2 oc-lane-supervisor and resets throttle on new turn", async () => {
    const api = new InMemoryPluginApi();
    let now = 50_000;
    pluginDef.register(api, {
      initialSessionTier: "standard",
      sessionsReader: () => ({}),
      sessionsWriter: () => {},
      clock: () => now,
    });

    const ctx = { sessionId: "v2-bridge-s1", channelId: "telegram" };
    await api.dispatchHook("before_agent_run", { prompt: "Turn 1", channelId: "telegram" }, ctx);

    const emittedTurn1: number[] = [];
    for (let i = 1; i <= 17; i++) {
      now += 100;
      const [res] = await api.dispatchHook(
        "tool_result_persist",
        {
          toolName: "read",
          message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: `r${i}` }] },
        },
        ctx,
      );
      const text =
        (res as { message?: { content?: Array<{ text: string }> } })?.message?.content
          ?.map((c) => c.text)
          .join("\n") ?? "";
      if (text.includes("Turn density high")) emittedTurn1.push(i);
    }
    expect(emittedTurn1).toEqual([12, 17]);

    // New turn resets bridge throttle cleanly (emits at action 12 again, no stale cross-turn state)
    await api.dispatchHook("before_agent_run", { prompt: "Turn 2", channelId: "telegram" }, ctx);
    const emittedTurn2: number[] = [];
    for (let i = 1; i <= 12; i++) {
      now += 100;
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
      if (text.includes("Turn density high")) emittedTurn2.push(i);
    }
    expect(emittedTurn2).toEqual([12]);
  });
});
