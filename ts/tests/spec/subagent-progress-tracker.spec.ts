/**
 * Subagent progress tracker — pure logic tests.
 *
 * Tests the heartbeat-based progress tracking that gives early warning of
 * stuck subagents (distinguishing "on track" from "stuck" before the run
 * timeout fires).
 *
 * @dft
 * - A1: no I/O — pure function calls only.
 * - A2: deterministic — all timestamps are injected parameters.
 * - A6: detectStuck returns a StuckDetectionResult (the report).
 */
import { describe, it, expect } from "vitest";
import {
  trackProgressStart,
  recordProgress,
  getProgress,
  isHeartbeatStale,
  interpolateProgress,
  computeProgressRate,
  detectStuck,
  DEFAULT_HISTORY_CAP,
  type ProgressMap,
} from "../../src/plugins/shared/subagent-progress-tracker.js";

const T0 = 1_000_000; // arbitrary base timestamp

describe("trackProgressStart", () => {
  it("registers a task with no heartbeat", () => {
    const map: ProgressMap = new Map();
    const next = trackProgressStart(map, "task:1", T0);

    expect(next.size).toBe(1);
    const record = next.get("task:1");
    expect(record?.startedAtMs).toBe(T0);
    expect(record?.heartbeatCount).toBe(0);
    expect(record?.lastHeartbeat).toBeUndefined();
    expect(record?.history).toEqual([]);
  });

  it("stores expectedDurationMs for interpolation", () => {
    const next = trackProgressStart(new Map(), "task:1", T0, 120_000);
    expect(next.get("task:1")?.expectedDurationMs).toBe(120_000);
  });

  it("does not mutate the original map", () => {
    const map: ProgressMap = new Map();
    trackProgressStart(map, "task:1", T0);
    expect(map.size).toBe(0);
  });
});

describe("recordProgress", () => {
  it("records a heartbeat on an existing task", () => {
    let map = trackProgressStart(new Map(), "task:1", T0);
    map = recordProgress(map, "task:1", 0.5, T0 + 60_000);

    const record = map.get("task:1");
    expect(record?.heartbeatCount).toBe(1);
    expect(record?.lastHeartbeat?.pct).toBe(0.5);
    expect(record?.lastHeartbeat?.ts).toBe(T0 + 60_000);
    expect(record?.history).toHaveLength(1);
  });

  it("creates a record defensively if trackProgressStart was not called", () => {
    const map = recordProgress(new Map(), "task:1", 0.3, T0);
    const record = map.get("task:1");
    expect(record?.heartbeatCount).toBe(1);
    expect(record?.lastHeartbeat?.pct).toBe(0.3);
    expect(record?.startedAtMs).toBe(T0);
  });

  it("clamps pct to [0, 1]", () => {
    let map = trackProgressStart(new Map(), "task:1", T0);
    map = recordProgress(map, "task:1", -0.5, T0 + 1000);
    expect(map.get("task:1")?.lastHeartbeat?.pct).toBe(0);

    map = recordProgress(map, "task:1", 1.5, T0 + 2000);
    expect(map.get("task:1")?.lastHeartbeat?.pct).toBe(1);
  });

  it("caps history to DEFAULT_HISTORY_CAP (20)", () => {
    let map = trackProgressStart(new Map(), "task:1", T0);
    for (let i = 1; i <= 25; i++) {
      map = recordProgress(map, "task:1", i / 100, T0 + i * 1000);
    }
    const record = map.get("task:1");
    expect(record?.heartbeatCount).toBe(25);
    expect(record?.history).toHaveLength(DEFAULT_HISTORY_CAP);
    // History keeps the most recent 20
    expect(record?.history[0]?.pct).toBe(6 / 100);
    expect(record?.history[record.history.length - 1]?.pct).toBe(25 / 100);
  });

  it("respects a custom historyCap", () => {
    let map = trackProgressStart(new Map(), "task:1", T0);
    for (let i = 1; i <= 5; i++) {
      map = recordProgress(map, "task:1", i / 10, T0 + i * 1000, { historyCap: 3 });
    }
    expect(map.get("task:1")?.history).toHaveLength(3);
  });

  it("does not mutate the original map", () => {
    let map = trackProgressStart(new Map(), "task:1", T0);
    const snapshot = new Map(map);
    recordProgress(map, "task:1", 0.5, T0 + 1000);
    expect(map.get("task:1")?.heartbeatCount).toBe(0);
    expect(snapshot.get("task:1")?.heartbeatCount).toBe(0);
  });
});

