/**
 * Session cleanup tests — pure logic, no file system.
 *
 * @dft
 * - All functions are pure (input → output, no side effects)
 * - Deterministic: injected timestamp, no Date.now()
 * - No fixtures: data is inline
 * - Tests run in <1ms
 */

import { describe, it, expect } from "vitest";
import {
  stripBloatFields,
  purgeStaleSubagents,
  computeCleanupReport,
  cleanupSessions,
  type SessionsMap,
} from "../../../src/plugins/oc-sidecar/src/session-cleanup.js";

const NOW = 1_000_000_000; // Fixed timestamp
const HOUR_MS = 60 * 60 * 1000;

// ── Test data ──────────────────────────────────────────────────

function makeSessions(): SessionsMap {
  return {
    "agent:main:telegram:topic:1": {
      sessionId: "sess-1",
      updatedAt: NOW - 1000,
      sessionStartedAt: NOW - 5000,
      compactionCheckpoints: [{ checkpoint: "data" }],
      systemPromptReport: { tokens: 50000 },
      skillsSnapshot: ["skill1", "skill2"],
      model: "openrouter/test",
    },
    "agent:main:subagent:abc-123": {
      sessionId: "sub-1",
      updatedAt: NOW - 1000,
      sessionStartedAt: NOW - 2000,
      status: "running",
      model: "openrouter/test",
    },
    "agent:main:subagent:old-456": {
      sessionId: "sub-2",
      updatedAt: NOW - 20 * HOUR_MS, // 20h ago — stale
      sessionStartedAt: NOW - 25 * HOUR_MS,
      status: "running",
      model: "openrouter/test",
    },
    "agent:main:subagent:older-789": {
      sessionId: "sub-3",
      updatedAt: NOW - 30 * HOUR_MS, // 30h ago — stale
      sessionStartedAt: NOW - 35 * HOUR_MS,
      status: "running",
      compactionCheckpoints: [{ big: "blob" }], // has bloat too
    },
  };
}

const BLOAT_FIELDS = [
  "compactionCheckpoints",
  "systemPromptReport",
  "skillsSnapshot",
  "contextBudgetStatus",
  "usageFamilySessionIds",
  "lastHeartbeatText",
];

// ── stripBloatFields ──────────────────────────────────────────

describe("stripBloatFields", () => {
  it("removes bloat fields from all entries", () => {
    const sessions = makeSessions();
    const { cleaned, strippedCount } = stripBloatFields(sessions, BLOAT_FIELDS);

    expect(cleaned["agent:main:telegram:topic:1"].compactionCheckpoints).toBeUndefined();
    expect(cleaned["agent:main:telegram:topic:1"].systemPromptReport).toBeUndefined();
    expect(cleaned["agent:main:telegram:topic:1"].skillsSnapshot).toBeUndefined();
    expect(cleaned["agent:main:telegram:topic:1"].model).toBe("openrouter/test"); // kept
    expect(strippedCount).toBe(4); // 3 from topic:1 + 1 from older-789
  });

  it("does not mutate the original object", () => {
    const sessions = makeSessions();
    const original = JSON.stringify(sessions);
    stripBloatFields(sessions, BLOAT_FIELDS);
    expect(JSON.stringify(sessions)).toBe(original);
  });

  it("handles empty sessions", () => {
    const { cleaned, strippedCount } = stripBloatFields({}, BLOAT_FIELDS);
    expect(Object.keys(cleaned)).toHaveLength(0);
    expect(strippedCount).toBe(0);
  });

  it("handles entries without bloat fields", () => {
    const sessions: SessionsMap = {
      "sess-1": { model: "test", updatedAt: 123 },
    };
    const { cleaned, strippedCount } = stripBloatFields(sessions, BLOAT_FIELDS);
    expect(cleaned["sess-1"].model).toBe("test");
    expect(strippedCount).toBe(0);
  });
});

// ── purgeStaleSubagents ───────────────────────────────────────

