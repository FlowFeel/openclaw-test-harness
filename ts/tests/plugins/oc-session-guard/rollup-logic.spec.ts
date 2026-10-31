/**
 * Unit tests for transient step rollup logic (T-583).
 *
 * @dft
 * - Pure logic: zero fixtures, inline data, deterministic.
 * - Covers burst segmentation, atomic summary formatting, transcript
 *   rollup transformation, and per-turn burst tracking.
 */

import { describe, it, expect } from "vitest";
import {
  segmentTransientBursts,
  rollupTransientSteps,
  formatRollupSummary,
  formatToolCounts,
  extractEntryText,
  extractEntryToolName,
  isToolResultEntry,
  isTransientToolName,
  createTurnBurstTracker,
  recordToolResultForRollup,
  finalizeTurnRollup,
  ROLLUP_TOOL_NAME,
  DEFAULT_TRANSIENT_TOOLS,
} from "../../../src/plugins/oc-session-guard/src/rollup-logic.js";

/** Builds a toolResult transcript entry. */
function tr(toolName: string, text: string) {
  return { role: "toolResult", toolName, content: [{ type: "text", text }] };
}

/** Builds a long run of transient tool results. */
function burst(toolName: string, n: number, prefix = "result"): unknown[] {
  return Array.from({ length: n }, (_, i) => tr(toolName, `${prefix} ${i + 1}`));
}

describe("entry normalization", () => {
  it("extracts tool names from direct and nested forms", () => {
    expect(extractEntryToolName(tr("exec", "x"))).toBe("exec");
    expect(extractEntryToolName({ message: { toolName: "read" } })).toBe("read");
    expect(extractEntryToolName({ content: "no tool" })).toBeUndefined();
    expect(extractEntryToolName("not an object")).toBeUndefined();
  });

  it("extracts text from string and content-array forms", () => {
    expect(extractEntryText({ content: "plain" })).toBe("plain");
    expect(extractEntryText(tr("exec", "chunk"))).toContain("chunk");
    expect(extractEntryText({ message: { content: [{ text: "nested" }] } })).toContain("nested");
    expect(extractEntryText(null)).toBe("");
  });

  it("classifies tool result entries", () => {
    expect(isToolResultEntry(tr("exec", "x"))).toBe(true);
    expect(isToolResultEntry({ role: "user", content: "hi" })).toBe(false);
    expect(isToolResultEntry({ toolName: "grep", content: "x" })).toBe(true);
    expect(isToolResultEntry("nope")).toBe(false);
  });

  it("matches transient tool names against the default set", () => {
    expect(isTransientToolName("exec", DEFAULT_TRANSIENT_TOOLS)).toBe(true);
    expect(isTransientToolName("task_output", DEFAULT_TRANSIENT_TOOLS)).toBe(true);
    expect(isTransientToolName("task_dispatch", DEFAULT_TRANSIENT_TOOLS)).toBe(false);
    expect(isTransientToolName(undefined, DEFAULT_TRANSIENT_TOOLS)).toBe(false);
  });
});

describe("segmentTransientBursts", () => {
  it("finds qualifying and non-qualifying bursts", () => {
    const entries = [
      { role: "user", content: "start" },
      ...burst("exec", 3),
      { role: "assistant", content: "thinking" },
      ...burst("read", 6),
      tr("task_dispatch", "dispatched"),
    ];
    const segs = segmentTransientBursts(entries, { minBurstSize: 6 });
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ start: 1, endExclusive: 4, size: 3, rollup: false });
    expect(segs[1]).toMatchObject({ start: 5, endExclusive: 11, size: 6, rollup: true });
  });

  it("treats a different transient tool as a burst breaker only when non-transient", () => {
    // exec and read are both transient — one continuous burst across both.
    const entries = [...burst("exec", 2), ...burst("read", 4)];
    const segs = segmentTransientBursts(entries, { minBurstSize: 6 });
    expect(segs).toHaveLength(1);
    expect(segs[0].size).toBe(6);
    expect(segs[0].rollup).toBe(true);
  });

  it("breaks bursts on non-toolResult entries even from transient tools", () => {
    const entries = [...burst("exec", 2), { role: "assistant", content: "mid-turn reasoning" }, ...burst("exec", 2)];
    const segs = segmentTransientBursts(entries, { minBurstSize: 6 });
    expect(segs).toHaveLength(2);
    expect(segs[0].rollup).toBe(false);
    expect(segs[1].rollup).toBe(false);
  });

  it("returns no segments for an empty slice", () => {
    expect(segmentTransientBursts([], { minBurstSize: 1 })).toEqual([]);
  });

  it("honors a custom transient tool list", () => {
    const entries = [...burst("websearch", 2)];
    expect(segmentTransientBursts(entries, { minBurstSize: 2, transientTools: ["websearch"] })[0].rollup).toBe(true);
    // Not transient under the default set → no burst segments at all.
    expect(segmentTransientBursts(entries, { minBurstSize: 2 })).toEqual([]);
  });
});

