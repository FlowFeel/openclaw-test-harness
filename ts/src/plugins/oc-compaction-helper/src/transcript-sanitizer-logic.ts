/**
 * In-situ transcript sanitizer logic.
 *
 * @behavior
 * - Reads a transcript of JSONL events (one message/entry per line).
 * - Identifies and deduplicates consecutive zero-delta poll frames (`process poll`, `(no new output)`).
 * - Applies head 800 + tail 800 truncation with omission notice to oversized toolResult messages.
 * - Deduplicates consecutive repeated tool errors (e.g., identical command failures).
 * - Preserves all user, assistant, system turns, and conversation order intact.
 * - Pure logic: operates on line arrays / strings, returns sanitized text and report.
 *
 * @dft
 * - Tested with synthetic bloated JSONL fixtures (>1,000 poll frames).
 */

import { truncateHeadTail } from "../../oc-session-guard/src/tool-result-hygiene-logic.js";
import {
  isZeroDeltaPollText,
  compactPollMarker,
  extractPollDetails,
} from "../../oc-session-guard/src/poll-hygiene-logic.js";

export interface SanitizeReport {
  originalEntries: number;
  sanitizedEntries: number;
  originalBytes: number;
  sanitizedBytes: number;
  suppressedPollFrames: number;
  truncatedToolResults: number;
  deduplicatedErrors: number;
  reductionPercent: number;
}

export interface SanitizeOptions {
  headChars?: number;
  tailChars?: number;
  maxToolResultChars?: number;
}

/**
 * Pure function to sanitize lines of a .jsonl transcript.
 */
export function sanitizeTranscriptLines(
  lines: string[],
  options?: SanitizeOptions,
): { sanitizedLines: string[]; report: SanitizeReport } {
  let originalBytes = 0;
  let suppressedPollFrames = 0;
  let truncatedToolResults = 0;
  let deduplicatedErrors = 0;

  const validEntries: Array<{ raw: string; parsed: Record<string, unknown> | null }> = [];

  for (const line of lines) {
    originalBytes += line.length + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      validEntries.push({ raw: trimmed, parsed });
    } catch {
      // If line is not JSON, preserve as-is
      validEntries.push({ raw: trimmed, parsed: null });
    }
  }

  const resultEntries: string[] = [];
  let inPollSequence = false;
  let lastErrorMessage: string | null = null;

  for (let i = 0; i < validEntries.length; i++) {
    const entry = validEntries[i];
    if (!entry.parsed) {
      resultEntries.push(entry.raw);
      inPollSequence = false;
      lastErrorMessage = null;
      continue;
    }

    const obj = entry.parsed;
    // OpenClaw transcript entries can be either an AgentMessage directly { role, content, ... }
    // or wrapped in an event record { type: "message", message: { role, content, ... } }
    const isWrapped = obj.message && typeof obj.message === "object";
    const msg = (isWrapped ? obj.message : obj) as Record<string, unknown>;

    // 1. Check if toolResult
    if (msg.role === "toolResult") {
      let textContent = "";
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
            textContent += (item as { text: string }).text + "\n";
          }
        }
      } else if (typeof msg.content === "string") {
        textContent = msg.content;
      }

      // Check for zero-delta poll
      if (isZeroDeltaPollText(textContent)) {
        if (inPollSequence) {
          // Suppress redundant consecutive poll frame
          suppressedPollFrames++;
          continue;
        }

        // First poll frame: compact to marker
        inPollSequence = true;
        const details = (msg.details && typeof msg.details === "object")
          ? (msg.details as Record<string, unknown>)
          : undefined;
        const { pid, sessionId } = extractPollDetails(textContent, details);
        const marker = compactPollMarker(pid, sessionId);

        const compactedMsg = { ...msg };
        if (Array.isArray(compactedMsg.content)) {
          compactedMsg.content = [{ type: "text", text: marker }];
        } else {
          compactedMsg.content = marker;
        }

        const nextObj = isWrapped ? { ...obj, message: compactedMsg } : compactedMsg;
        resultEntries.push(JSON.stringify(nextObj));
        lastErrorMessage = null;
        continue;
      }

      inPollSequence = false;

      // Check for repeated tool error deduplication
      const isError = Boolean(msg.isError) || textContent.toLowerCase().includes("error:");
      if (isError) {
        if (lastErrorMessage && lastErrorMessage === textContent.trim()) {
          deduplicatedErrors++;
          continue;
        }
        lastErrorMessage = textContent.trim();
      } else {
        lastErrorMessage = null;
      }

      // Apply head/tail truncation
      let changed = false;
      const nextMsg = { ...msg };
      if (Array.isArray(nextMsg.content)) {
        const nextContent = nextMsg.content.map((item) => {
          if (item && typeof item === "object") {
            const textVal = (item as { text?: unknown }).text;
            if (typeof textVal === "string") {
              const res = truncateHeadTail(textVal, options);
              if (res.truncated) {
                changed = true;
                return { ...item, text: res.text };
              }
            }
          }
          return item;
        });
        if (changed) {
          nextMsg.content = nextContent;
        }
      } else if (typeof nextMsg.content === "string") {
        const res = truncateHeadTail(nextMsg.content, options);
        if (res.truncated) {
          changed = true;
          nextMsg.content = res.text;
        }
      }

      if (changed) {
        truncatedToolResults++;
        const nextObj = isWrapped ? { ...obj, message: nextMsg } : nextMsg;
        resultEntries.push(JSON.stringify(nextObj));
      } else {
        resultEntries.push(JSON.stringify(obj));
      }
      continue;
    }

    // Non-toolResult message (user, assistant, system): reset poll sequence
    inPollSequence = false;
    lastErrorMessage = null;
    resultEntries.push(JSON.stringify(obj));
  }

  let sanitizedBytes = 0;
  for (const r of resultEntries) {
    sanitizedBytes += r.length + 1;
  }

  const reductionPercent = originalBytes > 0
    ? Math.round(((originalBytes - sanitizedBytes) / originalBytes) * 100)
    : 0;

  const report: SanitizeReport = {
    originalEntries: lines.filter((l) => l.trim().length > 0).length,
    sanitizedEntries: resultEntries.length,
    originalBytes,
    sanitizedBytes,
    suppressedPollFrames,
    truncatedToolResults,
    deduplicatedErrors,
    reductionPercent,
  };

  return { sanitizedLines: resultEntries, report };
}
