/**
 * Integration tests for OcLaneForecaster plugin.
 *
 * @dft
 * - Uses in-memory Protocol doubles (Axiom 5: no vi.fn() mocks).
 * - Deterministic time injection.
 */

import { describe, it, expect } from "vitest";
import { createLaneForecasterPlugin } from "../src/index.js";
import { InMemorySessionHistoryStore } from "../src/forecaster-io.js";
import type {
  PluginApi,
  ToolDefinition,
  HookEvent,
  HookContext,
} from "../../shared/types.js";

function createMockPluginApi() {
  const tools = new Map<string, ToolDefinition>();
  const hooks = new Map<string, (event: HookEvent, ctx?: HookContext) => Promise<unknown> | unknown>();
  const logs: string[] = [];

  const api: PluginApi = {
    logger: {
      info: (msg) => logs.push(`INFO: ${msg}`),
      error: (msg) => logs.push(`ERROR: ${msg}`),
      warn: (msg) => logs.push(`WARN: ${msg}`),
    },
    on: (name, handler) => {
      hooks.set(name, handler);
    },
    registerHook: (events, handler) => {
      const names = Array.isArray(events) ? events : [events];
      for (const n of names) hooks.set(n, handler);
    },
    registerTool: (tool) => {
      tools.set(tool.name, tool);
    },
  };

  return { api, tools, hooks, logs };
}

describe("oc-lane-forecaster integration", () => {
  it("registers tool 'lane_forecast' and lifecycle hooks", () => {
    const plugin = createLaneForecasterPlugin();
    const { api, tools, hooks } = createMockPluginApi();
    plugin.register(api);

    expect(tools.has("lane_forecast")).toBe(true);
    expect(hooks.has("before_dispatch")).toBe(true);
    expect(hooks.has("before_agent_run")).toBe(true);
    expect(hooks.has("agent_end")).toBe(true);
  });

  it("executes tool 'lane_forecast' returning prediction and recommendation", async () => {
    const historyStore = new InMemorySessionHistoryStore();
    const plugin = createLaneForecasterPlugin({
      historyReader: historyStore.read,
      historyWriter: historyStore.write,
      now: () => 1000,
    });

    const { api, tools } = createMockPluginApi();
    plugin.register(api);

    const tool = tools.get("lane_forecast")!;
    const res = await tool.execute("call-1", {
      prompt: "diagnose bug in payment lane, fix logic, run npm test and ship PR",
    });

    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.prediction.exceedsCap).toBe(true);
    expect(body.prediction.shape).toBe("work-loop");
    expect(body.prediction.recommendation).toBe("suggest_segmented_dispatch");
    expect(body.prediction.suggestedSegments.length).toBeGreaterThanOrEqual(3);
  });

  it("emits lane event telemetry during before_dispatch", async () => {
    const historyStore = new InMemorySessionHistoryStore();
    const plugin = createLaneForecasterPlugin({
      historyReader: historyStore.read,
      historyWriter: historyStore.write,
      now: () => 5000,
    });

    const { api, hooks, logs } = createMockPluginApi();
    plugin.register(api);

    const dispatchHook = hooks.get("before_dispatch")!;
    await dispatchHook({
      laneId: "lane-worker-3",
      topicId: 73239,
      sessionKey: "session-73239",
      prompt: "diagnose, fix, test, ship work-loop",
    });

    const telemetryLog = logs.find((l) => l.includes("lane forecast: lane=lane-worker-3 topic:73239"));
    expect(telemetryLog).toBeDefined();
    expect(telemetryLog).toContain("exceedsCap=true");
    expect(telemetryLog).toContain("shape=work-loop");

    const warnLog = logs.find((l) => l.includes("High duration predicted"));
    expect(warnLog).toBeDefined();
  });

  it("records run durations across before_agent_run and agent_end for session history", async () => {
    const historyStore = new InMemorySessionHistoryStore();
    let simTime = 1000;
    const plugin = createLaneForecasterPlugin({
      historyReader: historyStore.read,
      historyWriter: historyStore.write,
      now: () => simTime,
    });

    const { api, hooks } = createMockPluginApi();
    plugin.register(api);

    const beforeRun = hooks.get("before_agent_run")!;
    const endRun = hooks.get("agent_end")!;

    // Start run-1 at simTime = 1000
    await beforeRun({
      runId: "run-1",
      sessionKey: "session-topic-56300",
      prompt: "first run",
    });

    // End run-1 after 605 seconds (605000 ms)
    simTime += 605000;
    await endRun({
      runId: "run-1",
      sessionKey: "session-topic-56300",
      timedOut: true,
    });

    // Check store recorded history
    const history = historyStore.read("session-topic-56300");
    expect(history).not.toBeNull();
    expect(history?.recentDurationsMs).toEqual([605000]);
    expect(history?.timeoutsEncountered).toBe(1);

    // Subsequent dispatch should reflect historical timeout
    const dispatchHook = hooks.get("before_dispatch")!;
    const dispatchResult = (await dispatchHook({
      sessionKey: "session-topic-56300",
      prompt: "continue next turn",
    })) as { forecast: { exceedsCap: boolean; matchedSignatures: string[] } };

    expect(dispatchResult.forecast.exceedsCap).toBe(true);
    expect(dispatchResult.forecast.matchedSignatures).toContain("history-timeout-recurrence");
  });
});
