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
  hasKindFrontmatter,
  normalizePath,
  parseNoteFrontmatter,
  processToolResultForFileRead,
  recordFire,
  recordFollow,
  recordHit,
  verifyNotes,
  injectToolDescriptionNotes,
  buildNoteCatalogue,
  lintAgentReply,
  applyReplyLintCorrection,
  buildResumeRefreshNotice,
  extractBindPhrase,
  getKindCompression,
  isPredicatePermitted,
  projectCueLine,
  lintNoteSchemaV2,
  isProsePointer,
  resolvePointer,
  DEFAULT_KIND_PREDICATES,
  mergeKindPredicateTable,
  applyKindPredicateDefaults,
  type MemoryNote,
} from "../src/memory-recall-logic.js";
import { formatEventPushCue } from "../src/event-push-logic.js";

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

describe("M2: Tool-description note injection", () => {
  it("injects memory signposts into tool descriptions", () => {
    const rawNote = `---
kind: authority
use_when: executing database migrations
does_not_apply_when: read queries
provenance: "Architecture DB team"
source: "docs/db-migrations.md"
tool: "run_migrations"
---
# Migration note`;
    const note = parseNoteFrontmatter(rawNote, "db-note.md");
    const registry = createRegistry([note]);

    const tools = [
      { name: "run_migrations", description: "Executes pending schema migrations." },
      { name: "query_db", description: "Runs read query." },
    ];

    const result = injectToolDescriptionNotes(tools, registry);
    expect(result.modifiedCount).toBe(1);
    expect(result.notesApplied).toHaveLength(1);
    expect(result.tools[0].description).toContain("docs/db-migrations.md");
    expect(result.tools[0].description).toContain("[Memory Authority:");
    expect(result.tools[1].description).toBe("Runs read query.");
  });
});

describe("M7: Note catalogue", () => {
  it("generates a clean 1-line index per note", () => {
    const note = parseNoteFrontmatter(VALID_NOTE_RAW, "note1.md");
    const registry = createRegistry([note]);

    const report = buildNoteCatalogue(registry);
    expect(report.totalListed).toBe(1);
    expect(report.catalogue).toContain("# [MEMORY CATALOGUE] 1 of 1 memory notes:");
    expect(report.catalogue).toContain("[house_style] \"House Style Guidelines\" (docs/coding-style.md)");
    expect(report.catalogue).toContain("Writing or modifying plugin logic seams");
  });
});

describe("M4: Pre-reply review gate linter", () => {
  it("detects missing signpost when replying about a governed path without citation", () => {
    const rawNote = `---
kind: authority
use_when: changing token auth
does_not_apply_when: ui
provenance: "Security"
source: "src/auth/jwt.ts"
paths:
  - "src/auth/jwt.ts"
---
# Token note`;
    const note = parseNoteFrontmatter(rawNote, "jwt.md");
    const registry = createRegistry([note]);

    const badReply = "I have updated src/auth/jwt.ts with the new signature.";
    const lint = lintAgentReply(badReply, registry);
    expect(lint.valid).toBe(false);
    expect(lint.missingSignposts).toHaveLength(1);
    expect(lint.missingSignposts[0].pointer).toBe("src/auth/jwt.ts");

    const corrected = applyReplyLintCorrection(badReply, lint);
    expect(corrected).toContain("governed by authority: src/auth/jwt.ts");
  });

  it("passes when signpost/pointer is present in reply", () => {
    const rawNote = `---
kind: authority
use_when: changing token auth
does_not_apply_when: ui
provenance: "Security"
source: "src/auth/jwt.ts"
paths:
  - "src/auth/jwt.ts"
---
# Token note`;
    const note = parseNoteFrontmatter(rawNote, "jwt.md");
    const registry = createRegistry([note]);

    const goodReply = "Updated according to authority note src/auth/jwt.ts.";
    const lint = lintAgentReply(goodReply, registry);
    expect(lint.valid).toBe(true);
    expect(lint.missingSignposts).toHaveLength(0);
  });
});

