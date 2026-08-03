/**
 * BDD tests for #24: Per-Topic Session Isolation.
 *
 * @dft
 * - Pure logic only — no I/O, no Date.now()
 * - Deterministic: no clock, no random
 * - All data inline
 * - Tests run in <5ms
 *
 * Pattern: Feature/Scenario
 */

import { describe, it, expect } from "vitest";
import {
  allocateBudget,
  canSpawnForTopic,
  borrowSlot,
  returnBorrowedSlot,
  computeTopicStats,
  getBottleneckTopic,
  type TopicBudget,
  type TopicStats,
} from "../../src/plugins/shared/topic-isolation.js";

// ═══════════════════════════════════════════════════════════════
// Feature: Budget Allocation
// ═══════════════════════════════════════════════════════════════

describe("Feature: Budget Allocation", () => {
  it("Scenario: Even split — 10 slots across 3 topics → 4, 3, 3", () => {
    const map = allocateBudget(["alpha", "beta", "gamma"], 10);

    expect(map.size).toBe(3);
    expect(map.get("alpha")!.maxConcurrent).toBe(4);
    expect(map.get("beta")!.maxConcurrent).toBe(3);
    expect(map.get("gamma")!.maxConcurrent).toBe(3);

    // All start inactive with no borrows
    for (const budget of map.values()) {
      expect(budget.activeCount).toBe(0);
      expect(budget.borrowed).toBe(0);
    }
  });

  it("Scenario: Single topic gets all slots", () => {
    const map = allocateBudget(["alpha"], 8);

    expect(map.size).toBe(1);
    expect(map.get("alpha")!.maxConcurrent).toBe(8);
    expect(map.get("alpha")!.activeCount).toBe(0);
    expect(map.get("alpha")!.borrowed).toBe(0);
  });

  it("Scenario: Many topics — 100 slots across 12 topics", () => {
    const topics = Array.from({ length: 12 }, (_, i) => `topic-${i + 1}`);
    const map = allocateBudget(topics, 100);

    expect(map.size).toBe(12);

    // 100 / 12 = 8 remainder 4 → first 4 get 9, rest get 8
    const expectedPerTopic = [9, 9, 9, 9, 8, 8, 8, 8, 8, 8, 8, 8];
    for (let i = 0; i < 12; i++) {
      expect(map.get(topics[i])!.maxConcurrent).toBe(expectedPerTopic[i]);
    }
  });

  it("Scenario: Zero maxConcurrent — all topics get 0", () => {
    const map = allocateBudget(["alpha", "beta"], 0);

    expect(map.get("alpha")!.maxConcurrent).toBe(0);
    expect(map.get("beta")!.maxConcurrent).toBe(0);
  });

  it("Scenario: Empty topic list returns empty map", () => {
    const map = allocateBudget([], 10);
    expect(map.size).toBe(0);
  });

  it("Scenario: maxConcurrent evenly divisible — all topics equal", () => {
    const map = allocateBudget(["a", "b", "c", "d"], 12);
    for (const budget of map.values()) {
      expect(budget.maxConcurrent).toBe(3);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Spawn Capacity Check
// ═══════════════════════════════════════════════════════════════

describe("Feature: Spawn Capacity Check", () => {
  it("Scenario: Has capacity — activeCount < maxConcurrent", () => {
    const budget: TopicBudget = {
      topic: "alpha",
      maxConcurrent: 4,
      activeCount: 2,
      borrowed: 0,
    };
    expect(canSpawnForTopic(budget)).toBe(true);
  });

  it("Scenario: At limit — activeCount === maxConcurrent blocks spawn", () => {
    const budget: TopicBudget = {
      topic: "alpha",
      maxConcurrent: 3,
      activeCount: 3,
      borrowed: 0,
    };
    expect(canSpawnForTopic(budget)).toBe(false);
  });

  it("Scenario: Over limit — activeCount > maxConcurrent blocks spawn", () => {
    const budget: TopicBudget = {
      topic: "alpha",
      maxConcurrent: 3,
      activeCount: 5,
      borrowed: 0,
    };
    expect(canSpawnForTopic(budget)).toBe(false);
  });

  it("Scenario: Borrowed slots increase effective capacity", () => {
    // maxConcurrent=3, borrowed=1 → effective=4, active=3 can still spawn
    const budget: TopicBudget = {
      topic: "alpha",
      maxConcurrent: 3,
      activeCount: 3,
      borrowed: 1,
    };
    expect(canSpawnForTopic(budget)).toBe(true);

    // active=4, borrowed=1 → effective=4, at limit
    const atLimit: TopicBudget = {
      topic: "alpha",
      maxConcurrent: 3,
      activeCount: 4,
      borrowed: 1,
    };
    expect(canSpawnForTopic(atLimit)).toBe(false);
  });

  it("Scenario: Zero maxConcurrent with no borrows blocks spawn", () => {
    const budget: TopicBudget = {
      topic: "alpha",
      maxConcurrent: 0,
      activeCount: 0,
      borrowed: 0,
    };
    expect(canSpawnForTopic(budget)).toBe(false);
  });

  it("Scenario: Zero maxConcurrent with borrowed slot allows one spawn", () => {
    const budget: TopicBudget = {
      topic: "alpha",
      maxConcurrent: 0,
      activeCount: 0,
      borrowed: 1,
    };
    expect(canSpawnForTopic(budget)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Slot Borrowing
// ═══════════════════════════════════════════════════════════════

describe("Feature: Slot Borrowing", () => {
  it("Scenario: Borrow from idle — from has available, to gains borrowed count", () => {
    const from: TopicBudget = {
      topic: "beta",
      maxConcurrent: 3,
      activeCount: 1,
      borrowed: 0,
    };
    const to: TopicBudget = {
      topic: "alpha",
      maxConcurrent: 3,
      activeCount: 3,
      borrowed: 0,
    };

    const result = borrowSlot(from, to);

    // from unchanged (we didn't lend a slot — we just allowed the borrow)
    expect(result.from.topic).toBe("beta");
    expect(result.from.maxConcurrent).toBe(3);
    expect(result.from.activeCount).toBe(1);
    expect(result.from.borrowed).toBe(0);

    // to gains a borrowed slot
    expect(result.to.topic).toBe("alpha");
    expect(result.to.maxConcurrent).toBe(3);
    expect(result.to.activeCount).toBe(3);
    expect(result.to.borrowed).toBe(1);
  });

  it("Scenario: Cannot borrow from a topic with no available slots", () => {
    const from: TopicBudget = {
      topic: "beta",
      maxConcurrent: 2,
      activeCount: 2, // at capacity
      borrowed: 0,
    };
    const to: TopicBudget = {
      topic: "alpha",
      maxConcurrent: 3,
      activeCount: 3,
      borrowed: 0,
    };

    expect(() => borrowSlot(from, to)).toThrow(
      'cannot borrow from "beta": no available slots'
    );
  });

  it("Scenario: Borrowed increments — multiple borrows from same donor", () => {
    const from: TopicBudget = {
      topic: "idle",
      maxConcurrent: 5,
      activeCount: 1, // 4 available
      borrowed: 0,
    };
    const to: TopicBudget = {
      topic: "busy",
      maxConcurrent: 3,
      activeCount: 3,
      borrowed: 1, // already has 1 borrowed
    };

    // First borrow
    const r1 = borrowSlot(from, to);
    expect(r1.to.borrowed).toBe(2);

    // Second borrow — should increment again
    const r2 = borrowSlot(from, r1.to);
    expect(r2.to.borrowed).toBe(3);
  });

  it("Scenario: Return borrowed slot decrements borrowed counter", () => {
    const budget: TopicBudget = {
      topic: "alpha",
      maxConcurrent: 3,
      activeCount: 3,
      borrowed: 2,
    };

    const result = returnBorrowedSlot(budget);
    expect(result.borrowed).toBe(1);
  });

  it("Scenario: Return borrowed slot never goes below 0", () => {
    const budget: TopicBudget = {
      topic: "alpha",
      maxConcurrent: 3,
      activeCount: 2,
      borrowed: 0,
    };

    const result = returnBorrowedSlot(budget);
    expect(result.borrowed).toBe(0); // floored
  });

  it("Scenario: Cannot borrow when from has zero maxConcurrent and is active", () => {
    const from: TopicBudget = {
      topic: "stuck",
      maxConcurrent: 0,
      activeCount: 0, // activeCount >= maxConcurrent → no available
      borrowed: 0,
    };
    const to: TopicBudget = {
      topic: "needy",
      maxConcurrent: 2,
      activeCount: 2,
      borrowed: 0,
    };

    expect(() => borrowSlot(from, to)).toThrow(
      'cannot borrow from "stuck": no available slots'
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Bottleneck Detection
// ═══════════════════════════════════════════════════════════════

describe("Feature: Bottleneck Detection", () => {
  it("Scenario: Identify busiest topic — alpha is over capacity", () => {
    const stats: TopicStats[] = [
      { topic: "alpha", active: 5, available: -1, borrowed: 0 },
      { topic: "beta", active: 2, available: 1, borrowed: 0 },
      { topic: "gamma", active: 1, available: 2, borrowed: 0 },
    ];

    const bottleneck = getBottleneckTopic(stats);
    expect(bottleneck).toBe("alpha");
  });

  it("Scenario: No bottleneck when all topics have capacity", () => {
    const stats: TopicStats[] = [
      { topic: "alpha", active: 2, available: 1, borrowed: 0 },
      { topic: "beta", active: 1, available: 2, borrowed: 0 },
      { topic: "gamma", active: 0, available: 3, borrowed: 0 },
    ];

    const bottleneck = getBottleneckTopic(stats);
    expect(bottleneck).toBeNull();
  });

  it("Scenario: Multiple active — find highest pressure topic", () => {
    const stats: TopicStats[] = [
      { topic: "alpha", active: 4, available: -1, borrowed: 0 },
      { topic: "beta", active: 5, available: -2, borrowed: 1 }, // most severe
      { topic: "gamma", active: 3, available: 0, borrowed: 0 },
    ];

    const bottleneck = getBottleneckTopic(stats);
    expect(bottleneck).toBe("beta");
  });

  it("Scenario: All equal available values return null (no clear bottleneck)", () => {
    const stats: TopicStats[] = [
      { topic: "alpha", active: 3, available: -1, borrowed: 0 },
      { topic: "beta", active: 3, available: -1, borrowed: 0 },
    ];

    const bottleneck = getBottleneckTopic(stats);
    expect(bottleneck).toBeNull();
  });

  it("Scenario: Empty stats array returns null", () => {
    expect(getBottleneckTopic([])).toBeNull();
  });

  it("Scenario: Single topic over capacity is correctly identified", () => {
    const stats: TopicStats[] = [
      { topic: "alpha", active: 5, available: -2, borrowed: 0 },
    ];

    const bottleneck = getBottleneckTopic(stats);
    expect(bottleneck).toBe("alpha");
  });

  it("Scenario: Single topic with capacity returns null", () => {
    const stats: TopicStats[] = [
      { topic: "alpha", active: 1, available: 2, borrowed: 0 },
    ];

    expect(getBottleneckTopic(stats)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Immutability
// ═══════════════════════════════════════════════════════════════

describe("Feature: Immutability", () => {
  it("Scenario: allocateBudget does not mutate the input topics array beyond reference", () => {
    const topics = ["alpha", "beta", "gamma"];
    const original = [...topics]; // snapshot values

    allocateBudget(topics, 10);

    // The array itself is not mutated (reference unchanged, same values)
    expect(topics).toEqual(original);
  });

  it("Scenario: borrowSlot returns new objects — originals unchanged", () => {
    const from: TopicBudget = {
      topic: "beta",
      maxConcurrent: 3,
      activeCount: 1,
      borrowed: 0,
    };
    const to: TopicBudget = {
      topic: "alpha",
      maxConcurrent: 3,
      activeCount: 3,
      borrowed: 0,
    };

    // Snapshot the originals
    const fromSnapshot = { ...from };
    const toSnapshot = { ...to };

    const result = borrowSlot(from, to);

    // Originals not mutated
    expect(from).toEqual(fromSnapshot);
    expect(to).toEqual(toSnapshot);

    // Result objects are new (not the same references)
    expect(result.from).not.toBe(from);
    expect(result.to).not.toBe(to);
  });

  it("Scenario: returnBorrowedSlot returns a new object", () => {
    const budget: TopicBudget = {
      topic: "alpha",
      maxConcurrent: 3,
      activeCount: 2,
      borrowed: 1,
    };
    const snapshot = { ...budget };

    const result = returnBorrowedSlot(budget);

    // Original not mutated
    expect(budget).toEqual(snapshot);

    // Result is a new object
    expect(result).not.toBe(budget);
  });

  it("Scenario: computeTopicStats does not mutate the budgets map", () => {
    const map = allocateBudget(["alpha", "beta"], 6);
    map.set("alpha", {
      topic: "alpha",
      maxConcurrent: 3,
      activeCount: 3,
      borrowed: 1,
    });
    map.set("beta", {
      topic: "beta",
      maxConcurrent: 3,
      activeCount: 1,
      borrowed: 0,
    });

    // Snapshot the map entries
    const snapshotAlpha = { ...map.get("alpha")! };
    const snapshotBeta = { ...map.get("beta")! };

    const stats = computeTopicStats(map);

    // Map entries not mutated
    expect(map.get("alpha")).toEqual(snapshotAlpha);
    expect(map.get("beta")).toEqual(snapshotBeta);

    // Stats array entries are new objects
    expect(stats).toHaveLength(2);
  });

  it("Scenario: allocateBudget returns a new Map with no shared references to inputs", () => {
    const topics = ["alpha", "beta"];
    const map = allocateBudget(topics, 6);

    // The returned map contains new TopicBudget objects
    for (const topic of topics) {
      const budget = map.get(topic);
      expect(budget).toBeDefined();
      // These are fresh objects, not references to anything external
      expect(typeof budget!.maxConcurrent).toBe("number");
    }

    // Modifying the original array should not affect the map
    topics.push("gamma");
    expect(map.has("gamma")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Integration — End-to-End Flow
// ═══════════════════════════════════════════════════════════════

describe("Feature: Integration — End-to-End Flow", () => {
  it("Scenario: Allocate, spawn, borrow, return — full lifecycle", () => {
    // 1. Allocate 6 slots across 2 topics
    const map = allocateBudget(["research", "analysis"], 6);
    expect(map.get("research")!.maxConcurrent).toBe(3);
    expect(map.get("analysis")!.maxConcurrent).toBe(3);

    // 2. Research spawns 3 subagents
    const researchBusy: TopicBudget = {
      ...map.get("research")!,
      activeCount: 3,
    };
    expect(canSpawnForTopic(researchBusy)).toBe(false); // at limit

    // 3. Analysis spawns 2 subagents
    const analysisActive: TopicBudget = {
      ...map.get("analysis")!,
      activeCount: 2,
    };
    expect(canSpawnForTopic(analysisActive)).toBe(true);

    // 4. Research borrows from analysis (analysis has 1 available)
    const borrowResult = borrowSlot(analysisActive, researchBusy);
    expect(borrowResult.to.borrowed).toBe(1);
    expect(canSpawnForTopic(borrowResult.to)).toBe(true); // can spawn one more via borrowed slot

    // 5. Research returns the borrowed slot
    const returned = returnBorrowedSlot(borrowResult.to);
    expect(returned.borrowed).toBe(0);
    expect(canSpawnForTopic(returned)).toBe(false); // back at limit

    // 6. Compute stats
    const combinedMap = new Map<string, TopicBudget>();
    combinedMap.set("research", returned);
    combinedMap.set("analysis", borrowResult.from);
    const stats = computeTopicStats(combinedMap);

    // Research: active=3, max=3, borrowed=0 → available=0
    expect(stats.find((s) => s.topic === "research")!.available).toBe(0);
    // Analysis: active=2, max=3, borrowed=0 → available=1
    expect(stats.find((s) => s.topic === "analysis")!.available).toBe(1);

    // No bottleneck (both have >=0 available)
    expect(getBottleneckTopic(stats)).toBeNull();
  });
});