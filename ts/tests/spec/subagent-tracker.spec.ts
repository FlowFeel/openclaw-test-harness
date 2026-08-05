/**
 * Subagent tracker pure-logic specs.
 *
 * @dft
 * - DETERMINISTIC: all functions are pure (input state → output state).
 * - No Date.now() — uses injected timestamps.
 * - No I/O — no file system, no network.
 * - State is immutable (each operation returns a new Map).
 */
import { describe, it, expect } from "vitest";
import {
  trackSpawn,
  trackEnd,
  detectStale,
  getActiveCount,
  canSpawn,
  type SubagentMap,
  type SubagentRecord,
} from "../../src/plugins/shared/subagent-tracker.js";

const NOW = 1_000_000;

function activeRecord(
  sessionKey: string,
  overrides: Partial<SubagentRecord> = {},
): Omit<SubagentRecord, "status" | "endedAtMs"> {
  return {
    sessionKey,
    startedAtMs: NOW,
    ...overrides,
  };
}

describe("trackSpawn", () => {
  it("adds a subagent as active", () => {
    const map: SubagentMap = new Map();
    const next = trackSpawn(map, activeRecord("sub:1"), NOW);
    expect(next.size).toBe(1);
    expect(next.get("sub:1")?.status).toBe("active");
    expect(next.get("sub:1")?.startedAtMs).toBe(NOW);
  });

  it("uses nowMs when startedAtMs is 0", () => {
    const next = trackSpawn(
      new Map(),
      { sessionKey: "sub:1", startedAtMs: 0 },
      NOW,
    );
    expect(next.get("sub:1")?.startedAtMs).toBe(NOW);
  });

  it("preserves provided startedAtMs when non-zero", () => {
    const next = trackSpawn(
      new Map(),
      { sessionKey: "sub:1", startedAtMs: 500 },
      NOW,
    );
    expect(next.get("sub:1")?.startedAtMs).toBe(500);
  });

  it("does not mutate the original map", () => {
    const original: SubagentMap = new Map();
    trackSpawn(original, activeRecord("sub:1"), NOW);
    expect(original.size).toBe(0);
  });

  it("overwrites an existing key", () => {
    const map = trackSpawn(new Map(), activeRecord("sub:1"), NOW);
    const next = trackSpawn(map, activeRecord("sub:1", { model: "gpt-4" }), NOW);
    expect(next.get("sub:1")?.model).toBe("gpt-4");
    expect(next.size).toBe(1);
  });

  it("preserves optional fields (model, provider, spawnedBy)", () => {
    const next = trackSpawn(
      new Map(),
      activeRecord("sub:1", { model: "claude", provider: "anthropic", spawnedBy: "main" }),
      NOW,
    );
    expect(next.get("sub:1")?.model).toBe("claude");
    expect(next.get("sub:1")?.provider).toBe("anthropic");
    expect(next.get("sub:1")?.spawnedBy).toBe("main");
  });
});

describe("trackEnd", () => {
  it("marks an active subagent as ended", () => {
    const map = trackSpawn(new Map(), activeRecord("sub:1"), NOW);
    const next = trackEnd(map, "sub:1", NOW + 5000);
    expect(next.get("sub:1")?.status).toBe("ended");
    expect(next.get("sub:1")?.endedAtMs).toBe(NOW + 5000);
  });

  it("does not mutate the original map", () => {
    const map = trackSpawn(new Map(), activeRecord("sub:1"), NOW);
    trackEnd(map, "sub:1", NOW + 5000);
    expect(map.get("sub:1")?.status).toBe("active");
  });

  it("is a no-op for an unknown key", () => {
    const map = trackSpawn(new Map(), activeRecord("sub:1"), NOW);
    const next = trackEnd(map, "unknown", NOW);
    expect(next.size).toBe(1);
    expect(next.get("sub:1")?.status).toBe("active");
  });

  it("preserves other fields when marking ended", () => {
    const map = trackSpawn(
      new Map(),
      activeRecord("sub:1", { model: "gpt-4" }),
      NOW,
    );
    const next = trackEnd(map, "sub:1", NOW + 1000);
    expect(next.get("sub:1")?.model).toBe("gpt-4");
    expect(next.get("sub:1")?.startedAtMs).toBe(NOW);
  });
});

