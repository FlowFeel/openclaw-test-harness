/**
 * oc-topic-worker-pool pure logic unit tests.
 *
 * @dft
 * - Pure: inline data, zero fixtures, no filesystem.
 * - Deterministic: no Date.now(), no Math.random().
 */

import { describe, it, expect } from "vitest";
import {
  createSemaphore,
  acquire,
  release,
  getStats,
  isFull,
  hasCapacity,
  type SemaphoreState,
} from "../src/topic-worker-pool-logic.js";
import {
  parseTopicSessionKey,
  routeTopic,
  buildDedupKey,
  decideDispatch,
  hashContent,
  type TopicRoutingConfig,
} from "../src/topic-worker-pool-logic.js";

const NOW = 2_000_000_000;

// ── Semaphore tests ─────────────────────────────────────────────────────

describe("semaphore (pure logic)", () => {
  it("creates a semaphore with the given max", () => {
    const state = createSemaphore(3);
    expect(state.max).toBe(3);
    expect(state.active).toBe(0);
    expect(state.totalAcquired).toBe(0);
    expect(state.totalReleased).toBe(0);
    expect(state.totalWaited).toBe(0);
    expect(state.peakActive).toBe(0);
  });

  it("throws on invalid max", () => {
    expect(() => createSemaphore(0)).toThrow();
    expect(() => createSemaphore(-1)).toThrow();
    expect(() => createSemaphore(1.5)).toThrow();
    expect(() => createSemaphore(NaN)).toThrow();
  });

  it("acquires slots up to max", () => {
    const state = createSemaphore(2);
    const r1 = acquire(state);
    expect(r1.action).toBe("acquired");
    expect(state.active).toBe(1);

    const r2 = acquire(state);
    expect(r2.action).toBe("acquired");
    expect(state.active).toBe(2);

    expect(state.totalAcquired).toBe(2);
    expect(state.peakActive).toBe(2);
  });

  it("queues when pool is full", () => {
    const state = createSemaphore(1);
    acquire(state); // fill the pool

    const r2 = acquire(state);
    expect(r2.action).toBe("queued");
    expect(r2.waiterId).toBe(2);
    expect(state.active).toBe(1); // still 1 — the waiter hasn't been given a slot
    expect(state.totalWaited).toBe(1);
  });

  it("tracks peak active", () => {
    const state = createSemaphore(5);
    acquire(state);
    acquire(state);
    acquire(state);
    expect(state.peakActive).toBe(3);
    release(state);
    acquire(state);
    expect(state.peakActive).toBe(3); // peak doesn't decrease
  });

  it("releases slots", () => {
    const state = createSemaphore(2);
    acquire(state);
    acquire(state);

    const r = release(state);
    expect(r.action).toBe("released");
    expect(state.active).toBe(1);
    expect(state.totalReleased).toBe(1);
  });

  it("rejects double-release", () => {
    const state = createSemaphore(1);
    acquire(state);
    release(state);

    const r = release(state);
    expect(r.action).toBe("rejected");
    expect(r.reason).toContain("no active slots");
    expect(state.active).toBe(0);
  });

  it("isFull and hasCapacity are correct", () => {
    const state = createSemaphore(2);
    expect(isFull(state)).toBe(false);
    expect(hasCapacity(state)).toBe(true);

    acquire(state);
    acquire(state);
    expect(isFull(state)).toBe(true);
    expect(hasCapacity(state)).toBe(false);
  });

  it("getStats returns a snapshot", () => {
    const state = createSemaphore(4);
    acquire(state);
    acquire(state);

    const stats = getStats(state);
    expect(stats.active).toBe(2);
    expect(stats.max).toBe(4);
    expect(stats.available).toBe(2);
    expect(stats.utilization).toBe(0.5);
    expect(stats.totalAcquired).toBe(2);
    expect(stats.totalReleased).toBe(0);
    expect(stats.totalWaited).toBe(0);
    expect(stats.peakActive).toBe(2);
  });

  it("simulates a full acquire/release cycle", () => {
    const state = createSemaphore(2);

    // Two slots acquired
    acquire(state);
    acquire(state);
    expect(state.active).toBe(2);

    // Third is queued
    const r3 = acquire(state);
    expect(r3.action).toBe("queued");
    expect(state.totalWaited).toBe(1);

    // Release one — in the real wiring, this would resolve the waiter
    release(state);
    expect(state.active).toBe(1);

    // The pure logic doesn't auto-acquire for waiters — the wiring does.
    // But we can simulate: after release, the next acquire succeeds.
    const r4 = acquire(state);
    expect(r4.action).toBe("acquired");
    expect(state.active).toBe(2);
  });
});

// ── Topic routing tests ─────────────────────────────────────────────────

