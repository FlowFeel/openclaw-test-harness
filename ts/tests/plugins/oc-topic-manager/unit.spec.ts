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
import type { TopicMeta, SessionRegistration } from "../../../src/plugins/oc-topic-manager/src/types.js";

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