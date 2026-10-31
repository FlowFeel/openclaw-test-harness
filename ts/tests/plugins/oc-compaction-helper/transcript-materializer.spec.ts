/**
 * Spec: Compaction Successor Materializer pure logic (T-581 part 1).
 *
 * @dft
 * - Pure: in-memory string arrays, zero file I/O, zero network calls.
 * - Deterministic: all timestamps and session IDs injected via parameters.
 */

import { describe, it, expect } from "vitest";
import {
  detectUnrotatedCompaction,
  buildSuccessorLines,
  estimateContextTokens,
} from "../../../src/plugins/oc-compaction-helper/src/transcript-materializer-logic.js";

function makeSessionHeader(id = "sess-uuid-001", timestamp = "2026-10-31T00:00:00.000Z"): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp,
    cwd: "/home/node/.openclaw/workspace",
  });
}

function makeMessageEntry(id: string, parentId: string, text: string, role = "user"): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-31T00:01:00.000Z",
    message: {
      role,
      content: [{ type: "text", text }],
    },
  });
}

function makeCompactionEntry(id: string, parentId: string, firstKeptEntryId: string): string {
  return JSON.stringify({
    type: "compaction",
    id,
    parentId,
    timestamp: "2026-10-31T00:05:00.000Z",
    summary: "Compacted conversation summary",
    firstKeptEntryId,
    tokensBefore: 45000,
    details: { preserved: 10 },
    fromHook: true,
  });
}

describe("detectUnrotatedCompaction", () => {
  it("detects unrotated compaction when firstKeptIndex >= minLinesBeforeKept", () => {
    const lines: string[] = [makeSessionHeader()];
    // Add 130 filler messages
    for (let i = 1; i <= 130; i++) {
      const hexId = i.toString(16).padStart(8, "0");
      const parentHexId = (i - 1).toString(16).padStart(8, "0");
      lines.push(makeMessageEntry(hexId, parentHexId, `Message ${i}`));
    }

    // Target first kept entry at index 120
    // Line 0 is header, so entry 120 is at index 120 (id = 00000078 in hex)
    const targetKeptHexId = (120).toString(16).padStart(8, "0");
    const compactionEntry = makeCompactionEntry("comp-1", "00000082", targetKeptHexId);
    lines.push(compactionEntry);

    // Default minLinesBeforeKept is 50
    const detection = detectUnrotatedCompaction(lines);

    expect(detection.unrotated).toBe(true);
    expect(detection.compactionIndex).toBe(131);
    expect(detection.firstKeptIndex).toBe(120);
    expect(detection.compactionEntry?.firstKeptEntryId).toBe(targetKeptHexId);
  });

  it("returns unrotated: false when firstKeptIndex < minLinesBeforeKept", () => {
    const lines: string[] = [makeSessionHeader()];
    // Add 40 filler messages
    for (let i = 1; i <= 40; i++) {
      const hexId = i.toString(16).padStart(8, "0");
      const parentHexId = (i - 1).toString(16).padStart(8, "0");
      lines.push(makeMessageEntry(hexId, parentHexId, `Message ${i}`));
    }

    // firstKeptEntry pointing near the end, e.g. entry 35 (line index 35 < 50)
    const targetKeptHexId = (35).toString(16).padStart(8, "0");
    const compactionEntry = makeCompactionEntry("comp-1", "00000028", targetKeptHexId);
    lines.push(compactionEntry);

    const detection = detectUnrotatedCompaction(lines, { minLinesBeforeKept: 50 });

    expect(detection.unrotated).toBe(false);
    expect(detection.compactionIndex).toBe(41);
    expect(detection.firstKeptIndex).toBe(35);
    expect(detection.reason).toContain("firstKeptIndex (35) < minLinesBeforeKept (50)");
  });

  it("handles multiple compaction entries by inspecting the last one", () => {
    const lines: string[] = [makeSessionHeader()];
    for (let i = 1; i <= 100; i++) {
      const hexId = i.toString(16).padStart(8, "0");
      lines.push(makeMessageEntry(hexId, "00000000", `Msg ${i}`));
    }

    // Older compaction entry at index 101 pointing at 10
    lines.push(makeCompactionEntry("comp-old", "00000064", (10).toString(16).padStart(8, "0")));

    for (let i = 102; i <= 120; i++) {
      const hexId = i.toString(16).padStart(8, "0");
      lines.push(makeMessageEntry(hexId, "00000000", `Msg ${i}`));
    }

    // Last compaction entry at index 121 pointing at 60
    const targetHex = (60).toString(16).padStart(8, "0");
    lines.push(makeCompactionEntry("comp-last", "00000078", targetHex));

    const detection = detectUnrotatedCompaction(lines, { minLinesBeforeKept: 50 });
    expect(detection.unrotated).toBe(true);
    expect(detection.compactionIndex).toBe(121);
    expect(detection.firstKeptIndex).toBe(60);
    expect(detection.compactionEntry?.id).toBe("comp-last");
  });

  it("returns unrotated: false when no compaction entry exists", () => {
    const lines: string[] = [makeSessionHeader(), makeMessageEntry("00000001", "0", "hello")];
    const detection = detectUnrotatedCompaction(lines);
    expect(detection.unrotated).toBe(false);
    expect(detection.reason).toBe("No compaction entry found");
  });

  it("returns unrotated: false when firstKeptEntryId is not found", () => {
    const lines: string[] = [
      makeSessionHeader(),
      makeMessageEntry("00000001", "0", "hello"),
      makeCompactionEntry("comp-1", "00000001", "missing-id-999"),
    ];
    const detection = detectUnrotatedCompaction(lines);
    expect(detection.unrotated).toBe(false);
    expect(detection.reason).toContain("firstKeptEntryId missing-id-999 not found");
  });
});

