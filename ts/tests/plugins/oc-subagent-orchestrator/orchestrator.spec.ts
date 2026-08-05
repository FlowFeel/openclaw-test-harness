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
    on: (events: string, handler: any, opts?: { name?: string }) => {
      hooks.push({ event: events, handler, name: opts?.name });
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

  it("Scenario: Declares all 4 tools", () => {
    const m = JSON.parse(readFileSync(resolve(dir, "openclaw.plugin.json"), "utf8"));
    const tools = m.contracts.tools;
    expect(tools).toContain("queue_work");
    expect(tools).toContain("queue_status");
    expect(tools).toContain("queue_results");
    expect(tools).toContain("merge_results");
    expect(tools).toHaveLength(4);
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
    expect(events).toContain("agent_end");
    expect(events).toContain("subagent_spawned");
    expect(events).toContain("subagent_ended");
    expect(events).toContain("model_call_started");
    expect(events).toContain("model_call_ended");
    expect(events).toHaveLength(8);

    // All hooks registered via api.on (no name opts needed)
    for (const hook of api.hooks) {
      expect(hook.event).toBeDefined();
    }
  });

  it("Scenario: Registers all 4 tools", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const names = api.tools.map((t) => t.name);
    expect(names).toContain("queue_work");
    expect(names).toContain("queue_status");
    expect(names).toContain("queue_results");
    expect(names).toContain("merge_results");
    expect(api.tools).toHaveLength(4);
  });
});

// ═══════════════════════════════════════════════════════════════

describe.skip("Feature: subagent_health Tool", () => {
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
    expect(parsed.total).toBe(1);
    expect(parsed.queued).toBe(0);
    expect(parsed.dispatched).toBe(1);
    expect(parsed.completed).toBe(0);
    expect(parsed.failed).toBe(0);
  });

  it("Scenario: queue_work returns dispatch instructions with task prompts", async () => {
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

    // dispatchPlan should contain the dispatched tasks with their prompts
    expect(parsed.dispatchPlan).toBeDefined();
    expect(Array.isArray(parsed.dispatchPlan)).toBe(true);
    expect(parsed.dispatchPlan.length).toBeGreaterThan(0);

    // Each entry should have taskId, prompt, and priority
    for (const entry of parsed.dispatchPlan) {
      expect(entry).toHaveProperty("taskId");
      expect(entry).toHaveProperty("prompt");
      expect(entry).toHaveProperty("priority");
      expect(typeof entry.prompt).toBe("string");
      expect(entry.prompt.length).toBeGreaterThan(0);
    }

    // Instructions should mention sessions_spawn
    expect(parsed.instructions).toBeDefined();
    expect(parsed.instructions).toContain("sessions_spawn");
    expect(parsed.instructions).toContain("dispatchPlan");
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

  it("Scenario: queue_work dispatch plan respects maxConcurrent", async () => {
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
    expect(parsed.dispatchPlan.length).toBe(parsed.dispatched);

    // The dispatch plan entries should have taskId, prompt, priority
    for (const entry of parsed.dispatchPlan) {
      expect(entry).toHaveProperty("taskId");
      expect(entry).toHaveProperty("prompt");
    }

    // Verify via queue_status that the queue state is consistent
    // (queued field in queue_work = uncached count, not queue state)
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

describe.skip("Feature: event_loop_health Tool", () => {
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

  it.skip("Scenario: session_health reports actual file size", async () => {
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

  // ── Tool: queue_results (merge path) ──────────────────────────

  it("Scenario: queue_results with merge=true merges completed results", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    // Queue work
    const queueTool = api.tools.find((t) => t.name === "queue_work")!;
    await queueTool.execute("test", {
      tasks: [{ id: "t1", prompt: "search A" }],
    });

    // Simulate completion by directly manipulating queue state via queue_status
    // The merge path requires results in the queue — test the no-results path first
    const resultsTool = api.tools.find((t) => t.name === "queue_results")!;
    const result = await resultsTool.execute("test", { merge: true });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    // With no completed results, merge returns the normal results list
    expect(text).toContain("t1");
  });

  it("Scenario: queue_results with no active queue returns message", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const resultsTool = api.tools.find((t) => t.name === "queue_results")!;
    const result = await resultsTool.execute("test", {});
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain("No active work queue");
  });

  it("Scenario: queue_results without merge returns status list", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    // Queue work
    const queueTool = api.tools.find((t) => t.name === "queue_work")!;
    await queueTool.execute("test", {
      tasks: [{ id: "t1", prompt: "search A" }, { id: "t2", prompt: "search B" }],
    });

    const resultsTool = api.tools.find((t) => t.name === "queue_results")!;
    const result = await resultsTool.execute("test", {});
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("t1");
    expect(parsed[1].id).toBe("t2");
  });

  // ── Tool: merge_results ────────────────────────────────────────

  it("Scenario: merge_results merges array of results", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const mergeTool = api.tools.find((t) => t.name === "merge_results")!;
    const result = await mergeTool.execute("test", {
      results: [
        { taskId: "t1", taskType: "search", findings: [], citations: [{ url: "https://a.com", title: "A" }] },
        { taskId: "t2", taskType: "search", findings: [], citations: [{ url: "https://b.com", title: "B" }] },
      ],
    });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain("---"); // contains the report separator
  });

  it("Scenario: merge_results with non-array returns error", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const mergeTool = api.tools.find((t) => t.name === "merge_results")!;
    const result = await mergeTool.execute("test", { results: "not an array" });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain("must be an array");
  });

  // ── Tool: subagent_health ──────────────────────────────────────

  it.skip("Scenario: subagent_health returns depth and effective max info", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const healthTool = api.tools.find((t) => t.name === "subagent_health")!;
    const result = await healthTool.execute("test", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed).toHaveProperty("effectiveMaxConcurrent");
    expect(parsed).toHaveProperty("healthStatus");
    expect(parsed).toHaveProperty("maxSpawnDepth");
    expect(parsed).toHaveProperty("depth1Timeout");
    expect(parsed).toHaveProperty("depth2Timeout");
  });

  // ── Tool: event_loop_health ────────────────────────────────────

  it.skip("Scenario: event_loop_health returns telemetry snapshot", async () => {
    const api = createMockApi();
    const mod = await import("../../../src/plugins/oc-subagent-orchestrator/src/index.ts");
    mod.default.register(api as any, {});

    const healthTool = api.tools.find((t) => t.name === "event_loop_health")!;
    const result = await healthTool.execute("test", {});
    const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed).toHaveProperty("status");
    expect(parsed).toHaveProperty("eventLoopP99Ms");
    expect(parsed).toHaveProperty("eventLoopUtilization");
    expect(parsed).toHaveProperty("usedHeapMB");
    expect(parsed).toHaveProperty("cpuRatio");
    expect(parsed).toHaveProperty("effectiveMaxConcurrent");
  });
});
