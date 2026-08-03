/**
 * Shared pure logic tests — tests against the shared/ copies.
 * This ensures the shared modules are covered (not just the oc-sidecar copies).
 */

import { describe, it, expect } from "vitest";
import {
  stripBloatFields,
  purgeStaleSubagents,
  computeCleanupReport,
  cleanupSessions,
  type SessionsMap,
} from "../../../src/plugins/shared/session-cleanup.js";
import {
  aggregateSystemHealth,
  type ProcessTelemetry,
} from "../../../src/plugins/shared/telemetry-logic.js";

const NOW = 2_000_000_000;

describe("shared/session-cleanup", () => {
  it("stripBloatFields removes bloat and preserves data", () => {
    const sessions: SessionsMap = {
      "s1": { compactionCheckpoints: "x".repeat(500), model: "test", updatedAt: NOW },
    };
    const { cleaned, strippedCount } = stripBloatFields(sessions, ["compactionCheckpoints"]);
    expect(cleaned.s1.compactionCheckpoints).toBeUndefined();
    expect(cleaned.s1.model).toBe("test");
    expect(strippedCount).toBe(1);
  });

  it("purgeStaleSubagents removes old subagents", () => {
    const sessions: SessionsMap = {
      "agent:main:subagent:old": { updatedAt: NOW - 20 * 3600000 },
      "agent:main:subagent:fresh": { updatedAt: NOW - 1000 },
      "agent:main:topic:1": { updatedAt: NOW - 100 * 3600000 },
    };
    const { cleaned, purgedKeys } = purgeStaleSubagents(sessions, {
      maxAgeHours: 15,
      nowMs: NOW,
    });
    expect(purgedKeys).toContain("agent:main:subagent:old");
    expect(cleaned["agent:main:subagent:fresh"]).toBeDefined();
    expect(cleaned["agent:main:topic:1"]).toBeDefined();
  });

  it("cleanupSessions full pipeline", () => {
    const sessions: SessionsMap = {
      "topic:1": { compactionCheckpoints: "x".repeat(1000), model: "test", updatedAt: NOW },
      "agent:subagent:stale": { status: "running", updatedAt: NOW - 30 * 3600000 },
    };
    const { report } = cleanupSessions(sessions, {
      bloatFields: ["compactionCheckpoints"],
      maxAgeHours: 15,
      nowMs: NOW,
    });
    expect(report.purgedCount).toBe(1);
    expect(report.strippedFieldCount).toBe(1);
    expect(report.reductionPercent).toBeGreaterThan(50);
  });

  it("computeCleanupReport handles empty input", () => {
    const report = computeCleanupReport({}, {}, 0);
    expect(report.reductionPercent).toBe(0);
    expect(report.beforeCount).toBe(0);
  });
});

describe("shared/telemetry-logic", () => {
  it("aggregateSystemHealth returns healthy for low metrics", () => {
    const reading: ProcessTelemetry = {
      actorId: "main",
      eventLoopP99Ms: 5,
      eventLoopUtilization: 0.05,
      usedHeapSize: 10 * 1024 * 1024,
      cpuRatio: 0.01,
    };
    const result = aggregateSystemHealth([reading], 0, 0);
    expect(result.status).toBe("healthy");
  });

  it("aggregateSystemHealth returns critical for high P99", () => {
    const reading: ProcessTelemetry = {
      actorId: "main",
      eventLoopP99Ms: 500,
      eventLoopUtilization: 0.1,
      usedHeapSize: 10 * 1024 * 1024,
      cpuRatio: 0.1,
    };
    const result = aggregateSystemHealth([reading], 0, 0);
    expect(result.status).toBe("critical");
  });

  it("aggregateSystemHealth handles empty readings", () => {
    const result = aggregateSystemHealth([], 0, 0);
    expect(result.status).toBe("healthy");
    expect(result.readings).toBe(0);
  });
});
