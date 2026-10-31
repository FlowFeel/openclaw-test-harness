import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  materializeSuccessorForSession,
  sweepUnrotatedSessions,
  isMaterializationSafe,
  formatTimestampForFilename,
} from "../../../src/plugins/oc-compaction-helper/src/transcript-materializer-io.js";

describe("T-581 part 2: materializer I/O seam", () => {
  let dir: string;
  const NOW = Date.parse("2026-10-31T00:00:00.000Z");
  const STALE_UPDATED = "2026-10-30T20:00:00.000Z"; // 4h before NOW
  const FRESH_UPDATED = "2026-10-30T23:59:00.000Z"; // 1m before NOW

  const header = (id: string, ts: string) =>
    JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd: "/tmp" });
  const msg = (id: string, parentId: string, text: string) =>
    JSON.stringify({ type: "message", id, parentId, timestamp: "2026-10-30T21:00:00.000Z", message: { role: "user", content: [{ type: "text", text }] } });
  const compactionEntry = (firstKeptId: string) =>
    JSON.stringify({ type: "compaction", id: "c0ffee11", parentId: "babbf011", timestamp: "2026-10-30T22:00:00.000Z", summary: "summary text", firstKeptEntryId: firstKeptId, tokensBefore: 262144, fromHook: true });

  const entryId = (i: number) => i.toString(16).padStart(8, "0");
  const buildBloatedTranscript = (keptIndex: number) => {
    const lines: string[] = [header("old-session-uuid", "2026-10-30T10:00:00.000Z")];
    const ids: string[] = [];
    for (let i = 0; i < keptIndex; i++) {
      const id = entryId(i);
      ids.push(id);
      lines.push(msg(id, i === 0 ? "old-session-uuid" : ids[i - 1], `filler ${i}`));
    }
    // compaction entry after the filler; kept entries continue after it
    // (real shape: firstKeptEntryId refers to the first retained post-compaction entry)
    lines.push(compactionEntry(entryId(keptIndex)));
    for (let i = 0; i < 5; i++) {
      lines.push(msg(entryId(keptIndex + i), i === 0 ? "c0ffee11" : entryId(keptIndex + i - 1), `post-compaction ${i}`));
    }
    return { lines, keptId: entryId(keptIndex) };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "t581-io-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const setupSession = (status: string, updatedAt: string, keptIndex: number) => {
    const { lines, keptId } = buildBloatedTranscript(keptIndex);
    const sessionId = "aaaa1111-2222-4333-8444-555566667777";
    const transcriptPath = join(dir, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, lines.join("\n") + "\n");
    const sessionsPath = join(dir, "sessions.json");
    writeFileSync(sessionsPath, JSON.stringify({
      "agent:main:telegram:topic:1": {
        sessionFile: transcriptPath,
        sessionId,
        status,
        updatedAt,
        contextTokens: 262144,
        compactionCount: 1,
      },
    }));
    return { sessionsPath, transcriptPath, sessionId, lines, keptId };
  };

  it("formatTimestampForFilename matches live filename convention", () => {
    expect(formatTimestampForFilename("2026-08-21T21:29:40.926Z")).toBe("2026-08-21T21-29-40-926Z");
  });

  it("race guard: idle/killed/timeout always safe; fresh running unsafe; stale running safe", () => {
    const entry = (status: string, updatedAt: string) => ({ status, updatedAt });
    expect(isMaterializationSafe(entry("idle", FRESH_UPDATED), 900_000, NOW)).toBe(true);
    expect(isMaterializationSafe(entry("killed", FRESH_UPDATED), 900_000, NOW)).toBe(true);
    expect(isMaterializationSafe(entry("timeout", FRESH_UPDATED), 900_000, NOW)).toBe(true);
    expect(isMaterializationSafe(entry("running", FRESH_UPDATED), 900_000, NOW)).toBe(false);
    expect(isMaterializationSafe(entry("running", STALE_UPDATED), 900_000, NOW)).toBe(true);
  });

  it("refuses to materialize an actively running fresh session (race guard)", () => {
    const s = setupSession("running", FRESH_UPDATED, 120);
    const res = materializeSuccessorForSession("agent:main:telegram:topic:1", {
      sessionsPath: s.sessionsPath,
      nowMs: NOW,
      newSessionId: "bbbb2222-3333-4444-8555-666677778888",
    });
    expect(res.materialized).toBe(false);
    expect(res.reason).toContain("race guard");
    expect(existsSync(join(dir, "sessions.json.tmp"))).toBe(false);
  });

  it("materializes an idle unrotated session: new file written, sessions.json patched", () => {
    const s = setupSession("idle", STALE_UPDATED, 120);
    const res = materializeSuccessorForSession("agent:main:telegram:topic:1", {
      sessionsPath: s.sessionsPath,
      nowMs: NOW,
      newSessionId: "bbbb2222-3333-4444-8555-666677778888",
    });
    expect(res.materialized).toBe(true);
    expect(res.oldLines).toBe(127); // header + 120 filler + compaction + 5 post
    expect(res.newLines).toBe(7); // header + compaction + 5 kept
    expect(res.savedBytes).toBeGreaterThan(0);

    // new file exists with correct name convention
    const expectedName = `2026-10-31T00-00-00-000Z_bbbb2222-3333-4444-8555-666677778888.jsonl`;
    expect(res.newSessionFile).toBe(resolve(dir, expectedName));
    expect(existsSync(res.newSessionFile!)).toBe(true);

    // original transcript untouched (reversible by design)
    expect(readFileSync(s.transcriptPath, "utf8")).toBe(s.lines.join("\n") + "\n");

    // every successor line is valid JSON
    const successorLines = readFileSync(res.newSessionFile!, "utf8").trim().split("\n");
    for (const l of successorLines) expect(() => JSON.parse(l)).not.toThrow();
    expect(JSON.parse(successorLines[0])).toMatchObject({ type: "session", id: "bbbb2222-3333-4444-8555-666677778888" });
    expect(JSON.parse(successorLines[1])).toMatchObject({ type: "compaction" });
    expect(JSON.parse(successorLines[2])).toMatchObject({ id: s.keptId });

    // sessions.json patched atomically: new pointer, idle status, re-estimated tokens
    const store = JSON.parse(readFileSync(s.sessionsPath, "utf8"));
    const entry = store["agent:main:telegram:topic:1"];
    expect(entry.sessionFile).toBe(res.newSessionFile);
    expect(entry.sessionId).toBe("bbbb2222-3333-4444-8555-666677778888");
    expect(entry.status).toBe("idle");
    expect(entry.contextTokens).toBeGreaterThan(0);
    expect(entry.contextTokens).toBeLessThan(262144);
    expect(existsSync(`${s.sessionsPath}.bak`)).toBe(true);
    expect(existsSync(`${s.sessionsPath}.tmp`)).toBe(false);
  });

  it("is idempotent: a materialized successor is not detected as unrotated", () => {
    const s = setupSession("idle", STALE_UPDATED, 120);
    const first = materializeSuccessorForSession("agent:main:telegram:topic:1", {
      sessionsPath: s.sessionsPath, nowMs: NOW, newSessionId: "cccc3333-4444-5555-8666-777788889999",
    });
    expect(first.materialized).toBe(true);
    // second sweep on the patched store must find nothing to do
    const sweep = sweepUnrotatedSessions({ sessionsPath: s.sessionsPath, nowMs: NOW });
    const forOurKey = sweep.results.filter((r) => r.sessionKey === "agent:main:telegram:topic:1");
    expect(forOurKey.length).toBe(0);
  });

  it("rolls back the successor file if sessions.json patch fails", () => {
    const s = setupSession("idle", STALE_UPDATED, 120);
    // sabotage: make sessions.json unwritable by replacing it with a directory
    const real = readFileSync(s.sessionsPath, "utf8");
    rmSync(s.sessionsPath);
    mkdirSync(s.sessionsPath); // rename over a directory fails
    const res = materializeSuccessorForSession("agent:main:telegram:topic:1", {
      sessionsPath: s.sessionsPath, nowMs: NOW, newSessionId: "dddd4444-5555-6666-8777-888899990000",
    });
    expect(res.materialized).toBe(false);
    // no orphan successor or tmp files left behind
    expect(existsSync(resolve(dir, "2026-10-31T00-00-00-000Z_dddd4444-5555-6666-8777-888899990000.jsonl"))).toBe(false);
    expect(existsSync(`${s.sessionsPath}.tmp`)).toBe(false);
    // original transcript intact
    expect(existsSync(s.transcriptPath)).toBe(true);
    void real;
  });

  it("sweep respects maxMaterializations cap", () => {
    // build two zombie sessions + one healthy
    const sessions: Record<string, unknown> = {};
    for (const [key, uuid] of [
      ["agent:main:topic:a", "eeee1111-0000-4000-8000-00000000000a"],
      ["agent:main:topic:b", "eeee1111-0000-4000-8000-00000000000b"],
    ] as const) {
      const { lines } = buildBloatedTranscript(120);
      const p = join(dir, `${uuid}.jsonl`);
      writeFileSync(p, "x".repeat(2_100_000) + "\n" + lines.join("\n") + "\n"); // >2MB
      sessions[key] = { sessionFile: p, sessionId: uuid, status: "idle", updatedAt: STALE_UPDATED, contextTokens: 262144 };
    }
    const sessionsPath = join(dir, "sessions.json");
    writeFileSync(sessionsPath, JSON.stringify(sessions));
    const sweep = sweepUnrotatedSessions({ sessionsPath, nowMs: NOW, maxMaterializations: 1 });
    expect(sweep.swept).toBe(2);
    expect(sweep.results.length).toBe(1);
    expect(sweep.results[0].materialized).toBe(true);
  });
});
