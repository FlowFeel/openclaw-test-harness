/**
 * Tier 3 BDD Spec: v2-topic-aware-durable-memory.feature
 *
 * @dft Traceable Gherkin behavioral contract verified via InMemoryPluginApi Protocol double.
 */

import { describe, it, expect } from "vitest";
import pluginDef from "../../src/plugins/v2/oc-memory-nexus/src/index.js";
import { InMemoryPluginApi } from "../doubles/in-memory-plugin-api.js";
import type { MemoryDistillTaskSpec } from "../../src/plugins/v2/oc-memory-nexus/src/slices/compaction/state.js";

describe("Feature: Topic-Aware Durable Memory Architecture (Pillar 1 & Pillar 2)", () => {
  it("Scenario: Topic-scoped resolution for Telegram forum topic sessions", () => {
    const api = new InMemoryPluginApi();
    pluginDef.register(api, {});

    expect(api.memoryCapabilities).toHaveLength(1);
    const resolver = api.memoryCapabilities[0].flushPlanResolver;

    const plan = resolver({
      sessionKey: "agent:main:telegram:group:-1003842172831:topic:102248",
      topicName: "Cybernetics",
    });

    expect(plan.sessionType).toBe("topic");
    expect(plan.topicId).toBe(102248);
    expect(plan.topicSlug).toBe("cybernetics");
    expect(plan.targetPath).toBe("meta/memory/topics/102248-cybernetics/MEMORY.md");
    expect(plan.promptObjective).toContain("Topic-specific decisions");
  });

  it("Scenario: Monorepo platform lane and user persona resolution", () => {
    const api = new InMemoryPluginApi();
    pluginDef.register(api, {});

    const resolver = api.memoryCapabilities[0].flushPlanResolver;

    // Platform lane
    const platformPlan = resolver({
      sessionKey: "agent:main:platform:core",
      lane: "platform",
    });
    expect(platformPlan.sessionType).toBe("platform");
    expect(platformPlan.targetPath).toBe("meta/team/SPEC_LOG.md");
    expect(platformPlan.promptObjective).toContain("Architecture specs");

    // User persona lane
    const userPlan = resolver({
      sessionKey: "agent:main:direct:edphos",
      user: "edphos",
    });
    expect(userPlan.sessionType).toBe("user");
    expect(userPlan.user).toBe("edphos");
    expect(userPlan.targetPath).toBe("meta/memory/edphos/MEMORY.md");
    expect(userPlan.promptObjective).toContain("Personal preferences");
  });

  it("Scenario: Fallback unscoped resolution preserves daily note safety", () => {
    const api = new InMemoryPluginApi();
    const fixedIsoDate = new Date("2026-11-26T00:00:00Z").getTime();
    pluginDef.register(api, {
      clock: () => fixedIsoDate,
    });

    const resolver = api.memoryCapabilities[0].flushPlanResolver;
    const plan = resolver({});

    expect(plan.sessionType).toBe("fallback");
    expect(plan.targetPath).toBe("memory/2026-11-26.md");
    expect(plan.promptObjective).toContain("General daily activity log");
  });

  it("Scenario: Off-loop durable distillation dispatch in before_compaction", async () => {
    const api = new InMemoryPluginApi();
    const dispatchedTasks: MemoryDistillTaskSpec[] = [];

    const transcriptLines = [
      JSON.stringify({ role: "user", content: "Implement topic memory" }),
      JSON.stringify({ role: "assistant", content: "Working on topic 102248" }),
    ];

    pluginDef.register(api, {
      durableSpawner: (spec: MemoryDistillTaskSpec) => {
        dispatchedTasks.push(spec);
        return { ok: true, taskId: "distill-123" };
      },
      transcriptPathResolver: (key: string) => `/tmp/${key}.jsonl`,
      transcriptReader: () => transcriptLines,
    });

    const sessionKey = "agent:main:telegram:group:-1003842172831:topic:102248";
    const hookCtx = {
      sessionKey,
      topicId: 102248,
      topicName: "Cybernetics",
    };

    // Dispatch before_compaction hook
    const results = await api.dispatchHook("before_compaction", {}, hookCtx);

    expect(results).toHaveLength(1);
    expect(dispatchedTasks).toHaveLength(1);

    const task = dispatchedTasks[0];
    expect(task.task_name).toBe("memory_distill");
    expect(task.params.session_key).toBe(sessionKey);
    expect(task.params.topic_id).toBe(102248);
    expect(task.params.target_dir).toBe("meta/memory/topics/102248-cybernetics");
    expect(task.params.target_file).toBe("meta/memory/topics/102248-cybernetics/MEMORY.md");
    expect(task.params.transcript_tail).toContain("Implement topic memory");
  });
});
