/**
 * oc-model-router wiring specs — fires hooks + calls tools.
 *
 * @dft
 * - Uses a mock PluginApi that captures hooks + tools.
 * - Tests hook handlers update per-model stats + tool reports health.
 */
import { describe, it, expect } from "vitest";
import plugin from "../../../src/plugins/oc-model-router/src/index.js";

interface CapturedHook {
  event: string;
  handler: (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown>;
}

interface CapturedTool {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
}

function createMockApi() {
  const hooks: CapturedHook[] = [];
  const tools: CapturedTool[] = [];
  const api = {
    on: (event: string, handler: (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown>) => {
      hooks.push({ event, handler });
    },
    registerHook: () => {},
    registerTool: (tool: CapturedTool) => tools.push(tool),
    logger: {
      info: () => {},
      error: () => {},
      warn: () => {},
    },
  };
  return { api, hooks, tools };
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

describe("oc-model-router wiring", () => {
  it("registers 2 hooks (model_call_started, model_call_ended) and 1 tool", () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    expect(hooks.map((h) => h.event)).toEqual(["model_call_started", "model_call_ended"]);
    expect(tools.map((t) => t.name)).toEqual(["model_health"]);
  });

  it("model_call_started increments total calls", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "model_call_started").handler({ modelId: "gpt-4" });
    await getHook(hooks, "model_call_started").handler({ modelId: "gpt-4" });

    const result = await getTool(tools, "model_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0].model).toBe("gpt-4");
    expect(parsed.models[0].totalCalls).toBe(2);
  });

  it("model_call_started ignores events without modelId", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "model_call_started").handler({});

    const result = await getTool(tools, "model_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.models).toHaveLength(0);
  });

  it("model_call_ended records latency and errors", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "model_call_started").handler({ modelId: "gpt-4" });
    await getHook(hooks, "model_call_ended").handler({ modelId: "gpt-4", latencyMs: 500, error: false });

    const result = await getTool(tools, "model_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.models[0].totalCalls).toBe(1);
    expect(parsed.models[0].p99Ms).toBe(500);
    expect(parsed.models[0].errorRate).toBe(0);
  });

  it("model_call_ended records errors", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "model_call_started").handler({ modelId: "gpt-4" });
    await getHook(hooks, "model_call_started").handler({ modelId: "gpt-4" });
    await getHook(hooks, "model_call_ended").handler({ modelId: "gpt-4", latencyMs: 100, error: true });

