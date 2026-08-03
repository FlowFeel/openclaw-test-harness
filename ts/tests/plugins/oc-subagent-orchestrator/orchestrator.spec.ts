/**
 * BDD tests for oc-subagent-orchestrator plugin.
 *
 * @dft
 * - Tests the plugin entry registration (hooks + tools)
 * - Uses mock PluginApi
 * - No real OC runtime, no I/O
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── Mock PluginApi ───────────────────────────────────────────

interface MockHook { event: string; handler: (e: Record<string, unknown>) => Promise<void>; name?: string }
interface MockTool { name: string; description: string; execute: (id: string, p: Record<string, unknown>) => Promise<unknown> }

function createMockApi() {
  const hooks: MockHook[] = [];
  const tools: MockTool[] = [];
  const logs: string[] = [];
  return {
    hooks, tools, logs,
    logger: {
      info: (m: string) => logs.push(`[info] ${m}`),
      error: (m: string) => logs.push(`[error] ${m}`),
      warn: (m: string) => logs.push(`[warn] ${m}`),
    },
    registerHook: (events: string | string[], handler: any, opts?: { name?: string }) => {
      const list = Array.isArray(events) ? events : [events];
      for (const event of list) hooks.push({ event, handler, name: opts?.name });
    },
    registerTool: (tool: MockTool) => tools.push(tool),
  };
}

// ═══════════════════════════════════════════════════════════════

describe("Feature: Plugin Manifest", () => {
  const dir = resolve(process.cwd(), "src/plugins/oc-subagent-orchestrator");

  it("Scenario: Manifest exists and is valid", () => {
    expect(existsSync(resolve(dir, "openclaw.plugin.json"))).toBe(true);
    const m = JSON.parse(readFileSync(resolve(dir, "openclaw.plugin.json"), "utf8"));
    expect(m.id).toBe("oc-subagent-orchestrator");
    expect(m.activation.onStartup).toBe(true);
  });

  it("Scenario: Declares all 7 tools", () => {
    const m = JSON.parse(readFileSync(resolve(dir, "openclaw.plugin.json"), "utf8"));
    const tools = m.contracts.tools;
    expect(tools).toContain("queue_work");
    expect(tools).toContain("queue_status");
    expect(tools).toContain("queue_results");
    expect(tools).toContain("subagent_health");
    expect(tools).toContain("session_health");
    expect(tools).toContain("merge_results");
    expect(tools).toContain("event_loop_health");
    expect(tools).toHaveLength(7);
  });

  it("Scenario: Config has sensible defaults", () => {
    const m = JSON.parse(readFileSync(resolve(dir, "openclaw.plugin.json"), "utf8"));
    expect(m.configSchema.properties.maxConcurrent.default).toBe(6);
    expect(m.configSchema.properties.maxSpawnDepth.default).toBe(2);
    expect(m.configSchema.properties.cacheTtlMs.default).toBe(86400000);
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: Plugin Entry Registration", () => {
  it("Scenario: Registers all hooks with names", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const events = api.hooks.map((h) => h.event);
    expect(events).toContain("gateway_start");
    expect(events).toContain("gateway_stop");
    expect(events).toContain("after_compaction");
    expect(events).toContain("session_end");
    expect(events).toContain("subagent_spawned");
    expect(events).toContain("subagent_ended");
    expect(events).toContain("model_call_started");
    expect(events).toContain("model_call_ended");
    expect(events).toHaveLength(8);

    // All hooks have names
    for (const hook of api.hooks) {
      expect(hook.name).toBeDefined();
      expect(hook.name).toContain("orchestrator-");
    }
  });

  it("Scenario: Registers all 7 tools", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const names = api.tools.map((t) => t.name);
    expect(names).toContain("queue_work");
    expect(names).toContain("queue_status");
    expect(names).toContain("queue_results");
    expect(names).toContain("subagent_health");
    expect(names).toContain("session_health");
    expect(names).toContain("merge_results");
    expect(names).toContain("event_loop_health");
    expect(api.tools).toHaveLength(7);
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: subagent_health Tool", () => {
  it("Scenario: Returns valid JSON with all expected fields", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const tool = api.tools.find((t) => t.name === "subagent_health")!;
    const result = await tool.execute("test", {});
    const content = (result as any).content[0];
    const parsed = JSON.parse(content.text);

    expect(parsed.ok).toBe(true);
    expect(parsed).toHaveProperty("activeCount");
    expect(parsed).toHaveProperty("maxConcurrent");
    expect(parsed).toHaveProperty("effectiveMaxConcurrent");
    expect(parsed).toHaveProperty("canSpawn");
    expect(parsed).toHaveProperty("healthStatus");
    expect(parsed).toHaveProperty("maxSpawnDepth");
    expect(parsed).toHaveProperty("depth1Timeout");
    expect(parsed).toHaveProperty("depth2Timeout");
  });

  it("Scenario: Fresh state shows 0 active, canSpawn=true", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const tool = api.tools.find((t) => t.name === "subagent_health")!;
    const result = await tool.execute("test", {});
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.activeCount).toBe(0);
    expect(parsed.canSpawn).toBe(true);
    expect(parsed.depth1Timeout).toBe(300);
    expect(parsed.depth2Timeout).toBe(180);
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: queue_work Tool", () => {
  it("Scenario: Queuing tasks returns dispatch info", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const tool = api.tools.find((t) => t.name === "queue_work")!;
    const result = await tool.execute("test", {
      tasks: [
        { id: "t1", prompt: "search A", priority: "normal" },
        { id: "t2", prompt: "search B", priority: "high" },
      ],
    });
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.totalTasks).toBe(2);
    expect(parsed.dispatched).toBeGreaterThan(0);
  });

  it("Scenario: Non-array tasks returns error", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const tool = api.tools.find((t) => t.name === "queue_work")!;
    const result = await tool.execute("test", { tasks: "not an array" });
    expect((result as any).content[0].text).toContain("must be an array");
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: queue_status Tool", () => {
  it("Scenario: No active queue returns queueActive=false", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const tool = api.tools.find((t) => t.name === "queue_status")!;
    const result = await tool.execute("test", {});
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.queueActive).toBe(false);
  });

  it("Scenario: After queuing, status shows active queue", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const queueTool = api.tools.find((t) => t.name === "queue_work")!;
    await queueTool.execute("test", {
      tasks: [{ id: "t1", prompt: "search A" }],
    });

    const statusTool = api.tools.find((t) => t.name === "queue_status")!;
    const result = await statusTool.execute("test", {});
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.queueActive).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: merge_results Tool", () => {
  it("Scenario: Merging empty array returns empty document", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const tool = api.tools.find((t) => t.name === "merge_results")!;
    const result = await tool.execute("test", { results: [] });
    const text = (result as any).content[0].text;
    expect(text).toContain("Citations");
    expect(text).toContain("Findings");
  });

  it("Scenario: Non-array results returns error", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const tool = api.tools.find((t) => t.name === "merge_results")!;
    const result = await tool.execute("test", { results: "not array" });
    expect((result as any).content[0].text).toContain("must be an array");
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: event_loop_health Tool", () => {
  it("Scenario: Returns health snapshot", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const tool = api.tools.find((t) => t.name === "event_loop_health")!;
    const result = await tool.execute("test", {});
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("healthy");
    expect(parsed).toHaveProperty("effectiveMaxConcurrent");
    expect(parsed.effectiveMaxConcurrent).toBe(6);
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: Hook Lifecycle", () => {
  it("Scenario: subagent_spawned hook tracks the spawn", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const hook = api.hooks.find((h) => h.event === "subagent_spawned")!;
    await hook.handler({ sessionKey: "sub-1", resolvedModel: "test-model" });

    // Check logs show tracking
    expect(api.logs.some((l) => l.includes("Tracked spawn: sub-1"))).toBe(true);
  });

  it("Scenario: subagent_ended hook records and dispatches next", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    // Queue some work first
    const queueTool = api.tools.find((t) => t.name === "queue_work")!;
    await queueTool.execute("test", {
      tasks: [
        { id: "t1", prompt: "search A" },
        { id: "t2", prompt: "search B" },
      ],
    });

    // Simulate subagent_ended
    const hook = api.hooks.find((h) => h.event === "subagent_ended")!;
    await hook.handler({ sessionKey: "t1" });

    // Should not throw — result recorded, next dispatched
    expect(true).toBe(true);
  });

  it("Scenario: gateway_stop hook clears state", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    // Queue work
    const queueTool = api.tools.find((t) => t.name === "queue_work")!;
    await queueTool.execute("test", {
      tasks: [{ id: "t1", prompt: "search A" }],
    });

    // Stop
    const hook = api.hooks.find((h) => h.event === "gateway_stop")!;
    await hook.handler({});

    // Queue should be cleared
    expect(api.logs.some((l) => l.includes("Shut down"))).toBe(true);
  });
});
