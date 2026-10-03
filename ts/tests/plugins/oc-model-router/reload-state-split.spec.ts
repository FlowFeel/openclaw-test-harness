/**
 * oc-model-router — reload state-split repro + fixed-contract specs.
 *
 * @behavior
 * Production evidence (2026-10-02, gateway pid 463829): hooks fired for 119
 * model calls while `model_health` read empty — `loading oc-model-router`
 * appeared 5× in one process (config-sync hot reloads). Each `register()`
 * call re-allocated its local `modelStats` Map, so when hook dispatch binds
 * to a newer instance than the tool surface, writes and reads diverge across
 * an abandoned Map.
 *
 * Fixed contract:
 * 1. All plugin instances converge on ONE shared live state (globalThis
 *    anchor) — whichever instance serves the tool sees live traffic.
 * 2. `reloadCount` exposed for observability.
 * 3. Call correlation via `callId`: started marks the call, ended counts it
 *    once. Ended-only conventions (no started) still count. Both firing
 *    never double-counts.
 *
 * @dft
 * - Two/three mock api objects simulate reload cycles; no timers, no I/O.
 * - The globalThis anchor is process-global — reset between tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { PluginApi, HookEvent, HookContext } from "../../../src/plugins/shared/types.js";
import entry, { extractModelIdentifier } from "../../../src/plugins/oc-model-router/src/index.js";

interface MockApi {
  registeredTools: Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>;
  hooks: Array<{ event: string; handler: (event: HookEvent, ctx?: HookContext) => Promise<void> }>;
  on: (event: string, handler: (event: HookEvent, ctx?: HookContext) => Promise<void>) => void;
  registerTool: (tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) => void;
}

function makeApi(): MockApi {
  const api: MockApi = {
    registeredTools: new Map(),
    hooks: [],
    on(event, handler) {
      api.hooks.push({ event, handler });
    },
    registerTool(tool) {
      api.registeredTools.set(tool.name, tool);
    },
  };
  return api;
}

function register(api: MockApi): void {
  (entry.register as (api: PluginApi, config?: Record<string, unknown>) => void)(
    api as unknown as PluginApi
  );
}

function fireEvent(api: MockApi, event: string, payload: Partial<HookEvent>, ctx?: HookContext): Promise<void> {
  return Promise.all(
    api.hooks
      .filter((h) => h.event === event)
      .map((h) => h.handler(payload as HookEvent, ctx))
  ).then(() => undefined);
}

async function readToolHealth(api: MockApi): Promise<{
  models: Array<{ model: string; totalCalls: number }>;
  reloadCount?: number;
  fastestModel: string | null;
}> {
  const tool = api.registeredTools.get("model_health");
  if (!tool) throw new Error("model_health not registered");
  const res = (await tool.execute("test-id", {})) as {
    content: Array<{ type: string; text: string }>;
  };
  return JSON.parse(res.content[0].text);
}

const RESET_KEY = "__oc_model_router_state__";
const MODEL = "openrouter/z-ai/glm-5.3-flash";

describe("model-router reload state-split (119-calls-but-empty-model_health)", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[RESET_KEY];
  });

  it("all register() instances converge on one live state — tool on instance #1 sees hooks from instance #2", async () => {
    const api1 = makeApi(); // boot
    register(api1);
    const api2 = makeApi(); // config-sync reload #1
    register(api2);

    // Live traffic flows through instance #2 (the newest hook binding).
    for (let i = 0; i < 6; i++) {
      await fireEvent(api2, "model_call_ended", {
        model: MODEL,
        provider: "openrouter",
        callId: `call-${i}`,
        durationMs: 1000 + i,
        outcome: "completed",
      });
    }

    // Whichever instance serves the tool, it MUST see live traffic.
    const report1 = await readToolHealth(api1);
    expect(report1.models).toHaveLength(1);
    expect(report1.models[0].model).toBe(MODEL);
    expect(report1.models[0].totalCalls).toBeGreaterThanOrEqual(6);
  });

  it("counts reload cycles in the health report for observability", async () => {
    const api1 = makeApi();
    register(api1);
    const api2 = makeApi();
    register(api2);
    const api3 = makeApi();
    register(api3);
    const report = await readToolHealth(api1);
    expect(report.reloadCount).toBe(3);
  });

  it("state is anchored on globalThis so module re-evaluation converges", () => {
    const api1 = makeApi();
    register(api1);
    expect((globalThis as Record<string, unknown>)[RESET_KEY]).toBeDefined();
  });

  it("callId correlation: started + ended for the same call counts once, not twice", async () => {
    const api = makeApi();
    register(api);
    for (let i = 0; i < 3; i++) {
      await fireEvent(api, "model_call_started", {
        model: MODEL,
        provider: "openrouter",
        callId: `call-${i}`,
      });
      await fireEvent(api, "model_call_ended", {
        model: MODEL,
        provider: "openrouter",
        callId: `call-${i}`,
        durationMs: 1200,
        outcome: "completed",
      });
    }
    const report = await readToolHealth(api);
    expect(report.models).toHaveLength(1);
    expect(report.models[0].totalCalls).toBe(3); // not 6
  });

  it("ended-only convention (no started) still counts each call", async () => {
    const api = makeApi();
    register(api);
    for (let i = 0; i < 6; i++) {
      await fireEvent(api, "model_call_ended", {
        model: MODEL,
        provider: "openrouter",
        callId: `call-${i}`,
        durationMs: 1000 + i,
        outcome: "completed",
      });
    }
    const report = await readToolHealth(api);
    expect(report.models[0].totalCalls).toBe(6);
  });

  it("duplicate ended for the same callId does not double-count", async () => {
    const api = makeApi();
    register(api);
    for (let i = 0; i < 3; i++) {
      await fireEvent(api, "model_call_started", {
        model: MODEL,
        provider: "openrouter",
        callId: `call-${i}`,
      });
    }
    for (let i = 0; i < 3; i++) {
      await fireEvent(api, "model_call_ended", {
        model: MODEL,
        provider: "openrouter",
        callId: `call-${i}`,
        durationMs: 900,
        outcome: "completed",
      });
      // Retried/duplicate ended (e.g. failover re-dispatch):
      await fireEvent(api, "model_call_ended", {
        model: MODEL,
        provider: "openrouter",
        callId: `call-${i}`,
        durationMs: 900,
        outcome: "completed",
      });
    }
    const report = await readToolHealth(api);
    expect(report.models[0].totalCalls).toBe(3);
  });

  it("started-only convention still counts (latencies empty, totals live)", async () => {
    const api = makeApi();
    register(api);
    for (let i = 0; i < 5; i++) {
      await fireEvent(api, "model_call_started", {
        model: MODEL,
        provider: "openrouter",
        callId: `call-${i}`,
      });
    }
    const report = await readToolHealth(api);
    expect(report.models).toHaveLength(1);
    expect(report.models[0].totalCalls).toBe(5);
  });

  it("extractModelIdentifier still works (sanity — pure functions untouched)", () => {
    expect(extractModelIdentifier({ model: "m" } as HookEvent)).toBe("m");
  });
});
