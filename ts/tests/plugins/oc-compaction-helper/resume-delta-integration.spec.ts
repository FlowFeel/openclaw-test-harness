/**
 * Resume Delta Integration Tests for oc-compaction-helper (M8).
 *
 * @dft
 * - Pure: mock PluginApi, injectable statReader, no disk I/O.
 * - Deterministic: mock clock, explicit hook triggers.
 * - Protocol double: mock PluginApi implementing typed hooks and enqueueNextTurnInjection.
 */

import { describe, it, expect } from "vitest";
import plugin from "../../../src/plugins/oc-compaction-helper/src/index.js";
import type { PluginApi, ToolDefinition } from "../../../src/plugins/shared/types.js";

function createMockPluginApi() {
  const hooks: Record<string, ((event: unknown) => Promise<unknown> | unknown)[]> = {};
  const tools = new Map<string, ToolDefinition>();
  const logs: { level: string; msg: string }[] = [];
  const enqueuedInjections: { text: string; idempotencyKey?: string }[] = [];

  const api: PluginApi = {
    logger: {
      info: (msg: string) => logs.push({ level: "info", msg }),
      error: (msg: string) => logs.push({ level: "error", msg }),
      warn: (msg: string) => logs.push({ level: "warn", msg }),
    },
    on: (hookName: string, handler: (event: any, ctx?: any) => Promise<unknown> | unknown) => {
      if (!hooks[hookName]) hooks[hookName] = [];
      hooks[hookName].push(handler);
    },
    registerHook: () => {},
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    },
    session: {
      workflow: {
        enqueueNextTurnInjection: async (params: { text: string; idempotencyKey?: string }) => {
          enqueuedInjections.push(params);
          return { enqueued: true, id: `inj-${enqueuedInjections.length}` };
        },
      },
    },
  };

  async function trigger(hookName: string, event: unknown = {}) {
    const handlers = hooks[hookName] ?? [];
    for (const h of handlers) {
      await h(event);
    }
  }

  return { api, hooks, tools, logs, enqueuedInjections, trigger };
}

describe("oc-compaction-helper M8 Resume Delta Integration", () => {
  it("registers compact_delta tool", () => {
    const harness = createMockPluginApi();
    plugin.register(harness.api, { watchPaths: ["/docs"] });

    expect(harness.tools.has("compact_delta")).toBe(true);
    expect(harness.tools.has("compact_check")).toBe(true);
  });

  it("reports no snapshot before compaction occurs", async () => {
    const harness = createMockPluginApi();
    plugin.register(harness.api, { watchPaths: ["/docs"] });

    const tool = harness.tools.get("compact_delta")!;
    const res = await tool.execute("call-1", {});
    const parsed = JSON.parse(res.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.hasSnapshot).toBe(false);
  });

  it("captures snapshot on after_compaction and emits resume delta on before_prompt_build", async () => {
    const harness = createMockPluginApi();
    const mockFiles: Record<string, number> = {
      "/docs/note.md": 1000,
    };

    const mockStatReader = () => ({ ...mockFiles });

    plugin.register(harness.api, {
      watchPaths: ["/docs/note.md"],
      statReader: mockStatReader,
      trackResumeDeltas: true,
      sessionsPath: "/tmp/non-existent-sessions.json",
    });

    // 1. Compaction occurs -> captures snapshot
    await harness.trigger("after_compaction", {});

    // Verify snapshot exists via compact_delta
    const tool = harness.tools.get("compact_delta")!;
    const res1 = await tool.execute("call-1", {});
    const parsed1 = JSON.parse(res1.content[0].text);
    expect(parsed1.hasSnapshot).toBe(true);
    expect(parsed1.hasChanges).toBe(false);

    // 2. Turn 1 before prompt build: no changes -> no injection
    await harness.trigger("before_prompt_build", {});
    expect(harness.enqueuedInjections).toHaveLength(0);

    // 3. File changes before resume / turn 2
    mockFiles["/docs/note.md"] = 2500;

    // Turn 2 before prompt build: modified file detected -> injection emitted
    await harness.trigger("before_prompt_build", {});
    expect(harness.enqueuedInjections).toHaveLength(1);
    expect(harness.enqueuedInjections[0].text).toContain("# [RESUME STATE DELTA]");
    expect(harness.enqueuedInjections[0].text).toContain("• /docs/note.md");
    expect(harness.enqueuedInjections[0].idempotencyKey).toContain("m8-delta-");

    // 4. Turn 3 before prompt build with SAME file stats -> duplicate suppressed
    await harness.trigger("before_prompt_build", {});
    expect(harness.enqueuedInjections).toHaveLength(1); // Still 1

    // 5. Query compact_delta tool -> reflects modified state
    const res2 = await tool.execute("call-2", {});
    const parsed2 = JSON.parse(res2.content[0].text);
    expect(parsed2.hasChanges).toBe(true);
    expect(parsed2.modified).toEqual(["/docs/note.md"]);
  });
});
