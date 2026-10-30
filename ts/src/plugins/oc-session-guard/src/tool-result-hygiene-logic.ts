/**
 * Tool Result Persist & Hygeine Logic — pure truncation and formatting seam.
 *
 * @behavior
 * - Pure logic: no direct I/O, no timers, zero auxiliary model calls.
 * - Truncates oversized tool results using head/tail elision (default 800 head + 800 tail).
 * - JSON-aware path (T-582): structured payloads are elided at the value/element
 *   level so the result remains valid, parseable JSON after truncation.
 * - Emits a concise omission notice indicating omitted characters.
 * - Preserves exempt tools from truncation.
 *
 * @dft
 * - Tested with inline string fixtures.
 * - JSON truncation round-trip invariant: every elided output must re-parse
 *   via JSON.parse without error (asserted in tests).
 */

export interface TruncationOptions {
  headChars?: number;
  tailChars?: number;
  maxToolResultChars?: number;
  exemptTools?: string[];
  /** T-582: per-string-field elision cap for structured JSON payloads. */
  maxFieldChars?: number;
}

export const DEFAULT_HEAD_CHARS = 800;
export const DEFAULT_TAIL_CHARS = 800;
export const DEFAULT_MAX_CHARS = 1600;
export const DEFAULT_MAX_FIELD_CHARS = 800;

// T-582: array elision keeps the first and last few elements so both the
// request shape and the terminal entries survive.
const JSON_ARRAY_KEEP_HEAD = 3;
const JSON_ARRAY_KEEP_TAIL = 2;

export const OMISSION_NOTICE_PREFIX = "\n\n[... ";
export const OMISSION_NOTICE_SUFFIX = " characters truncated by oc-session-guard ...]\n\n";

/**
 * Pure function to format an omission notice for truncated output.
 */
export function formatOmissionNotice(omittedChars: number): string {
  return `${OMISSION_NOTICE_PREFIX}${omittedChars}${OMISSION_NOTICE_SUFFIX}`;
}

/**
 * Pure function to elide oversized string values inside a JSON structure.
 * Strings longer than maxFieldChars become a bounded notice string, keeping
 * the overall structure valid JSON. Recurses through arrays and objects with
 * a depth guard to bound pathological nesting.
 */
