/**
 * Sessions I/O specs for oc-compaction-helper's local sessions-io.ts.
 *
 * Tests the two functions added for the sidecar offload wiring:
 * - getSessionFileSize: statSync-based size estimate (replaces JSON.stringify scan)
 * - writeSessionsString: writes a pre-serialized string (sidecar returns string)
 *
 * @dft
 * - A5 (mock-doubles): uses a real temp directory (mkdtempSync) — no mocks.
 * - A1 (pure-io-separation): the I/O wrapper is the seam; these tests verify it.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  readSessions,
  writeSessions,
  getSessionFileSize,
  writeSessionsString,
} from "../../../src/plugins/oc-compaction-helper/src/sessions-io.js";
import type { SessionsMap } from "../../../src/plugins/shared/session-cleanup.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "compaction-sessions-io-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe("getSessionFileSize", () => {
  it("returns 0 when the file does not exist", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    expect(getSessionFileSize(path)).toBe(0);
  });

  it("returns the byte size of an existing file", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    const content = '{"topic:1":{"model":"gpt-4"}}';
    writeFileSync(path, content);
    expect(getSessionFileSize(path)).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("returns 0 for an empty file", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    writeFileSync(path, "");
    expect(getSessionFileSize(path)).toBe(0);
  });

  it("returns a larger size for a bigger file", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    const data: SessionsMap = {
      "topic:1": { model: "gpt-4", data: "x".repeat(10_000) },
    };
    writeSessions(data, path);
    const size = getSessionFileSize(path);
    expect(size).toBeGreaterThan(10_000);
  });
});

describe("writeSessionsString", () => {
  it("writes a pre-serialized string that readSessions can parse", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    const data: SessionsMap = { "topic:1": { model: "gpt-4" } };
    const serialized = JSON.stringify(data);
    writeSessionsString(serialized, path);
    const result = readSessions(path);
    expect(result).toEqual(data);
  });

  it("overwrites an existing file", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    writeSessions({ "topic:1": { model: "old" } } as SessionsMap, path);
    writeSessionsString(JSON.stringify({ "topic:2": { model: "new" } }), path);
    const result = readSessions(path);
    expect(result).toEqual({ "topic:2": { model: "new" } });
    expect(result!["topic:1"]).toBeUndefined();
  });

  it("creates the file if it does not exist", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    writeSessionsString("{}", path);
    const result = readSessions(path);
    expect(result).toEqual({});
  });

  it("round-trips through the sidecar pattern: writeSessionsString → readSessions", () => {
    const dir = makeTmpDir();
    const path = resolve(dir, "sessions.json");
    // Simulate what the sidecarWriter does when the sidecar returns a string
    const data: SessionsMap = {
      "topic:1": { model: "claude", tokens: 1234 },
      "topic:2": { model: "gpt-4", tokens: 5678 },
    };
    const sidecarResult = JSON.stringify(data);
    writeSessionsString(sidecarResult, path);
    expect(readSessions(path)).toEqual(data);
  });
});
