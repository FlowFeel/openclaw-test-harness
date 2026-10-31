/**
 * Transcript materializer pure logic (T-581 part 1).
 *
 * @behavior
 * - Scans JSONL transcript lines to detect unrotated compaction states.
 * - Extracts and identifies the last compaction entry and its referenced firstKeptEntryId.
 * - Evaluates whether unrotated compaction occurred based on line distance before firstKeptEntryId.
 * - Builds successor transcript lines containing a fresh session header, the compaction entry, and kept lines verbatim.
 * - Deterministically estimates token counts using message content length heuristics.
 *
 * @dft
 * - Pure functions only: no node:fs, no I/O, no network.
 * - Deterministic: all timestamps and session IDs are injected via parameters. No Date.now() or Math.random().
 * - Safe error handling: invalid JSON lines and malformed entries are ignored or handled gracefully without throwing.
 */

export interface CompactionEntry {
  type: "compaction";
  id?: string;
  parentId?: string;
  timestamp?: string;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  details?: Record<string, unknown>;
  fromHook?: boolean;
  [key: string]: unknown;
}

export interface UnrotatedCompactionDetection {
  unrotated: boolean;
  compactionIndex?: number;
  firstKeptIndex?: number;
  compactionEntry?: CompactionEntry;
  reason?: string;
}

export interface BuildSuccessorResult {
  lines: string[];
  hasSessionHeader: boolean;
  warning?: string;
}

export interface DetectOptions {
  minLinesBeforeKept?: number;
}

/**
 * Scans JSONL transcript lines for unrotated compaction.
 *
 * Finds the last compaction entry (`type === "compaction"`).
 * If found, locates the first line index whose `id` equals the compaction entry's `firstKeptEntryId`.
 * If that index is >= minLinesBeforeKept (default 50), the file was never rotated.
 */
export function detectUnrotatedCompaction(
  lines: string[],
  opts?: DetectOptions,
): UnrotatedCompactionDetection {
  const minLinesBeforeKept = opts?.minLinesBeforeKept ?? 50;

  let lastCompactionIndex = -1;
  let lastCompactionEntry: CompactionEntry | null = null;

  // Scan backwards or forwards to find the LAST compaction entry
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed && parsed.type === "compaction") {
        lastCompactionIndex = i;
        lastCompactionEntry = parsed as CompactionEntry;
        break;
      }
    } catch {
      // Ignore unparsable lines defensively
    }
  }

  if (lastCompactionIndex === -1 || !lastCompactionEntry) {
    return {
      unrotated: false,
      reason: "No compaction entry found",
    };
  }

  const targetId = lastCompactionEntry.firstKeptEntryId;
  if (!targetId || typeof targetId !== "string") {
    return {
      unrotated: false,
      compactionIndex: lastCompactionIndex,
      compactionEntry: lastCompactionEntry,
      reason: "Compaction entry missing firstKeptEntryId",
    };
  }

  let firstKeptIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed && parsed.id === targetId) {
        firstKeptIndex = i;
        break;
      }
    } catch {
      // Ignore unparsable lines defensively
    }
  }

  if (firstKeptIndex === -1) {
    return {
      unrotated: false,
      compactionIndex: lastCompactionIndex,
      compactionEntry: lastCompactionEntry,
      reason: `firstKeptEntryId ${targetId} not found in transcript lines`,
    };
  }

  const unrotated = firstKeptIndex >= minLinesBeforeKept;

  return {
    unrotated,
    compactionIndex: lastCompactionIndex,
    firstKeptIndex,
    compactionEntry: lastCompactionEntry,
    ...(unrotated ? {} : { reason: `firstKeptIndex (${firstKeptIndex}) < minLinesBeforeKept (${minLinesBeforeKept})` }),
  };
}

/**
 * Builds successor transcript lines from detection results and injected metadata.
 *
 * If line 0 is a session header (`type === "session"`), its `id` and `timestamp`
 * are replaced with `meta.newSessionId` and `meta.timestamp`, retaining other fields.
 * If line 0 is not a session header, the successor has no header (warning set).
 *
 * Retained range semantics (verified against append-only upstream layout):
 * the successor is the session header followed by all original lines from
 * `firstKeptIndex` to end of file, verbatim. The compaction entry itself is
 * INSIDE that range in the real layout (entries with ids >= firstKeptEntryId
 * precede the compaction entry physically, since the transcript is append-only).
 * Only when the compaction entry falls OUTSIDE the retained range (kept entries
 * all post-date it) is it re-inserted right after the header, so the summary
 * is never lost. Duplicates are never emitted.
 */
export function buildSuccessorLines(
  lines: string[],
  detection: UnrotatedCompactionDetection,
  meta: { newSessionId: string; timestamp: string },
): BuildSuccessorResult {
  const resultLines: string[] = [];
  let hasSessionHeader = false;
  let warning: string | undefined;

  if (detection.compactionIndex === undefined || detection.firstKeptIndex === undefined) {
    throw new Error("Cannot build successor lines without valid compactionIndex and firstKeptIndex");
  }

  // Handle header (index 0)
  if (lines.length > 0) {
    const line0 = lines[0].trim();
    try {
      const parsed0 = JSON.parse(line0) as Record<string, unknown>;
      if (parsed0 && parsed0.type === "session") {
        const updatedHeader = {
          ...parsed0,
          id: meta.newSessionId,
          timestamp: meta.timestamp,
        };
        resultLines.push(JSON.stringify(updatedHeader));
        hasSessionHeader = true;
      }
    } catch {
      // Line 0 is not valid JSON
    }
  }

  if (!hasSessionHeader) {
    warning = "First line is not a session header; header omitted from successor transcript";
  }

  // Retained range: all lines from firstKeptIndex to EOF, verbatim.
  // The compaction entry may sit inside this range (real append-only shape);
  // if it does not, re-insert it right after the header so the summary survives.
  const compactionLine = lines[detection.compactionIndex];
  const compactionInsideRange = detection.compactionIndex >= detection.firstKeptIndex;
  if (!compactionInsideRange) {
    resultLines.push(compactionLine);
  }

  for (let i = detection.firstKeptIndex; i < lines.length; i++) {
    resultLines.push(lines[i]);
  }

  return {
    lines: resultLines,
    hasSessionHeader,
    warning,
  };
}

/**
 * Deterministically estimates context tokens for an array of JSONL transcript lines.
 *
 * Heuristic:
 * 1. For lines parseable as JSON:
 *    - If entry has `message.content`, extract text (string or array of text blocks).
 *    - If text exists, tokens = Math.ceil(text.length / 4).
 *    - If no text content (or custom/model_change/session entry), fall back to Math.ceil(line.length / 4).
 * 2. For unparseable lines, fall back to Math.ceil(line.length / 4).
 */
export function estimateContextTokens(lines: string[]): number {
  let totalTokens = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let lineTokens = 0;
    let countedFromMessage = false;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const rawMsg = parsed?.message;

      if (rawMsg && typeof rawMsg === "object") {
        const msg = rawMsg as Record<string, unknown>;
        let extractedText = "";

        if (typeof msg.content === "string") {
          extractedText = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
              extractedText += (part as { text: string }).text;
            }
          }
        }

        if (extractedText.length > 0) {
          lineTokens = Math.ceil(extractedText.length / 4);
          countedFromMessage = true;
        }
      }
    } catch {
      // Fallback
    }

    if (!countedFromMessage) {
      lineTokens = Math.ceil(trimmed.length / 4);
    }

    totalTokens += lineTokens;
  }

  return totalTokens;
}
