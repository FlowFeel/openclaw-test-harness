/**
 * oc-topic-manager — sync-plan unit specs.
 *
 * @behavior
 * Exercises the sync decision core: registration gap (orphans), idle
 * staleness, healthy counts, and determinism with an injected `now`.
 *
 * @dft
 * - Pure: inputs in, SyncPlan out. No I/O, no mocks.
 * - Deterministic timestamps (fixed NOW injected).
 * - Unknown activity (empty lastActiveAt) is never stale.
 */

import { describe, it, expect } from "vitest";
import {
  buildSyncPlan,
  idleDaysFor,
  isStale,
  type SyncPlanConfig,
} from "../../../src/plugins/oc-topic-manager/src/sync-plan.js";
import type { SessionRegistration, TopicMeta } from "../../../src/plugins/oc-topic-manager/src/types.js";

const NOW_MS = Date.parse("2026-09-06T17:00:00Z");
const cfg = (over: Partial<SyncPlanConfig> = {}): SyncPlanConfig => ({
  maxIdleDays: 14,
  nowMs: NOW_MS,
  ...over,
});

const topic = (over: Partial<TopicMeta> = {}): TopicMeta => ({
  id: 82385,
  title: "Flow agent",
  messageCount: 10,
  lastActiveAt: "2026-09-06T10:00:00Z",
  pinned: false,
  ...over,
});

describe("idleDaysFor", () => {
  it("computes whole days (floor) between timestamp and now", () => {
    const twoWeeksAgo = new Date(NOW_MS - 14 * 86_400_000).toISOString();
    expect(idleDaysFor(twoWeeksAgo, NOW_MS)).toBe(14);
  });

  it("returns 0 for future or invalid timestamps", () => {
    expect(idleDaysFor(new Date(NOW_MS + 1000).toISOString(), NOW_MS)).toBe(0);
    expect(idleDaysFor("", NOW_MS)).toBe(0);
    expect(idleDaysFor("not-a-date", NOW_MS)).toBe(0);
  });
});

describe("isStale", () => {
  it("flags topics idle past the threshold", () => {
    const old = topic({ lastActiveAt: new Date(NOW_MS - 30 * 86_400_000).toISOString() });
    expect(isStale(old, cfg())).toBe(true);
  });

  it("keeps topics under the threshold healthy", () => {
    const recent = topic({ lastActiveAt: new Date(NOW_MS - 1000).toISOString() });
    expect(isStale(recent, cfg())).toBe(false);
  });

  it("never flags unknown activity as stale", () => {
    expect(isStale(topic({ lastActiveAt: "" }), cfg())).toBe(false);
  });

  it("respects the configured threshold", () => {
    const weekOld = topic({ lastActiveAt: new Date(NOW_MS - 7 * 86_400_000).toISOString() });
    expect(isStale(weekOld, cfg({ maxIdleDays: 3 }))).toBe(true);
    expect(isStale(weekOld, cfg({ maxIdleDays: 30 }))).toBe(false);
  });
});

describe("buildSyncPlan", () => {
  const registrations: SessionRegistration[] = [
    { topicId: 1, sessionKey: "agent:main:telegram:group:-100:topic:1" },
    { topicId: 82385, sessionKey: "agent:main:telegram:group:-100:topic:82385" },
    { topicId: 99999, sessionKey: "agent:main:telegram:group:-100:topic:99999" },
  ];

  it("reports unregistered forum topics as toRegister", () => {
    const topics = [topic({ id: 1 }), topic({ id: 82385, title: "Flow agent" })];
    const plan = buildSyncPlan(topics, registrations, cfg());
    expect(plan.toRegister).toEqual([]);
  });

  it("flags an entirely missing registration", () => {
    const topics = [topic({ id: 1 }), topic({ id: 55555, title: "Unregistered" })];
    const plan = buildSyncPlan(topics, registrations, cfg());
    expect(plan.toRegister.map((t) => t.id)).toEqual([55555]);
  });

  it("separates stale from healthy registered topics", () => {
    const topics = [
      topic({ id: 1, lastActiveAt: new Date(NOW_MS - 30 * 86_400_000).toISOString() }),
      topic({ id: 82385, lastActiveAt: new Date(NOW_MS - 1000).toISOString() }),
    ];
    const plan = buildSyncPlan(topics, registrations, cfg());
    expect(plan.stale.map((s) => s.topic.id)).toEqual([1]);
    expect(plan.stale[0].idleDays).toBe(30);
    expect(plan.healthyCount).toBe(1);
    expect(plan.totalTopics).toBe(2);
  });

  it("counts only registered non-stale topics as healthy", () => {
    const topics = [
      topic({ id: 1, lastActiveAt: new Date(NOW_MS - 30 * 86_400_000).toISOString() }),
      topic({ id: 82385, lastActiveAt: new Date(NOW_MS - 1000).toISOString() }),
      topic({ id: 77777, title: "Ghost" }),
    ];
    const plan = buildSyncPlan(topics, registrations, cfg());
    expect(plan.healthyCount).toBe(1);
    expect(plan.registeredCount).toBe(3);
  });

  it("is deterministic across calls with the same inputs", () => {
    const topics = [topic({ id: 1, lastActiveAt: "" }), topic({ id: 82385 })];
    const a = buildSyncPlan(topics, registrations, cfg());
    const b = buildSyncPlan(topics, registrations, cfg());
    expect(a).toEqual(b);
  });
});