describe("getProgress", () => {
  it("returns the record for a tracked task", () => {
    const map = trackProgressStart(new Map(), "task:1", T0);
    expect(getProgress(map, "task:1")?.startedAtMs).toBe(T0);
  });

  it("returns undefined for an untracked task", () => {
    expect(getProgress(new Map(), "nope")).toBeUndefined();
  });
});

describe("isHeartbeatStale", () => {
  it("returns true for a task with no heartbeat", () => {
    const record = trackProgressStart(new Map(), "t", T0).get("t")!;
    expect(isHeartbeatStale(record, 60_000, T0 + 10_000)).toBe(true);
  });

  it("returns false for a recent heartbeat", () => {
    let map = trackProgressStart(new Map(), "t", T0);
    map = recordProgress(map, "t", 0.5, T0 + 30_000);
    const record = map.get("t")!;
    expect(isHeartbeatStale(record, 60_000, T0 + 50_000)).toBe(false);
  });

  it("returns true when heartbeat exceeds maxAgeMs", () => {
    let map = trackProgressStart(new Map(), "t", T0);
    map = recordProgress(map, "t", 0.5, T0 + 30_000);
    const record = map.get("t")!;
    expect(isHeartbeatStale(record, 60_000, T0 + 100_000)).toBe(true);
  });
});

describe("interpolateProgress", () => {
  it("uses the heartbeat pct when available", () => {
    let map = trackProgressStart(new Map(), "t", T0, 120_000);
    map = recordProgress(map, "t", 0.5, T0 + 60_000);
    expect(interpolateProgress(map.get("t")!, T0 + 90_000)).toBe(0.5);
  });

  it("interpolates from elapsed/expected when no heartbeat", () => {
    const map = trackProgressStart(new Map(), "t", T0, 120_000);
    // 60s elapsed of 120s expected → 0.5
    expect(interpolateProgress(map.get("t")!, T0 + 60_000)).toBe(0.5);
  });

  it("clamps interpolated progress to 1.0", () => {
    const map = trackProgressStart(new Map(), "t", T0, 120_000);
    // 200s elapsed of 120s → clamped to 1.0
    expect(interpolateProgress(map.get("t")!, T0 + 200_000)).toBe(1);
  });

  it("returns 0 when no heartbeat and no expectedDuration", () => {
    const map = trackProgressStart(new Map(), "t", T0);
    expect(interpolateProgress(map.get("t")!, T0 + 60_000)).toBe(0);
  });
});

describe("computeProgressRate", () => {
  it("returns 0 for fewer than 2 heartbeats", () => {
    let map = trackProgressStart(new Map(), "t", T0);
    map = recordProgress(map, "t", 0.3, T0 + 60_000);
    expect(computeProgressRate(map.get("t")!)).toBe(0);
  });

  it("computes pct-per-ms from the last two heartbeats", () => {
    let map = trackProgressStart(new Map(), "t", T0);
    map = recordProgress(map, "t", 0.2, T0 + 60_000);
    map = recordProgress(map, "t", 0.5, T0 + 120_000);
    // (0.5 - 0.2) / (120000 - 60000) = 0.3 / 60000 = 0.000005
    expect(computeProgressRate(map.get("t")!)).toBeCloseTo(0.3 / 60_000, 10);
  });

  it("returns 0 when two heartbeats have the same timestamp", () => {
    let map = trackProgressStart(new Map(), "t", T0);
    map = recordProgress(map, "t", 0.2, T0 + 60_000);
    map = recordProgress(map, "t", 0.5, T0 + 60_000);
    expect(computeProgressRate(map.get("t")!)).toBe(0);
  });

  it("detects a stalled task (rate 0, same pct)", () => {
    let map = trackProgressStart(new Map(), "t", T0);
    map = recordProgress(map, "t", 0.5, T0 + 60_000);
    map = recordProgress(map, "t", 0.5, T0 + 120_000);
    expect(computeProgressRate(map.get("t")!)).toBe(0);
  });
});

