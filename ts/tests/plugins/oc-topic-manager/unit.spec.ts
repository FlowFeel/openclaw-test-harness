/**
 * oc-topic-manager — pure-logic unit specs.
 *
 * @behavior
 * Exercises the pure core only: parse-topics, detect-orphans,
 * archival-policy, recovery-plan. No I/O, no OC API mocks.
 *
 * @dft
 * - Every case is a pure function call: input → expected output.
 * - Deterministic timestamps (fixed `now` injected).
 */

import { describe, it, expect } from "vitest";
import { parseTopics } from "../../../src/plugins/oc-topic-manager/src/parse-topics.js";
import { detectOrphans } from "../../../src/plugins/oc-topic-manager/src/detect-orphans.js";
import { decideArchival } from "../../../src/plugins/oc-topic-manager/src/archival-policy.js";
import { buildRecoveryPlan } from "../../../src/plugins/oc-topic-manager/src/recovery-plan.js";
import {
  applyRecoveryPlan,
  parseTopicSessionKey,
  registrationsFromSessions,
} from "../../../src/plugins/oc-topic-manager/src/apply-recovery.js";
import type {
  TopicMeta,
  SessionRegistration,
  RecoveryPlan,
} from "../../../src/plugins/oc-topic-manager/src/types.js";
import type { SessionsMap } from "../../../src/plugins/shared/session-cleanup.ts";

const NOW = Date.parse("2026-09-06T17:00:00Z");

const topic = (over: Partial<TopicMeta> = {}): TopicMeta => ({
  id: 82385,
  title: "Flow agent",
  messageCount: 10,
  lastActiveAt: "2026-09-06T10:00:00Z",
  pinned: false,
  ...over,
});

describe("parseTopics", () => {
  it("normalizes a Telegram forum topics payload", () => {
    const payload = {
      topics: [
        { message_thread_id: 82385, title: "Flow agent", message_count: 10, pinned: false },
        { message_thread_id: 73336, title: "Archived", message_count: 400, pinned: true },
      ],
    };
    const out = parseTopics(payload);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe(82385);
    expect(out[0].title).toBe("Flow agent");
    expect(out[1].pinned).toBe(true);
  });

  it("drops malformed entries instead of throwing", () => {
    const payload = { topics: [{ message_thread_id: "bogus" }, null, 42, { message_thread_id: 1, title: "ok" }] };
    const out = parseTopics(payload);
    expect(out.map((t) => t.id)).toEqual([1]);
  });

  it("returns empty array for garbage input", () => {
    expect(parseTopics(undefined)).toEqual([]);
    expect(parseTopics({ topics: "nope" })).toEqual([]);
  });

  it("accepts a bare topic array directly", () => {
    const out = parseTopics([{ message_thread_id: 5, title: "x", message_count: 1 }]);
    expect(out.map((t) => t.id)).toEqual([5]);
  });

  it("passes through a supplied lastActiveAt when the source derives it", () => {
    const out = parseTopics([
      { message_thread_id: 5, title: "x", message_count: 1, lastActiveAt: "2026-09-01T00:00:00Z" },
      { message_thread_id: 6, title: "y", message_count: 1, last_active_at: "2026-09-02T00:00:00Z" },
    ]);
    expect(out[0].lastActiveAt).toBe("2026-09-01T00:00:00Z");
    expect(out[1].lastActiveAt).toBe("2026-09-02T00:00:00Z");
  });

  it("leaves lastActiveAt empty when absent or unparseable (never fabricates it)", () => {
    const out = parseTopics([
      { message_thread_id: 5, title: "no field" },
      { message_thread_id: 6, title: "garbage", lastActiveAt: "not-a-date" },
      { message_thread_id: 7, title: "empty", lastActiveAt: "" },
    ]);
    expect(out.map((t) => t.lastActiveAt)).toEqual(["", "", ""]);
  });
});

describe("detectOrphans", () => {
  const sessions: SessionRegistration[] = [
    { topicId: 1, sessionKey: "agent:main:telegram:group:-100:topic:1" },
    { topicId: 99999, sessionKey: "agent:main:telegram:group:-100:topic:99999" },
  ];

  it("flags topics without a registration as orphaned", () => {
    const topics = [topic({ id: 1 }), topic({ id: 82385, title: "Flow agent" })];
    const report = detectOrphans(topics, sessions);
    expect(report.orphaned.map((t) => t.id)).toEqual([82385]);
  });

  it("flags registrations whose topic vanished as unregisteredSessions", () => {
    const topics = [topic({ id: 1 })];
    const report = detectOrphans(topics, sessions);
    expect(report.unregistered.map((s) => s.topicId)).toEqual([99999]);
  });

  it("returns empty lists when everything is registered", () => {
    const topics = [topic({ id: 1 })];
    const report = detectOrphans(topics, [sessions[0]]);
    expect(report.orphaned).toHaveLength(0);
    expect(report.unregistered).toHaveLength(0);
  });
});

