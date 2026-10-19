/**
 * Regex Library — centralized, tested, named pattern matching.
 *
 * @dft principle: No inline regex anywhere else. Every regex lives here,
 * is named, documented, and tested in isolation. This makes pattern matching
 * auditable, testable, and immune to catastrophic backtracking.
 *
 * @invariants
 * - Every pattern is a frozen RegExp with a documented purpose
 * - Patterns are named constants (UPPER_SNAKE_CASE)
 * - No pattern uses catastrophic backtracking (nested quantifiers)
 * - Each pattern has dedicated tests in regex-library.spec.ts
 * - Patterns are anchored where possible (^ or $) for performance
 *
 * @usage
 *   import { TRAILING_COMMA, DOI_FORMAT, URL_HTTP } from "./regex-library.js";
 *   if (DOI_FORMAT.test(str)) { ... }
 *   const cleaned = str.replace(TRAILING_COMMA, "");
 */

// ═══════════════════════════════════════════════════════════════
// String trimming patterns
// ═══════════════════════════════════════════════════════════════

/**
 * Matches a trailing comma at the end of a string.
 * Used by result-merger.ts to clean up source attribution strings.
 *
 * @example
 *   "search-1,search-2," → "search-1,search-2"
 *   "search-1" → "search-1" (no match, no change)
 */
export const TRAILING_COMMA: Readonly<RegExp> = Object.freeze(/,$/);

/**
 * Matches leading/trailing whitespace.
 * Used for normalizing findings before dedup comparison.
 *
 * @example
 *   "  hello  " → "hello" (with .replace(LEADING_TRAILING_WS, ""))
 */
// Factory for global patterns — .test() mutates lastIndex on global RegExps,
// so we return a fresh instance per call to avoid shared state issues.
export function leadingTrailingWs(): RegExp {
  return /^\s+|\s+$/g;
}

// ═══════════════════════════════════════════════════════════════
// Citation parsing patterns
// ═══════════════════════════════════════════════════════════════

/**
 * Matches a DOI string in standard format (10.xxxx/yyyy).
 * Does NOT match DOIs with "doi:" prefix — use DOI_WITH_PREFIX for that.
 *
 * @example
 *   "10.1038/nature12345" → match
 *   "10.1126/science.abc123" → match
 *   "doi:10.1038/test" → no match (use DOI_WITH_PREFIX)
 */
export const DOI_FORMAT: Readonly<RegExp> = Object.freeze(/^10\.\d{4,}\/.+$/);

/**
 * Matches a DOI with optional "doi:" prefix.
 * Capture group 1 = the bare DOI (without "doi:").
 *
 * @example
 *   "doi:10.1038/test" → ["doi:10.1038/test", "10.1038/test"]
 *   "10.1038/test" → ["10.1038/test", "10.1038/test"]
 */
export const DOI_WITH_PREFIX: Readonly<RegExp> = Object.freeze(/^(?:doi:)?(10\.\d{4,}\/.+)$/i);

// ═══════════════════════════════════════════════════════════════
// URL patterns
// ═══════════════════════════════════════════════════════════════

/**
 * Matches http(s) URLs (basic validation — not RFC-compliant).
 * Requires protocol prefix to avoid matching plain text.
 *
 * @example
 *   "https://example.com/path" → match
 *   "http://doi.org/10.1038/test" → match
 *   "example.com" → no match
 */
export const URL_HTTP: Readonly<RegExp> = Object.freeze(/^https?:\/\/[^\s]+$/i);

/**
 * Extracts a URL from markdown link syntax [text](url).
 * Capture group 1 = the URL.
 *
 * @example
 *   "[paper](https://example.com)" → captures "https://example.com"
 *   "[link](http://doi.org/10.1/test)" → captures "http://doi.org/10.1/test"
 */
export const MARKDOWN_LINK_URL: Readonly<RegExp> = Object.freeze(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/i);

// ═══════════════════════════════════════════════════════════════
// Session key patterns
// ═══════════════════════════════════════════════════════════════

/**
 * Matches OC session keys containing "subagent".
 * Used by session-cleanup.ts to identify subagent sessions for purging.
 *
 * @example
 *   "agent:main:subagent:abc-123" → match
 *   "agent:main:telegram:topic:1" → no match
 */
export const SUBAGENT_KEY: Readonly<RegExp> = Object.freeze(/subagent/i);