describe("topic routing (pure logic)", () => {
  it("parses a standard topic session key", () => {
    const result = parseTopicSessionKey("telegram:123:-100456:topic:789");
    expect(result).not.toBeNull();
    expect(result!.chatId).toBe("-100456");
    expect(result!.topicId).toBe("789");
    expect(result!.conversationId).toBe("-100456:topic:789");
  });

  it("parses a bare topic session key", () => {
    const result = parseTopicSessionKey("-100456:topic:789");
    expect(result).not.toBeNull();
    expect(result!.chatId).toBe("-100456");
    expect(result!.topicId).toBe("789");
  });

  it("returns null for non-topic sessions", () => {
    expect(parseTopicSessionKey("telegram:123:456")).toBeNull();
    expect(parseTopicSessionKey("telegram:123:-100456")).toBeNull();
    expect(parseTopicSessionKey("")).toBeNull();
    expect(parseTopicSessionKey("session-main")).toBeNull();
  });

  it("routes to default pool for unknown topics", () => {
    const config: TopicRoutingConfig = { defaultPool: "main" };
    const topic = parseTopicSessionKey("-100:topic:42")!;
    const route = routeTopic(topic, config);
    expect(route.pool).toBe("main");
    expect(route.isPriority).toBe(false);
    expect(route.isChatRoute).toBe(false);
    expect(route.isNonTopic).toBe(false);
  });

  it("routes to priority pool for specific topics", () => {
    const config: TopicRoutingConfig = {
      defaultPool: "main",
      priorityTopics: [{ topicId: "42", pool: "priority" }],
    };
    const topic = parseTopicSessionKey("-100:topic:42")!;
    const route = routeTopic(topic, config);
    expect(route.pool).toBe("priority");
    expect(route.isPriority).toBe(true);
  });

  it("routes to chat pool for all topics in a chat", () => {
    const config: TopicRoutingConfig = {
      defaultPool: "main",
      chatPools: [{ chatId: "-100", pool: "chat100" }],
    };
    const topic = parseTopicSessionKey("-100:topic:42")!;
    const route = routeTopic(topic, config);
    expect(route.pool).toBe("chat100");
    expect(route.isChatRoute).toBe(true);
  });

  it("priority takes precedence over chat routing", () => {
    const config: TopicRoutingConfig = {
      defaultPool: "main",
      priorityTopics: [{ topicId: "42", pool: "priority" }],
      chatPools: [{ chatId: "-100", pool: "chat100" }],
    };
    const topic = parseTopicSessionKey("-100:topic:42")!;
    const route = routeTopic(topic, config);
    expect(route.pool).toBe("priority");
    expect(route.isPriority).toBe(true);
    expect(route.isChatRoute).toBe(false);
  });

  it("routes non-topic sessions to default pool", () => {
    const config: TopicRoutingConfig = { defaultPool: "main" };
    const route = routeTopic(null, config);
    expect(route.pool).toBe("main");
    expect(route.isNonTopic).toBe(true);
  });
});

// ── Dedup key tests ─────────────────────────────────────────────────────

describe("dedup key (pure logic)", () => {
  it("builds a valid dedup key for topic sessions", () => {
    const topic = parseTopicSessionKey("-100:topic:42")!;
    const key = buildDedupKey(topic, "abc123");
    expect(key.valid).toBe(true);
    expect(key.key).toBe("-100:42:abc123");
  });

  it("returns invalid for non-topic sessions", () => {
    const key = buildDedupKey(null, "abc123");
    expect(key.valid).toBe(false);
    expect(key.key).toBe("");
  });

  it("hashContent is deterministic", () => {
    const h1 = hashContent("hello world");
    const h2 = hashContent("hello world");
    expect(h1).toBe(h2);
  });

  it("hashContent differs for different content", () => {
    const h1 = hashContent("hello world");
    const h2 = hashContent("hello earth");
    expect(h1).not.toBe(h2);
  });

  it("hashContent handles empty input", () => {
    expect(hashContent("")).toBe("empty");
    expect(hashContent("")).toBe("empty");
  });
});

// ── Dispatch decision tests ─────────────────────────────────────────────

describe("decideDispatch (pure logic)", () => {
  it("routes normal messages", () => {
    const topic = parseTopicSessionKey("-100:topic:42")!;
    const report = decideDispatch({
      topic,
      content: "hello",
      isDuplicate: false,
      pool: "main",
    });
    expect(report.action).toBe("route");
    expect(report.pool).toBe("main");
  });

  it("short-circuits duplicate messages", () => {
    const topic = parseTopicSessionKey("-100:topic:42")!;
    const report = decideDispatch({
      topic,
      content: "hello",
      isDuplicate: true,
      pool: "main",
    });
    expect(report.action).toBe("short-circuit");
    expect(report.reason).toBe("duplicate message");
  });

  it("skips empty content", () => {
    const topic = parseTopicSessionKey("-100:topic:42")!;
    const report = decideDispatch({
      topic,
      content: "   ",
      isDuplicate: false,
      pool: "main",
    });
    expect(report.action).toBe("skip");
    expect(report.reason).toBe("empty content");
  });

  it("skips empty string content", () => {
    const report = decideDispatch({
      topic: null,
      content: "",
      isDuplicate: false,
      pool: "main",
    });
    expect(report.action).toBe("skip");
  });

  it("routes non-topic sessions normally", () => {
    const report = decideDispatch({
      topic: null,
      content: "hello",
      isDuplicate: false,
      pool: "main",
    });
    expect(report.action).toBe("route");
  });
});
