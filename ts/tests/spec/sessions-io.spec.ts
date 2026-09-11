/**
 * Sessions I/O specs — tests readSessions/writeSessions round-trip.
 *
 * @dft
 * - Uses a real temp directory (mkdtempSync) — no mocks.
 * - Tests actual file system behavior (missing file, invalid JSON, round-trip).
 * - Cleanup in afterEach — no leaked temp files.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readSessions, writeSessions } from "../../src/plugins/shared/sessions-io.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { SessionsMap } from "../../src/plugins/shared/session-cleanup.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "sessions-io-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe("readSessions", () => {
  it("returns null when the file does not exist", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    expect(readSessions(path)).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    writeSessions({} as SessionsMap, path);
    // Overwrite with invalid JSON
    const { writeFileSync } = require("node:fs");
    writeFileSync(path, "{ invalid json }");
    expect(readSessions(path)).toBeNull();
  });

  it("returns null for an empty file", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    const { writeFileSync } = require("node:fs");
    writeFileSync(path, "");
    expect(readSessions(path)).toBeNull();
  });
});

describe("writeSessions + readSessions round-trip", () => {
  it("round-trips a simple sessions map", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    const data: SessionsMap = {
      "topic:1": { model: "gpt-4", updatedAt: 12345 },
      "topic:2": { model: "claude", updatedAt: 67890 },
    };
    writeSessions(data, path);
    const result = readSessions(path);
    expect(result).toEqual(data);
  });

  it("round-trips a nested sessions map with arrays", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    const data: SessionsMap = {
      "topic:1": {
        model: "gpt-4",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
        metadata: { tokenCount: 42 },
      },
    };
    writeSessions(data, path);
    const result = readSessions(path);
    expect(result).toEqual(data);
  });

  it("round-trips an empty object", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    const data: SessionsMap = {};
    writeSessions(data, path);
    const result = readSessions(path);
    expect(result).toEqual({});
  });

  it("Scenario: a successful write replaces the file atomically", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    writeSessions({ "topic:1": { model: "old" } } as SessionsMap, path);
    writeSessions({ "topic:2": { model: "new" } } as SessionsMap, path);
    const result = readSessions(path);
    expect(result).toEqual({ "topic:2": { model: "new" } });
    expect(result!["topic:1"]).toBeUndefined();
  });

  it("creates the file if it does not exist", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    expect(existsSync(path)).toBe(false);
    writeSessions({ "topic:1": { model: "gpt" } } as SessionsMap, path);
    expect(existsSync(path)).toBe(true);
  });

  it("does not leave temporary files behind (atomic rename)", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    writeSessions({ "topic:1": { model: "gpt" } } as SessionsMap, path);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("Scenario: each write backs up the previous content", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    const previous = { "topic:1": { model: "old" } } as unknown as SessionsMap;
    const next = { "topic:2": { model: "new" } } as SessionsMap;
    writeSessions(previous, path);
    writeSessions(next, path);
    expect(readSessions(`${path}.bak`)).toEqual(previous);
    expect(readSessions(path)).toEqual(next);
  });

  it("does not create a backup when the file does not exist yet", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    writeSessions({ "topic:1": { model: "gpt" } } as SessionsMap, path);
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it("Scenario: a failed write leaves the previous file intact", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    const previous = { "topic:1": { model: "keep" } } as SessionsMap;
    writeSessions(previous, path);
    // Circular reference — JSON.stringify throws before the target is touched.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      writeSessions({ "topic:x": circular } as unknown as SessionsMap, path),
    ).toThrow();
    expect(readSessions(path)).toEqual(previous);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});