describe("M5: Resume refresh", () => {
  it("summarizes standing authority and architectural decisions", () => {
    const note1 = parseNoteFrontmatter(VALID_NOTE_RAW, "note1.md"); // house_style
    const note2 = parseNoteFrontmatter(
      `---
kind: architectural_decision
use_when: state machine updates
does_not_apply_when: none
provenance: "Architecture"
source: "docs/arch.md"
---
# Arch`,
      "note2.md",
    );
    const registry = createRegistry([note1, note2]);

    const refresh = buildResumeRefreshNotice(registry);
    expect(refresh.refreshedNotes).toHaveLength(1);
    expect(refresh.summary).toContain("# [MEMORY RESUME REFRESH]");
    expect(refresh.summary).toContain("docs/arch.md");
  });
});

describe("hasKindFrontmatter (boot-flood guard)", () => {
  it("accepts a note with a closed kind-bearing frontmatter block", () => {
    expect(hasKindFrontmatter(VALID_NOTE_RAW)).toBe(true);
  });

  it("rejects episodic daily-log frontmatter without a kind key", () => {
    const daily = `---
date: 2026-06-12
sessions: 1
users: [edphos]
---
# Daily log
Content.
`;
    expect(hasKindFrontmatter(daily)).toBe(false);
  });

  it("rejects content with no frontmatter at all", () => {
    expect(hasKindFrontmatter("# Just a heading\nBody text.\n")).toBe(false);
  });

  it("rejects an unclosed frontmatter block", () => {
    expect(hasKindFrontmatter("---\nkind: house_style\nuse_when: x\n")).toBe(false);
  });

  it("rejects kind mentioned only in the body, outside frontmatter", () => {
    const body = `# Notes\nkind: house_style\nmore text\n`;
    expect(hasKindFrontmatter(body)).toBe(false);
  });
});

describe("createRegistry (valid-only indexing)", () => {
  it("never indexes invalid notes, even when handed them directly", () => {
    const valid = parseNoteFrontmatter(VALID_NOTE_RAW, "style-note.md");
    const invalid = parseNoteFrontmatter("# no frontmatter here\n", "daily.md");
    const invalidFrontmatter = parseNoteFrontmatter(
      "---\ndate: 2026-06-12\nsessions: 1\n---\nlog\n",
      "dated.md",
    );
    const registry = createRegistry([valid, invalid, invalidFrontmatter]);
    expect(registry.notes.size).toBe(1);
    expect(registry.kindToNotes.has("unknown")).toBe(false);
    expect(registry.kindToNotes.get("house_style")?.length).toBe(1);
  });
});

describe("Schema v2: Frontmatter Parsing & BIND Extraction", () => {
  it("parses v2 optional fields (bind, predicate, event, updated)", () => {
    const raw = `---
kind: house_style
use_when: Writing plugins
does_not_apply_when: Writing scripts
provenance: "Research Stable 2026-10-18"
source: "docs/style.md"
title: "House Style Note"
bind: "Explicit Bind Override"
predicate: "changed since this summary: new style rules recorded"
event: "lint passes"
updated: "2026-10-18T12:00:00Z"
---
# Content Header
Body content.
`;
    const note = parseNoteFrontmatter(raw, "v2-note.md");
    expect(note.valid).toBe(true);
    expect(note.frontmatter.bind).toBe("Explicit Bind Override");
    expect(note.frontmatter.predicate).toBe("changed since this summary: new style rules recorded");
    expect(note.frontmatter.event).toBe("lint passes");
    expect(note.frontmatter.updated).toBe("2026-10-18T12:00:00Z");
  });

  it("extracts BIND with correct precedence: bind -> title -> first heading -> note ID", () => {
    // 1. Explicit bind field
    const noteWithBind: MemoryNote = {
      id: "note-a.md",
      frontmatter: {
        kind: "house_style",
        use_when: "x",
        does_not_apply_when: "y",
        provenance: "z",
        source: "s",
        bind: "Explicit Bind",
        title: "Title Value",
      },
      content: "# Header One\nText",
      raw: "",
      valid: true,
    };
    expect(extractBindPhrase(noteWithBind)).toBe("Explicit Bind");

    // 2. Title field fallback
    const noteWithTitle: MemoryNote = {
      id: "note-b.md",
      frontmatter: {
        kind: "house_style",
        use_when: "x",
        does_not_apply_when: "y",
        provenance: "z",
        source: "s",
        title: "Title Value",
      },
      content: "# Header One\nText",
      raw: "",
      valid: true,
    };
    expect(extractBindPhrase(noteWithTitle)).toBe("Title Value");

    // 3. First heading fallback
    const noteWithHeading: MemoryNote = {
      id: "note-c.md",
      frontmatter: {
        kind: "house_style",
        use_when: "x",
        does_not_apply_when: "y",
        provenance: "z",
        source: "s",
      },
      content: "# First Extracted Heading\nSome body text",
      raw: "",
      valid: true,
    };
    expect(extractBindPhrase(noteWithHeading)).toBe("First Extracted Heading");

    // 4. Note ID fallback
    const noteWithIdOnly: MemoryNote = {
      id: "path/to/my-rule.md",
      frontmatter: {
        kind: "house_style",
        use_when: "x",
        does_not_apply_when: "y",
        provenance: "z",
        source: "s",
      },
      content: "No headings here.",
      raw: "",
      valid: true,
    };
    expect(extractBindPhrase(noteWithIdOnly)).toBe("path/to/my-rule");
  });
});

