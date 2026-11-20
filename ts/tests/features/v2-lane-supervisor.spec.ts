/**
 * Tier 3 BDD Spec: v2-lane-supervisor.feature
 *
 * @dft Traceable Gherkin behavioral contract verified via InMemoryPluginApi.
 */

import { describe, it, expect } from "vitest";
import pluginDef from "../../src/plugins/v2/oc-lane-supervisor/src/index.js";
import { InMemoryPluginApi } from "../doubles/in-memory-plugin-api.js";

describe("Feature: Plugins v2 Lane Supervisor — Turn Energy, Poll Hygiene, Admission & Topic Recovery", () => {
  it("Scenario: Zero-delta poll loop exhausts constrained turn energy and triggers soft landing", async () => {
    const api = new InMemoryPluginApi();
    pluginDef.register(api, { initialSessionTier: "constrained" });
    const ctx = { sessionId: "bdd-s1" };

    await api.dispatchHook("before_agent_run", { prompt: "Run diagnostics" }, ctx);
    for (let i = 0; i < 6; i++) {
      await api.dispatchHook(
        "tool_result_persist",
        {
          toolName: "process",
          message: { role: "toolResult", toolName: "process", content: [{ type: "text", text: "(no new output)" }] },
        },
        ctx,
      );
    }

    const [gate] = await api.dispatchHook("before_tool_call", { toolName: "exec", params: {} }, ctx);
    expect((gate as { block?: boolean; blockReason?: string }).block).toBe(true);
    expect((gate as { blockReason?: string }).blockReason).toContain("Turn energy budget exhausted");
  });

  it("Scenario: Idle whitespace prompt is suppressed before model invocation", async () => {
    const api = new InMemoryPluginApi();
    pluginDef.register(api, { suppressIdleHeartbeats: true });
    const [res] = await api.dispatchHook("before_agent_run", { prompt: "   \n  " }, { sessionId: "bdd-idle" });
    expect(res).toEqual({
      outcome: "block",
      reason: expect.stringContaining("Empty or whitespace-only prompt blocked"),
    });

    // Interactive Telegram messages (even with missing/redacted prompt) MUST pass with InputGateDecision
    const [tgPass] = await api.dispatchHook(
      "before_agent_run",
      { channelId: "telegram", senderId: "user-42" },
      { sessionId: "bdd-tg" },
    );
    expect(tgPass).toEqual({ outcome: "pass" });
  });

  it("Scenario: Topic audit and recovery plan detect unregistered topics deterministically", async () => {
    const api = new InMemoryPluginApi();
    pluginDef.register(api, {});

    const audit = JSON.parse(
      (
        await api.executeTool("topic_audit", {
          topics: [{ message_thread_id: 83272, title: "Plugins" }],
          registrations: [{ topicId: 83272, sessionKey: "agent:main:topic:83272" }],
          health: false,
        })
      ).content[0].text,
    );
    expect(audit.orphaned).toHaveLength(0);

    const recover = JSON.parse(
      (
        await api.executeTool("topic_recover", {
          topicId: 99999,
          chatId: "-100123",
          agentId: "main",
          apply: false,
        })
      ).content[0].text,
    );
    expect(recover.sessionKey).toContain("topic:99999");
  });
});