// ═══════════════════════════════════════════════════════════════
// Transcript patterns
// ═══════════════════════════════════════════════════════════════

/**
 * Matches a message boundary (double newline) in a transcript.
 * Used by compact.context handler to find safe truncation points.
 *
 * @example
 *   "msg1\n\nmsg2\n\nmsg3" → matches at each \n\n
 */
export function messageBoundary(): RegExp {
  return /\n\n/g;
}

// ═══════════════════════════════════════════════════════════════
// JSON patterns
// ═══════════════════════════════════════════════════════════════

/**
 * Detects whether a string looks like a JSON object (starts with {).
 * Used by the sidecar server's extractJson helper.
 *
 * @example
 *   '{"ok":true}' → match
 *   'not json' → no match
 */
export const JSON_OBJECT_START: Readonly<RegExp> = Object.freeze(/^\{/);

/**
 * Detects whether a string looks like a JSON array (starts with [).
 *
 * @example
 *   '[1,2,3]' → match
 *   '{"a":1}' → no match (use JSON_OBJECT_START)
 */
export const JSON_ARRAY_START: Readonly<RegExp> = Object.freeze(/^\[/);

// ═══════════════════════════════════════════════════════════════
// Task Plane command classifier patterns
// ═══════════════════════════════════════════════════════════════

export const DOCKER_CMD_REGEX: Readonly<RegExp> = Object.freeze(
  /\bdocker\s+(build|compose\s+(build|up(\s+--build)?))\b/i
);

export const PKG_INSTALL_CMD_REGEX: Readonly<RegExp> = Object.freeze(
  /\b(npm\s+(ci|install|rebuild)|yarn(\s+install)?|pnpm\s+install|composer\s+install|cargo\s+build|pip\s+install)\b/i
);

export const TEST_SUITE_CMD_REGEX: Readonly<RegExp> = Object.freeze(
  /\b(npm\s+test|vitest(\s+run)?|jest|pytest|cargo\s+test|go\s+test)\b/i
);

export const DATA_MEDIA_CMD_REGEX: Readonly<RegExp> = Object.freeze(
  /\b(rsync|ffmpeg|tar\s+-[a-z]*c[a-z]*f|wget|curl\s+-[a-z]*O)\b/i
);

export const ML_CMD_REGEX: Readonly<RegExp> = Object.freeze(
  /\bpython\d?\s+.*(train|fine_tune|eval|embed).*\.py\b/i
);

// ═══════════════════════════════════════════════════════════════
// Lane Forecaster signature patterns
// ═══════════════════════════════════════════════════════════════

export const WORK_LOOP_REGEX: Readonly<RegExp> = Object.freeze(
  /\b(diagnose\b.*\bfix\b.*\btest\b.*\bship\b|work-loop|PR workloop|checkpoint-first|fix.*and\s+run\s+tests.*and\s+push)\b/i
);

export const TEST_SUITE_FORECAST_REGEX: Readonly<RegExp> = Object.freeze(
  /\b(npm\s+(test|run\s+test(:ci)?)|vitest\s+run\b|vitest\b(?!\.config)|jest\b(?!\.config)|pytest\b|cargo\s+test\b|go\s+test\b|playwright\b|e2e\s+test)\b/i
);

export const PROBE_LOOP_REGEX: Readonly<RegExp> = Object.freeze(
  /\b(while\s+true|until\s+.*\bcurl\b|curl.*\|\s*grep|probe\s+loop|wait-for|retry\s+until|poll\s+status)\b/i
);

export const VISION_MEDIA_REGEX: Readonly<RegExp> = Object.freeze(
  /\b(ffmpeg\b|transcode|vision\s+attachment|process\s+image|analyze\s+screenshot|image-to-text|video\s+render)\b/i
);

export const DEEP_REFACTOR_REGEX: Readonly<RegExp> = Object.freeze(
  /\b(refactor\s+entire|migrate\s+all|across\s+all\s+\d+\s+plugins|rewrite\s+architecture)\b/i
);

export const INTENT_DIAGNOSE_REGEX: Readonly<RegExp> = Object.freeze(/\bdiagnos(e|ing)\b/i);
export const INTENT_FIX_REGEX: Readonly<RegExp> = Object.freeze(/\bfix(ing|ed)?\b/i);
export const INTENT_TEST_REGEX: Readonly<RegExp> = Object.freeze(/\btest(ing|s)?\b/i);
export const INTENT_SHIP_REGEX: Readonly<RegExp> = Object.freeze(
  /\b(ship(ping|ped)?|push(ing)?|pr|pull\s+request)\b/i
);

// ═══════════════════════════════════════════════════════════════
// Compaction Helper flush patterns
// ═══════════════════════════════════════════════════════════════

export const FLUSH_RUNTIME_EVENT_REGEX: Readonly<RegExp> = Object.freeze(
  /Continue the OpenClaw runtime event/i
);

export const FLUSH_RUNTIME_PREFIX_REGEX: Readonly<RegExp> = Object.freeze(/^runtime-flush/i);
export const FLUSH_TURN_PREFIX_REGEX: Readonly<RegExp> = Object.freeze(/^flush-turn/i);
export const FLUSH_HEARTBEAT_REGEX: Readonly<RegExp> = Object.freeze(/automated heartbeat pulse/i);

// ═══════════════════════════════════════════════════════════════
// Topic Manager session patterns
// ═══════════════════════════════════════════════════════════════

export const TOPIC_SESSION_KEY_REGEX: Readonly<RegExp> = Object.freeze(
  /^agent:([^:]+):telegram:group:(-?\d+):topic:(\d+)$/
);

// ═══════════════════════════════════════════════════════════════
// Path & Token splitting patterns
// ═══════════════════════════════════════════════════════════════

export const TOKEN_SPLIT_REGEX: Readonly<RegExp> = Object.freeze(/[\s,._-]+/);
export const PHRASE_SPLIT_REGEX: Readonly<RegExp> = Object.freeze(/[;,]/);
export const LEADING_SLASH_REGEX: Readonly<RegExp> = Object.freeze(/^[/\\]/);
export function edgeSlashes(): RegExp {
  return /^[/\\]+|[/\\]+$/g;
}
export function backslashGlobal(): RegExp {
  return /\\/g;
}
export function quoteTrimGlobal(): RegExp {
  return /^["']|["']$/g;
}
export const KIND_LINE_REGEX: Readonly<RegExp> = Object.freeze(/^kind\s*:/m);
export const MARKDOWN_HEADING_REGEX: Readonly<RegExp> = Object.freeze(/^#+\s+(.+)$/m);
export const MD_EXTENSION_REGEX: Readonly<RegExp> = Object.freeze(/\.md$/);
export const WHITESPACE_CHAR_REGEX: Readonly<RegExp> = Object.freeze(/\s/);
export const WHITESPACE_SEQUENCE_REGEX: Readonly<RegExp> = Object.freeze(/\s+/);

// ═══════════════════════════════════════════════════════════════
// Memory Note grammar and linting patterns
// ═══════════════════════════════════════════════════════════════

export const PREDICATE_INTERNAL_PERIOD_REGEX: Readonly<RegExp> = Object.freeze(/\.[ \t]+[A-Za-z]/);
export const IMPERATIVE_MOOD_REGEX: Readonly<RegExp> = Object.freeze(
  /^(do not|never|always|ensure|make sure|use|avoid|please)\b/i
);
export const PATH_SHAPE_REGEX: Readonly<RegExp> = Object.freeze(
  /^(\.?\.?\/|[\w-]+\/|[a-zA-Z]:\\|[\w-]+\.[a-zA-Z0-9]+$)[\w\-./\\]*$/
);
export const ISO_8601_REGEX: Readonly<RegExp> = Object.freeze(
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/
);

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Test if a string matches a pattern. Pure wrapper for readability.
 */
export function matches(pattern: Readonly<RegExp>, input: string): boolean {
  return pattern.test(input);
}

/**
 * Extract the first capture group from a pattern, or null.
 */
export function extractFirst(pattern: Readonly<RegExp>, input: string): string | null {
  const m = input.match(pattern);
  return m && m[1] ? m[1] : null;
}

/**
 * Replace all matches of a pattern with a replacement string.
 */
export function replaceAll(
  pattern: RegExp,
  input: string,
  replacement: string
): string {
  return input.replace(pattern as RegExp, replacement);
}

/**
 * Split a string on a pattern.
 */
export function splitOn(pattern: Readonly<RegExp>, input: string): string[] {
  return input.split(pattern as RegExp);
}