describe("buildSuccessorLines", () => {
  it("builds successor lines with new session header, compaction entry, and kept lines verbatim", () => {
    const header = makeSessionHeader("sess-old", "2026-10-01T00:00:00.000Z");
    const lines: string[] = [header];
    for (let i = 1; i <= 120; i++) {
      lines.push(makeMessageEntry(i.toString(16).padStart(8, "0"), "0", `Msg ${i}`));
    }

    const firstKeptId = (110).toString(16).padStart(8, "0");
    const compLine = makeCompactionEntry("comp-1", "0", firstKeptId);
    lines.push(compLine);

    const detection = detectUnrotatedCompaction(lines, { minLinesBeforeKept: 50 });
    expect(detection.unrotated).toBe(true);

    const successor = buildSuccessorLines(lines, detection, {
      newSessionId: "sess-new-1234",
      timestamp: "2026-10-31T01:00:00.000Z",
    });

    expect(successor.hasSessionHeader).toBe(true);

    // Line 0: Header with replaced ID & timestamp, preserving other fields
    const parsedHeader = JSON.parse(successor.lines[0]);
    expect(parsedHeader.type).toBe("session");
    expect(parsedHeader.id).toBe("sess-new-1234");
    expect(parsedHeader.timestamp).toBe("2026-10-31T01:00:00.000Z");
    expect(parsedHeader.version).toBe(3);
    expect(parsedHeader.cwd).toBe("/home/node/.openclaw/workspace");

    // Line 1: Compaction entry verbatim
    expect(successor.lines[1]).toBe(compLine);

    // Kept lines: indices 110 to 121 (110..120 are messages, 121 is the compaction entry)
    // From firstKeptIndex (110) to lines.length - 1 (121) is 12 lines.
    // Total successor lines = 1 (header) + 1 (compaction) + 12 = 14 lines.
    expect(successor.lines.length).toBe(14);
    for (let i = 0; i < 12; i++) {
      expect(successor.lines[2 + i]).toBe(lines[110 + i]);
    }

    // Verify round-trip JSON.parse on every successor line
    for (const l of successor.lines) {
      expect(() => JSON.parse(l)).not.toThrow();
    }

    // Verify idempotence: detectUnrotatedCompaction on successor returns unrotated: false
    // In successor, firstKeptId is at index 2 (which is < 50)
    const reDetection = detectUnrotatedCompaction(successor.lines);
    expect(reDetection.unrotated).toBe(false);
  });

  it("handles transcripts missing session header on line 0", () => {
    const lines: string[] = [
      makeMessageEntry("msg-1", "0", "no header line here"),
      makeMessageEntry("msg-2", "msg-1", "message 2"),
      makeCompactionEntry("comp-1", "msg-2", "msg-2"),
    ];

    const detection = detectUnrotatedCompaction(lines, { minLinesBeforeKept: 1 });
    expect(detection.unrotated).toBe(true);

    const successor = buildSuccessorLines(lines, detection, {
      newSessionId: "sess-abc",
      timestamp: "2026-10-31T02:00:00.000Z",
    });

    expect(successor.hasSessionHeader).toBe(false);
    expect(successor.warning).toBeDefined();
    // Line 0 is compaction entry
    expect(successor.lines[0]).toBe(lines[2]);
    // Line 1 is msg-2
    expect(successor.lines[1]).toBe(lines[1]);
  });
});

describe("estimateContextTokens", () => {
  it("estimates tokens from message content accurately", () => {
    // 40 characters of message text -> Math.ceil(40 / 4) = 10 tokens
    const msg = makeMessageEntry("00000001", "0", "1234567890123456789012345678901234567890");
    const count = estimateContextTokens([msg]);
    expect(count).toBe(10);
  });

  it("falls back to line length / 4 when entry is not a text message", () => {
    const customLine = JSON.stringify({ type: "custom", payload: "test" });
    const count = estimateContextTokens([customLine]);
    expect(count).toBe(Math.ceil(customLine.length / 4));
  });

  it("ignores blank lines", () => {
    const count = estimateContextTokens(["", "   ", "\n"]);
    expect(count).toBe(0);
  });
});