    const result = await getTool(tools, "model_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.models[0].errorRate).toBe(0.5); // 1 error / 2 calls
  });

  it("model_call_ended ignores events without modelId", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "model_call_ended").handler({ latencyMs: 100 });

    const result = await getTool(tools, "model_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.models).toHaveLength(0);
  });

  it("model_call_ended ignores zero latency", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "model_call_started").handler({ modelId: "gpt-4" });
    await getHook(hooks, "model_call_ended").handler({ modelId: "gpt-4", latencyMs: 0 });

    const result = await getTool(tools, "model_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    // latency not recorded (0 is falsy)
    expect(parsed.models[0].p99Ms).toBe(0);
  });

  it("model_health tool reports multiple models", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "model_call_started").handler({ modelId: "gpt-4" });
    await getHook(hooks, "model_call_started").handler({ modelId: "claude" });
    await getHook(hooks, "model_call_ended").handler({ modelId: "gpt-4", latencyMs: 200 });
    await getHook(hooks, "model_call_ended").handler({ modelId: "claude", latencyMs: 100 });

    const result = await getTool(tools, "model_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.models).toHaveLength(2);
    expect(parsed.fastestModel).toBe("claude"); // lower avg latency
  });

  it("model_health tool reports thresholds", async () => {
    const { api, tools } = createMockApi();
    plugin.register(api as never, { p99ThresholdMs: 10000, errorRateThreshold: 0.05, minSamples: 3 });
    const result = await getTool(tools, "model_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.thresholds.p99ThresholdMs).toBe(10000);
    expect(parsed.thresholds.errorRateThreshold).toBe(0.05);
    expect(parsed.thresholds.minSamples).toBe(3);
  });

  it("model_health tool uses default thresholds", async () => {
    const { api, tools } = createMockApi();
    plugin.register(api as never, {});
    const result = await getTool(tools, "model_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.thresholds.p99ThresholdMs).toBe(15000);
    expect(parsed.thresholds.errorRateThreshold).toBe(0.1);
    expect(parsed.thresholds.minSamples).toBe(5);
  });

  it("model_health tool returns empty models for no data", async () => {
    const { api, tools } = createMockApi();
    plugin.register(api as never, {});
    const result = await getTool(tools, "model_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.models).toHaveLength(0);
    expect(parsed.fastestModel).toBeNull();
  });

  it("hook errors are caught (never throw)", async () => {
    const { api, hooks } = createMockApi();
    plugin.register(api as never, {});
    // Pass malformed event — should not throw
    await expect(getHook(hooks, "model_call_started").handler({ modelId: 123 } as never)).resolves.not.toThrow();
  });

  it("handles upstream OpenClaw event formats (model, provider, durationMs, outcome)", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});

    // Upstream OpenClaw emits event.model (not modelId) and event.provider, with context
    await getHook(hooks, "model_call_started").handler(
      { model: "glm-5.2", provider: "openrouter" },
      { modelId: "glm-5.2", modelProviderId: "openrouter" },
    );
    await getHook(hooks, "model_call_ended").handler(
      { model: "glm-5.2", provider: "openrouter", durationMs: 1200, outcome: "completed" },
      { modelId: "glm-5.2", modelProviderId: "openrouter" },
    );

    const result = await getTool(tools, "model_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0]).toMatchObject({
      model: "glm-5.2",
      provider: "openrouter",
      totalCalls: 1,
      p99Ms: 1200,
      errorRate: 0,
      timeouts: 0,
      status: "healthy",
    });
  });

  it("detects timeout storm and switches fastestModel to healthy fallback", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, { p99ThresholdMs: 15000, errorRateThreshold: 0.1, minSamples: 5 });

    // Simulate primary model (glm-5.2) hitting 900s timeouts during a storm
    for (let i = 0; i < 6; i++) {
      await getHook(hooks, "model_call_started").handler({ model: "glm-5.2", provider: "openrouter" });
      await getHook(hooks, "model_call_ended").handler({
        model: "glm-5.2",
        provider: "openrouter",
        durationMs: 900_000,
        outcome: "error",
        failureKind: "timeout",
      });
    }

    // Simulate fallback model (deepseek-v4-flash) responding swiftly
    for (let i = 0; i < 6; i++) {
      await getHook(hooks, "model_call_started").handler({ model: "deepseek-v4-flash", provider: "openrouter" });
      await getHook(hooks, "model_call_ended").handler({
        model: "deepseek-v4-flash",
        provider: "openrouter",
        durationMs: 850,
        outcome: "completed",
      });
    }

    const result = await getTool(tools, "model_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);

    const glm = parsed.models.find((m: { model: string }) => m.model === "glm-5.2");
    const deepseek = parsed.models.find((m: { model: string }) => m.model === "deepseek-v4-flash");

    expect(glm).toBeDefined();
    expect(glm.status).toBe("critical");
    expect(glm.timeouts).toBe(6);
    expect(glm.errorRate).toBe(1.0);
    expect(glm.p99Ms).toBe(900_000);

    expect(deepseek).toBeDefined();
    expect(deepseek.status).toBe("healthy");
    expect(deepseek.timeouts).toBe(0);
    expect(deepseek.errorRate).toBe(0);
    expect(deepseek.p99Ms).toBe(850);

    // Automatic routing chooses the healthy fallback model
    expect(parsed.fastestModel).toBe("deepseek-v4-flash");
  });

  it("bounds memory and recovers P99 when fast samples roll off old timeouts", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, { maxSamples: 5, minSamples: 5 });

    // 5 slow calls (10,000ms)
    for (let i = 0; i < 5; i++) {
      await getHook(hooks, "model_call_started").handler({ modelId: "gpt-4" });
      await getHook(hooks, "model_call_ended").handler({ modelId: "gpt-4", durationMs: 10000 });
    }

    let result = await getTool(tools, "model_health").execute("id", {});
    let parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.models[0].p99Ms).toBe(10000);

    // 5 new fast calls (150ms) push out the slow calls due to rolling window (maxSamples=5)
    for (let i = 0; i < 5; i++) {
      await getHook(hooks, "model_call_started").handler({ modelId: "gpt-4" });
      await getHook(hooks, "model_call_ended").handler({ modelId: "gpt-4", durationMs: 150 });
    }

    result = await getTool(tools, "model_health").execute("id", {});
    parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.models[0].p99Ms).toBe(150);
  });

  it("records totalCalls when model_call_ended arrives without model_call_started", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});

    await getHook(hooks, "model_call_ended").handler({
      model: "orphaned-call",
      durationMs: 300,
      outcome: "error",
    });

    const result = await getTool(tools, "model_health").execute("id", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.models[0].totalCalls).toBe(1);
    expect(parsed.models[0].errorRate).toBe(1);
  });
});