describe("Schema v2: Kind Compression & Selection", () => {
  it("maps methods/mistakes to the skip-list (procedure, workaround, historical_incident)", () => {
    const proc = parseNoteFrontmatter(`---
kind: procedure
use_when: deployment
does_not_apply_when: local dev
provenance: "2026-10-18"
source: "deploy.md"
predicate: "step 1"
---
Body`, "proc.md");
    expect(getKindCompression(proc)).toBe("skip");

    const workaround = parseNoteFrontmatter(`---
kind: workaround
use_when: bug
does_not_apply_when: fix
provenance: "2026-10-18"
source: "bug.md"
---
Body`, "wa.md");
    expect(getKindCompression(workaround)).toBe("skip");
  });

  it("maps notes with event to event_slot", () => {
    const eventNote = parseNoteFrontmatter(`---
kind: open_loop
use_when: awaiting CI
does_not_apply_when: done
provenance: "2026-10-18"
source: "ci.md"
event: "CI passes"
---
Body`, "ci.md");
    expect(getKindCompression(eventNote)).toBe("event_slot");
  });

  it("maps notes with predicate to three_slot", () => {
    const claimNote = parseNoteFrontmatter(`---
kind: house_style
use_when: coding
does_not_apply_when: tests
provenance: "2026-10-18"
source: "style.md"
predicate: "changed since this summary: pure logic required"
---
Body`, "style.md");
    expect(getKindCompression(claimNote)).toBe("three_slot");
  });

  it("maps notes without predicate to plain", () => {
    const plainNote = parseNoteFrontmatter(`---
kind: glossary
use_when: terms
does_not_apply_when: none
provenance: "2026-10-18"
source: "glossary.md"
title: "Project Glossary"
---
Body`, "gloss.md");
    expect(getKindCompression(plainNote)).toBe("plain");
  });
});

describe("Schema v2: Condition Gating (Truthfulness Invariant)", () => {
  const noteWithUpdated = parseNoteFrontmatter(`---
kind: house_style
use_when: coding
does_not_apply_when: tests
provenance: "2026-10-18"
source: "style.md"
title: "House Style"
predicate: "changed since this summary: new pure logic rule"
updated: "2026-10-18T12:00:00Z"
---
Body`, "style.md");

  it("permits predicate during file-read arm", () => {
    expect(isPredicatePermitted(noteWithUpdated, { arm: "file_read" })).toBe(true);
  });

  it("suppresses predicate during injection/refresh arms to avoid negative prompt penalty", () => {
    expect(isPredicatePermitted(noteWithUpdated, { arm: "resume_refresh" })).toBe(false);
    expect(isPredicatePermitted(noteWithUpdated, { arm: "event_push" })).toBe(false);
    expect(isPredicatePermitted(noteWithUpdated, { arm: "status" })).toBe(false);
  });

  it("suppresses predicate when note is not newer than file mtime", () => {
    const fileMtimeMs = Date.parse("2026-10-18T13:00:00Z"); // file is newer than note (12:00)
    expect(isPredicatePermitted(noteWithUpdated, { arm: "file_read", fileMtimeMs })).toBe(false);

    const olderFileMtimeMs = Date.parse("2026-10-18T11:00:00Z"); // file is older than note
    expect(isPredicatePermitted(noteWithUpdated, { arm: "file_read", fileMtimeMs: olderFileMtimeMs })).toBe(true);
  });
});

