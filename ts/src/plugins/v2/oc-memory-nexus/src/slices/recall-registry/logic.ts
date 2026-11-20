/**
 * Recall Registry Pure Transition Algebra — note indexing, M4 reply linting,
 * verification, catalogue projection, and telemetry accounting.
 *
 * @invariants
 * - Pure logic: zero I/O, zero Date.now(), immutable CheckResult transitions (A1, A2, A6).
 *
 * @dft
 * - Tested via slices/recall-registry/tests/logic.spec.ts.
 */

import {
  createRegistry,
  parseNoteFrontmatter,
  hasKindFrontmatter,
  buildRecallStatusReport,
  verifyNotes,
  buildNoteCatalogue,
  recordFire,
  recordHit,
  type MemoryNote,
} from "../../memory-recall-logic.js";
import { lintAgentReply, applyReplyLintCorrection } from "../../reply-linter-logic.js";
import type { RawNoteFile } from "../../memory-recall-io.js";
import type { RecallRegistrySliceState } from "./state.js";

export function indexRawNoteFiles(
  state: RecallRegistrySliceState,
  rawFiles: RawNoteFile[],
): { nextState: RecallRegistrySliceState; scanned: number; candidates: number; indexed: number } {
  const candidates = rawFiles.filter((n) => hasKindFrontmatter(n.rawContent));
  const parsedNotes: MemoryNote[] = candidates
    .map((n) => parseNoteFrontmatter(n.rawContent, n.filePath))
    .filter((n): n is MemoryNote => Boolean(n));
  const registry = createRegistry(parsedNotes);

  return {
    scanned: rawFiles.length,
    candidates: candidates.length,
    indexed: registry.notes.size,
    nextState: {
      ...state,
      registry,
      lastScanCount: rawFiles.length,
      lastCandidateCount: candidates.length,
    },
  };
}

export function applyM4ReplyLint(
  state: RecallRegistrySliceState,
  cleanedBody: string,
): { nextState: RecallRegistrySliceState; correctedBody?: string; flaggedCount: number } {
  if (!cleanedBody) return { nextState: state, flaggedCount: 0 };
  const lint = lintAgentReply(cleanedBody, state.registry);
  if (lint.valid) return { nextState: state, flaggedCount: 0 };

  let telemetry = state.telemetry;
  for (const item of lint.missingSignposts) {
    telemetry = recordFire(telemetry, item.kind, "M4");
    telemetry = recordHit(telemetry, item.kind, "M4");
  }
  const correctedBody = applyReplyLintCorrection(cleanedBody, lint);
  return {
    nextState: { ...state, telemetry },
    correctedBody,
    flaggedCount: lint.missingSignposts.length,
  };
}

export function recordExternalTelemetryEvents(
  state: RecallRegistrySliceState,
  events: Array<{ kind: string; arm: string }>,
): { nextState: RecallRegistrySliceState; count: number } {
  let telemetry = state.telemetry;
  for (const ev of events) {
    telemetry = recordFire(telemetry, ev.kind, ev.arm);
    telemetry = recordHit(telemetry, ev.kind, ev.arm);
  }
  return { nextState: { ...state, telemetry }, count: events.length };
}

export function projectRecallStatus(state: RecallRegistrySliceState) {
  return buildRecallStatusReport(state.registry, state.telemetry);
}

export function projectRecallVerification(state: RecallRegistrySliceState) {
  return verifyNotes(Array.from(state.registry.notes.values()));
}

export function projectRecallCatalogue(
  state: RecallRegistrySliceState,
  opts: { kind?: string; maxEntries?: number },
) {
  return buildNoteCatalogue(state.registry, {
    kinds: opts.kind ? [opts.kind] : undefined,
    maxEntries: opts.maxEntries ?? 50,
  });
}

