/**
 * Subagent tracker tests — pure logic, no I/O.
 *
 * @dft: pure functions, deterministic timestamps, inline data.
 */

import { describe, it, expect } from "vitest";
import {
  trackSpawn,
  trackEnd,
  detectStale,
  getActiveCount,
  canSpawn,
  type SubagentMap,
} from "../../../src/plugins/oc-subagent-watchdog/src/subagent-tracker.js";

const NOW = 1_000_000_000;
const SEC = 1000;

describe("subagent-tracker", () => {
  it("trackSpawn adds a new subagent", () => {
    const map: SubagentMap = new Map();
    const next = trackSpawn(map, {
      sessionKey: "sub-1",
      startedAtMs: NOW,
    }, NOW);
    expect(next.size).toBe(1);
    expect(next.get("sub-1")?.status).toBe("active");
  });

  it("trackEnd marks a subagent as ended", () => {
    const map = trackSpawn(new Map(), {
      sessionKey: "sub-1",
      startedAtMs: NOW,
    }, NOW);
    const next = trackEnd(map, "sub-1", NOW + 5000);
    expect(next.get("sub-1")?.status).toBe("ended");
    expect(next.get("sub-1")?.endedAtMs).toBe(NOW + 5000);
  });

  it("detectStale finds timed-out subagents", () => {
    let map: SubagentMap = new Map();
    // Fresh subagent (started 10s ago, timeout 300s)
    map = trackSpawn(map, { sessionKey: "fresh", startedAtMs: NOW - 10 * SEC }, NOW);
    // Stale subagent (started 400s ago, timeout 300s)
    map = trackSpawn(map, { sessionKey: "stale", startedAtMs: NOW - 400 * SEC }, NOW);

    const { stale, result } = detectStale(map, 300, NOW);
    expect(result.staleKeys).toContain("stale");
    expect(result.staleKeys).not.toContain("fresh");
    expect(stale.size).toBe(1);
  });

  it("detectStale ignores ended subagents", () => {
    let map: SubagentMap = new Map();
    map = trackSpawn(map, { sessionKey: "sub-1", startedAtMs: NOW - 400 * SEC }, NOW);
    map = trackEnd(map, "sub-1", NOW - 300 * SEC);

    const { result } = detectStale(map, 300, NOW);
    expect(result.staleKeys).toHaveLength(0);
    expect(result.totalEnded).toBe(1);
  });

  it("getActiveCount counts only active subagents", () => {
    let map: SubagentMap = new Map();
    map = trackSpawn(map, { sessionKey: "a", startedAtMs: NOW }, NOW);
    map = trackSpawn(map, { sessionKey: "b", startedAtMs: NOW }, NOW);
    map = trackEnd(map, "a", NOW + 1000);

    expect(getActiveCount(map)).toBe(1);
  });

  it("canSpawn returns false at capacity", () => {
    let map: SubagentMap = new Map();
    map = trackSpawn(map, { sessionKey: "a", startedAtMs: NOW }, NOW);
    map = trackSpawn(map, { sessionKey: "b", startedAtMs: NOW }, NOW);

    expect(canSpawn(map, 2)).toBe(false);
    expect(canSpawn(map, 3)).toBe(true);
  });

  it("trackSpawn does not mutate original map", () => {
    const map: SubagentMap = new Map();
    const next = trackSpawn(map, { sessionKey: "sub-1", startedAtMs: NOW }, NOW);
    expect(map.size).toBe(0);
    expect(next.size).toBe(1);
  });
});
