import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  getSession,
  saveSession,
  deleteSession,
  countActiveSessions,
  countChildren,
  getTimedOut,
  clearRegistry
} from "../../patches/sqlite-accessor.js";

describe("SQLite Session Registry Accessor", () => {
  beforeEach(() => {
    clearRegistry();
  });

  it("should insert and retrieve a session record correctly", () => {
    const record = {
      sessionKey: "session-123",
      sessionId: "id-123",
      status: "running",
      model: "gpt-4o",
      spawnedBy: "parent-abc",
      spawnDepth: 1,
      isSubagent: 1,
      startedAtMs: Date.now(),
      endedAtMs: null,
      runtimeMs: null,
      aborted: 0,
      raw: { test: true }
    };

    saveSession(record);

    const retrieved = getSession("session-123");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.sessionKey).toBe("session-123");
    expect(retrieved!.status).toBe("running");
    expect(retrieved!.isSubagent).toBe(1);
    expect(retrieved!.raw).toEqual({ test: true });
  });

  it("should handle updates for an existing session key", () => {
    const record = {
      sessionKey: "session-123",
      status: "created"
    };
    saveSession(record);

    const recordUpdate = {
      sessionKey: "session-123",
      status: "completed",
      endedAtMs: Date.now()
    };
    saveSession(recordUpdate);

    const retrieved = getSession("session-123");
    expect(retrieved!.status).toBe("completed");
  });

  it("should count active sessions accurately", () => {
    saveSession({ sessionKey: "s1", status: "created" });
    saveSession({ sessionKey: "s2", status: "running" });
    saveSession({ sessionKey: "s3", status: "completed" }); // Terminal

    expect(countActiveSessions()).toBe(2);
  });

  it("should count child subagents for a given parent", () => {
    saveSession({ sessionKey: "child-1", status: "running", spawnedBy: "parent-1", isSubagent: 1 });
    saveSession({ sessionKey: "child-2", status: "running", spawnedBy: "parent-1", isSubagent: 1 });
    saveSession({ sessionKey: "child-3", status: "completed", spawnedBy: "parent-1", isSubagent: 1 }); // Terminal
    saveSession({ sessionKey: "child-4", status: "running", spawnedBy: "parent-2", isSubagent: 1 }); // Different parent

    expect(countChildren("parent-1")).toBe(2);
  });

  it("should retrieve timed out subagent session keys", () => {
    const now = Date.now();
    const timeoutLimit = 300; // 300 seconds

    // 1. Stale running subagent (started 400 seconds ago)
    saveSession({
      sessionKey: "stale-sub",
      status: "running",
      isSubagent: 1,
      startedAtMs: now - 400 * 1000
    });

    // 2. Fresh running subagent (started 10 seconds ago)
    saveSession({
      sessionKey: "fresh-sub",
      status: "running",
      isSubagent: 1,
      startedAtMs: now - 10 * 1000
    });

    // 3. Stale completed subagent (already completed, should not match)
    saveSession({
      sessionKey: "completed-sub",
      status: "completed",
      isSubagent: 1,
      startedAtMs: now - 400 * 1000
    });

    const timedOut = getTimedOut(timeoutLimit);
    expect(timedOut).toContain("stale-sub");
    expect(timedOut).not.toContain("fresh-sub");
    expect(timedOut).not.toContain("completed-sub");
  });

  it("should return true when deleting an existing session and false otherwise", () => {
    saveSession({ sessionKey: "s-delete", status: "created" });
    expect(deleteSession("s-delete")).toBe(true);
    expect(deleteSession("s-delete")).toBe(false);
  });
});