describe("detectStuck", () => {
  it("categorizes on-track tasks (recent heartbeat)", () => {
    let map = trackProgressStart(new Map(), "t1", T0);
    map = recordProgress(map, "t1", 0.5, T0 + 30_000);

    const result = detectStuck(map, 60_000, T0 + 40_000);
    expect(result.onTrackTaskIds).toEqual(["t1"]);
    expect(result.stuckTaskIds).toHaveLength(0);
    expect(result.totalTracked).toBe(1);
  });

  it("flags a stale heartbeat as stuck", () => {
    let map = trackProgressStart(new Map(), "t1", T0);
    map = recordProgress(map, "t1", 0.5, T0 + 30_000);

    // 100s after the heartbeat — exceeds 60s maxAge
    const result = detectStuck(map, 60_000, T0 + 130_000);
    expect(result.staleHeartbeatTaskIds).toEqual(["t1"]);
    expect(result.stuckTaskIds).toEqual(["t1"]);
    expect(result.onTrackTaskIds).toHaveLength(0);
  });

  it("flags no-heartbeat tasks past the grace period as stuck", () => {
    const map = trackProgressStart(new Map(), "t1", T0);
    // Started 100s ago, no heartbeat, maxAge 60s → past grace → stuck
    const result = detectStuck(map, 60_000, T0 + 100_000);
    expect(result.noHeartbeatTaskIds).toEqual(["t1"]);
    expect(result.stuckTaskIds).toEqual(["t1"]);
  });

  it("does not flag no-heartbeat tasks within the grace period", () => {
    const map = trackProgressStart(new Map(), "t1", T0);
    // Started 30s ago, no heartbeat, maxAge 60s → within grace → not stuck
    const result = detectStuck(map, 60_000, T0 + 30_000);
    expect(result.noHeartbeatTaskIds).toEqual(["t1"]);
    expect(result.stuckTaskIds).toHaveLength(0);
  });

  it("categorizes a mixed set of tasks", () => {
    let map = trackProgressStart(new Map(), "onTrack", T0);
    map = recordProgress(map, "onTrack", 0.5, T0 + 30_000);

    let m2 = trackProgressStart(map, "staleBeat", T0);
    m2 = recordProgress(m2, "staleBeat", 0.3, T0 + 20_000);

    const m3 = trackProgressStart(m2, "noBeat", T0);

    // At T0 + 100s: onTrack heartbeat is 70s old (stale!), staleBeat is 80s old (stale), noBeat started 100s ago (past grace)
    const result = detectStuck(m3, 60_000, T0 + 100_000);
    expect(result.onTrackTaskIds).toHaveLength(0);
    expect(result.stuckTaskIds).toHaveLength(3);
    expect(result.staleHeartbeatTaskIds).toHaveLength(2); // onTrack + staleBeat
    expect(result.noHeartbeatTaskIds).toEqual(["noBeat"]);
    expect(result.totalTracked).toBe(3);
  });

  it("returns empty results for an empty map", () => {
    const result = detectStuck(new Map(), 60_000, T0);
    expect(result.stuckTaskIds).toHaveLength(0);
    expect(result.totalTracked).toBe(0);
  });
});
