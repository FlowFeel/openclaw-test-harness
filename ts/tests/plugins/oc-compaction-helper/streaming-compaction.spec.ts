/**
 * oc-compaction-helper — streaming compaction specs.
 *
 * @behavior
 * Verifies the segmented provider: segmentation boundaries, oversized
 * singletons, capped rolling merge with explicit elision, determinism,
 * refiner injection, refiner-failure degradation, and the core guarantee
 * that the summary is never empty (so OC never falls back to the
 * unbounded built-in summarizer).
 *
 * @dft
 * - Pure logic with an injectable async refiner; no network, no files.
 * - Synthetic transcripts sized to force multi-segment behavior.
 */

import { describe, it, expect } from "vitest";
import {
  segmentMessages,
  mergeRolling,
  streamingCompact,
  DEFAULT_SEGMENT_BUDGET_BYTES,
  DEFAULT_MAX_ROLLING_CHARS,
} from "../../../src/plugins/oc-compaction-helper/src/streaming-compaction-logic.js";

const userTurn = (text: string) => ({ role: "user", content: text });
const toolBloat = (bytes: number) => ({
  role: "tool",
  name: "exec",
  content: "x".repeat(bytes),
});

describe("segmentMessages", () => {
  it("returns a single segment when the transcript fits the budget", () => {
    const msgs = [userTurn("a"), userTurn("b"), userTurn("c")];
    const segments = segmentMessages(msgs, DEFAULT_SEGMENT_BUDGET_BYTES);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(3);
  });

  it("splits into multiple segments at the byte budget", () => {
    const msgs = [toolBloat(300_000), toolBloat(300_000), toolBloat(300_000)];
    const segments = segmentMessages(msgs, 400_000);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    // Every message is present exactly once across segments.
    const total = segments.reduce((n, s) => n + s.length, 0);
    expect(total).toBe(3);
  });

  it("never splits a message; an oversized message gets its own segment", () => {
    const big = toolBloat(900_000);
    const msgs = [userTurn("before"), big, userTurn("after")];
    const segments = segmentMessages(msgs, 400_000);
    // [before] [big] [after] — big cannot share a segment at this budget.
    const counts = segments.map((s) => s.length);
    expect(counts).toEqual([1, 1, 1]);
    expect(segments[1][0]).toBe(big);
  });

  it("handles empty input", () => {
    expect(segmentMessages([], 1000)).toEqual([]);
  });
});

describe("mergeRolling", () => {
  it("concatenates under the cap", () => {
    expect(mergeRolling("a", "b", 100)).toBe("a\n\nb");
  });

  it("elides with an explicit marker over the cap", () => {
    const rolling = "r".repeat(100);
    const section = "s".repeat(100);
    const merged = mergeRolling(rolling, section, 120);
    expect(merged.length).toBeLessThanOrEqual(120 + 200); // bounded + slack
    expect(merged).toContain("elided");
    expect(merged.startsWith("r")).toBe(true);
    expect(merged.endsWith("s")).toBe(true);
  });
});

describe("streamingCompact", () => {
  it("compacts a small transcript in one segment, deterministically", async () => {
    const msgs = [
      userTurn("Ship the plugin suite to the gateway"),
      toolBloat(50_000),
      { role: "assistant", content: "Installed and verified." },
    ];
    const a = await streamingCompact(msgs);
    const b = await streamingCompact(msgs);
    expect(a.segmentCount).toBe(1);
    expect(a.refinedSegments).toBe(0);
    expect(a.summary).toContain("Ship the plugin suite");
    expect(a.summary).toBe(b.summary);
    expect(a.reductionPercent).toBeGreaterThan(0);
  });

  it("streams a large transcript across segments with a non-empty capped summary", async () => {
    // ~1.5 MB synthetic transcript — larger than any single model call
    // budget, representative of the topic-70660 dead end.
    const msgs: unknown[] = [];
    for (let i = 0; i < 60; i++) {
      msgs.push(userTurn(`Deploy observatory step ${i}: run the SMW pass`));
      msgs.push(toolBloat(25_000));
    }
    const result = await streamingCompact(msgs, { segmentBudgetBytes: 400_000 });
    expect(result.segmentCount).toBeGreaterThanOrEqual(2);
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.summary).toContain("Deploy observatory step");
    expect(result.reductionPercent).toBeGreaterThan(80);
    // Rolling cap holds.
    const second = await streamingCompact(msgs, { segmentBudgetBytes: 400_000 });
    expect(second.summary).toBe(result.summary);
  });

  it("survives an oversized single message without throwing", async () => {
    const msgs = [toolBloat(900_000), userTurn("summarize this")];
    const result = await streamingCompact(msgs, { segmentBudgetBytes: 400_000 });
    expect(result.segmentCount).toBeGreaterThanOrEqual(2);
    expect(result.summary).toContain("summarize this");
    expect(result.summary.length).toBeLessThanOrEqual(
      DEFAULT_MAX_ROLLING_CHARS + 4096
    );
  });

  it("invokes the injected refiner per merge and reports refined segments", async () => {
    const msgs = [toolBloat(300_000), toolBloat(300_000), toolBloat(300_000)];
    const seen: Array<{ index: number; total: number; bounded: boolean }> = [];
    const result = await streamingCompact(msgs, {
      segmentBudgetBytes: 400_000,
      refine: async ({ section, previousSummary, index, total }) => {
        seen.push({
          index,
          total,
          bounded: section.length < 400_000 && previousSummary.length <= 120_000 + 4096,
        });
        return `refined ${index}`;
      },
    });
    expect(result.refinedSegments).toBe(3);
    expect(seen.every((s) => s.bounded)).toBe(true);
    expect(result.summary).toContain("refined 0");
    expect(result.summary).toContain("refined 2");
  });

  it("degrades to deterministic merge when the refiner fails — never empty", async () => {
    const msgs = [userTurn("keep me"), toolBloat(100_000)];
    const result = await streamingCompact(msgs, {
      refine: async () => {
        throw new Error("model unavailable");
      },
    });
    expect(result.refinedSegments).toBe(0);
    expect(result.summary).toContain("keep me");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("rolls previousSummary forward and stays non-empty on empty input", async () => {
    const withPrevious = await streamingCompact([], { previousSummary: "prior state" });
    expect(withPrevious.summary).toContain("prior state");
    expect(withPrevious.summary.length).toBeGreaterThan(0);
  });
});
