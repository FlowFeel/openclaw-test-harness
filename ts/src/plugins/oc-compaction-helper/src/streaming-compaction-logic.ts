/**
 * Streaming compaction — segmented, bounded-memory transcript summarization.
 *
 * @behavior
 * The built-in LLM summarizer loads the ENTIRE transcript into one model
 * call. Above ~5.2 MB that call itself overflows the model context
 * ("prompt too large for the model (precheck)") and compaction requires
 * compacting — a hard logical dead end seen live on topic 70660
 * (2026-09-17/18, twice, 18h apart).
 *
 * This provider never makes a single unbounded model call:
 * 1. Segment the transcript into chunks that each fit a byte budget.
 * 2. Literate-compact each segment (deterministic strip of tool payloads,
 *    assistant skeletons, verbatim user turns).
 * 3. Merge sections into a rolling summary capped at maxRollingChars,
 *    with an explicit elision marker when earlier stream text is dropped.
 * 4. Optionally refine each merge through an injected async refiner
 *    (e.g. a context-fitting LLM call). Refiner failure degrades to the
 *    deterministic merge — the provider NEVER returns empty, so OC never
 *    falls back to the unbounded built-in path.
 *
 * @invariants
 * - Pure except the injected refiner (Axiom 1: logic/io separation).
 * - Deterministic: same messages + no refiner -> byte-identical summary.
 * - Non-empty summary for any input (never triggers LLM fallback).
 * - Bounded: rolling summary never exceeds maxRollingChars + slack.
 * - A message is never split across segments; an oversized message gets
 *   its own segment (the literate pass shrinks it before merging).
 *
 * @dft
 * - streaming-compaction.spec.ts: segmentation boundaries, oversized
 *   singletons, rolling-cap elision, determinism, refiner injection and
 *   refiner-failure degradation.
 */

import { compactLiterate } from "./literate-compaction-logic.js";

/** Default per-segment byte budget: ~400 KB ≈ ~100K tokens of JSON. */
export const DEFAULT_SEGMENT_BUDGET_BYTES = 400_000;

/** Default rolling-summary cap before elision kicks in. */
export const DEFAULT_MAX_ROLLING_CHARS = 120_000;

export interface StreamingCompactionOptions {
  /** Max estimated bytes per segment. Default: 400_000. */
  segmentBudgetBytes?: number;
  /** Max chars of the rolling summary before elision. Default: 120_000. */
  maxRollingChars?: number;
  /** Custom instructions threaded into each segment's literate pass. */
  customInstructions?: string;
  /** Previous summary text to roll forward (from OC compaction state). */
  previousSummary?: string;
  /**
   * Optional async refiner applied to each merge (context-fitting by
   * construction: section + rolling summary are both bounded). Failure
   * degrades to the deterministic merge — never throws, never returns empty.
   */
  refine?: (input: {
    section: string;
    previousSummary: string;
    index: number;
    total: number;
  }) => Promise<string>;
}

export interface StreamingCompactionResult {
  summary: string;
  segmentCount: number;
  refinedSegments: number;
  totalInputBytes: number;
  finalBytes: number;
  reductionPercent: number;
}

/** Cheap size proxy for one message. Never throws. */
function estimateBytes(msg: unknown): number {
  try {
    return JSON.stringify(msg ?? null).length;
  } catch {
    return 0;
  }
}

/**
 * Split messages into segments that each fit the byte budget.
 * A message is never split across segments; a message larger than the
 * whole budget becomes a single-message segment.
 */
export function segmentMessages(
  messages: unknown[],
  budgetBytes: number
): unknown[][] {
  const segments: unknown[][] = [];
  let current: unknown[] = [];
  let currentBytes = 0;

  for (const msg of messages) {
    const bytes = estimateBytes(msg);
    if (current.length > 0 && currentBytes + bytes > budgetBytes) {
      segments.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(msg);
    currentBytes += bytes;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * Merge a section into the rolling summary, eliding with an explicit
 * marker when the cap is exceeded. Deterministic.
 */
export function mergeRolling(
  rolling: string,
  section: string,
  capChars: number
): string {
  const combined = rolling ? `${rolling}\n\n${section}` : section;
  if (combined.length <= capChars) return combined;

  const headChars = Math.floor(capChars * 0.6);
  const tailChars = Math.floor(capChars * 0.35);
  const head = combined.slice(0, headChars).trim();
  const tail = combined.slice(combined.length - tailChars).trim();
  const elided = combined.length - headChars - tailChars;
  return `${head}\n... [${elided} chars of earlier compaction stream elided] ...\n${tail}`;
}

/**
 * Streaming compaction: segment → literate per segment → capped rolling
 * merge → (optional) injected refiner per merge.
 */
export async function streamingCompact(
  messages: unknown[],
  options?: StreamingCompactionOptions
): Promise<StreamingCompactionResult> {
  const budget = options?.segmentBudgetBytes ?? DEFAULT_SEGMENT_BUDGET_BYTES;
  const cap = options?.maxRollingChars ?? DEFAULT_MAX_ROLLING_CHARS;

  const segments = segmentMessages(Array.isArray(messages) ? messages : [], budget);
  let rolling = options?.previousSummary ? options.previousSummary.trim() : "";
  let refinedSegments = 0;
  let totalInputBytes = 0;

  for (let i = 0; i < segments.length; i++) {
    const literate = compactLiterate(segments[i], {
      customInstructions: options?.customInstructions,
    });
    totalInputBytes += literate.originalEstimatedBytes;

    let section = literate.summary;
    if (options?.refine) {
      try {
        const refined = await options.refine({
          section,
          previousSummary: rolling,
          index: i,
          total: segments.length,
        });
        if (typeof refined === "string" && refined.trim()) {
          section = refined.trim();
          refinedSegments++;
        }
      } catch {
        // Degrade to the deterministic section — never fall back to the
        // built-in unbounded summarizer (issue: compaction dead end).
      }
    }
    rolling = mergeRolling(rolling, section, cap);
  }

  const header =
    `# Streaming Session Compaction Summary\n\n` +
    `- **Segments:** ${segments.length}` +
    (refinedSegments > 0 ? ` (refined: ${refinedSegments})` : " (deterministic)") +
    `\n- **Input processed:** ${totalInputBytes} bytes\n`;
  const summary = `${header}\n${rolling}`.trim();
  const finalBytes = summary.length;
  const reductionPercent =
    totalInputBytes > 0
      ? Math.max(
          0,
          Math.round(((totalInputBytes - finalBytes) / totalInputBytes) * 100)
        )
      : 0;

  return {
    summary,
    segmentCount: segments.length,
    refinedSegments,
    totalInputBytes,
    finalBytes,
    reductionPercent,
  };
}
