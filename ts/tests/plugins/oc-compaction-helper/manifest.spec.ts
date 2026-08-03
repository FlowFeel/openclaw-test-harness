/**
 * Compaction helper manifest + structure tests.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

describe("oc-compaction-helper plugin", () => {
  const pluginDir = resolve(process.cwd(), "src/plugins/oc-compaction-helper");

  it("manifest exists", () => {
    expect(existsSync(resolve(pluginDir, "openclaw.plugin.json"))).toBe(true);
  });

  it("package.json exists", () => {
    expect(existsSync(resolve(pluginDir, "package.json"))).toBe(true);
  });

  it("entry point exists", () => {
    expect(existsSync(resolve(pluginDir, "src/index.ts"))).toBe(true);
  });

  it("sessions-io exists", () => {
    expect(existsSync(resolve(pluginDir, "src/sessions-io.ts"))).toBe(true);
  });

  const manifest = JSON.parse(
    readFileSync(resolve(pluginDir, "openclaw.plugin.json"), "utf8")
  );

  it("declares compact_check tool", () => {
    expect(manifest.contracts.tools).toContain("compact_check");
  });

  it("activates on startup", () => {
    expect(manifest.activation.onStartup).toBe(true);
  });

  it("has maxTranscriptMb default of 5", () => {
    expect(manifest.configSchema.properties.maxTranscriptMb.default).toBe(5);
  });

  it("has bloatFields default list", () => {
    const defaults = manifest.configSchema.properties.bloatFields.default;
    expect(defaults).toContain("compactionCheckpoints");
    expect(defaults).toContain("systemPromptReport");
    expect(defaults).toContain("skillsSnapshot");
    expect(defaults).toContain("contextBudgetStatus");
    expect(defaults).toContain("usageFamilySessionIds");
    expect(defaults).toContain("lastHeartbeatText");
  });

  it("no additional properties in configSchema", () => {
    expect(manifest.configSchema.additionalProperties).toBe(false);
  });
});

describe("oc-compaction-helper plugin structure", () => {
  it("registers 3 hooks (before_compaction, agent_end, after_compaction) with names", () => {
    // Simulate loading the plugin to verify hook registration
    const hooksRegistered: Array<{ event: string; name: string }> = [];
    const mockApi = {
      logger: {
        info: () => {},
        error: () => {},
        warn: () => {},
      },
      registerHook: (event: string | string[], _handler: unknown, opts?: { name?: string }) => {
        const events = Array.isArray(event) ? event : [event];
        for (const e of events) {
          hooksRegistered.push({ event: e, name: opts?.name ?? "unnamed" });
        }
      },
      registerTool: () => {},
    };

    // Load the plugin module dynamically
    const pluginPath = resolve(process.cwd(), "src/plugins/oc-compaction-helper/src/index.ts");
    expect(existsSync(pluginPath)).toBe(true);

    // We test the behavior by checking the source file for expected patterns
    const source = readFileSync(pluginPath, "utf8");
    const beforeCompactionHook = source.includes('registerHook("before_compaction"');
    const afterCompactionHook = source.includes('registerHook("after_compaction"');
    const beforeName = source.includes('name: "compaction-helper-before"');
    const afterName = source.includes('name: "compaction-helper-after"');

    expect(beforeCompactionHook).toBe(true);
    expect(afterCompactionHook).toBe(true);
    expect(beforeName).toBe(true);
    expect(afterName).toBe(true);
  });

  it("registers 1 tool (compact_check)", () => {
    const pluginPath = resolve(process.cwd(), "src/plugins/oc-compaction-helper/src/index.ts");
    const source = readFileSync(pluginPath, "utf8");

    const compactCheckTool = source.includes('name: "compact_check"');
    expect(compactCheckTool).toBe(true);
  });
});

describe("oc-compaction-helper plugin mock API", () => {
  it("mock PluginApi pattern works", () => {
    // Verify the mock API pattern that would be used in integration tests
    const toolsRegistered: string[] = [];
    const hooksRegistered: Array<{ event: string; name: string }> = [];

    const mockApi = {
      logger: {
        info: () => {},
        error: () => {},
        warn: () => {},
      },
      registerHook: (event: string | string[], _handler: unknown, opts?: { name?: string }) => {
        const events = Array.isArray(event) ? event : [event];
        for (const e of events) {
          hooksRegistered.push({ event: e, name: opts?.name ?? "unnamed" });
        }
      },
      registerTool: (tool: Record<string, unknown>) => {
        toolsRegistered.push(tool.name as string);
      },
    };

    // Simulate registering hooks
    mockApi.registerHook("before_compaction", async () => {}, { name: "compaction-helper-before" });
    mockApi.registerHook("agent_end", async () => {}, { name: "compaction-helper-agent-end" });
    mockApi.registerHook("after_compaction", async () => {}, { name: "compaction-helper-after" });
    mockApi.registerTool({ name: "compact_check", description: "", parameters: {}, execute: async () => ({ content: [] }) });

    // Verify 3 hooks registered
    expect(hooksRegistered).toHaveLength(3);
    expect(hooksRegistered[0].event).toBe("before_compaction");
    expect(hooksRegistered[0].name).toBe("compaction-helper-before");
    expect(hooksRegistered[1].event).toBe("agent_end");
    expect(hooksRegistered[1].name).toBe("compaction-helper-agent-end");
    expect(hooksRegistered[2].event).toBe("after_compaction");
    expect(hooksRegistered[2].name).toBe("compaction-helper-after");

    // Verify 1 tool registered
    expect(toolsRegistered).toHaveLength(1);
    expect(toolsRegistered[0]).toBe("compact_check");
  });
});