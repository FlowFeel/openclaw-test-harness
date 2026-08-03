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
