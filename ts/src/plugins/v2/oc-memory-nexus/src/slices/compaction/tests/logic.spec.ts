/**
 * Tier 1 Unit Spec: oc-memory-nexus / compaction slice.
 *
 * @dft Pure unit tests — verifies real trigger evaluation, M8 file deltas, and transcript sanitization.
 */

import { describe, it, expect } from "vitest";
import { createCompactionSliceState } from "../state.js";
import {
  evaluateCompactionCheck,
  recordCompactionCheckpoint,
  evaluateResumeDelta,
  runTranscriptSanitization,
  buildMemoryDistillTaskSpec,
  recordDistillationTask,
} from "../logic.js";

describe("oc-memory-nexus / slices/compaction (Tier 1 Unit)", () => {
  it("triggers compaction when byte size exceeds threshold and respects cooldown", () => {
    const cfg = {
      autoCompactionEnabled: true,
      autoCompactionThresholdMb: 2,
      maxTranscriptMb: 5,
      watchedPaths: [],
    };
    let state = createCompactionSliceState();

    const under = evaluateCompactionCheck(state, cfg, 500_000, 100_000);
    expect(under.decision.shouldTrigger).toBe(false);

    const over = evaluateCompactionCheck(under.nextState, cfg, 3 * 1024 * 1024, 200_000);
    state = over.nextState;
    expect(over.decision.shouldTrigger).toBe(true);

    // Within 120s cooldown
    const cooled = evaluateCompactionCheck(state, cfg, 3 * 1024 * 1024, 210_000);
    expect(cooled.decision.shouldTrigger).toBe(false);
    expect(cooled.decision.cooldownRemainingMs).toBeGreaterThan(0);
  });

  it("computes M8 file deltas across compaction checkpoints", () => {
    let state = createCompactionSliceState();
    const ck = recordCompactionCheckpoint(state, { "a.ts": 100, "b.ts": 100 }, 1000, "ckpt-1");
    state = ck.nextState;

    const delta = evaluateResumeDelta(state, { "a.ts": 200, "c.ts": 150 }, 5000);
    expect(delta.report.checkpointId).toBe("ckpt-1");
    expect(delta.report.modified).toEqual(["a.ts"]);
    expect(delta.report.added).toEqual(["c.ts"]);
    expect(delta.report.removed).toEqual(["b.ts"]);
    expect(delta.report.hasChanges).toBe(true);
  });

  it("sanitizes transcript lines and tracks removed lines when not dryRun", () => {
    const state = createCompactionSliceState();
    const lines = [
      JSON.stringify({ role: "user", content: "hi" }),
      JSON.stringify({ role: "toolResult", toolName: "process", content: [{ type: "text", text: "(no new output)" }] }),
      JSON.stringify({ role: "toolResult", toolName: "process", content: [{ type: "text", text: "(no new output)" }] }),
    ];
    const dry = runTranscriptSanitization(state, lines, true);
    expect(dry.report.originalEntries).toBe(3);
    expect(dry.nextState.totalSanitizedLinesRemoved).toBe(0);

    const live = runTranscriptSanitization(state, lines, false);
    expect(live.report.originalEntries).toBe(3);
    expect(live.nextState.totalSanitizedLinesRemoved).toBe(live.linesRemoved);
  });

  it("builds and records off-loop durable distillation task specs (Pillar 2)", () => {
    let state = createCompactionSliceState();
    const taskSpec = buildMemoryDistillTaskSpec({
      sessionKey: "agent:main:telegram:group:-1003842172831:topic:102248",
      targetDir: "meta/memory/topics/102248-cybernetics",
      targetFile: "meta/memory/topics/102248-cybernetics/MEMORY.md",
      topicId: 102248,
      transcriptTail: "line 1\nline 2",
    });

    expect(taskSpec.task_name).toBe("memory_distill");
    expect(taskSpec.params.session_key).toBe("agent:main:telegram:group:-1003842172831:topic:102248");
    expect(taskSpec.params.topic_id).toBe(102248);
    expect(taskSpec.params.target_dir).toBe("meta/memory/topics/102248-cybernetics");
    expect(taskSpec.params.target_file).toBe("meta/memory/topics/102248-cybernetics/MEMORY.md");
    expect(taskSpec.params.transcript_tail).toBe("line 1\nline 2");

    state = recordDistillationTask(state, taskSpec);
    expect(state.lastDistillationTask).toEqual(taskSpec);
    expect(state.emittedDistillationCount).toBe(1);
  });
});
