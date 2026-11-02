/**
 * unit-health-logic.spec.ts — unit tests for topic health telemetry & zombie detector (T-584).
 *
 * @behavior
 * Tests classification of unhealthy topics in the OC session registry:
 * - CRITICAL_CONTEXT_CEILING: contextTokens >= 240,000
 * - DEAD_TOPIC: status == "killed" or abortedLastRun == true
 * - ZOMBIE_RUNNING: status == "running" AND updatedAt older than 15 minutes
 * - UNCOMPACTED_BLOAT: active transcript .jsonl file larger than 2.0 MB
 * - Automated remediation recommendations ("sanitize_transcript", "materialize_successor")
 *
 * @dft
 * - 100% pure function tests: input data -> expected health verdicts & remedies.
 * - Deterministic: fixed nowMs injected.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateTopicSessionHealth,
  evaluateTopicsHealth,
  CONTEXT_CEILING_THRESHOLD,
  ZOMBIE_TIMEOUT_MS,
  UNCOMPACTED_BLOAT_BYTES,
} from "../../../src/plugins/oc-topic-manager/src/health-logic.js";
import type { SessionsMap } from "../../../src/plugins/shared/session-cleanup.js";

const NOW = 1_700_000_000_000;

describe("T-584: evaluateTopicSessionHealth", () => {
  it("returns null for a healthy done topic", () => {
    const entry = {
      status: "done",
      contextTokens: 50_000,
      abortedLastRun: false,
      updatedAt: NOW - 60_000,
    };
    const res = evaluateTopicSessionHealth(
      123,
      "agent:main:telegram:group:-100:topic:123",
      entry,
      500 * 1024,
      NOW
    );
    expect(res).toBeNull();
  });

  it("flags CRITICAL_CONTEXT_CEILING when contextTokens >= 240,000", () => {
    const entry = {
      status: "done",
      contextTokens: 262_144,
      abortedLastRun: false,
      updatedAt: NOW - 60_000,
    };
    const res = evaluateTopicSessionHealth(
      123,
      "agent:main:telegram:group:-100:topic:123",
      entry,
      500 * 1024,
      NOW
    );
    expect(res).not.toBeNull();
    expect(res?.verdicts).toContain("CRITICAL_CONTEXT_CEILING");
    expect(res?.remedy).toBe("materialize_successor");
  });

  it("flags DEAD_TOPIC when status == 'killed'", () => {
    const entry = {
      status: "killed",
      contextTokens: 10_000,
      abortedLastRun: false,
      updatedAt: NOW - 60_000,
    };
    const res = evaluateTopicSessionHealth(
      123,
      "agent:main:telegram:group:-100:topic:123",
      entry,
      500 * 1024,
      NOW
    );
    expect(res).not.toBeNull();
    expect(res?.verdicts).toContain("DEAD_TOPIC");
  });

  it("flags DEAD_TOPIC when abortedLastRun == true", () => {
    const entry = {
      status: "done",
      contextTokens: 10_000,
      abortedLastRun: true,
      updatedAt: NOW - 60_000,
    };
    const res = evaluateTopicSessionHealth(
      123,
      "agent:main:telegram:group:-100:topic:123",
      entry,
      500 * 1024,
      NOW
    );
    expect(res).not.toBeNull();
    expect(res?.verdicts).toContain("DEAD_TOPIC");
  });

  it("flags ZOMBIE_RUNNING when status == 'running' and updatedAt > 15m ago", () => {
    const entry = {
      status: "running",
      contextTokens: 10_000,
      abortedLastRun: false,
      updatedAt: NOW - (16 * 60 * 1000), // 16m ago
    };
    const res = evaluateTopicSessionHealth(
      123,
      "agent:main:telegram:group:-100:topic:123",
      entry,
      500 * 1024,
      NOW
    );
    expect(res).not.toBeNull();
    expect(res?.verdicts).toContain("ZOMBIE_RUNNING");
    expect(res?.remedy).toBe("sanitize_transcript");
  });

  it("does NOT flag ZOMBIE_RUNNING when status == 'running' but updatedAt is fresh (< 15m)", () => {
    const entry = {
      status: "running",
      contextTokens: 10_000,
      abortedLastRun: false,
      updatedAt: NOW - (5 * 60 * 1000), // 5m ago
    };
    const res = evaluateTopicSessionHealth(
      123,
      "agent:main:telegram:group:-100:topic:123",
      entry,
      500 * 1024,
      NOW
    );
    expect(res).toBeNull();
  });

  it("flags UNCOMPACTED_BLOAT when transcript file > 2.0 MB", () => {
    const entry = {
      status: "done",
      contextTokens: 50_000,
      abortedLastRun: false,
      updatedAt: NOW - 60_000,
    };
    const res = evaluateTopicSessionHealth(
      123,
      "agent:main:telegram:group:-100:topic:123",
      entry,
      2.5 * 1024 * 1024, // 2.5 MB
      NOW
    );
    expect(res).not.toBeNull();
    expect(res?.verdicts).toContain("UNCOMPACTED_BLOAT");
    expect(res?.remedy).toBe("sanitize_transcript");
  });

  it("flags multiple issues and prioritizes materialize_successor if context ceiling is reached", () => {
    const entry = {
      status: "killed",
      contextTokens: 250_000,
      abortedLastRun: true,
      updatedAt: NOW - 60_000,
    };
    const res = evaluateTopicSessionHealth(
      123,
      "agent:main:telegram:group:-100:topic:123",
      entry,
      3.0 * 1024 * 1024,
      NOW
    );
    expect(res).not.toBeNull();
    expect(res?.verdicts).toContain("CRITICAL_CONTEXT_CEILING");
    expect(res?.verdicts).toContain("DEAD_TOPIC");
    expect(res?.verdicts).toContain("UNCOMPACTED_BLOAT");
    expect(res?.remedy).toBe("materialize_successor");
  });
});

describe("T-584: evaluateTopicsHealth", () => {
  it("scans topic sessions and returns structured summary and counts", () => {
    const sessions: SessionsMap = {
      "agent:main:telegram:group:-100:topic:1": {
        status: "done",
        contextTokens: 262_144, // ceiling
        updatedAt: NOW - 1000,
      },
      "agent:main:telegram:group:-100:topic:2": {
        status: "running",
        updatedAt: NOW - (20 * 60 * 1000), // zombie
      },
      "agent:main:telegram:group:-100:topic:3": {
        status: "killed", // dead
        updatedAt: NOW - 1000,
      },
      "agent:main:telegram:group:-100:topic:4": {
        status: "done",
        contextTokens: 10_000,
        updatedAt: NOW - 1000,
      },
      // Non-topic session (should be ignored)
      "agent:main:main": {
        status: "running",
        updatedAt: NOW - (50 * 60 * 1000),
      },
    };

    const fileSizes = {
      "agent:main:telegram:group:-100:topic:4": 4 * 1024 * 1024, // bloat
    };

    const summary = evaluateTopicsHealth(sessions, fileSizes, NOW);

    expect(summary.totalScanned).toBe(4);
    expect(summary.flaggedCount).toBe(4);
    expect(summary.byIssue.CRITICAL_CONTEXT_CEILING).toBe(1);
    expect(summary.byIssue.ZOMBIE_RUNNING).toBe(1);
    expect(summary.byIssue.DEAD_TOPIC).toBe(1);
    expect(summary.byIssue.UNCOMPACTED_BLOAT).toBe(1);
    expect(summary.evaluations).toHaveLength(4);
  });
});
