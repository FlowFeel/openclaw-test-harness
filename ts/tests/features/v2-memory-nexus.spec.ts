/**
 * Tier 3 BDD Spec: v2-memory-nexus.feature
 *
 * @dft Traceable Gherkin behavioral contract verified via InMemory* Protocol doubles.
 */

import { describe, it, expect } from "vitest";
import pluginDef from "../../src/plugins/v2/oc-memory-nexus/src/index.js";
import { InMemoryPluginApi } from "../doubles/in-memory-plugin-api.js";
import { InMemorySessionsStore } from "../doubles/in-memory-io.js";

describe("Feature: Plugins v2 Memory Nexus — Compaction, Sanitization, Recall & Off-Loop Sidecar", () => {
  it("Scenario: Compact check triggers when session exceeds threshold and enforces cooldown", async () => {
    const api = new InMemoryPluginApi();
    const sessions = new InMemorySessionsStore({
      "agent:main:s1": { sessionId: "s1", updatedAt: 1000, blob: "z".repeat(20_000) } as never,
    });
    let now = 100_000;
    pluginDef.register(api, {
      sessionsReader: sessions.read,
      autoCompactionThresholdMb: 0.01,
      clock: () => now,
    });

    const first = JSON.parse((await api.executeTool("compact_check")).content[0].text);
    expect(first.recommendation).toBe("compact");

    now += 10_000;
    const second = JSON.parse((await api.executeTool("compact_check")).content[0].text);
    expect(second.recommendation).toBe("healthy");
    expect(second.cooldownRemainingMs).toBeGreaterThan(0);
  });

  it("Scenario: M8 compact_delta reports files modified or added after before_compaction", async () => {
    const api = new InMemoryPluginApi();
    let mtimes: Record<string, number> = { "docs/a.md": 100 };
    let now = 10_000;
    pluginDef.register(api, {
      mtimeReader: () => ({ ...mtimes }),
      clock: () => now,
    });

    await api.dispatchHook("before_compaction");
    mtimes = { "docs/a.md": 200, "docs/b.md": 250 };
    now += 5000;

    const delta = JSON.parse((await api.executeTool("compact_delta")).content[0].text);
    expect(delta.deltaCount).toBe(2);
    expect(delta.modified).toEqual(["docs/a.md"]);
    expect(delta.added).toEqual(["docs/b.md"]);
  });

  it("Scenario: M1 event push enqueues matching memory cue into next turn", async () => {
    const api = new InMemoryPluginApi();
    pluginDef.register(api, {
      notesLoader: () => [
        {
          id: "deploy-rule",
          filePath: "memory/deploy.md",
          rawContent:
            "---\nkind: code_rule\nevent: staging_deploy\nuse_when: deploying\n" +
            "does_not_apply_when: local\nprovenance: spec\nsource: memory/deploy.md\n---\nVerify SHA.",
        },
      ],
    });

    await api.dispatchHook("gateway_start");
    await api.dispatchHook("after_tool_call", {
      toolName: "exec",
      params: { cmd: "staging_deploy" },
      sessionKey: "s1",
    });

    expect(api.injections).toHaveLength(1);
    expect(api.injections[0].text).toContain("MEMORY CUE");
  });
});
