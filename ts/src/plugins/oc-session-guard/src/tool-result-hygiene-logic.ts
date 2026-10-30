/**
 * Tool Result Persist & Hygeine Logic — pure truncation and formatting seam.
 *
 * @behavior
 * - Pure logic: no direct I/O, no timers, zero auxiliary model calls.
 * - Truncates oversized tool results using head/tail elision (default 800 head + 800 tail).
 * - Emits a concise omission notice indicating omitted characters.
 * - Preserves exempt tools from truncation.
 *
 * @dft
 * - Tested with inline string fixtures.
 */

export interface TruncationOptions {
  headChars?: number;
  tailChars?: number;
  maxToolResultChars?: number;
  exemptTools?: string[];
}

export const DEFAULT_HEAD_CHARS = 800;
export const DEFAULT_TAIL_CHARS = 800;
export const DEFAULT_MAX_CHARS = 1600;

export const OMISSION_NOTICE_PREFIX = "\n\n[... ";
export const OMISSION_NOTICE_SUFFIX = " characters truncated by oc-session-guard ...]\n\n";

/**
 * Pure function to format an omission notice for truncated output.
 */
export function formatOmissionNotice(omittedChars: number): string {
  return `${OMISSION_NOTICE_PREFIX}${omittedChars}${OMISSION_NOTICE_SUFFIX}`;
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

  if (Array.isArray(nextMessage.content)) {
    const nextContent = nextMessage.content.map((item) => {
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
      nextMessage.content = nextContent;
    }
  } else if (typeof nextMessage.content === "string") {
    const res = truncateHeadTail(nextMessage.content, options);
    if (res.truncated) {
      changed = true;
      nextMessage.content = res.text;
    }
  }

  return { message: changed ? nextMessage : message, changed };
}