describe("Schema v2: Cue Projection Grammar & Slot Order", () => {
  it("projects Claim-type with PREDICATE before BIND: [PREDICATE]: [BIND] — see [POINTER]", () => {
    const claimNote = parseNoteFrontmatter(`---
kind: house_style
use_when: coding
does_not_apply_when: tests
provenance: "2026-10-18"
source: "docs/style.md"
title: "House Style Guidelines"
predicate: "changed since this summary: pure logic required"
---
Body`, "style.md");

    const result = projectCueLine(claimNote, { arm: "file_read" });
    expect(result.emitted).toBe(true);
    expect(result.compression).toBe("three_slot");
    expect(result.cueText).toBe(
      "changed since this summary: pure logic required: House Style Guidelines — see docs/style.md"
    );
  });

  it("projects Event-type with BIND before PREDICATE: [BIND], waiting for: [EVENT] — [PREDICATE]; see [POINTER]", () => {
    const eventNote = parseNoteFrontmatter(`---
kind: open_loop
use_when: PR open
does_not_apply_when: merged
provenance: "2026-10-18"
source: "docs/pr-process.md"
title: "PR #58 Review"
event: "test suite passing"
predicate: "you owe a step when this happens"
---
Body`, "pr58.md");

    const result = projectCueLine(eventNote, { arm: "file_read" });
    expect(result.emitted).toBe(true);
    expect(result.compression).toBe("event_slot");
    expect(result.cueText).toBe(
      "PR #58 Review, waiting for: test suite passing — you owe a step when this happens; see docs/pr-process.md"
    );
  });

  it("projects Plain-type with BIND + POINTER only: [BIND] — see [POINTER]", () => {
    const plainNote = parseNoteFrontmatter(`---
kind: glossary
use_when: terms
does_not_apply_when: none
provenance: "2026-10-18"
source: "docs/glossary.md"
title: "System Architecture Glossary"
---
Body`, "gloss.md");

    const result = projectCueLine(plainNote, { arm: "file_read" });
    expect(result.emitted).toBe(true);
    expect(result.compression).toBe("plain");
    expect(result.cueText).toBe("System Architecture Glossary — see docs/glossary.md");
  });

  it("suppresses Skip-list kinds (emits false, empty cueText)", () => {
    const procNote = parseNoteFrontmatter(`---
kind: procedure
use_when: deployment
does_not_apply_when: none
provenance: "2026-10-18"
source: "docs/deploy.md"
title: "Deployment Checklist"
predicate: "step 1 run migrations"
---
Body`, "deploy.md");

    const result = projectCueLine(procNote, { arm: "file_read" });
    expect(result.emitted).toBe(false);
    expect(result.cueText).toBe("");
    expect(result.compression).toBe("skip");
  });

  it("falls back to plain BIND + POINTER when condition gating suppresses predicate", () => {
    const claimNote = parseNoteFrontmatter(`---
kind: house_style
use_when: coding
does_not_apply_when: tests
provenance: "2026-10-18"
source: "docs/style.md"
title: "House Style Guidelines"
predicate: "changed since this summary: pure logic required"
---
Body`, "style.md");

    // Injected arm (e.g. resume_refresh) suppresses predicate
    const result = projectCueLine(claimNote, { arm: "resume_refresh" });
    expect(result.emitted).toBe(true);
    expect(result.compression).toBe("plain");
    expect(result.cueText).toBe("House Style Guidelines — see docs/style.md");
    expect(result.reason).toContain("Predicate suppressed by condition gating");
  });

  it("formatFileMarker formats v2 cue lines with prefix", () => {
    const claimNote = parseNoteFrontmatter(`---
kind: house_style
use_when: coding
does_not_apply_when: tests
provenance: "2026-10-18"
source: "docs/style.md"
title: "House Style Guidelines"
predicate: "changed since this summary: pure logic required"
---
Body`, "style.md");

    const marker = formatFileMarker(claimNote);
    expect(marker).toContain(DEFAULT_MARKER_PREFIX);
    expect(marker).toContain("changed since this summary: pure logic required: House Style Guidelines — see docs/style.md");
  });
});