describe("detectStale", () => {
  const TIMEOUT_S = 30; // 30 seconds

  it("marks active subagents past the timeout as stale", () => {
    const map = trackSpawn(
      new Map(),
      activeRecord("sub:old", { startedAtMs: NOW - 60_000 }),
      NOW,
    );
    const { stale, fresh, result } = detectStale(map, TIMEOUT_S, NOW);
    expect(stale.size).toBe(1);
    expect(stale.get("sub:old")?.status).toBe("stale");
    expect(fresh.size).toBe(0);
    expect(result.staleKeys).toContain("sub:old");
  });

  it("keeps active subagents within the timeout as fresh", () => {
    const map = trackSpawn(
      new Map(),
      activeRecord("sub:fresh", { startedAtMs: NOW - 10_000 }),
      NOW,
    );
    const { stale, fresh, result } = detectStale(map, TIMEOUT_S, NOW);
    expect(stale.size).toBe(0);
    expect(fresh.size).toBe(1);
    expect(result.staleKeys).toHaveLength(0);
  });

  it("never marks ended subagents as stale", () => {
    const map = trackEnd(
      trackSpawn(new Map(), activeRecord("sub:ended", { startedAtMs: NOW - 60_000 }), NOW - 60_000),
      "sub:ended",
      NOW - 50_000,
    );
    const { stale, fresh, result } = detectStale(map, TIMEOUT_S, NOW);
    expect(stale.size).toBe(0);
    expect(result.staleKeys).toHaveLength(0);
  });

  it("splits a mixed map correctly", () => {
    let map: SubagentMap = new Map();
    map = trackSpawn(map, activeRecord("sub:fresh", { startedAtMs: NOW - 5_000 }), NOW);
    map = trackSpawn(map, activeRecord("sub:stale", { startedAtMs: NOW - 60_000 }), NOW);
    map = trackSpawn(map, activeRecord("sub:ended", { startedAtMs: NOW - 60_000 }), NOW - 60_000);
    map = trackEnd(map, "sub:ended", NOW - 50_000);

    const { stale, fresh, result } = detectStale(map, TIMEOUT_S, NOW);
    expect(stale.size).toBe(1);
    expect(fresh.size).toBe(2); // fresh + ended
    expect(result.staleKeys).toEqual(["sub:stale"]);
    expect(result.activeCount).toBe(1); // only fresh active (ended doesn't count)
    expect(result.totalSpawned).toBe(3);
    expect(result.totalEnded).toBe(1);
  });

  it("handles an empty map", () => {
    const { stale, fresh, result } = detectStale(new Map(), TIMEOUT_S, NOW);
    expect(stale.size).toBe(0);
    expect(fresh.size).toBe(0);
    expect(result.staleKeys).toHaveLength(0);
    expect(result.activeCount).toBe(0);
  });
});

describe("getActiveCount", () => {
  it("counts only active subagents", () => {
    let map: SubagentMap = new Map();
    map = trackSpawn(map, activeRecord("sub:1"), NOW);
    map = trackSpawn(map, activeRecord("sub:2"), NOW);
    map = trackEnd(map, "sub:2", NOW + 1000);
    expect(getActiveCount(map)).toBe(1);
  });

  it("returns 0 for an empty map", () => {
    expect(getActiveCount(new Map())).toBe(0);
  });

  it("returns 0 when all are ended", () => {
    let map: SubagentMap = new Map();
    map = trackSpawn(map, activeRecord("sub:1"), NOW);
    map = trackEnd(map, "sub:1", NOW + 1000);
    expect(getActiveCount(map)).toBe(0);
  });
});

describe("canSpawn", () => {
  it("returns true when below the limit", () => {
    const map = trackSpawn(new Map(), activeRecord("sub:1"), NOW);
    expect(canSpawn(map, 3)).toBe(true);
  });

  it("returns false when at the limit", () => {
    let map: SubagentMap = new Map();
    map = trackSpawn(map, activeRecord("sub:1"), NOW);
    map = trackSpawn(map, activeRecord("sub:2"), NOW);
    map = trackSpawn(map, activeRecord("sub:3"), NOW);
    expect(canSpawn(map, 3)).toBe(false);
  });

  it("returns true for an empty map with non-zero limit", () => {
    expect(canSpawn(new Map(), 1)).toBe(true);
  });

  it("does not count ended subagents toward the limit", () => {
    let map: SubagentMap = new Map();
    map = trackSpawn(map, activeRecord("sub:1"), NOW);
    map = trackSpawn(map, activeRecord("sub:2"), NOW);
    map = trackSpawn(map, activeRecord("sub:3"), NOW);
    map = trackEnd(map, "sub:1", NOW + 1000);
    expect(canSpawn(map, 3)).toBe(true); // 2 active, 1 slot freed
  });
});
