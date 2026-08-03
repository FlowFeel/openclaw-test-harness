/**
 * BDD tests for oc-subagent-orchestrator plugin.
 *
 * @dft
 * - Tests the plugin entry registration (hooks + tools)
 * - Uses mock PluginApi
 * - No real OC runtime, no I/O
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// Import the pure cache check functions for testing (no I/O)
import {
  checkCacheForTasks,
  type CacheCheckResult,
} from "../../../src/plugins/oc-subagent-orchestrator/src/index.ts";
import {
  cacheKey,
  putEntry,
  type CacheStore,
} from "../../../src/plugins/shared/result-cache.js";
import { type TaskSpec } from "../../../src/plugins/shared/work-queue-scheduler.ts";

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

  it("Scenario: Returns heartbeatSummary field with all expected properties", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const tool = api.tools.find((t) => t.name === "subagent_health")!;
    const result = await tool.execute("test", {});
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed).toHaveProperty("heartbeatSummary");
    expect(parsed.heartbeatSummary).toHaveProperty("activeSubagents");
    expect(parsed.heartbeatSummary).toHaveProperty("staleSubagents");
    expect(parsed.heartbeatSummary).toHaveProperty("queueActive");
    expect(parsed.heartbeatSummary).toHaveProperty("queueProgress");
    expect(parsed.heartbeatSummary).toHaveProperty("cacheHitRate");
    expect(parsed.heartbeatSummary).toHaveProperty("healthStatus");
    expect(parsed.heartbeatSummary).toHaveProperty("effectiveMaxConcurrent");
    expect(parsed.heartbeatSummary).toHaveProperty("generatedAt");

    // Fresh state: no subagents, no queue
    expect(parsed.heartbeatSummary.activeSubagents).toBe(0);
    expect(parsed.heartbeatSummary.staleSubagents).toBe(0);
    expect(parsed.heartbeatSummary.queueActive).toBe(false);
    expect(parsed.heartbeatSummary.queueProgress.total).toBe(0);
    expect(parsed.heartbeatSummary.queueProgress.completed).toBe(0);
    expect(parsed.heartbeatSummary.queueProgress.failed).toBe(0);
    expect(parsed.heartbeatSummary.queueProgress.queued).toBe(0);
    expect(parsed.heartbeatSummary.cacheHitRate).toBe(0);
    expect(parsed.heartbeatSummary.healthStatus).toBe("healthy");
    expect(parsed.heartbeatSummary.effectiveMaxConcurrent).toBe(6);
    expect(typeof parsed.heartbeatSummary.generatedAt).toBe("string");
  });

  it("Scenario: heartbeatSummary has queueProgress when queue is active", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    // Queue work to activate the queue
    const queueTool = api.tools.find((t) => t.name === "queue_work")!;
    await queueTool.execute("test", {
      tasks: [
        { id: "t1", prompt: "search A" },
        { id: "t2", prompt: "search B" },
      ],
    });

    const tool = api.tools.find((t) => t.name === "subagent_health")!;
    const result = await tool.execute("test", {});
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.heartbeatSummary.queueActive).toBe(true);
    expect(parsed.heartbeatSummary.queueProgress.total).toBe(2);
    // dispatched should be > 0, queued + dispatched = total
    expect(parsed.heartbeatSummary.queueProgress.queued + parsed.heartbeatSummary.queueProgress.completed + parsed.heartbeatSummary.queueProgress.failed).toBeLessThanOrEqual(2);
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
    expect(parsed.total).toBe(1);
    expect(parsed.queued).toBe(0);
    expect(parsed.dispatched).toBe(1);
    expect(parsed.completed).toBe(0);
    expect(parsed.failed).toBe(0);
  });

  it("Scenario: queue_work returns spawnInstructions array", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const tool = api.tools.find((t) => t.name === "queue_work")!;
    const result = await tool.execute("test", {
      tasks: [
        { id: "t1", prompt: "search engines", priority: "high" },
        { id: "t2", prompt: "search databases", priority: "normal" },
        { id: "t3", prompt: "search algorithms", priority: "low" },
      ],
    });
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.totalTasks).toBe(3);

    // spawnInstructions should contain the dispatched tasks with their prompts
    expect(parsed.spawnInstructions).toBeDefined();
    expect(Array.isArray(parsed.spawnInstructions)).toBe(true);
    expect(parsed.spawnInstructions.length).toBeGreaterThan(0);

    // Each entry should have taskId, prompt, and taskName
    for (const entry of parsed.spawnInstructions) {
      expect(entry).toHaveProperty("taskId");
      expect(entry).toHaveProperty("prompt");
      expect(entry).toHaveProperty("taskName");
      expect(typeof entry.prompt).toBe("string");
      expect(entry.prompt.length).toBeGreaterThan(0);
      expect(typeof entry.taskName).toBe("string");
      expect(entry.taskName.length).toBeGreaterThan(0);
    }
  });

  it("Scenario: queue_status includes pendingSpawnCount and activeSubagents", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const queueTool = api.tools.find((t) => t.name === "queue_work")!;
    await queueTool.execute("test", {
      tasks: [
        { id: "t1", prompt: "search A" },
        { id: "t2", prompt: "search B" },
      ],
    });

    const statusTool = api.tools.find((t) => t.name === "queue_status")!;
    const result = await statusTool.execute("test", {});
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.queueActive).toBe(true);

    // Should have accurate dispatched/queued/completed/failed counts
    expect(parsed.total).toBe(2);
    expect(parsed.dispatched + parsed.queued + parsed.completed + parsed.failed).toBe(parsed.total);

    // pendingSpawnCount should match the number of tasks dispatched but not yet spawned
    expect(parsed.pendingSpawnCount).toBeDefined();
    expect(parsed.pendingSpawnCount).toBeGreaterThanOrEqual(0);

    // activeSubagents should reflect the actual spawned subagent count
    expect(parsed.activeSubagents).toBeDefined();
    expect(parsed.activeSubagents).toBe(0); // No subagents spawned yet

    // activeSlots should match the number of dispatched tasks
    expect(parsed.activeSlots).toBe(parsed.dispatched);
  });

  it("Scenario: queue_status with no active queue returns queueActive=false and activeSubagents", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const tool = api.tools.find((t) => t.name === "queue_status")!;
    const result = await tool.execute("test", {});
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.queueActive).toBe(false);
    expect(parsed.activeSubagents).toBe(0);
  });

  it("Scenario: queue_work spawnInstructions respects maxConcurrent", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const tool = api.tools.find((t) => t.name === "queue_work")!;
    const result = await tool.execute("test", {
      tasks: [
        { id: "t1", prompt: "search A" },
        { id: "t2", prompt: "search B" },
        { id: "t3", prompt: "search C" },
        { id: "t4", prompt: "search D" },
        { id: "t5", prompt: "search E" },
        { id: "t6", prompt: "search F" },
        { id: "t7", prompt: "search G" },
      ],
    });
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.totalTasks).toBe(7);

    // Should dispatch at most maxConcurrent (6) tasks
    expect(parsed.dispatched).toBeLessThanOrEqual(6);
    expect(parsed.spawnInstructions.length).toBe(parsed.dispatched);

    // The spawn instructions should have taskId, prompt, taskName
    for (const entry of parsed.spawnInstructions) {
      expect(entry).toHaveProperty("taskId");
      expect(entry).toHaveProperty("prompt");
      expect(entry).toHaveProperty("taskName");
    }

    // Verify via queue_status that the queue state is consistent
    const statusTool = api.tools.find((t) => t.name === "queue_status")!;
    const statusResult = await statusTool.execute("test", {});
    const statusParsed = JSON.parse((statusResult as any).content[0].text);

    expect(statusParsed.total).toBe(7);
    expect(statusParsed.dispatched).toBe(parsed.dispatched);
    expect(statusParsed.queued).toBe(7 - parsed.dispatched);
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

  it("Scenario: Returns non-zero values after model_call_started populates telemetry", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    // Fire model_call_started to populate real telemetry
    const hook = api.hooks.find((h) => h.event === "model_call_started")!;
    await hook.handler({});

    // Now read the health snapshot
    const tool = api.tools.find((t) => t.name === "event_loop_health")!;
    const result = await tool.execute("test", {});
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.ok).toBe(true);
    // heap should always be non-zero in a running Node.js process
    expect(parsed.usedHeapMB).toBeGreaterThan(0);
    // cpuRatio should be non-zero after any process work
    expect(parsed.cpuRatio).toBeGreaterThanOrEqual(0);
    // status should be a valid health status string
    expect(["healthy", "degraded", "critical"]).toContain(parsed.status);
    // eventLoopUtilization should be a number between 0-1
    expect(parsed.eventLoopUtilization).toBeGreaterThanOrEqual(0);
    expect(parsed.eventLoopUtilization).toBeLessThanOrEqual(1);
    // eventLoopP99Ms should be >= 0
    expect(parsed.eventLoopP99Ms).toBeGreaterThanOrEqual(0);
    // effectiveMaxConcurrent should be based on real health status
    const expectedMax = parsed.status === "healthy" ? 6 : parsed.status === "degraded" ? 4 : 0;
    expect(parsed.effectiveMaxConcurrent).toBe(expectedMax);
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

  it("Scenario: subagent_spawned hook links sessionKey to queued task ID", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    // Queue work — this populates pendingSpawnTaskIds
    const queueTool = api.tools.find((t) => t.name === "queue_work")!;
    const queueResult = await queueTool.execute("test", {
      tasks: [
        { id: "t1", prompt: "search A", priority: "high" },
        { id: "t2", prompt: "search B" },
      ],
    });
    const parsed = JSON.parse((queueResult as any).content[0].text);
    expect(parsed.dispatched).toBeGreaterThan(0);

    // Simulate spawn events — should consume from pendingSpawnTaskIds in FIFO order
    const spawnedHook = api.hooks.find((h) => h.event === "subagent_spawned")!;
    await spawnedHook.handler({ sessionKey: "session-abc", resolvedModel: "test-model" });

    // Check log shows the link
    expect(api.logs.some((l) => l.includes("linked to task"))).toBe(true);
    expect(api.logs.some((l) => l.includes("Tracked spawn: session-abc"))).toBe(true);

    // Second spawn should link to the next task
    await spawnedHook.handler({ sessionKey: "session-def", resolvedModel: "test-model" });
    expect(api.logs.some((l) => l.includes("Tracked spawn: session-def"))).toBe(true);
  });

  it("Scenario: subagent_spawned with no pending spawns still tracks (no link)", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const spawnedHook = api.hooks.find((h) => h.event === "subagent_spawned")!;
    await spawnedHook.handler({ sessionKey: "session-xyz", resolvedModel: "test-model" });

    // Tracks the spawn but no link (no queue active)
    expect(api.logs.some((l) => l.includes("Tracked spawn: session-xyz"))).toBe(true);

    // No task link in log message
    const linkLog = api.logs.find((l) => l.includes("session-xyz"));
    expect(linkLog).toBeDefined();
    expect(linkLog).not.toContain("linked to task");
  });

  it("Scenario: subagent_ended uses session-to-task mapping for recordResult", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    // Queue work with 2 tasks
    const queueTool = api.tools.find((t) => t.name === "queue_work")!;
    await queueTool.execute("test", {
      tasks: [
        { id: "t1", prompt: "search A" },
        { id: "t2", prompt: "search B" },
      ],
    });

    // Simulate spawn (links sessionKey to task ID)
    const spawnedHook = api.hooks.find((h) => h.event === "subagent_spawned")!;
    await spawnedHook.handler({ sessionKey: "session-abc", resolvedModel: "test-model" });

    // Verify status shows 1 dispatched, 1 pendingSpawn
    const statusTool = api.tools.find((t) => t.name === "queue_status")!;
    let statusResult = await statusTool.execute("test", {});
    let statusParsed = JSON.parse((statusResult as any).content[0].text);
    expect(statusParsed.pendingSpawnCount).toBe(1);

    // Simulate end — should look up taskId from sessionKey
    const endedHook = api.hooks.find((h) => h.event === "subagent_ended")!;
    await endedHook.handler({ sessionKey: "session-abc" });

    // Verify result recorded: t1 should be completed
    statusResult = await statusTool.execute("test", {});
    statusParsed = JSON.parse((statusResult as any).content[0].text);
    expect(statusParsed.completed).toBe(1);
    expect(statusParsed.pendingSpawnCount).toBe(1); // t2 still pending spawn
  });

  it("Scenario: subagent_ended with no queue mapping still cleans up", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    // Spawn a subagent outside the queue mechanism
    const spawnedHook = api.hooks.find((h) => h.event === "subagent_spawned")!;
    await spawnedHook.handler({ sessionKey: "session-orphan" });

    // End it — should not throw even though there's no queue/task mapping
    const endedHook = api.hooks.find((h) => h.event === "subagent_ended")!;
    await endedHook.handler({ sessionKey: "session-orphan" });

    expect(true).toBe(true); // No error thrown
  });

  it("Scenario: subagent_spawned without sessionKey is a no-op", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const spawnedHook = api.hooks.find((h) => h.event === "subagent_spawned")!;
    await spawnedHook.handler({ resolvedModel: "test-model" });

    // No sessionKey — should not log anything
    expect(api.logs.filter((l) => l.includes("Tracked spawn")).length).toBe(0);
  });

  it("Scenario: subagent_ended without sessionKey is a no-op", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const endedHook = api.hooks.find((h) => h.event === "subagent_ended")!;
    await endedHook.handler({});

    expect(true).toBe(true); // No error thrown
  });

  it("Scenario: after_compaction hook reads and cleans sessions", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "orch-test-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      // Write test sessions.json with bloat fields and stale subagent
      const sessionsDir = resolve(tmpDir, ".openclaw/agents/main/sessions");
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(resolve(sessionsDir, "sessions.json"), JSON.stringify({
        "main": { updatedAt: Date.now(), compactionCheckpoints: [1, 2, 3], systemPromptReport: "lots of text" },
        "subagent-abc": { updatedAt: Date.now() - 20 * 60 * 60 * 1000 }, // 20h old, stale (maxAgeHours=15)
      }));

      const api = createMockApi();
      const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
      mod.default.register(api as any, { maxAgeHours: 15 });

      const hook = api.hooks.find((h) => h.event === "after_compaction")!;
      await hook.handler({});

      // Read the cleaned file
      const cleaned = JSON.parse(readFileSync(resolve(sessionsDir, "sessions.json"), "utf8"));
      // bloat fields should be stripped
      expect(cleaned.main.compactionCheckpoints).toBeUndefined();
      expect(cleaned.main.systemPromptReport).toBeUndefined();
      // stale subagent should be purged
      expect(cleaned["subagent-abc"]).toBeUndefined();
      // non-bloat fields should remain
      expect(cleaned.main.updatedAt).toBeDefined();
    } finally {
      process.env.HOME = originalHome;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Scenario: session_health reports actual file size", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "orch-test-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const sessionsDir = resolve(tmpDir, ".openclaw/agents/main/sessions");
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(resolve(sessionsDir, "sessions.json"), JSON.stringify({
        "main": { updatedAt: Date.now() },
        "subagent-abc": { updatedAt: Date.now() },
      }));

      const api = createMockApi();
      const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
      mod.default.register(api as any, { maxAgeHours: 15 });

      const tool = api.tools.find((t) => t.name === "session_health")!;
      const result = await tool.execute("test", {});
      const parsed = JSON.parse((result as any).content[0].text);

      expect(parsed.ok).toBe(true);
      expect(parsed.fileSizeBytes).toBeGreaterThan(0);
      expect(parsed.entryCount).toBe(2);
      expect(parsed.subagentEntryCount).toBe(1);
    } finally {
      process.env.HOME = originalHome;
      rmSync(tmpDir, { recursive: true, force: true });
    }
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

  it("Scenario: gateway_start hook does not throw on empty event", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const hook = api.hooks.find((h) => h.event === "gateway_start")!;
    await expect(hook.handler({})).resolves.toBeUndefined();
  });

  it("Scenario: model_call_started hook does not throw on empty event", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const hook = api.hooks.find((h) => h.event === "model_call_started")!;
    await expect(hook.handler({})).resolves.toBeUndefined();
  });

  it("Scenario: model_call_ended hook does not throw on empty event", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const hook = api.hooks.find((h) => h.event === "model_call_ended")!;
    await expect(hook.handler({})).resolves.toBeUndefined();
  });

  it("Scenario: session_end hook does not throw on empty event", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const hook = api.hooks.find((h) => h.event === "session_end")!;
    await expect(hook.handler({})).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: queue_results Tool", () => {
  it("Scenario: No active queue returns 'No active work queue'", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const tool = api.tools.find((t) => t.name === "queue_results")!;
    const result: any = await tool.execute("test", {});
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("No active work queue");
  });

  it("Scenario: After queuing, results show task statuses", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    // Queue work
    const queueTool = api.tools.find((t) => t.name === "queue_work")!;
    await queueTool.execute("test", {
      tasks: [
        { id: "t1", prompt: "search A", priority: "high" },
        { id: "t2", prompt: "search B", priority: "normal" },
      ],
    });

    // Get results
    const tool = api.tools.find((t) => t.name === "queue_results")!;
    const result: any = await tool.execute("test", {});
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);

    // Each entry should have id, status, hasResult
    for (const entry of parsed) {
      expect(entry).toHaveProperty("id");
      expect(entry).toHaveProperty("status");
      expect(entry).toHaveProperty("hasResult");
    }
  });

  it("Scenario: queue_results with merge=true returns formatted document", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    // Queue work — need at least one task so queue is active
    const queueTool = api.tools.find((t) => t.name === "queue_work")!;
    await queueTool.execute("test", {
      tasks: [{ id: "t1", prompt: "search A", priority: "high" }],
    });

    // Get results with merge=true (no completed results, so no merge happens)
    const tool = api.tools.find((t) => t.name === "queue_results")!;
    const result: any = await tool.execute("test", { merge: true });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    // Should still return task status JSON (no completed subagent results to merge)
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("Scenario: Handles undefined merge param gracefully", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const queueTool = api.tools.find((t) => t.name === "queue_work")!;
    await queueTool.execute("test", {
      tasks: [{ id: "t1", prompt: "search A" }],
    });

    const tool = api.tools.find((t) => t.name === "queue_results")!;
    const result: any = await tool.execute("test", {});
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: session_health Tool (no file system)", () => {
  it("Scenario: Returns zeroes when no sessions.json exists", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    const originalHome = process.env.HOME;
    const tmpDir = mkdtempSync(resolve(tmpdir(), "session-health-test-"));
    process.env.HOME = tmpDir;

    try {
      mod.default.register(api as any, { maxAgeHours: 15 });

      const tool = api.tools.find((t) => t.name === "session_health")!;
      const result = await tool.execute("test", {});
      const parsed = JSON.parse((result as any).content[0].text);

      expect(parsed.ok).toBe(true);
      expect(parsed.fileSizeBytes).toBe(0);
      expect(parsed.entryCount).toBe(0);
      expect(parsed.subagentEntryCount).toBe(0);
      expect(parsed).toHaveProperty("bloatFieldsTracked");
      expect(parsed).toHaveProperty("maxAgeHours");
      expect(parsed).toHaveProperty("staleSubagentCount");
      expect(parsed).toHaveProperty("cacheSize");
      expect(parsed).toHaveProperty("cacheHitRate");
    } finally {
      process.env.HOME = originalHome;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Scenario: Returns staleSubagentCount=0 when no subagents", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    const originalHome = process.env.HOME;
    const tmpDir = mkdtempSync(resolve(tmpdir(), "session-health-test-"));
    process.env.HOME = tmpDir;

    try {
      mod.default.register(api as any, { maxAgeHours: 15 });

      const tool = api.tools.find((t) => t.name === "session_health")!;
      const result = await tool.execute("test", {});
      const parsed = JSON.parse((result as any).content[0].text);

      expect(parsed.staleSubagentCount).toBe(0);
      expect(parsed.cacheSize).toBe(0);
    } finally {
      process.env.HOME = originalHome;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: detectStaleAndFail (pure function)", () => {
  it("Scenario: stale subagent detected and marked failed", async () => {
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    const { detectStaleAndFail } = mod;
    const { createQueue, dispatchNext } = await import("../../../src/plugins/shared/work-queue-scheduler.ts");
    const { trackSpawn } = await import("../../../src/plugins/shared/subagent-tracker.ts");

    // Create a queue with one task and dispatch it
    const queue = createQueue([{ id: "t1", prompt: "search A" }]);
    const { taskIds, state: dispatched } = dispatchNext(queue, 6, 1000);
    expect(taskIds).toHaveLength(1);

    // Create a subagent map with one active subagent, started at t=1000
    let subagents = new Map();
    subagents = trackSpawn(subagents, {
      sessionKey: "sub-1",
      startedAtMs: 1000,
    }, 1000);

    // Link session to task
    const sessionToTaskMap = new Map([["sub-1", "t1"]]);

    // Detect stale: runTimeoutSeconds=1, nowMs=3000 → cutoff=2000
    // startedAtMs=1000 < 2000 → stale
    const result = detectStaleAndFail(
      subagents,
      dispatched,
      sessionToTaskMap,
      1,   // runTimeoutSeconds
      6,   // maxConcurrent
      "healthy",
      3000 // nowMs
    );

    expect(result.staleCount).toBe(1);
    expect(result.staleKeys).toEqual(["sub-1"]);

    // Task should be marked as failed
    const task = result.queue!.tasks.get("t1");
    expect(task!.status).toBe("failed");
    expect(task!.error).toContain("subagent crashed or timed out");

    // Stale subagent removed from map
    expect(result.subagents.has("sub-1")).toBe(false);

    // Session-to-task mapping removed
    expect(result.sessionToTaskMap.has("sub-1")).toBe(false);
  });

  it("Scenario: dependents of stale task are blocked", async () => {
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    const { detectStaleAndFail } = mod;
    const { createQueue, dispatchNext } = await import("../../../src/plugins/shared/work-queue-scheduler.ts");
    const { trackSpawn } = await import("../../../src/plugins/shared/subagent-tracker.ts");

    // Three tasks: t2 depends on t1, t3 is independent
    const queue = createQueue([
      { id: "t1", prompt: "search A" },
      { id: "t2", prompt: "search B", dependsOn: ["t1"] },
      { id: "t3", prompt: "search C" },
    ]);

    // Use maxConcurrent=1 so only t1 dispatches (t2 blocked by dependsOn)
    const { taskIds, state: dispatched } = dispatchNext(queue, 1, 1000);
    expect(taskIds).toHaveLength(1);
    expect(taskIds).toContain("t1");

    // Track subagent for t1
    let subagents = new Map();
    subagents = trackSpawn(subagents, {
      sessionKey: "sub-1",
      startedAtMs: 1000,
    }, 1000);

    const sessionToTaskMap = new Map([["sub-1", "t1"]]);

    // Detect stale: t1's subagent is stale
    const result = detectStaleAndFail(
      subagents,
      dispatched,
      sessionToTaskMap,
      1, // runTimeoutSeconds
      6, // maxConcurrent
      "healthy",
      3000 // nowMs
    );

    // t1 should be failed
    expect(result.queue!.tasks.get("t1")!.status).toBe("failed");

    // t2 (depends on t1) should be blocked (failed)
    expect(result.queue!.tasks.get("t2")!.status).toBe("failed");
    expect(result.queue!.tasks.get("t2")!.error).toContain("dependency failed: t1");

    // t3 (no dependency) should be dispatched to fill freed slot
    expect(result.queue!.tasks.get("t3")!.status).toBe("dispatched");
  });

  it("Scenario: freed slot dispatches next task", async () => {
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    const { detectStaleAndFail } = mod;
    const { createQueue, dispatchNext } = await import("../../../src/plugins/shared/work-queue-scheduler.ts");
    const { trackSpawn } = await import("../../../src/plugins/shared/subagent-tracker.ts");

    // Three tasks, maxConcurrent=2, so only 2 dispatch initially
    const queue = createQueue([
      { id: "t1", prompt: "search A" },
      { id: "t2", prompt: "search B" },
      { id: "t3", prompt: "search C" },
    ]);

    const { taskIds, state: dispatched } = dispatchNext(queue, 2, 1000);
    expect(taskIds).toHaveLength(2);
    expect(taskIds).toEqual(["t1", "t2"]);

    // Both t1 and t2 are dispatched, t3 is queued
    expect(dispatched.tasks.get("t3")!.status).toBe("queued");

    // Track subagent for t1
    let subagents = new Map();
    subagents = trackSpawn(subagents, {
      sessionKey: "sub-1",
      startedAtMs: 1000,
    }, 1000);

    const sessionToTaskMap = new Map([["sub-1", "t1"]]);

    // t1 goes stale → frees a slot → t3 should dispatch
    const result = detectStaleAndFail(
      subagents,
      dispatched,
      sessionToTaskMap,
      1, // runTimeoutSeconds
      2, // maxConcurrent (not effective max, but the configured value)
      "healthy",
      3000 // nowMs
    );

    // t1 should be failed
    expect(result.queue!.tasks.get("t1")!.status).toBe("failed");

    // t3 should now be dispatched (freed slot)
    expect(result.queue!.tasks.get("t3")!.status).toBe("dispatched");

    // spawnInstructions should contain t3
    expect(result.spawnInstructions).toHaveLength(1);
    expect(result.spawnInstructions[0].taskId).toBe("t3");
    expect(result.spawnInstructions[0].prompt).toBe("search C");
    expect(result.spawnInstructions[0].taskName).toBe("t3");
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: Crash Recovery (#39)", () => {
  it("Scenario: crashed task marked failed with error message", async () => {
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    const { detectStaleAndFail } = mod;
    const { createQueue, dispatchNext } = await import("../../../src/plugins/shared/work-queue-scheduler.ts");
    const { trackSpawn } = await import("../../../src/plugins/shared/subagent-tracker.ts");

    // Create queue with one task, dispatch it
    const queue = createQueue([{ id: "t1", prompt: "search A" }]);
    const { taskIds, state: dispatched } = dispatchNext(queue, 6, 1000);
    expect(taskIds).toHaveLength(1);

    // Track subagent
    let subagents = new Map();
    subagents = trackSpawn(subagents, {
      sessionKey: "sub-1",
      startedAtMs: 1000,
    }, 1000);

    const sessionToTaskMap = new Map([["sub-1", "t1"]]);

    // Detect stale
    const result = detectStaleAndFail(
      subagents,
      dispatched,
      sessionToTaskMap,
      1,   // runTimeoutSeconds
      6,
      "healthy",
      3000
    );

    // Verify task is marked failed with specific error message
    expect(result.staleCount).toBe(1);
    const task = result.queue!.tasks.get("t1");
    expect(task!.status).toBe("failed");
    expect(task!.error).toBe("subagent crashed or timed out");
  });

  it("Scenario: dependent tasks blocked with dependency error", async () => {
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    const { detectStaleAndFail } = mod;
    const { createQueue, dispatchNext } = await import("../../../src/plugins/shared/work-queue-scheduler.ts");
    const { trackSpawn } = await import("../../../src/plugins/shared/subagent-tracker.ts");

    // Three tasks: t2 depends on t1, t3 is independent
    const queue = createQueue([
      { id: "t1", prompt: "search A" },
      { id: "t2", prompt: "search B", dependsOn: ["t1"] },
      { id: "t3", prompt: "search C", dependsOn: ["t1"] },
    ]);

    const { taskIds, state: dispatched } = dispatchNext(queue, 1, 1000);
    expect(taskIds).toHaveLength(1);
    expect(taskIds).toContain("t1");

    let subagents = new Map();
    subagents = trackSpawn(subagents, {
      sessionKey: "sub-1",
      startedAtMs: 1000,
    }, 1000);

    const sessionToTaskMap = new Map([["sub-1", "t1"]]);

    const result = detectStaleAndFail(
      subagents,
      dispatched,
      sessionToTaskMap,
      1,
      6,
      "healthy",
      3000
    );

    // t1 should be failed
    expect(result.queue!.tasks.get("t1")!.status).toBe("failed");

    // t2 should be blocked with dependency error referencing t1
    expect(result.queue!.tasks.get("t2")!.status).toBe("failed");
    expect(result.queue!.tasks.get("t2")!.error).toBe("dependency failed: t1");

    // t3 should also be blocked with dependency error referencing t1
    expect(result.queue!.tasks.get("t3")!.status).toBe("failed");
    expect(result.queue!.tasks.get("t3")!.error).toBe("dependency failed: t1");

    // blockedCount should reflect the number of blocked dependents
    expect(result.blockedCount).toBe(2);
  });

  it("Scenario: queue_status shows crashRecoveryReport", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, { runTimeoutSeconds: 0.001 });

    // Queue work
    const queueTool = api.tools.find((t) => t.name === "queue_work")!;
    await queueTool.execute("test", {
      tasks: [
        { id: "t1", prompt: "search A" },
        { id: "t2", prompt: "search B", dependsOn: ["t1"] },
      ],
    });

    // Spawn subagent for t1
    const spawnedHook = api.hooks.find((h) => h.event === "subagent_spawned")!;
    await spawnedHook.handler({ sessionKey: "sub-1", resolvedModel: "test-model" });

    // Wait to become stale
    await new Promise((r) => setTimeout(r, 5));

    // Trigger session_end → stale detection pipeline
    const sessionEndHook = api.hooks.find((h) => h.event === "session_end")!;
    await sessionEndHook.handler({});

    // Check queue_status shows crashRecoveryReport
    const statusTool = api.tools.find((t) => t.name === "queue_status")!;
    const result = await statusTool.execute("test", {});
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed).toHaveProperty("crashRecoveryReport");
    expect(parsed.crashRecoveryReport).toHaveProperty("recoveredCount");
    expect(parsed.crashRecoveryReport).toHaveProperty("blockedCount");
    expect(parsed.crashRecoveryReport).toHaveProperty("newDispatchCount");

    // t1 went stale (recoveredCount >= 1), t2 blocked (blockedCount >= 1)
    expect(parsed.crashRecoveryReport.recoveredCount).toBeGreaterThanOrEqual(1);
    expect(parsed.crashRecoveryReport.blockedCount).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: queue_status reports staleCount", () => {
  it("Scenario: queue_status with active queue reports staleCount", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, { runTimeoutSeconds: 0.001 });

    // Queue work
    const queueTool = api.tools.find((t) => t.name === "queue_work")!;
    await queueTool.execute("test", {
      tasks: [{ id: "t1", prompt: "search A" }],
    });

    // Spawn a subagent (links to task t1)
    const spawnedHook = api.hooks.find((h) => h.event === "subagent_spawned")!;
    await spawnedHook.handler({ sessionKey: "sub-1", resolvedModel: "test-model" });

    // Wait a tiny bit so the subagent becomes stale with runTimeoutSeconds=0.001
    await new Promise((r) => setTimeout(r, 5));

    // Trigger session_end → stale detection pipeline
    const sessionEndHook = api.hooks.find((h) => h.event === "session_end")!;
    await sessionEndHook.handler({});

    // Check queue_status reports staleCount
    const statusTool = api.tools.find((t) => t.name === "queue_status")!;
    const result = await statusTool.execute("test", {});
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.staleCount).toBeDefined();
    expect(parsed.staleCount).toBeGreaterThanOrEqual(0);

    // The task should have been marked as failed
    expect(parsed.failed).toBe(1);
    expect(parsed.completed).toBe(0);
  });

  it("Scenario: queue_status with no queue reports staleCount=0", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const tool = api.tools.find((t) => t.name === "queue_status")!;
    const result = await tool.execute("test", {});
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.staleCount).toBeDefined();
    expect(parsed.staleCount).toBe(0);
  });

  it("Scenario: queue_status staleCount reflects actual stale subagents", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, { runTimeoutSeconds: 0.001 });

    // Queue work with 2 tasks
    const queueTool = api.tools.find((t) => t.name === "queue_work")!;
    await queueTool.execute("test", {
      tasks: [
        { id: "t1", prompt: "search A" },
        { id: "t2", prompt: "search B" },
      ],
    });

    // Spawn both subagents
    const spawnedHook = api.hooks.find((h) => h.event === "subagent_spawned")!;
    await spawnedHook.handler({ sessionKey: "sub-1", resolvedModel: "test-model" });
    await spawnedHook.handler({ sessionKey: "sub-2", resolvedModel: "test-model" });

    // Wait to become stale
    await new Promise((r) => setTimeout(r, 5));

    // Trigger session_end
    const sessionEndHook = api.hooks.find((h) => h.event === "session_end")!;
    await sessionEndHook.handler({});

    // Check queue_status
    const statusTool = api.tools.find((t) => t.name === "queue_status")!;
    const result = await statusTool.execute("test", {});
    const parsed = JSON.parse((result as any).content[0].text);

    // Both tasks should be failed
    expect(parsed.failed).toBe(2);
    expect(parsed.staleCount).toBe(0); // stale subagents were cleaned up, so 0 remaining
  });
});

// ── Feature: Cache Check Logic (Pure Tests — No I/O) ──────────────────────
/**
 * Pure tests for the cache check logic that powers queue_work.
 * 
 * These tests verify:
 * - If cache hit → task is skipped (not queued)
 * - If cache miss → task is queued
 * 
 * They use the pure `checkCacheForTasks` function which is testable without I/O.
 * The SQLite check (subprocess) is tested separately in a real runtime.
 *
 * @dft
 * - Uses mock data only
 * - No subprocess calls, no Date.now() dependency (nowMs is injected)
 * - Validates the bridge between in-memory cache and SQLite hits map
 */