describe("Schema v2: recall_verify Linter Checks", () => {
  it("rejects prose and URI pointers in paths", () => {
    expect(isProsePointer("all typescript files across the repository")).toBe(true);
    expect(isProsePointer("https://example.com/docs")).toBe(true);
    expect(isProsePointer("src/plugins/shared/types.ts")).toBe(false);
    expect(isProsePointer("docs/conventions.md")).toBe(false);
    expect(isProsePointer("types.ts")).toBe(false);

    const proseNote = parseNoteFrontmatter(`---
kind: house_style
use_when: coding
does_not_apply_when: tests
provenance: "2026-10-18"
source: "docs/style.md"
paths:
  - "all typescript files across the repository"
  - "https://internal.wiki/rules"
---
Body`, "bad-paths.md");

    const lint = lintNoteSchemaV2(proseNote);
    expect(lint.errors.length).toBe(2);
    expect(lint.errors[0]).toContain("prose/URI pointer");
    expect(lint.errors[1]).toContain("prose/URI pointer");
  });

  it("rejects multi-clause predicates with sentence-internal periods", () => {
    const multiClauseNote = parseNoteFrontmatter(`---
kind: house_style
use_when: coding
does_not_apply_when: tests
provenance: "2026-10-18"
source: "docs/style.md"
predicate: "first clause stated. Second clause follows immediately"
---
Body`, "multi.md");

    const lint = lintNoteSchemaV2(multiClauseNote);
    expect(lint.errors.some((e) => e.includes("sentence-internal period"))).toBe(true);
  });

  it("rejects predicates exceeding 140 characters", () => {
    const longPred = "a".repeat(141);
    const longNote = parseNoteFrontmatter(`---
kind: house_style
use_when: coding
does_not_apply_when: tests
provenance: "2026-10-18"
source: "docs/style.md"
predicate: "${longPred}"
---
Body`, "long.md");

    const lint = lintNoteSchemaV2(longNote);
    expect(lint.errors.some((e) => e.includes("exceeds 140 characters"))).toBe(true);
  });

  it("rejects imperative mood in predicates", () => {
    const imperativeDoNot = parseNoteFrontmatter(`---
kind: house_style
use_when: coding
does_not_apply_when: tests
provenance: "2026-10-18"
source: "docs/style.md"
predicate: "do not use Date.now() directly in logic"
---
Body`, "imp1.md");

    const imperativeAlways = parseNoteFrontmatter(`---
kind: house_style
use_when: coding
does_not_apply_when: tests
provenance: "2026-10-18"
source: "docs/style.md"
predicate: "always wrap I/O behind protocols"
---
Body`, "imp2.md");

    expect(lintNoteSchemaV2(imperativeDoNot).errors.some((e) => e.includes("imperative mood"))).toBe(true);
    expect(lintNoteSchemaV2(imperativeAlways).errors.some((e) => e.includes("imperative mood"))).toBe(true);
  });

  it("warns on unparseable ISO 8601 in updated field", () => {
    const badDateNote = parseNoteFrontmatter(`---
kind: house_style
use_when: coding
does_not_apply_when: tests
provenance: "2026-10-18"
source: "docs/style.md"
updated: "not-a-date"
---
Body`, "bad-date.md");

    const lint = lintNoteSchemaV2(badDateNote);
    expect(lint.warnings.some((w) => w.includes("not a valid ISO 8601 date string"))).toBe(true);
  });

  it("warns on event field present on non-event kinds", () => {
    const misplacedEvent = parseNoteFrontmatter(`---
kind: house_style
use_when: coding
does_not_apply_when: tests
provenance: "2026-10-18"
source: "docs/style.md"
event: "lint passes"
---
Body`, "event-warn.md");

    const lint = lintNoteSchemaV2(misplacedEvent);
    expect(lint.warnings.some((w) => w.includes("Field 'event' present on non-event kind"))).toBe(true);
  });
});

