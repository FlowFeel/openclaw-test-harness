/**
 * OcMemoryRecall — pure logic seam barrel export.
 *
 * @behavior
 * Pure decision logic for the oc-memory-recall plugin (Deliverables 0, 1, 2, 4, 5, 6):
 * Decomposed into focused units under single responsibilities:
 * - note-schema-logic: frontmatter parsing & schema verification
 * - note-registry-logic: in-memory registry & path/kind indexing
 * - cue-projection-logic: 3-slot cue projection, signposts, and pointer resolution
 * - reply-linter-logic: pre-reply review gate, catalogue, and telemetry
 * - recall-regex-utils: centralized named regular expressions
 * - recall-messages: centralized message constants and string templates
 *
 * @invariants
 * - Every function is pure: same input → same output, zero side effects.
 * - No imports of I/O modules (node:fs, node:http, fetch).
 * - No Date.now() / Math.random() — timestamps are injected if needed.
 * - Zero auxiliary model calls: all decisions are deterministic host compute.
 * - Zero inline regexes in logic files (regex in utils file only).
 * - Zero else-if chains (switch / object maps used throughout).
 *
 * @dft
 * - Tested in memory-recall-logic.spec.ts with inline data, zero fixtures.
 */

// Re-export regexes and messages from utils
export {
  PREDICATE_INTERNAL_PERIOD_REGEX,
  IMPERATIVE_MOOD_REGEX,
  PATH_SHAPE_REGEX,
  ISO_8601_REGEX,
  KIND_LINE_REGEX,
  WHITESPACE_CHAR_REGEX,
  WHITESPACE_SEQUENCE_REGEX,
  MARKDOWN_HEADING_REGEX,
  MD_EXTENSION_REGEX,
} from "./recall-regex-utils.ts";

export { RECALL_MESSAGES } from "./recall-messages.ts";

// Note schema & frontmatter parsing
export {
  RECOGNIZED_NOTE_KINDS,
  type NoteKind,
  type MemoryNoteFrontmatter,
  type MemoryNote,
  hasKindFrontmatter,
  parseNoteFrontmatter,
  parseSimpleYaml,
} from "./note-schema-logic.ts";

// Registry indexing & path queries
export {
  type NoteRegistry,
  normalizePath,
  createRegistry,
  findNotesForPath,
  findNotesForKind,
} from "./note-registry-logic.ts";

// Cue projection, compression, and signposts
export {
  type CompressionLevel,
  type CueContext,
  type CueProjectionResult,
  SKIP_LIST_KINDS,
  EVENT_SLOT_KINDS,
  DEFAULT_MARKER_PREFIX,
  extractBindPhrase,
  getKindCompression,
  isPredicatePermitted,
  projectCueLine,
  formatFileMarker,
  type MarkerProcessResult,
  FILE_READ_TOOLS,
  extractTargetFilePath,
  processToolResultForFileRead,
  isProsePointer,
  resolvePointer,
} from "./cue-projection-logic.ts";

// Review gate, catalogue, and telemetry
export {
  type ArmTelemetry,
  type RecallTelemetryState,
  createInitialTelemetry,
  recordFire,
  recordHit,
  recordFollow,
  formatTelemetryReport,
  lintNoteSchemaV2,
  type NoteVerificationResult,
  verifyNotes,
  buildRecallStatusReport,
  type ToolDescriptionInjectionResult,
  formatToolNoteSignpost,
  injectToolDescriptionNotes,
  type CatalogueOptions,
  type CatalogueReport,
  buildNoteCatalogue,
  type MissingSignpost,
  type ReplyLintReport,
  lintAgentReply,
  applyReplyLintCorrection,
  type ResumeRefreshResult,
  buildResumeRefreshNotice,
} from "./reply-linter-logic.ts";
