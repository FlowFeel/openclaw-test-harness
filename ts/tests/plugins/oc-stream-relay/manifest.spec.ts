/**
 * OC Stream Relay manifest + structure + DFT tests.
 *
 * @dft
 * - Pure logic (shouldRelay, shouldFallback, createRelayState) tested
 *   without the OC plugin runtime.
 * - Manifest structure tests verify the plugin contract.
 * - Runtime hook/tool registration tests use a mock PluginApi.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── Manifest structure tests ─────────────────────────────────────────

describe("oc-stream-relay plugin manifest", () => {
  const pluginDir = resolve(process.cwd(), "src/plugins/oc-stream-relay");

  it("manifest exists", () => {
    expect(existsSync(resolve(pluginDir, "openclaw.plugin.json"))).toBe(true);
  });

  it("package.json exists", () => {
    expect(existsSync(resolve(pluginDir, "package.json"))).toBe(true);
  });

  it("entry point exists", () => {
    expect(existsSync(resolve(pluginDir, "src/index.ts"))).toBe(true);
  });

  const manifest = JSON.parse(
    readFileSync(resolve(pluginDir, "openclaw.plugin.json"), "utf8")
  );

  it("has correct id", () => {
    expect(manifest.id).toBe("oc-stream-relay");
  });

  it("declares stream_relay_health tool", () => {
    expect(manifest.contracts.tools).toContain("stream_relay_health");
  });

  it("activates on startup", () => {
    expect(manifest.activation.onStartup).toBe(true);
  });

  it("has valid config schema", () => {
    expect(manifest.configSchema.type).toBe("object");
    expect(manifest.configSchema.properties).toBeDefined();
    expect(manifest.configSchema.properties.relay).toBeDefined();
  });

  it("relay config has sensible defaults", () => {
    const relay = manifest.configSchema.properties.relay.properties;
    expect(relay.sidecarPort.default).toBe(18900);
    expect(relay.fallbackEnabled.default).toBe(true);
    expect(relay.fallbackTimeoutMs.default).toBe(3000);
    expect(relay.maxRetries.default).toBe(2);
    expect(relay.healthCheckIntervalMs.default).toBe(15000);
  });
});

// ── DFT: Pure logic tests ───────────────────────────────────────────

import {
  shouldRelay,
  shouldFallback,
  createRelayState,
  type RelayState,
  type StreamRelayPluginConfig,
} from "../../../src/plugins/oc-stream-relay/src/index.js";

describe("shouldRelay", () => {
  it("returns true when sidecar is available", () => {
    expect(shouldRelay("gpt-4", true, true)).toBe(true);
  });

  it("returns true when sidecar is down but fallback is enabled", () => {
    expect(shouldRelay("gpt-4", false, true)).toBe(true);
  });

  it("returns false when sidecar is down and fallback is disabled", () => {
    expect(shouldRelay("gpt-4", false, false)).toBe(false);
  });

  it("returns false for empty model id", () => {
    expect(shouldRelay("", true, true)).toBe(false);
  });
});

describe("shouldFallback", () => {
  it("returns true when sidecar is unavailable and fallback enabled", () => {
    expect(shouldFallback(false, true, 0, 2)).toBe(true);
  });

  it("returns false when fallback is disabled", () => {
    expect(shouldFallback(false, false, 0, 2)).toBe(false);
  });

  it("returns true when consecutive failures exceed max retries", () => {
    expect(shouldFallback(true, true, 2, 2)).toBe(true);
  });

  it("returns false when sidecar is healthy and under retry limit", () => {
    expect(shouldFallback(true, true, 1, 2)).toBe(false);
  });

  it("returns false when sidecar is healthy, under retry, and fallback disabled", () => {
    expect(shouldFallback(true, false, 1, 2)).toBe(false);
  });
});

describe("createRelayState", () => {
  it("returns initial state with defaults", () => {
    const state: RelayState = createRelayState({});
    expect(state.started).toBe(false);
    expect(state.startedAt).toBeNull();
    expect(state.sidecarPort).toBe(18900);
    expect(state.fallbackMode).toBe(false);
    expect(state.fallbackCount).toBe(0);
    expect(state.totalRelayed).toBe(0);
    expect(state.totalFailed).toBe(0);
    expect(state.lastLatencyMs).toBeNull();
    expect(state.avgLatencyMs).toBeNull();
  });

  it("accepts custom sidecar port", () => {
    const config: StreamRelayPluginConfig = { relay: { sidecarPort: 19000 } };
    const state: RelayState = createRelayState(config);
    expect(state.sidecarPort).toBe(19000);
  });
});

// ── Plugin hook/tool registration tests ─────────────────────────────

describe("oc-stream-relay plugin registration", () => {
  it("registers 3 hooks (gateway_start, gateway_stop, model_call_started)", async () => {
    const hooks: Array<{ event: string; opts: { name: string } }> = [];
    const tools: string[] = [];

    const mockApi = {
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
      on: vi.fn(
        (event: string, _handler: unknown) => {
          hooks.push({ event, opts: { name: "" } });
        }
      ),
      registerHook: vi.fn(
        (event: string | string[], _handler: unknown, opts?: { name: string }) => {
          const events = Array.isArray(event) ? event : [event];
          for (const e of events) {
            hooks.push({ event: e, opts: opts ?? { name: "" } });
          }
        }
      ),
      registerTool: vi.fn((tool: { name: string }) => {
        tools.push(tool.name);
      }),
    };

    // Import and invoke the plugin register function
    const pluginModule = await import(
      "../../../src/plugins/oc-stream-relay/src/index.js"
    );
    const plugin = pluginModule.default;
    plugin.register(mockApi as any, {});

    // Should have 3 hooks
    expect(hooks).toHaveLength(3);

    // Check hook events (api.on uses the hook name directly, no opts.name)
    const hookEvents = hooks.map((h) => h.event);
    expect(hookEvents).toContain("gateway_start");
    expect(hookEvents).toContain("gateway_stop");
    expect(hookEvents).toContain("model_call_started");
  });

  it("registers 1 tool (stream_relay_health)", async () => {
    const tools: string[] = [];

    const mockApi = {
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
      on: vi.fn(),
      registerHook: vi.fn(),
      registerTool: vi.fn((tool: { name: string }) => {
        tools.push(tool.name);
      }),
    };

    const pluginModule = await import(
      "../../../src/plugins/oc-stream-relay/src/index.js"
    );
    const plugin = pluginModule.default;
    plugin.register(mockApi as any, {});

    expect(tools).toHaveLength(1);
    expect(tools).toContain("stream_relay_health");
  });
});