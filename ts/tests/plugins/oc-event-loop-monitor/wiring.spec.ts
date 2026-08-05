/**
 * oc-event-loop-monitor wiring specs — fires hooks + calls tools.
 *
 * @dft
 * - Uses a mock PluginApi that captures hooks + tools.
 * - Tests hook handlers collect telemetry + tool reports health.
 * - TelemetryCollector uses real perf_hooks — no mocking needed.
 */
import { describe, it, expect } from "vitest";
import plugin from "../../../src/plugins/oc-event-loop-monitor/src/index.js";

interface CapturedHook {
  event: string;
  handler: (event: Record<string, unknown>) => Promise<unknown>;
}

interface CapturedTool {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
}

function createMockApi() {
  const hooks: CapturedHook[] = [];
  const tools: CapturedTool[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const api = {
    on: (event: string, handler: (event: Record<string, unknown>) => Promise<unknown>) => {
      hooks.push({ event, handler });
    },
    registerHook: () => {},
    registerTool: (tool: CapturedTool) => tools.push(tool),
    logger: {
      info: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
      warn: () => {},
    },
  };
  return { api, hooks, tools, logs, errors };
}

function getHook(hooks: CapturedHook[], event: string): CapturedHook {
  const h = hooks.find((h) => h.event === event);
  if (!h) throw new Error(`Hook ${event} not registered`);
  return h;
}

function getTool(tools: CapturedTool[], name: string): CapturedTool {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool ${name} not registered`);
  return t;
}

describe("oc-event-loop-monitor wiring", () => {
  it("registers 3 hooks and 1 tool", () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    expect(hooks.map((h) => h.event)).toEqual([
      "model_call_started",
      "model_call_ended",
      "gateway_stop",
    ]);
    expect(tools.map((t) => t.name)).toEqual(["event_loop_health"]);
  });

  it("model_call_started hook collects telemetry without error", async () => {
    const { api, hooks, errors } = createMockApi();
    plugin.register(api as never, {});
    await expect(getHook(hooks, "model_call_started").handler({})).resolves.not.toThrow();
    expect(errors).toHaveLength(0);
  });

  it("model_call_ended hook collects telemetry without error", async () => {
    const { api, hooks, errors } = createMockApi();
    plugin.register(api as never, {});
    await expect(getHook(hooks, "model_call_ended").handler({})).resolves.not.toThrow();
    expect(errors).toHaveLength(0);
  });

  it("gateway_stop hook stops the collector without error", async () => {
    const { api, hooks, errors } = createMockApi();
    plugin.register(api as never, {});
    await expect(getHook(hooks, "gateway_stop").handler({})).resolves.not.toThrow();
    expect(errors).toHaveLength(0);
  });

  it("event_loop_health tool returns health status and metrics", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    // Collect some telemetry first
    await getHook(hooks, "model_call_started").handler({});
    await getHook(hooks, "model_call_ended").handler({});

    const result = await getTool(tools, "event_loop_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed).toHaveProperty("status");
    expect(parsed).toHaveProperty("eventLoopP99Ms");
    expect(parsed).toHaveProperty("eventLoopUtilization");
    expect(parsed).toHaveProperty("usedHeapMB");
    expect(parsed).toHaveProperty("cpuRatio");
    expect(parsed).toHaveProperty("uptime");
  });

  it("event_loop_health tool returns valid status value", async () => {
    const { api, tools } = createMockApi();
    plugin.register(api as never, {});
    const result = await getTool(tools, "event_loop_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(["healthy", "degraded", "critical"]).toContain(parsed.status);
  });

  it("multiple model_call hooks collect multiple readings", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    // Fire several hooks
    for (let i = 0; i < 5; i++) {
      await getHook(hooks, "model_call_started").handler({});
      await getHook(hooks, "model_call_ended").handler({});
    }
    // Tool should still work
    const result = await getTool(tools, "event_loop_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("gateway_stop can be called multiple times without error", async () => {
    const { api, hooks, errors } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "gateway_stop").handler({});
    await getHook(hooks, "gateway_stop").handler({});
    expect(errors).toHaveLength(0);
  });
});
