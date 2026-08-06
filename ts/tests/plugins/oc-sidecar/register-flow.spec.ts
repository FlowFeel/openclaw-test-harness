/**
 * Register-flow tests for oc-sidecar/src/index.ts.
 *
 * @dft
 * - A5 (mock-doubles): mock PluginApi captures hooks/tools; mock sidecar-manager
 *   avoids spawning real processes.
 *
 * @context
 * P2 fix: the old code fired a top-level fetch() during register() — a
 * fire-and-forget async with no timeout that raced with gateway_start.
 * These tests verify:
 * 1. register() does NOT call fetch (the race is eliminated)
 * 2. register() captures the gateway_start hook (hot-restart check is deferred)
 * 3. gateway_start fires tryAdoptRunningSidecar (fetch with 200ms timeout)
 * 4. When adoption fails, startSidecar is called (fresh-start path)
 * 5. gateway_stop calls stopSidecar + unregisterSidecar (cleanup)
 * 6. Config is parsed via SidecarPluginConfig (P5: no `as any`)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock sidecar-manager so gateway_start doesn't spawn a real process
vi.mock("../../../src/plugins/oc-sidecar/src/sidecar-manager.js", () => ({
  startSidecar: vi.fn().mockResolvedValue({
    process: { pid: 99999, kill: vi.fn(), killed: false, exitCode: null },
    port: 18900,
    pid: 99999,
  }),
  stopSidecar: vi.fn().mockResolvedValue(undefined),
}));

// Import after mock setup
const sidecarManager = await import("../../../src/plugins/oc-sidecar/src/sidecar-manager.js");
const { default: plugin, tryAdoptRunningSidecar } = await import(
  "../../../src/plugins/oc-sidecar/src/index.js"
);
const { resetSidecarRegistry, getSidecar } = await import(
  "../../../src/plugins/shared/sidecar-registry.js"
);

// ── Mock PluginApi ────────────────────────────────────────────

interface CapturedHook {
  name: string;
  handler: (event: any, ctx?: any) => Promise<unknown> | unknown;
}

function createMockApi() {
  const hooks: CapturedHook[] = [];
  const tools: any[] = [];
  const logs: string[] = [];
  return {
    hooks,
    tools,
    logs,
    api: {
      logger: {
        info: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
        warn: (msg: string) => logs.push(msg),
      },
      on: (name: string, handler: any) => {
        hooks.push({ name, handler });
      },
      registerTool: (tool: any) => {
        tools.push(tool);
      },
    },
  };
}

describe("P2 fix: register() does not fire fetch (no race condition)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    resetSidecarRegistry();
    vi.mocked(sidecarManager.startSidecar).mockClear();
    vi.mocked(sidecarManager.stopSidecar).mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetSidecarRegistry();
  });

  it("register() does NOT call fetch (the race is eliminated)", () => {
    const { api } = createMockApi();
    plugin.register(api as any, {});

    // The old code fired fetch() here. The new code defers to gateway_start.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("register() captures the gateway_start hook (hot-restart check is deferred)", () => {
    const { api, hooks } = createMockApi();
    plugin.register(api as any, {});

    const startHook = hooks.find((h) => h.name === "gateway_start");
    expect(startHook).toBeDefined();
    expect(typeof startHook!.handler).toBe("function");
  });

  it("register() captures the gateway_stop hook", () => {
    const { api, hooks } = createMockApi();
    plugin.register(api as any, {});

    const stopHook = hooks.find((h) => h.name === "gateway_stop");
    expect(stopHook).toBeDefined();
  });

  it("register() registers both tools (sidecar_health, sidecar_exec)", () => {
    const { api, tools } = createMockApi();
    plugin.register(api as any, {});

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("sidecar_health");
    expect(toolNames).toContain("sidecar_exec");
  });
});

describe("P2 fix: gateway_start hot-restart flow", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    resetSidecarRegistry();
    vi.mocked(sidecarManager.startSidecar).mockClear();
    vi.mocked(sidecarManager.stopSidecar).mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetSidecarRegistry();
  });

  it("gateway_start calls fetch (hot-restart probe) when no sidecar is running", async () => {
    const { api, hooks } = createMockApi();
    plugin.register(api as any, {});

    // fetch rejects (no sidecar running) — simulate ECONNREFUSED
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    const startHook = hooks.find((h) => h.name === "gateway_start")!;
    await startHook.handler({});

    // tryAdoptRunningSidecar probed the port
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:18900/health",
      expect.objectContaining({ method: "GET" })
    );
    // Adoption failed → startSidecar was called (fresh-start path)
    expect(sidecarManager.startSidecar).toHaveBeenCalledWith(
      expect.objectContaining({ port: 18900, workerThreads: 3 })
    );
  });

  it("gateway_start adopts a running sidecar (skips startSidecar)", async () => {
    const { api, hooks } = createMockApi();
    plugin.register(api as any, {});

    // fetch succeeds (sidecar is already running) — simulate hot restart
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, status: "live", pool: { active: 0, poolSize: 3, completed: 5, failed: 0 } }),
    } as any);

    const startHook = hooks.find((h) => h.name === "gateway_start")!;
    await startHook.handler({});

    // Adoption succeeded → startSidecar was NOT called
    expect(fetchSpy).toHaveBeenCalled();
    expect(sidecarManager.startSidecar).not.toHaveBeenCalled();
    // But the sidecar was registered in the registry
    expect(getSidecar().isAvailable()).toBe(true);
  });

  it("gateway_start uses config port (P5: no `as any`, config parsed correctly)", async () => {
    const { api, hooks } = createMockApi();
    plugin.register(api as any, { sidecar: { port: 9999, workerThreads: 7 } });

    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    const startHook = hooks.find((h) => h.name === "gateway_start")!;
    await startHook.handler({});

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/health",
      expect.anything()
    );
    expect(sidecarManager.startSidecar).toHaveBeenCalledWith(
      expect.objectContaining({ port: 9999, workerThreads: 7 })
    );
  });
});

describe("P2 fix: gateway_stop cleanup", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    resetSidecarRegistry();
    vi.mocked(sidecarManager.startSidecar).mockClear();
    vi.mocked(sidecarManager.stopSidecar).mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetSidecarRegistry();
  });

  it("gateway_stop calls stopSidecar + unregisterSidecar after a fresh start", async () => {
    const { api, hooks } = createMockApi();
    plugin.register(api as any, {});

    // Start: adoption fails, fresh start
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const startHook = hooks.find((h) => h.name === "gateway_start")!;
    await startHook.handler({});

    expect(getSidecar().isAvailable()).toBe(true);

    // Stop
    const stopHook = hooks.find((h) => h.name === "gateway_stop")!;
    await stopHook.handler({});

    expect(sidecarManager.stopSidecar).toHaveBeenCalled();
    expect(getSidecar().isAvailable()).toBe(false);
  });

  it("gateway_stop does NOT call stopSidecar when sidecar was adopted (we didn't start it)", async () => {
    const { api, hooks } = createMockApi();
    plugin.register(api as any, {});

    // Adopt: sidecar already running
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, status: "live", pool: {} }),
    } as any);
    const startHook = hooks.find((h) => h.name === "gateway_start")!;
    await startHook.handler({});

    // Stop
    const stopHook = hooks.find((h) => h.name === "gateway_stop")!;
    await stopHook.handler({});

    // We adopted it, so we shouldn't kill it
    expect(sidecarManager.stopSidecar).not.toHaveBeenCalled();
    // But we should unregister from the registry
    expect(getSidecar().isAvailable()).toBe(false);
  });
});
