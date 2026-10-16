/**
 * Pure logic spec for oc-memory-recall (DFT Axiom 1, 2, 3).
 * Inline data only, zero fixtures, zero I/O.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKER_PREFIX,
  buildRecallStatusReport,
  createInitialTelemetry,
  createRegistry,
  findNotesForKind,
  findNotesForPath,
  formatFileMarker,
  formatTelemetryReport,
  normalizePath,
  parseNoteFrontmatter,
  processToolResultForFileRead,
  recordFire,
  recordFollow,
  recordHit,
  verifyNotes,
  type MemoryNote,
} from "../src/memory-recall-logic.js";

const VALID_NOTE_RAW = `---
kind: house_style
use_when: Writing or modifying plugin logic seams
does_not_apply_when: Writing integration test doubles
provenance: "Research Stable 2026-10-15 / 1d"
source: "docs/coding-style.md"
title: "House Style Guidelines"
paths:
  - "src/plugins/shared/types.ts"
  - "docs/conventions.md"
---
# Style Rules
Always use pure logic seams without Date.now().
`;

describe("parseNoteFrontmatter", () => {
  it("parses valid frontmatter with all foundation schema fields", () => {
    const note = parseNoteFrontmatter(VALID_NOTE_RAW, "style-note.md");
    expect(note.valid).toBe(true);
    expect(note.id).toBe("style-note.md");
    expect(note.frontmatter.kind).toBe("house_style");
    expect(note.frontmatter.use_when).toBe("Writing or modifying plugin logic seams");
    expect(note.frontmatter.does_not_apply_when).toBe("Writing integration test doubles");
    expect(note.frontmatter.provenance).toBe("Research Stable 2026-10-15 / 1d");
    expect(note.frontmatter.source).toBe("docs/coding-style.md");
    expect(note.frontmatter.paths).toEqual([
      "src/plugins/shared/types.ts",
      "docs/conventions.md",
    ]);
    expect(note.content).toContain("# Style Rules");
  });

  it("flags error if frontmatter is missing", () => {
    const note = parseNoteFrontmatter("# Just markdown\nNo yaml here.");
    expect(note.valid).toBe(false);
    expect(note.errors).toContain("Missing frontmatter header ('---')");
  });

  it("flags error if frontmatter block is not closed", () => {
    const note = parseNoteFrontmatter("---\nkind: house_style\nNo closing delimiter");
    expect(note.valid).toBe(false);
    expect(note.errors).toContain("Unclosed frontmatter block (missing terminating '---')");
  });

  it("reports missing required foundation fields", () => {
    const incomplete = `---
kind: house_style
use_when: Always
---
body`;
    const note = parseNoteFrontmatter(incomplete, "incomplete.md");
    expect(note.valid).toBe(false);
    expect(note.errors).toBeDefined();
    expect(note.errors?.some((e) => e.includes("does_not_apply_when"))).toBe(true);
    expect(note.errors?.some((e) => e.includes("provenance"))).toBe(true);
    expect(note.errors?.some((e) => e.includes("source"))).toBe(true);
  });
});

describe("normalizePath", () => {
  it("normalizes backslashes and strips leading relative paths", () => {
    expect(normalizePath("./src/foo/bar.ts")).toBe("src/foo/bar.ts");
    expect(normalizePath(".\\src\\foo\\bar.ts")).toBe("src/foo/bar.ts");
    expect(normalizePath("src/foo/bar.ts")).toBe("src/foo/bar.ts");
  });
});

describe("NoteRegistry", () => {
  const note1 = parseNoteFrontmatter(VALID_NOTE_RAW, "note1.md");
  const note2 = parseNoteFrontmatter(
    `---
kind: silent_trap
use_when: Touching database migration scripts
does_not_apply_when: In-memory unit tests
provenance: "Incident postmortem 2026-10-11 / 5d"
source: "db/migrations/001.sql"
---
Watch out for table locking.`,
    "note2.md",
  );

  const registry = createRegistry([note1, note2]);

  it("indexes notes by source path and explicit paths array", () => {
    const match1 = findNotesForPath(registry, "docs/coding-style.md");
    expect(match1).toHaveLength(1);
    expect(match1[0].id).toBe("note1.md");

    const matchPath = findNotesForPath(registry, "src/plugins/shared/types.ts");
    expect(matchPath).toHaveLength(1);
    expect(matchPath[0].id).toBe("note1.md");

    const match2 = findNotesForPath(registry, "db/migrations/001.sql");
    expect(match2).toHaveLength(1);
    expect(match2[0].id).toBe("note2.md");
  });

  it("matches absolute or suffix paths", () => {
    const match = findNotesForPath(
      registry,
      "/Users/edphillips/projects/db/migrations/001.sql",
    );
    expect(match).toHaveLength(1);
    expect(match[0].id).toBe("note2.md");
  });

  it("indexes notes by kind", () => {
    const houseStyleNotes = findNotesForKind(registry, "house_style");
    expect(houseStyleNotes).toHaveLength(1);
    expect(houseStyleNotes[0].id).toBe("note1.md");

    const silentTrapNotes = findNotesForKind(registry, "silent_trap");
    expect(silentTrapNotes).toHaveLength(1);
    expect(silentTrapNotes[0].id).toBe("note2.md");

    const unknownNotes = findNotesForKind(registry, "non_existent_kind");
    expect(unknownNotes).toHaveLength(0);
  });
});

describe("Telemetry State", () => {
  it("records fire, hit, and follow metrics per kind and arm", () => {
    let t = createInitialTelemetry();
    expect(t.totalFired).toBe(0);

    t = recordFire(t, "house_style", "M6");
    t = recordHit(t, "house_style", "M6");
    t = recordFollow(t, "house_style", "M6");
    t = recordFire(t, "house_style", "M6");

    expect(t.totalFired).toBe(2);
    expect(t.totalHit).toBe(1);
    expect(t.totalFollowed).toBe(1);
    expect(t.stats["house_style"]["M6"]).toEqual({
      fired: 2,
      hit: 1,
      followed: 1,
    });

    const report = formatTelemetryReport(t);
    expect(report).toContain("totals (fired: 2, hit: 1, followed: 1)");
    expect(report).toContain("[house_style][M6]: fired=2 hit=1 followed=1");
  });
});

describe("processToolResultForFileRead (Deliverable 2 - M6)", () => {
  const note = parseNoteFrontmatter(VALID_NOTE_RAW, "note1.md");
  const registry = createRegistry([note]);

  it("ignores non-file tools", () => {
    const res = processToolResultForFileRead(
      "exec_command",
      { cmd: "ls" },
      "file1.txt\nfile2.txt",
      registry,
    );
    expect(res.modified).toBe(false);
    expect(res.output).toBe("file1.txt\nfile2.txt");
  });

  it("returns unmodified output if file path has no matching memory note", () => {
    const res = processToolResultForFileRead(
      "view_file",
      { AbsolutePath: "/workspace/untracked.ts" },
      "export const x = 1;",
      registry,
    );
    expect(res.modified).toBe(false);
    expect(res.notesApplied).toHaveLength(0);
  });

  it("prepends signpost marker when file read touches a registered path", () => {
    const res = processToolResultForFileRead(
      "view_file",
      { AbsolutePath: "/workspace/docs/coding-style.md" },
      "# Coding Style\nActual content here...",
      registry,
    );

    expect(res.modified).toBe(true);
    expect(res.notesApplied).toHaveLength(1);
    expect(res.notesApplied[0].id).toBe("note1.md");
    expect(res.output).toContain(DEFAULT_MARKER_PREFIX);
    expect(res.output).toContain("docs/coding-style.md");
    expect(res.output).toContain("# Coding Style\nActual content here...");
  });

  it("formatFileMarker formats correctly with pointer and scope condition", () => {
    const marker = formatFileMarker(note);
    expect(marker).toContain(DEFAULT_MARKER_PREFIX);
    expect(marker).toContain("docs/coding-style.md");
    expect(marker).toContain("(Writing or modifying plugin logic seams)");
  });
});

describe("Status and verification builders", () => {
  it("builds valid status report with counts and kind breakdown", () => {
    const note = parseNoteFrontmatter(VALID_NOTE_RAW, "note1.md");
    const registry = createRegistry([note]);
    const telemetry = createInitialTelemetry();

    const report = buildRecallStatusReport(registry, telemetry);
    expect(report.verdict).toBe("ok");
    expect(report.summary).toContain("notes: 1 total (1 valid, 0 invalid)");
    expect(report.summary).toContain("1 kinds");
  });

  it("verifyNotes returns invalid note list and error diagnostics", () => {
    const note1 = parseNoteFrontmatter(VALID_NOTE_RAW, "valid.md");
    const note2 = parseNoteFrontmatter("no frontmatter", "invalid.md");

    const result = verifyNotes([note1, note2]);
    expect(result.validCount).toBe(1);
    expect(result.invalidCount).toBe(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].id).toBe("invalid.md");
  });
});