describe("decideArchival", () => {
  const thresholds = { maxIdleDays: 14, maxMessages: 2000 };

  it("leaves a healthy active topic alone", () => {
    const t = topic({ lastActiveAt: "2026-09-05T10:00:00Z", messageCount: 10 });
    const d = decideArchival(t, NOW, thresholds);
    expect(d.action).toBe("leave");
  });

  it("archives an idle topic", () => {
    const t = topic({ lastActiveAt: "2026-08-01T10:00:00Z" });
    const d = decideArchival(t, NOW, thresholds);
    expect(d.action).toBe("archive");
    expect(d.reason).toMatch(/idle/i);
  });

  it("compacts an oversized topic", () => {
    const t = topic({ lastActiveAt: "2026-09-06T10:00:00Z", messageCount: 3000 });
    const d = decideArchival(t, NOW, thresholds);
    expect(d.action).toBe("compact");
  });

  it("prefers archive when both rules match", () => {
    const t = topic({ lastActiveAt: "2026-08-01T10:00:00Z", messageCount: 3000 });
    expect(decideArchival(t, NOW, thresholds).action).toBe("archive");
  });

  it("does NOT archive on unknown last activity — rule is unevaluated, not passed", () => {
    // Real Bot API payloads carry no per-topic last-activity field; a missing
    // source must never silently satisfy the idle rule.
    const t = topic({ lastActiveAt: "" });
    const d = decideArchival(t, NOW, thresholds);
    expect(d.action).toBe("leave");
    expect(d.reason).toMatch(/unknown/i);
  });

  it("still compacts an oversized topic when last activity is unknown", () => {
    const t = topic({ lastActiveAt: "", messageCount: 3000 });
    const d = decideArchival(t, NOW, thresholds);
    expect(d.action).toBe("compact");
  });
});

describe("buildRecoveryPlan", () => {
  it("produces a canonical OC session key", () => {
    const plan = buildRecoveryPlan(topic({ id: 82385 }), "-1003842172831", "main");
    expect(plan).toEqual({
      topicId: 82385,
      chatId: "-1003842172831",
      agentId: "main",
      sessionKey: "agent:main:telegram:group:-1003842172831:topic:82385",
      action: "register",
    });
  });

  it("rejects a missing agent id", () => {
    expect(() => buildRecoveryPlan(topic(), "-100", "")).toThrow(/agentId/i);
  });
});

describe("parseTopicSessionKey", () => {
  it("parses the canonical topic key", () => {
    expect(parseTopicSessionKey("agent:main:telegram:group:-1003842172831:topic:82385")).toEqual({
      agentId: "main",
      chatId: "-1003842172831",
      topicId: 82385,
    });
  });

  it("rejects non-topic keys", () => {
    expect(parseTopicSessionKey("agent:main:main")).toBeNull();
    expect(parseTopicSessionKey("agent:main:telegram:group:-100")).toBeNull();
    expect(parseTopicSessionKey("agent:main:telegram:direct:-100:topic:1")).toBeNull();
    expect(parseTopicSessionKey("global")).toBeNull();
  });
});

describe("registrationsFromSessions", () => {
  it("projects topic keys and skips everything else", () => {
    const sessions: SessionsMap = {
      "agent:main:main": { model: "x" },
      "agent:main:telegram:group:-1003842172831:topic:1": { model: "y" },
      "agent:main:telegram:group:-1003842172831:topic:82385": {},
      "garbage-key": {},
    };
    const out = registrationsFromSessions(sessions);
    expect(out.map((r) => r.topicId).sort((a, b) => a - b)).toEqual([1, 82385]);
  });

  it("returns empty for empty or malformed input", () => {
    expect(registrationsFromSessions({})).toEqual([]);
    // @ts-expect-error defensive: malformed registry content
    expect(registrationsFromSessions({ key: "not-an-object" })).toEqual([]);
  });
});

describe("applyRecoveryPlan", () => {
  const NOW = Date.parse("2026-09-06T17:00:00Z");
  const planOf = (over: Partial<RecoveryPlan> = {}): RecoveryPlan => ({
    topicId: 82385,
    chatId: "-1003842172831",
    agentId: "main",
    sessionKey: "agent:main:telegram:group:-1003842172831:topic:82385",
    action: "register",
    ...over,
  });

  it("inserts the entry and returns an applied report", () => {
    const { updated, report } = applyRecoveryPlan(planOf(), {}, NOW);
    expect(report).toMatchObject({
      applied: true,
      created: true,
      before: "absent",
      after: "registered",
      sessionKey: planOf().sessionKey,
    });
    const entry = updated[planOf().sessionKey];
    expect(entry).toMatchObject({
      topicId: 82385,
      chatId: "-1003842172831",
      agentId: "main",
      registeredAtMs: NOW,
      source: "oc-topic-manager",
    });
  });

  it("never mutates the input map", () => {
    const sessions: SessionsMap = {};
    applyRecoveryPlan(planOf(), sessions, NOW);
    expect(Object.keys(sessions)).toHaveLength(0);
  });

  it("is idempotent: an existing registration is refused, not overwritten", () => {
    const existing: SessionsMap = {
      "agent:main:telegram:group:-1003842172831:topic:82385": { model: "precious" },
    };
    const { updated, report } = applyRecoveryPlan(planOf(), existing, NOW);
    expect(report.applied).toBe(false);
    expect(report.reason).toMatch(/already registered/i);
    // The pre-existing entry is untouched.
    expect(updated[planOf().sessionKey]).toEqual({ model: "precious" });
  });

  it("preserves unrelated entries", () => {
    const sessions: SessionsMap = { "agent:main:main": { model: "x" } };
    const { updated } = applyRecoveryPlan(planOf(), sessions, NOW);
    expect(updated["agent:main:main"]).toEqual({ model: "x" });
    expect(Object.keys(updated)).toHaveLength(2);
  });
});