describe("formatRollupSummary", () => {
  it("summarizes tool mix and preserves the final result tail", () => {
    const entries = [...burst("exec", 4), ...burst("read", 3, "file contents")];
    const summary = formatRollupSummary(entries, { tailChars: 50 });
    expect(summary).toContain("[oc-session-guard rollup]");
    expect(summary).toContain("7 transient discovery/inspection");
    expect(summary).toContain("exec×4, read×3");
    expect(summary).toContain("file contents 3");
  });

  it("truncates long final results to the tail", () => {
    const entries = [tr("exec", "x".repeat(500))];
    const summary = formatRollupSummary(entries, { tailChars: 20 });
    expect(summary).toContain("…");
    const shown = summary.match(/"([^"]*)"/)![1];
    expect(shown.length).toBeLessThanOrEqual(21); // ellipsis + 20
  });

  it("omits the tail part when the final result is empty", () => {
    const entries = [tr("grep", ""), tr("grep", "")];
    const summary = formatRollupSummary(entries);
    expect(summary).not.toContain("final result");
  });
});

describe("rollupTransientSteps", () => {
  it("squashes a qualifying burst into exactly one atomic summary entry", () => {
    const longResults = Array.from({ length: 6 }, (_, i) =>
      tr("exec", `step ${i + 1} output: ${"x".repeat(200)}`),
    );
    const entries = [
      { role: "user", content: "explore the repo" },
      ...longResults,
      { role: "assistant", content: "done exploring" },
    ];
    const { entries: next, report } = rollupTransientSteps(entries, { minBurstSize: 6 });
    expect(report.changed).toBe(true);
    expect(report.burstsRolled).toBe(1);
    expect(report.entriesRemoved).toBe(5);
    expect(next).toHaveLength(3); // user + summary + assistant
    const summaryEntry = next[1] as { toolName: string; role: string; content: Array<{ text: string }> };
    expect(summaryEntry.role).toBe("toolResult");
    expect(summaryEntry.toolName).toBe(ROLLUP_TOOL_NAME);
    expect(summaryEntry.content[0].text).toContain("[oc-session-guard rollup]");
    expect(report.summaries).toHaveLength(1);
    expect(report.charsAfter).toBeLessThan(report.charsBefore);
  });

  it("leaves non-qualifying bursts and other entries untouched", () => {
    const entries = [
      ...burst("exec", 2),
      { role: "user", content: "hi" },
      ...burst("read", 5),
    ];
    const { entries: next, report } = rollupTransientSteps(entries, { minBurstSize: 6 });
    expect(report.changed).toBe(false);
    expect(report.burstsRolled).toBe(0);
    expect(next).toEqual(entries);
  });

  it("rolls multiple independent qualifying bursts", () => {
    const entries = [
      ...burst("exec", 6),
      { role: "assistant", content: "phase 2" },
      ...burst("grep", 7),
    ];
    const { entries: next, report } = rollupTransientSteps(entries, { minBurstSize: 6 });
    expect(report.burstsRolled).toBe(2);
    expect(report.entriesRemoved).toBe(6 + 7 - 2);
    expect(next).toHaveLength(3);
  });

  it("never mutates its input array", () => {
    const entries = [...burst("exec", 6)];
    const snapshot = JSON.parse(JSON.stringify(entries));
    rollupTransientSteps(entries, { minBurstSize: 6 });
    expect(entries).toEqual(snapshot);
  });

  it("handles an empty slice", () => {
    const { entries: next, report } = rollupTransientSteps([]);
    expect(next).toEqual([]);
    expect(report.changed).toBe(false);
  });
});

describe("turn burst tracking", () => {
  it("accumulates transient steps and closes bursts on non-transient results", () => {
    let state = createTurnBurstTracker();
    for (let i = 0; i < 6; i++) {
      const r = recordToolResultForRollup(state, "exec");
      state = r.tracker;
      expect(r.counted).toBe(true);
    }
    const closed = recordToolResultForRollup(state, "task_dispatch");
    state = closed.tracker;
    expect(closed.counted).toBe(false);
    expect(state.currentBurst).toBe(0);
    expect(state.closedBursts).toBe(1);

    const fin = finalizeTurnRollup(state, { minBurstSize: 6 });
    expect(fin.shouldRollup).toBe(true);
    expect(fin.qualifyingBurstSizes).toEqual([6]);
    expect(fin.largestBurst).toBe(6);
    expect(fin.totalTransient).toBe(6);
  });

  it("does not flag small bursts as qualifying", () => {
    let state = createTurnBurstTracker();
    for (let i = 0; i < 3; i++) state = recordToolResultForRollup(state, "read").tracker;
    state = recordToolResultForRollup(state, "task_dispatch").tracker;
    const fin = finalizeTurnRollup(state, { minBurstSize: 6 });
    expect(fin.shouldRollup).toBe(false);
    expect(fin.totalBursts).toBe(1);
  });

  it("flags an open burst at finalize time", () => {
    let state = createTurnBurstTracker();
    for (let i = 0; i < 8; i++) state = recordToolResultForRollup(state, "grep").tracker;
    const fin = finalizeTurnRollup(state, { minBurstSize: 6 });
    expect(fin.shouldRollup).toBe(true);
    expect(fin.qualifyingBurstSizes).toEqual([8]);
  });

  it("tracking is pure: record returns a new state, input untouched", () => {
    const state = createTurnBurstTracker();
    const { tracker: next } = recordToolResultForRollup(state, "exec");
    expect(next.currentBurst).toBe(1);
    expect(state.currentBurst).toBe(0);
  });
});
