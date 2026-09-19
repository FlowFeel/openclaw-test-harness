/**
 * oc-topic-manager — registry-client unit specs.
 *
 * @behavior
 * Covers session-key parsing and registration extraction — pure, no
 * file I/O. The read-side (readTopicRegistrations) is exercised with an
 * injectable path against a temp file via the fs fixtures in CI.
 *
 * @dft
 * - Parsing rules isolated in parseSessionKey; extraction in
 *   extractTopicRegistrations.
 * - Malformed keys are skipped, never thrown.
 */

import { describe, it, expect } from "vitest";
import {
  parseSessionKey,
  extractTopicRegistrations,
  readTopicRegistrations,
} from "../../../src/plugins/oc-topic-manager/src/registry-client.js";

describe("parseSessionKey", () => {
  it("parses the canonical forum-topic key", () => {
    const parsed = parseSessionKey("agent:main:telegram:group:-1003842172831:topic:82385");
    expect(parsed).toEqual({
      agentId: "main",
      chatId: "-1003842172831",
      topicId: 82385,
      sessionKey: "agent:main:telegram:group:-1003842172831:topic:82385",
    });
  });

  it("rejects non-topic session keys", () => {
    expect(parseSessionKey("agent:main:telegram:user:12345")).toBeNull();
    expect(parseSessionKey("agent:main:cron:heartbeat")).toBeNull();
    expect(parseSessionKey("agent:main:telegram:group:-100:topic")).toBeNull();
  });

  it("rejects malformed topic ids", () => {
    expect(parseSessionKey("agent:main:telegram:group:-100:topic:abc")).toBeNull();
    expect(parseSessionKey("agent:main:telegram:group:-100:topic:1:extra")).toBeNull();
  });
});

describe("extractTopicRegistrations", () => {
  it("extracts only forum-topic sessions", () => {
    const sessions = {
      "agent:main:telegram:group:-1003842172831:topic:1": {},
      "agent:main:telegram:group:-1003842172831:topic:82385": {},
      "agent:main:cron:heartbeat": {},
      "agent:main:telegram:user:777": {},
    };
    const regs = extractTopicRegistrations(sessions);
    expect(regs.map((r) => r.topicId)).toEqual([1, 82385]);
    expect(regs[1].sessionKey).toContain("topic:82385");
  });

  it("returns empty for non-object / empty input", () => {
    expect(extractTopicRegistrations({})).toEqual([]);
    expect(extractTopicRegistrations(null as unknown as Record<string, unknown>)).toEqual([]);
    expect(extractTopicRegistrations(undefined as unknown as Record<string, unknown>)).toEqual([]);
  });
});

describe("readTopicRegistrations", () => {
  it("returns empty list for a missing file", () => {
    expect(readTopicRegistrations("/nonexistent/path/sessions.json")).toEqual([]);
  });

  it("returns empty list for unparseable JSON", () => {
    // Pointed at a path that cannot exist as JSON — parse failure path.
    expect(readTopicRegistrations("/dev/null")).toEqual([]);
  });
});