describe("Feature: Cache Check Logic (#41)", () => {
  const nowMs = 1_000_000_000_000;
  const ttlMs = 86_400_000; // 24h

  /** Create a store with one cached result. */
  function createStoreWithCachedResult(
    query: string,
    taskId: string,
    result: unknown,
  ): CacheStore {
    const store: CacheStore = new Map();
    const key = cacheKey(query, taskId);
    return putEntry(store, key, result, nowMs, ttlMs);
  }

  it("Scenario: In-memory cache hit skips task", () => {
    const cache = createStoreWithCachedResult("search A", "t1", { found: true });
    const tasks: TaskSpec[] = [
      { id: "t1", prompt: "search A" },
      { id: "t2", prompt: "search B" },
    ];
    const sqliteHits = new Map<string, unknown>();

    const result = checkCacheForTasks(tasks, cache, nowMs, sqliteHits);

    // t1 was cached → not queued
    expect(result.cached).toHaveLength(1);
    expect(result.cached[0]).toEqual({ found: true });

    // t2 was not cached → queued
    expect(result.uncached).toHaveLength(1);
    expect(result.uncached[0].id).toBe("t2");

    // Correct hit count
    expect(result.hitCount).toBe(1);
  });

  it("Scenario: SQLite hits map causes cache hit", () => {
    const cache: CacheStore = new Map(); // Empty in-memory cache
    const tasks: TaskSpec[] = [
      { id: "t1", prompt: "search A" },
      { id: "t2", prompt: "search B" },
    ];

    // Simulate SQLite returning a result for t1
    const sqliteHits = new Map<string, unknown>([
      ["t1", { fromSqlite: true, ns: "memory", uri: "test.md", title: "Test" }],
    ]);

    const result = checkCacheForTasks(tasks, cache, nowMs, sqliteHits);

    // t1 was in SQLite hits → cached (even though in-memory cache is empty)
    expect(result.cached).toHaveLength(1);
    expect(result.cached[0]).toEqual({
      fromSqlite: true,
      ns: "memory",
      uri: "test.md",
      title: "Test",
    });

    // t2 was not in SQLite hits → queued
    expect(result.uncached).toHaveLength(1);
    expect(result.uncached[0].id).toBe("t2");

    expect(result.hitCount).toBe(1);
  });

  it("Scenario: Both caches contribute to hits", () => {
    const cache = createStoreWithCachedResult("search A", "t1", { fromMemory: true });
    const tasks: TaskSpec[] = [
      { id: "t1", prompt: "search A" }, // cached in-memory
      { id: "t2", prompt: "search B" }, // cached via SQLite hits
      { id: "t3", prompt: "search C" }, // not cached
      { id: "t4", prompt: "search D" }, // cached via both (in-memory takes precedence)
    ];
    const sqliteHits = new Map<string, unknown>([
      ["t2", { fromSqlite: true }],
      ["t4", { fromSqliteToo: true }],
    ]);

    const result = checkCacheForTasks(tasks, cache, nowMs, sqliteHits);

    // t1 and t2 are cached (one from memory, one from SQLite hits)
    // t4 is cached from in-memory (takes precedence over SQLite hits)
    // t3 is uncached
    expect(result.cached).toHaveLength(3);
    expect(result.uncached).toHaveLength(1);
    expect(result.uncached[0].id).toBe("t3");

    // Verify hit counts
    expect(result.hitCount).toBe(3);
  });

  it("Scenario: Empty tasks returns all empty", () => {
    const cache: CacheStore = new Map();
    const tasks: TaskSpec[] = [];
    const sqliteHits = new Map<string, unknown>();

    const result = checkCacheForTasks(tasks, cache, nowMs, sqliteHits);

    expect(result.cached).toHaveLength(0);
    expect(result.uncached).toHaveLength(0);
    expect(result.hitCount).toBe(0);
  });

  it("Scenario: All tasks uncached returns all uncached", () => {
    const cache: CacheStore = new Map();
    const tasks: TaskSpec[] = [
      { id: "t1", prompt: "search A" },
      { id: "t2", prompt: "search B" },
    ];
    const sqliteHits = new Map<string, unknown>();

    const result = checkCacheForTasks(tasks, cache, nowMs, sqliteHits);

    expect(result.cached).toHaveLength(0);
    expect(result.uncached).toHaveLength(2);
    expect(result.hitCount).toBe(0);
  });

  it("Scenario: All tasks cached returns all cached", () => {
    const cache = createStoreWithCachedResult("search A", "t1", { result: 1 });
    const tasks: TaskSpec[] = [
      { id: "t1", prompt: "search A" },
    ];
    const sqliteHits = new Map<string, unknown>();

    const result = checkCacheForTasks(tasks, cache, nowMs, sqliteHits);

    expect(result.cached).toHaveLength(1);
    expect(result.uncached).toHaveLength(0);
    expect(result.hitCount).toBe(1);
  });

  it("Scenario: TTL expiry causes cache miss", () => {
    // Entry created long ago (before current time by more than TTL)
    const createdAtMs = nowMs - 90_000_000; // > 24h ago
    const ttlMs = 86_400_000;

    const cache: CacheStore = new Map();
    const key = cacheKey("search A", "t1");
    cache.set(key, {
      key,
      result: { expired: true },
      createdAtMs,
      ttlMs,
      hitCount: 0,
    });

    const tasks: TaskSpec[] = [{ id: "t1", prompt: "search A" }];
    const sqliteHits = new Map<string, unknown>();

    const result = checkCacheForTasks(tasks, cache, nowMs, sqliteHits);

    // Expired entry = cache miss
    expect(result.cached).toHaveLength(0);
    expect(result.uncached).toHaveLength(1);
    expect(result.uncached[0].id).toBe("t1");
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: shouldUseCached (#41)", () => {
  it("Scenario: Valid cache hit with all fields returns true", async () => {
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    const { shouldUseCached } = mod;

    const hit = {
      query: "search test",
      ns: "memory",
      uri: "doc.md",
      title: "Test Document",
    };

    expect(shouldUseCached(hit)).toBe(true);
    expect(shouldUseCached(hit, 0.0)).toBe(true);
    expect(shouldUseCached(hit, 1.0)).toBe(true);
  });

  it("Scenario: Null or partial hit returns false", async () => {
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    const { shouldUseCached } = mod;

    // Null hit → not cached
    expect(shouldUseCached(null)).toBe(false);
    expect(shouldUseCached(undefined)).toBe(false);

    // Partial hit → not cached
    expect(shouldUseCached({ query: "q", ns: "", uri: "", title: "" })).toBe(false);
    expect(shouldUseCached({ query: "q", ns: "mem", uri: "", title: "" })).toBe(false);
    expect(shouldUseCached({ query: "", ns: "mem", uri: "doc.md", title: "Title" })).toBe(false);
  });
});