describe("purgeStaleSubagents", () => {
  it("removes subagent entries older than maxAgeHours", () => {
    const sessions = makeSessions();
    const { cleaned, purgedKeys } = purgeStaleSubagents(sessions, {
      maxAgeHours: 15,
      nowMs: NOW,
    });

    expect(Object.keys(cleaned)).toHaveLength(2); // 4 - 2 stale
    expect(purgedKeys).toContain("agent:main:subagent:old-456");
    expect(purgedKeys).toContain("agent:main:subagent:older-789");
    expect(cleaned["agent:main:subagent:abc-123"]).toBeDefined(); // still fresh
    expect(cleaned["agent:main:telegram:topic:1"]).toBeDefined(); // not a subagent
  });

  it("does not purge non-subagent sessions regardless of age", () => {
    const sessions: SessionsMap = {
      "agent:main:telegram:topic:1": {
        updatedAt: NOW - 100 * HOUR_MS, // very old
      },
    };
    const { cleaned, purgedKeys } = purgeStaleSubagents(sessions, {
      maxAgeHours: 15,
      nowMs: NOW,
    });
    expect(Object.keys(cleaned)).toHaveLength(1);
    expect(purgedKeys).toHaveLength(0);
  });

  it("handles entries with missing timestamps", () => {
    const sessions: SessionsMap = {
      "agent:main:subagent:no-ts": {
        status: "running", // no updatedAt, no sessionStartedAt
      },
    };
    const { cleaned, purgedKeys } = purgeStaleSubagents(sessions, {
      maxAgeHours: 1,
      nowMs: NOW,
    });
    // Missing timestamps = 0 = very old = purged
    expect(purgedKeys).toContain("agent:main:subagent:no-ts");
    expect(Object.keys(cleaned)).toHaveLength(0);
  });
});

// ── computeCleanupReport ──────────────────────────────────────

describe("computeCleanupReport", () => {
  it("computes accurate size reduction", () => {
    const before: SessionsMap = {
      "sess-1": { compactionCheckpoints: "x".repeat(1000) },
    };
    const after: SessionsMap = {
      "sess-1": {},
    };
    const report = computeCleanupReport(before, after, 1);

    expect(report.beforeCount).toBe(1);
    expect(report.afterCount).toBe(1);
    expect(report.purgedCount).toBe(0);
    expect(report.strippedFieldCount).toBe(1);
    expect(report.beforeBytes).toBeGreaterThan(report.afterBytes);
    expect(report.reductionPercent).toBeGreaterThan(0);
  });

  it("reports 0% reduction when nothing changed", () => {
    const sessions: SessionsMap = { "sess-1": { model: "test" } };
    const report = computeCleanupReport(sessions, sessions, 0);
    expect(report.reductionPercent).toBe(0);
  });
});

// ── cleanupSessions (full pipeline) ───────────────────────────

describe("cleanupSessions", () => {
  it("strips bloat and purges stale in one pass", () => {
    const sessions = makeSessions();
    const { cleaned, report } = cleanupSessions(sessions, {
      bloatFields: BLOAT_FIELDS,
      maxAgeHours: 15,
      nowMs: NOW,
    });

    // 2 stale subagents purged
    expect(report.purgedCount).toBe(2);
    expect(Object.keys(cleaned)).toHaveLength(2); // topic:1 + abc-123

    // Bloat fields stripped
    expect(report.strippedFieldCount).toBe(4);
    expect(cleaned["agent:main:telegram:topic:1"].compactionCheckpoints).toBeUndefined();

    // Size reduction
    expect(report.reductionPercent).toBeGreaterThan(0);
  });

  it("preserves fresh subagents", () => {
    const sessions = makeSessions();
    const { cleaned } = cleanupSessions(sessions, {
      bloatFields: BLOAT_FIELDS,
      maxAgeHours: 15,
      nowMs: NOW,
    });
    expect(cleaned["agent:main:subagent:abc-123"]).toBeDefined();
  });
});