function elideLargeStringValues(
  value: unknown,
  maxFieldChars: number,
  depth = 0,
): unknown {
  if (depth > 24) return value;
  if (typeof value === "string") {
    if (value.length > maxFieldChars) {
      const omitted = value.length - maxFieldChars;
      return `[... ${omitted} characters truncated by oc-session-guard ...]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      elideLargeStringValues(item, maxFieldChars, depth + 1),
    );
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = elideLargeStringValues(val, maxFieldChars, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Pure function to truncate a parsed JSON value:
 * - Arrays: keep first JSON_ARRAY_KEEP_HEAD + last JSON_ARRAY_KEEP_TAIL elements
 *   and insert an omission marker object.
 * - Objects: elide oversized string values via elideLargeStringValues.
 * Returns null when nothing needed changing.
 */
export function truncateJsonResult(
  value: unknown,
  options?: TruncationOptions,
): { value: unknown; changed: boolean; omittedItems: number } | null {
  const maxFieldChars = options?.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS;

  if (Array.isArray(value)) {
    const keep = JSON_ARRAY_KEEP_HEAD + JSON_ARRAY_KEEP_TAIL;
    if (value.length <= keep) {
      const elided = elideLargeStringValues(value, maxFieldChars);
      return JSON.stringify(elided) === JSON.stringify(value)
        ? null
        : { value: elided, changed: true, omittedItems: 0 };
    }
    const head = value.slice(0, JSON_ARRAY_KEEP_HEAD).map((item) =>
      elideLargeStringValues(item, maxFieldChars),
    );
    const tail = value.slice(-JSON_ARRAY_KEEP_TAIL).map((item) =>
      elideLargeStringValues(item, maxFieldChars),
    );
    const omittedItems = value.length - keep;
    return {
      value: [
        ...head,
        { _omitted: omittedItems, _note: "items omitted by oc-session-guard" },
        ...tail,
      ],
      changed: true,
      omittedItems,
    };
  }

  if (value && typeof value === "object") {
    const elided = elideLargeStringValues(value, maxFieldChars);
    return JSON.stringify(elided) === JSON.stringify(value)
      ? null
      : { value: elided, changed: true, omittedItems: 0 };
  }

  return null;
}

/**
 * Detect valid JSON text. Returns the parsed value or null.
 * Plain scalars (numbers, bare strings like "ok") are NOT treated as JSON —
 * only objects and arrays qualify for the structured path.
 */
export function parseJsonToolResult(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Pure function to apply head/tail truncation to a string.
 * If text length <= maxChars (or headChars + tailChars), returns text unchanged.
 */
export function truncateHeadTail(
  text: string,
  options?: TruncationOptions,
): { text: string; truncated: boolean; omittedCount: number } {
  const headChars = options?.headChars ?? DEFAULT_HEAD_CHARS;
  const tailChars = options?.tailChars ?? DEFAULT_TAIL_CHARS;
  const maxThreshold = options?.maxToolResultChars ?? (headChars + tailChars);

  if (text.length <= maxThreshold) {
    return { text, truncated: false, omittedCount: 0 };
  }

  // Already truncated guard: if text already contains our omission notice, don't re-truncate idempotently
  if (text.includes("characters truncated by oc-session-guard")) {
    return { text, truncated: false, omittedCount: 0 };
  }

  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const omittedCount = text.length - (headChars + tailChars);

  if (omittedCount <= 0) {
    return { text, truncated: false, omittedCount: 0 };
  }

  const notice = formatOmissionNotice(omittedCount);
  return {
    text: `${head}${notice}${tail}`,
    truncated: true,
    omittedCount,
  };
}

/**
 * Truncate message content blocks or string content.
 */
export function applyToolResultTruncation(
  message: Record<string, unknown>,
  toolName?: string,
  options?: TruncationOptions,
): { message: Record<string, unknown>; changed: boolean } {
  const exempt = options?.exemptTools ?? [];
  if (toolName && exempt.includes(toolName)) {
    return { message, changed: false };
  }

  let changed = false;
  const nextMessage = { ...message };

  // T-582: structured JSON path runs first for oversized content. Valid JSON
  // object/array payloads are elided at the value/element level so the result
  // stays parseable; invalid or small content falls through to the string path.
  const handleText = (textVal: string): string | null => {
    const maxThreshold = options?.maxToolResultChars ?? DEFAULT_MAX_CHARS;
    if (textVal.length <= maxThreshold) return null;
    const parsed = parseJsonToolResult(textVal);
    if (parsed !== null) {
      const res = truncateJsonResult(parsed, options);
      if (!res) return null;
      const serialized = JSON.stringify(res.value, null, 2);
      if (serialized.length > maxThreshold) {
        // Even after structural elision the payload is huge; fall back to
        // head/tail string elision on top of the already-parseable form.
        return truncateHeadTail(serialized, options).text;
      }
      return serialized;
    }
    const strRes = truncateHeadTail(textVal, options);
    return strRes.truncated ? strRes.text : null;
  };

  if (Array.isArray(nextMessage.content)) {
    const nextContent = nextMessage.content.map((item) => {
      if (item && typeof item === "object") {
        const textVal = (item as { text?: unknown }).text;
        if (typeof textVal === "string") {
          const nextText = handleText(textVal);
          if (nextText !== null) {
            changed = true;
            return { ...item, text: nextText };
          }
        }
      }
      return item;
    });
    if (changed) {
      nextMessage.content = nextContent;
    }
  } else if (typeof nextMessage.content === "string") {
    const nextText = handleText(nextMessage.content);
    if (nextText !== null) {
      changed = true;
      nextMessage.content = nextText;
    }
  }

  return { message: changed ? nextMessage : message, changed };
}
