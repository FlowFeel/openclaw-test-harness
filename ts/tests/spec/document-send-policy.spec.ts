/**
 * Document send policy — pure logic tests.
 *
 * Tests the policy that computes gateway websocket send timeouts, retry
 * schedules, and chunk fallbacks for the message tool. Every test encodes
 * a behavior recommended in the Sunday postmortem.
 *
 * @dft
 * - A1: no I/O — pure function calls only.
 * - A2: deterministic — all inputs are parameters, no clocks or randomness.
 * - A6: planDocumentSend returns a plan with a rationale (the report).
 */
import { describe, it, expect } from "vitest";
import {
  computeWireBytes,
  resolveDocumentSendTimeout,
  resolveRetrySchedule,
  computeChunkPlan,
  planDocumentSend,
} from "../../src/plugins/shared/document-send-policy.js";

describe("computeWireBytes", () => {
  it("inflates by 4/3 for base64 encoding", () => {
    expect(computeWireBytes(300)).toBe(400); // 300 * 4/3 = 400
  });

  it("rounds up to the next byte", () => {
    expect(computeWireBytes(232_000)).toBe(Math.ceil((232_000 * 4) / 3)); // 309_334
    expect(computeWireBytes(1)).toBe(2); // ceil(4/3) = 2
  });

  it("returns 0 for zero or negative payload", () => {
    expect(computeWireBytes(0)).toBe(0);
    expect(computeWireBytes(-100)).toBe(0);
  });
});

describe("resolveDocumentSendTimeout", () => {
  it("uses 30s for text sends (the current default)", () => {
    expect(
      resolveDocumentSendTimeout({ forceDocument: false, payloadBytes: 500 }),
    ).toBe(30_000);
  });

  it("uses 90s for document sends (60-120s range)", () => {
    const timeout = resolveDocumentSendTimeout({
      forceDocument: true,
      payloadBytes: 232_000,
    });
    expect(timeout).toBe(90_000);
    expect(timeout).toBeGreaterThanOrEqual(60_000);
    expect(timeout).toBeLessThanOrEqual(120_000);
  });

  it("adds load headroom for concurrent gateway operations", () => {
    const timeout = resolveDocumentSendTimeout({
      forceDocument: true,
      payloadBytes: 232_000,
      concurrentLoad: 5,
    });
    // 90,000 + 5 × 15,000 = 165,000
    expect(timeout).toBe(165_000);
  });

  it("caps at maxTimeoutMs (180s) even under extreme load", () => {
    const timeout = resolveDocumentSendTimeout({
      forceDocument: true,
      payloadBytes: 232_000,
      concurrentLoad: 20,
    });
    // 90,000 + 20 × 15,000 = 390,000, capped at 180,000
    expect(timeout).toBe(180_000);
  });

  it("does not add load headroom for text sends", () => {
    const timeout = resolveDocumentSendTimeout({
      forceDocument: false,
      payloadBytes: 500,
      concurrentLoad: 10,
    });
    expect(timeout).toBe(30_000);
  });

  it("respects custom documentTimeoutMs", () => {
    const timeout = resolveDocumentSendTimeout({
      forceDocument: true,
      payloadBytes: 232_000,
      documentTimeoutMs: 120_000,
      concurrentLoad: 0,
    });
    expect(timeout).toBe(120_000);
  });

  it("treats negative concurrentLoad as zero", () => {
    const timeout = resolveDocumentSendTimeout({
      forceDocument: true,
      payloadBytes: 232_000,
      concurrentLoad: -5,
    });
    expect(timeout).toBe(90_000);
  });
});

describe("resolveRetrySchedule", () => {
  it("produces exponential backoff 30s → 60s → 120s for 3 attempts", () => {
    const schedule = resolveRetrySchedule();
    expect(schedule).toEqual([30_000, 60_000, 120_000]);
  });

  it("caps each delay at maxDelayMs", () => {
    const schedule = resolveRetrySchedule({
      attempts: 5,
      baseDelayMs: 30_000,
      maxDelayMs: 120_000,
    });
    // 30k, 60k, 120k, 120k (capped), 120k (capped)
    expect(schedule).toEqual([30_000, 60_000, 120_000, 120_000, 120_000]);
  });

  it("supports linear strategy", () => {
    const schedule = resolveRetrySchedule({
      attempts: 3,
      baseDelayMs: 30_000,
      strategy: "linear",
    });
    // 30k × 1, 30k × 2, 30k × 3
    expect(schedule).toEqual([30_000, 60_000, 90_000]);
  });

  it("returns empty array for zero attempts", () => {
    expect(resolveRetrySchedule({ attempts: 0 })).toEqual([]);
  });

  it("respects custom base delay", () => {
    const schedule = resolveRetrySchedule({
      attempts: 2,
      baseDelayMs: 10_000,
    });
    expect(schedule).toEqual([10_000, 20_000]);
  });
});

