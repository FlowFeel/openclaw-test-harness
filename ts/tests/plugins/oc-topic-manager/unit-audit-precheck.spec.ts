/**
 * oc-topic-manager — audit-precheck unit specs (issue #31).
 *
 * @behavior
 * Verifies the fail-loudly guard: empty topic payloads refuse the audit
 * and surface the phantom-unregistered risk count; non-empty payloads pass.
 *
 * @dft
 * - Pure function calls only: input -> expected verdict.
 * - Deterministic: no clock, no I/O.
 */

import { describe, it, expect } from "vitest";
import { auditPrecheck } from "../../../src/plugins/oc-topic-manager/src/audit-precheck.js";
import { parseTopics } from "../../../src/plugins/oc-topic-manager/src/parse-topics.js";
import type { TopicMeta } from "../../../src/plugins/oc-topic-manager/src/types.js";

const topic = (id: number): TopicMeta => ({
  id,
  title: `Topic ${id}`,
  messageCount: 1,
  lastActiveAt: "2026-09-18T00:00:00Z",
  pinned: false,
});

describe("auditPrecheck (issue #31: fail loudly on empty topics payload)", () => {
  it("refuses when topics are empty and registrations exist — surfaces phantom risk", () => {
    const result = auditPrecheck([], 240);
    expect(result.ok).toBe(false);
    expect(result.phantomRisk).toBe(240);
    expect(result.error).toContain("240");
    expect(result.error).toContain("unregistered");
  });

  it("refuses even when registrations are also empty — an empty audit is meaningless", () => {
    const result = auditPrecheck([], 0);
    expect(result.ok).toBe(false);
    expect(result.phantomRisk).toBe(0);
  });

  it("passes through on a non-empty topic set", () => {
    const result = auditPrecheck([topic(82385)], 12);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.phantomRisk).toBeUndefined();
  });

  it("guards the tool-level failure mode: parsed empty payload from undefined input", () => {
    // Production failure: caller invoked topic_audit without the topics
    // param. parseTopics(undefined) -> []; precheck must refuse.
    const parsed = parseTopics(undefined);
    expect(parsed).toEqual([]);
    const result = auditPrecheck(parsed, 240);
    expect(result.ok).toBe(false);
  });

  it("guards the explicit empty-array payload variant", () => {
    const parsed = parseTopics({ topics: [] });
    expect(parsed).toEqual([]);
    const result = auditPrecheck(parsed, 7);
    expect(result.ok).toBe(false);
    expect(result.phantomRisk).toBe(7);
  });

  it("passes through payloads whose entries are all malformed but non-empty", () => {
    // A payload of malformed entries parses to [] — same refusal semantics:
    // we cannot audit what we did not receive. Non-empty RAW payload that
    // parses to zero valid topics is still an empty audit.
    const parsed = parseTopics({ topics: [{ no_id: true }, "garbage"] });
    expect(parsed).toEqual([]);
    const result = auditPrecheck(parsed, 3);
    expect(result.ok).toBe(false);
  });
});