describe("resolvePointer (exact-path pointer guarantee)", () => {
  it("uses path-shaped source verbatim as the pointer", () => {
    const note = parseNoteFrontmatter(
      `---\nkind: house_style\nuse_when: x\ndoes_not_apply_when: y\nprovenance: p\nsource: "docs/style.md"\n---\n# T\n`,
      "notes/style-note.md",
    );
    expect(resolvePointer(note)).toEqual({ pointer: "docs/style.md" });
  });

  it("demotes prose source to context and falls back to the note's own id", () => {
    const note = parseNoteFrontmatter(
      `---\nkind: house_style\nuse_when: x\ndoes_not_apply_when: y\nprovenance: p\nsource: "the wiki entry on style guidelines"\n---\n# T\n`,
      "notes/style-note.md",
    );
    const r = resolvePointer(note);
    expect(r.pointer).toBe("notes/style-note");
    expect(r.context).toBe("the wiki entry on style guidelines");
  });

  it("demotes URI sources (index-hop risk)", () => {
    const note = parseNoteFrontmatter(
      `---\nkind: authority\nuse_when: x\ndoes_not_apply_when: y\nprovenance: p\nsource: "https://wiki.example.org/Authority"\n---\n# T\n`,
      "notes/authority-note.md",
    );
    const r = resolvePointer(note);
    expect(r.pointer).toBe("notes/authority-note");
    expect(r.context).toBe("https://wiki.example.org/Authority");
  });

  it("falls back to the registry id when source is empty", () => {
    const note = parseNoteFrontmatter(
      `---\nkind: domain_fact\nuse_when: x\ndoes_not_apply_when: y\nprovenance: p\nsource: ""\n---\n# T\n`,
      "notes/fact.md",
    );
    expect(resolvePointer(note).pointer).toBe("notes/fact");
  });

  it("projectCueLine uses the resolved pointer (plain form)", () => {
    const note = parseNoteFrontmatter(
      `---\nkind: glossary\nuse_when: x\ndoes_not_apply_when: y\nprovenance: p\nsource: "Glossary of Terms"\n---\n# T\n`,
      "notes/glossary-entry.md",
    );
    const cue = projectCueLine(note, { arm: "file_read" });
    expect(cue.cueText).toBe("T — see notes/glossary-entry");
    expect(cue.cueText).not.toContain("Glossary of Terms");
  });

  it("v1 fallback marker carries the exact path with prose source as context", () => {
    const note = parseNoteFrontmatter(
      `---\nkind: environment\nuse_when: host work\ndoes_not_apply_when: n/a\nprovenance: p\nsource: "the platform wiki"\n---\n# T\n`,
      "notes/env-note.md",
    );
    const marker = formatFileMarker(note, "# [SIGNPOST] current version in memory:");
    // Pointer token must be the exact path; prose source demoted to trailing context
    expect(marker).toContain(": notes/env-note (the platform wiki) (host work)");
    expect(marker.startsWith("# [SIGNPOST] current version in memory: notes/env-note")).toBe(true);
  });

  it("formatEventPushCue resolves prose sources to the registry path", () => {
    const note = parseNoteFrontmatter(
      `---\nkind: project_status\nuse_when: x\ndoes_not_apply_when: y\nprovenance: p\nsource: "Standup Board"\n---\n# T\n`,
      "notes/status.md",
    );
    const cue = formatEventPushCue(note, "hold-once");
    // Pointer token is the exact path; prose source may appear only as demoted context
    expect(cue).toContain("• notes/status — via: Standup Board");
    expect(cue.indexOf("notes/status")).toBeLessThan(cue.indexOf("Standup Board"));
  });
});

// ═══════════════════════════════════════════════════════════════
// PR-1: Per-kind default predicate table + MUST-framing lint
// ═══════════════════════════════════════════════════════════════