describe("computeChunkPlan", () => {
  it("does not chunk when no prior timeout", () => {
    const plan = computeChunkPlan({ payloadBytes: 232_000 });
    expect(plan.shouldChunk).toBe(false);
    expect(plan.chunkCount).toBe(1);
  });

  it("does not chunk when payload fits in one chunk", () => {
    const plan = computeChunkPlan({
      payloadBytes: 50_000,
      timedOutOnce: true,
    });
    expect(plan.shouldChunk).toBe(false);
    expect(plan.chunkCount).toBe(1);
  });

  it("chunks a 232KB file into 3 parts after a timeout", () => {
    const plan = computeChunkPlan({
      payloadBytes: 232_000,
      timedOutOnce: true,
    });
    expect(plan.shouldChunk).toBe(true);
    expect(plan.chunkCount).toBe(3); // ceil(232000 / 100000) = 3
    expect(plan.chunkSize).toBe(100_000);
    expect(plan.lastChunkSize).toBe(32_000); // 232000 - 2 × 100000
    expect(plan.totalBytes).toBe(232_000);
  });

  it("handles exact multiple of chunk size", () => {
    const plan = computeChunkPlan({
      payloadBytes: 200_000,
      timedOutOnce: true,
    });
    expect(plan.shouldChunk).toBe(true);
    expect(plan.chunkCount).toBe(2);
    expect(plan.lastChunkSize).toBe(100_000);
  });

  it("respects custom chunk size", () => {
    const plan = computeChunkPlan({
      payloadBytes: 232_000,
      chunkSizeBytes: 50_000,
      timedOutOnce: true,
    });
    expect(plan.chunkCount).toBe(5); // ceil(232000 / 50000) = 5
    expect(plan.lastChunkSize).toBe(32_000); // 232000 - 4 × 50000
  });

  it("includes a rationale string for logging", () => {
    const plan = computeChunkPlan({
      payloadBytes: 232_000,
      timedOutOnce: true,
    });
    expect(plan.rationale).toContain("prior timeout");
    expect(plan.rationale).toContain("3 chunks");
  });
});

describe("planDocumentSend", () => {
  it("the Sunday scenario: 232KB document under 5-subagent load", () => {
    const plan = planDocumentSend({
      forceDocument: true,
      payloadBytes: 232_000,
      concurrentLoad: 5,
    });

    // Timeout: 90s + 5×15s = 165s — well above the 30s that failed
    expect(plan.timeoutMs).toBe(165_000);
    // Retry: 3 attempts with exponential backoff
    expect(plan.retryScheduleMs).toEqual([30_000, 60_000, 120_000]);
    // No chunk fallback yet (first attempt)
    expect(plan.chunkFallback?.shouldChunk).toBe(false);
    // Wire bytes account for base64 inflation
    expect(plan.wireBytes).toBe(Math.ceil((232_000 * 4) / 3));
    // Rationale is present for postmortem logging
    expect(plan.rationale).toContain("document send");
    expect(plan.rationale).toContain("165000ms");
    expect(plan.rationale).toContain("5 concurrent ops");
  });

  it("the Sunday scenario after first timeout: chunk fallback kicks in", () => {
    const plan = planDocumentSend({
      forceDocument: true,
      payloadBytes: 232_000,
      concurrentLoad: 5,
      chunk: { timedOutOnce: true },
    });

    expect(plan.chunkFallback?.shouldChunk).toBe(true);
    expect(plan.chunkFallback?.chunkCount).toBe(3);
    expect(plan.rationale).toContain("chunk fallback");
  });

  it("text sends get 30s timeout, no chunk fallback, no load scaling", () => {
    const plan = planDocumentSend({
      forceDocument: false,
      payloadBytes: 500,
      concurrentLoad: 5,
    });

    expect(plan.timeoutMs).toBe(30_000);
    expect(plan.chunkFallback?.shouldChunk).toBe(false);
    expect(plan.rationale).toContain("text send");
    expect(plan.rationale).not.toContain("load-aware");
  });

  it("returns a rationale that captures every decision", () => {
    const plan = planDocumentSend({
      forceDocument: true,
      payloadBytes: 232_000,
      concurrentLoad: 3,
      chunk: { timedOutOnce: true },
    });

    expect(plan.rationale).toContain("document send");
    expect(plan.rationale).toContain("3 concurrent ops");
    expect(plan.rationale).toContain("retry");
    expect(plan.rationale).toContain("chunk fallback");
  });

  it("the current (broken) behavior: 30s for everything, no retries", () => {
    // This encodes what the message tool does TODAY (no policy): 30s timeout,
    // no retries, no chunking. The plan makes the gap explicit.
    const plan = planDocumentSend({
      forceDocument: true,
      payloadBytes: 232_000,
      concurrentLoad: 0,
      retry: { attempts: 0 },
    });

    expect(plan.timeoutMs).toBe(90_000); // policy already improves on 30s
    expect(plan.retryScheduleMs).toEqual([]); // but no retries if disabled
  });
});
