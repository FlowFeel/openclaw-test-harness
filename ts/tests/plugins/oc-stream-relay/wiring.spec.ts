/**
 * oc-stream-relay wiring specs — fires hooks + calls tools.
 *
 * @dft
 * - Uses a mock PluginApi that captures hooks + tools.
 * - Tests pure logic (shouldRelay, shouldFallback, createRelayState) inline.
 * - Tests hook handlers update state + tools report state.
 */
import { describe, it, expect } from "vitest";
import plugin, {
  shouldRelay,
  shouldFallback,
  createRelayState,
  type RelayState,
  type StreamRelayPluginConfig,
} from "../../../src/plugins/oc-stream-relay/src/index.js";

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
  const warns: string[] = [];
  const api = {
    on: (event: string, handler: (event: Record<string, unknown>) => Promise<unknown>) => {
      hooks.push({ event, handler });
    },
    registerHook: () => {},
    registerTool: (tool: CapturedTool) => tools.push(tool),
    logger: {
      info: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
      warn: (msg: string) => warns.push(msg),
    },
  };
  return { api, hooks, tools, logs, errors, warns };
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

// ── Pure logic ───────────────────────────────────────────────

describe("shouldRelay", () => {
  it("returns false for empty modelId", () => {
    expect(shouldRelay("", true, true)).toBe(false);
  });

  it("returns true when sidecar is available", () => {
    expect(shouldRelay("gpt-4", true, false)).toBe(true);
  });

  it("returns true when sidecar unavailable but fallback enabled", () => {
    expect(shouldRelay("gpt-4", false, true)).toBe(true);
  });

  it("returns false when sidecar unavailable and fallback disabled", () => {
    expect(shouldRelay("gpt-4", false, false)).toBe(false);
  });
});

describe("shouldFallback", () => {
  it("returns false when fallback disabled", () => {
    expect(shouldFallback(false, false, 5, 3)).toBe(false);
  });

  it("returns true when sidecar unavailable and fallback enabled", () => {
    expect(shouldFallback(false, true, 0, 3)).toBe(true);
  });

  it("returns true when consecutive failures exceed maxRetries", () => {
    expect(shouldFallback(true, true, 3, 3)).toBe(true);
    expect(shouldFallback(true, true, 4, 3)).toBe(true);
  });

  it("returns false when sidecar available and failures below max", () => {
    expect(shouldFallback(true, true, 2, 3)).toBe(false);
  });
});

describe("createRelayState", () => {
  it("creates default state", () => {
    const state = createRelayState({});
    expect(state.started).toBe(false);
    expect(state.startedAt).toBeNull();
    expect(state.sidecarPort).toBe(18900);
    expect(state.fallbackMode).toBe(false);
    expect(state.totalRelayed).toBe(0);
    expect(state.totalFailed).toBe(0);
  });

  it("uses configured sidecarPort", () => {
    const state = createRelayState({ relay: { sidecarPort: 9999 } });
    expect(state.sidecarPort).toBe(9999);
  });
});

// ── Wiring ───────────────────────────────────────────────────

describe("oc-stream-relay wiring", () => {
  it("registers 3 hooks and 1 tool", () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    expect(hooks.map((h) => h.event)).toEqual([
      "gateway_start",
      "gateway_stop",
      "model_call_started",
    ]);
    expect(tools.map((t) => t.name)).toEqual(["stream_relay_health"]);
  });

  it("gateway_start sets started=true and logs", async () => {
    const { api, hooks, tools, logs } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "gateway_start").handler({});
    expect(logs.some((l) => l.includes("Relay process started"))).toBe(true);

    const health = await getTool(tools, "stream_relay_health").execute("id", {});
    const parsed = JSON.parse((health as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.started).toBe(true);
    expect(parsed.status).toBe("live");
  });

  it("gateway_stop sets started=false and resets failures", async () => {
    const { api, hooks, tools, logs } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "gateway_start").handler({});
    await getHook(hooks, "gateway_stop").handler({});
    expect(logs.some((l) => l.includes("Relay process stopped"))).toBe(true);

    const health = await getTool(tools, "stream_relay_health").execute("id", {});
    const parsed = JSON.parse((health as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.started).toBe(false);
    expect(parsed.status).toBe("stopped");
  });

  it("model_call_started relays when sidecar started", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "gateway_start").handler({});
    await getHook(hooks, "model_call_started").handler({ modelId: "gpt-4" });

    const health = await getTool(tools, "stream_relay_health").execute("id", {});
    const parsed = JSON.parse((health as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.totalRelayed).toBe(1);
    expect(parsed.totalFailed).toBe(0);
  });

  it("model_call_started does not relay for empty modelId", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "gateway_start").handler({});
    await getHook(hooks, "model_call_started").handler({ modelId: "" });

    const health = await getTool(tools, "stream_relay_health").execute("id", {});
    const parsed = JSON.parse((health as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.totalRelayed).toBe(0);
  });

  it("model_call_started enters fallback when sidecar not started and fallback enabled", async () => {
    const { api, hooks, tools, warns } = createMockApi();
    plugin.register(api as never, { relay: { fallbackEnabled: true } });
    // Don't call gateway_start — sidecar not started
    await getHook(hooks, "model_call_started").handler({ modelId: "gpt-4" });

    const health = await getTool(tools, "stream_relay_health").execute("id", {});
    const parsed = JSON.parse((health as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.fallbackMode).toBe(true);
    expect(parsed.fallbackCount).toBe(1);
    expect(warns.some((w) => w.includes("Fallback mode"))).toBe(true);
  });

  it("model_call_started does nothing when sidecar down and fallback disabled", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, { relay: { fallbackEnabled: false } });
    await getHook(hooks, "model_call_started").handler({ modelId: "gpt-4" });

    const health = await getTool(tools, "stream_relay_health").execute("id", {});
    const parsed = JSON.parse((health as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.totalRelayed).toBe(0);
    expect(parsed.fallbackCount).toBe(0);
  });

  it("stream_relay_health tool returns all state fields", async () => {
    const { api, hooks, tools } = createMockApi();
    plugin.register(api as never, {});
    await getHook(hooks, "gateway_start").handler({});
    const health = await getTool(tools, "stream_relay_health").execute("id", {});
    const parsed = JSON.parse((health as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed).toHaveProperty("started");
    expect(parsed).toHaveProperty("startedAt");
    expect(parsed).toHaveProperty("sidecarPort");
    expect(parsed).toHaveProperty("fallbackMode");
    expect(parsed).toHaveProperty("fallbackCount");
    expect(parsed).toHaveProperty("totalRelayed");
    expect(parsed).toHaveProperty("totalFailed");
    expect(parsed).toHaveProperty("lastLatencyMs");
    expect(parsed).toHaveProperty("avgLatencyMs");
    expect(parsed).toHaveProperty("status");
  });
});