describe("PR-1: Per-kind default predicate table", () => {
  const unpredicated = (kind: string, id = "note.md") =>
    parseNoteFrontmatter(`---
kind: ${kind}
use_when: testing
does_not_apply_when: none
provenance: "2026-10-19"
source: "target.md"
title: "Test Note"
---
Body`, id);

  it("seeds bench-backed defaults for measured kinds", () => {
    expect(DEFAULT_KIND_PREDICATES.domain_fact).toBe("value changed");
    expect(DEFAULT_KIND_PREDICATES.authority).toBe("approver changed");
    expect(DEFAULT_KIND_PREDICATES.user_preference).toBe("owner's choice was revised");
  });

  it("fills the predicate gap on un-predicated notes of seeded kinds", () => {
    const seeded = applyKindPredicateDefaults(unpredicated("domain_fact"), DEFAULT_KIND_PREDICATES);
    expect(seeded.frontmatter.predicate).toBe("value changed");
    expect(getKindCompression(seeded)).toBe("three_slot");
  });

  it("projects the seeded predicate through three-slot grammar", () => {
    const seeded = applyKindPredicateDefaults(unpredicated("authority"), DEFAULT_KIND_PREDICATES);
    const cue = projectCueLine(seeded, { arm: "file_read" });
    expect(cue.compression).toBe("three_slot");
    expect(cue.cueText).toBe("approver changed: Test Note — see target.md");
  });

  it("never overwrites a note's own predicate", () => {
    const note = parseNoteFrontmatter(`---
kind: domain_fact
use_when: testing
does_not_apply_when: none
provenance: "2026-10-19"
source: "target.md"
predicate: "the source of this figure was corrected"
---
Body`, "note.md");
    const seeded = applyKindPredicateDefaults(note, DEFAULT_KIND_PREDICATES);
    expect(seeded).toBe(note);
    expect(seeded.frontmatter.predicate).toBe("the source of this figure was corrected");
  });

  it("leaves unseeded kinds and invalid notes untouched", () => {
    const glossary = applyKindPredicateDefaults(unpredicated("glossary"), DEFAULT_KIND_PREDICATES);
    expect(glossary.frontmatter.predicate).toBeUndefined();
    const invalid = parseNoteFrontmatter("no frontmatter", "bad.md");
    expect(applyKindPredicateDefaults(invalid, DEFAULT_KIND_PREDICATES)).toBe(invalid);
  });

  it("merges config over defaults and supports empty-string disable", () => {
    const table = mergeKindPredicateTable({ domain_fact: "the source of this figure was corrected", authority: "" });
    expect(table.domain_fact).toBe("the source of this figure was corrected");
    expect(table.authority).toBe("");
    expect(table.user_preference).toBe("owner's choice was revised");
    const seeded = applyKindPredicateDefaults(unpredicated("domain_fact"), table);
    expect(seeded.frontmatter.predicate).toBe("the source of this figure was corrected");
    const disabled = applyKindPredicateDefaults(unpredicated("authority"), table);
    expect(disabled.frontmatter.predicate).toBeUndefined();
  });

  it("empty config falls back to the default table", () => {
    expect(mergeKindPredicateTable({})).toBe(DEFAULT_KIND_PREDICATES);
    expect(mergeKindPredicateTable(null)).toBe(DEFAULT_KIND_PREDICATES);
    expect(mergeKindPredicateTable(undefined)).toBe(DEFAULT_KIND_PREDICATES);
  });
});

describe("PR-1: MUST-framing predicate lint", () => {
  const mustNote = (predicate: string) =>
    parseNoteFrontmatter(`---
kind: authority
use_when: testing
does_not_apply_when: none
provenance: "2026-10-19"
source: "target.md"
predicate: "${predicate}"
---
Body`, "note.md");

  it("rejects mid-clause MUST framing as a lint error", () => {
    const lint = lintNoteSchemaV2(mustNote("you MUST re-check the approver"));
    expect(lint.errors.some((e) => e.includes("MUST-rule framing"))).toBe(true);
  });

  it("accepts descriptive predicates without MUST framing", () => {
    const lint = lintNoteSchemaV2(mustNote("approver changed"));
    expect(lint.errors).toEqual([]);
  });

  it("keeps verification verdict consistent: MUST-framed note counts invalid", () => {
    const bad = mustNote("you MUST re-check the approver");
    const good = mustNote("approver changed");
    const report = verifyNotes([bad, good]);
    expect(report.validCount).toBe(1);
    expect(report.invalidCount).toBe(1);
  });
});
