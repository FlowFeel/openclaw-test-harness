/**
 * Register-flow tests for oc-sidecar/src/index.ts.
 *
 * @dft
 * - A5 (protocol-doubles): uses stateful InMemoryPluginApi + InMemorySidecarLifecycle
 *   instead of vi.mock() — zero module monkey-patching.
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

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import plugin, { type SidecarLifecycleProtocol } from "../../../src/plugins/oc-sidecar/src/index.js";
import type { SidecarHandle } from "../../../src/plugins/oc-sidecar/src/sidecar-manager.js";
import { resetSidecarRegistry, getSidecar } from "../../../src/plugins/shared/sidecar-registry.js";
import { InMemoryPluginApi } from "../../doubles/in-memory-plugin-api.js";

/** Stateful in-memory Protocol double for sidecar process lifecycle (A5). */
class InMemorySidecarLifecycle implements SidecarLifecycleProtocol {
  readonly startCalls: Array<{ port?: number; workerThreads?: number; startupTimeoutMs?: number }> = [];
  readonly stopCalls: SidecarHandle[] = [];

  startSidecar: SidecarLifecycleProtocol["startSidecar"] = async (opts) => {
    this.startCalls.push(opts);
    return {
      process: {
        pid: 99999,
        kill: () => true,
        killed: false,
        exitCode: null,
      } as unknown as SidecarHandle["process"],
      port: opts.port ?? 18900,
      pid: 99999,
    };
  };

  stopSidecar: SidecarLifecycleProtocol["stopSidecar"] = async (handle) => {
    this.stopCalls.push(handle);
  };
}

describe("P2 fix: register() does not fire fetch (no race condition)", () => {
  let fetchSpy: MockInstance;
  let lifecycle: InMemorySidecarLifecycle;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    lifecycle = new InMemorySidecarLifecycle();
    resetSidecarRegistry();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetSidecarRegistry();
  });

  it("register() does NOT call fetch (the race is eliminated)", () => {
    const api = new InMemoryPluginApi();
    plugin.register(api, { sidecarLifecycle: lifecycle });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("register() captures the gateway_start hook (hot-restart check is deferred)", () => {
    const api = new InMemoryPluginApi();
    plugin.register(api, { sidecarLifecycle: lifecycle });
    expect(api.registeredHookNames()).toContain("gateway_start");
  });

  it("register() captures the gateway_stop hook", () => {
    const api = new InMemoryPluginApi();
    plugin.register(api, { sidecarLifecycle: lifecycle });
    expect(api.registeredHookNames()).toContain("gateway_stop");
  });

  it("register() registers both tools (sidecar_health, sidecar_exec)", () => {
    const api = new InMemoryPluginApi();
    plugin.register(api, { sidecarLifecycle: lifecycle });
    const toolNames = api.registeredToolNames();
    expect(toolNames).toContain("sidecar_health");
    expect(toolNames).toContain("sidecar_exec");
  });
});

describe("P2 fix: gateway_start hot-restart flow", () => {
  let fetchSpy: MockInstance;
  let lifecycle: InMemorySidecarLifecycle;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    lifecycle = new InMemorySidecarLifecycle();
    resetSidecarRegistry();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetSidecarRegistry();
  });

  it("gateway_start calls fetch (hot-restart probe) when no sidecar is running", async () => {
    const api = new InMemoryPluginApi();
    plugin.register(api, { sidecarLifecycle: lifecycle });

    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    await api.dispatchHook("gateway_start", {});

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:18900/health",
      expect.objectContaining({ method: "GET" })
    );
    expect(lifecycle.startCalls).toHaveLength(1);
    expect(lifecycle.startCalls[0]).toMatchObject({ port: 18900, workerThreads: 3 });
  });

  it("gateway_start adopts a running sidecar (skips startSidecar)", async () => {
    const api = new InMemoryPluginApi();
    plugin.register(api, { sidecarLifecycle: lifecycle });

    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        status: "live",
        pool: { active: 0, poolSize: 3, completed: 5, failed: 0 },
      }),
    } as Response);

    await api.dispatchHook("gateway_start", {});

    expect(fetchSpy).toHaveBeenCalled();
    expect(lifecycle.startCalls).toHaveLength(0);
    expect(getSidecar().isAvailable()).toBe(true);
  });

  it("gateway_start uses config port (P5: no `as any`, config parsed correctly)", async () => {
    const api = new InMemoryPluginApi();
    plugin.register(api, {
      sidecar: { port: 9999, workerThreads: 7 },
      sidecarLifecycle: lifecycle,
    });

    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    await api.dispatchHook("gateway_start", {});

    expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:9999/health", expect.anything());
    expect(lifecycle.startCalls[0]).toMatchObject({ port: 9999, workerThreads: 7 });
  });
});

describe("P2 fix: gateway_stop cleanup", () => {
  let fetchSpy: MockInstance;
  let lifecycle: InMemorySidecarLifecycle;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    lifecycle = new InMemorySidecarLifecycle();
    resetSidecarRegistry();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetSidecarRegistry();
  });

  it("gateway_stop calls stopSidecar + unregisterSidecar after a fresh start", async () => {
    const api = new InMemoryPluginApi();
    plugin.register(api, { sidecarLifecycle: lifecycle });

    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    await api.dispatchHook("gateway_start", {});
    expect(getSidecar().isAvailable()).toBe(true);

    await api.dispatchHook("gateway_stop", {});
    expect(lifecycle.stopCalls).toHaveLength(1);
    expect(getSidecar().isAvailable()).toBe(false);
  });

  it("gateway_stop does NOT call stopSidecar when sidecar was adopted (we didn't start it)", async () => {
    const api = new InMemoryPluginApi();
    plugin.register(api, { sidecarLifecycle: lifecycle });

    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, status: "live", pool: {} }),
    } as Response);
    await api.dispatchHook("gateway_start", {});

    await api.dispatchHook("gateway_stop", {});
    expect(lifecycle.stopCalls).toHaveLength(0);
    expect(getSidecar().isAvailable()).toBe(false);
  });
});
