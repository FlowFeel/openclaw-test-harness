/**
 * BDD tests for the Regex Library.
 *
 * @dft
 * - Each pattern tested in isolation with known inputs
 * - Edge cases: empty strings, no-match, boundary conditions
 * - Non-mutating: patterns don't modify input
 * - Catastrophic backtracking: no nested quantifiers
 *
 * Pattern: Feature/Scenario
 */

import { describe, it, expect } from "vitest";
import {
  TRAILING_COMMA,
  leadingTrailingWs,
  DOI_FORMAT,
  DOI_WITH_PREFIX,
  URL_HTTP,
  MARKDOWN_LINK_URL,
  SUBAGENT_KEY,
  messageBoundary,
  JSON_OBJECT_START,
  JSON_ARRAY_START,
  matches,
  extractFirst,
  replaceAll,
  splitOn,
} from "../../src/plugins/shared/regex-library.js";

// ═══════════════════════════════════════════════════════════════
// Feature: Trailing Comma Trimming
// ═══════════════════════════════════════════════════════════════

describe("Feature: Trailing Comma Trimming", () => {
  it("Scenario: Trailing comma is matched and removed", () => {
    expect("search-1,search-2,".replace(TRAILING_COMMA as RegExp, "")).toBe("search-1,search-2");
  });

  it("Scenario: No trailing comma means no change", () => {
    expect("search-1,search-2".replace(TRAILING_COMMA as RegExp, "")).toBe("search-1,search-2");
  });

  it("Scenario: Empty string produces empty", () => {
    expect("".replace(TRAILING_COMMA as RegExp, "")).toBe("");
  });

  it("Scenario: Only commas — removes only the last", () => {
    expect("a,b,".replace(TRAILING_COMMA as RegExp, "")).toBe("a,b");
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Whitespace Normalization
// ═══════════════════════════════════════════════════════════════

describe("Feature: Whitespace Normalization", () => {
  it("Scenario: Leading and trailing whitespace removed", () => {
    expect("  hello  ".replace(leadingTrailingWs() as RegExp, "")).toBe("hello");
  });

  it("Scenario: No whitespace means no change", () => {
    expect("hello".replace(leadingTrailingWs() as RegExp, "")).toBe("hello");
  });

  it("Scenario: Only leading whitespace removed", () => {
    expect("  hello".replace(leadingTrailingWs() as RegExp, "")).toBe("hello");
  });

  it("Scenario: Tab and newline whitespace handled", () => {
    expect("\t\thello\n\n".replace(leadingTrailingWs() as RegExp, "")).toBe("hello");
  });

  it("Scenario: Empty string produces empty", () => {
    expect("".replace(leadingTrailingWs() as RegExp, "")).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: DOI Validation
// ═══════════════════════════════════════════════════════════════

describe("Feature: DOI Validation", () => {
  it("Scenario: Standard DOI matches", () => {
    expect(DOI_FORMAT.test("10.1038/nature12345")).toBe(true);
  });

  it("Scenario: DOI with subpath matches", () => {
    expect(DOI_FORMAT.test("10.1126/science.abc123")).toBe(true);
  });

  it("Scenario: DOI with prefix does not match (use DOI_WITH_PREFIX)", () => {
    expect(DOI_FORMAT.test("doi:10.1038/test")).toBe(false);
  });

  it("Scenario: Plain text does not match", () => {
    expect(DOI_FORMAT.test("not a doi")).toBe(false);
  });

  it("Scenario: Too short registrant (< 4 digits) does not match", () => {
    expect(DOI_FORMAT.test("10.1/abc")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: DOI With Prefix Extraction", () => {
  it("Scenario: DOI with 'doi:' prefix captures bare DOI", () => {
    const m = "doi:10.1038/test".match(DOI_WITH_PREFIX as RegExp);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("10.1038/test");
  });

  it("Scenario: Bare DOI captures itself", () => {
    const m = "10.1038/test".match(DOI_WITH_PREFIX as RegExp);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("10.1038/test");
  });

  it("Scenario: 'DOI:' (case-insensitive) matches", () => {
    expect(DOI_WITH_PREFIX.test("DOI:10.1038/test")).toBe(true);
  });

  it("Scenario: Non-DOI string does not match", () => {
    expect(DOI_WITH_PREFIX.test("not a doi")).toBe(false);
  });

  it("Scenario: extractFirst helper returns the DOI", () => {
    expect(extractFirst(DOI_WITH_PREFIX, "doi:10.1038/paper")).toBe("10.1038/paper");
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: URL Matching
// ═══════════════════════════════════════════════════════════════

describe("Feature: URL Matching", () => {
  it("Scenario: HTTPS URL matches", () => {
    expect(URL_HTTP.test("https://example.com/path")).toBe(true);
  });

  it("Scenario: HTTP URL matches", () => {
    expect(URL_HTTP.test("http://doi.org/10.1038/test")).toBe(true);
  });

  it("Scenario: URL without protocol does not match", () => {
    expect(URL_HTTP.test("example.com")).toBe(false);
  });

  it("Scenario: URL with spaces does not match", () => {
    expect(URL_HTTP.test("https://example.com/ has spaces")).toBe(false);
  });

  it("Scenario: Empty string does not match", () => {
    expect(URL_HTTP.test("")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════

describe("Feature: Markdown Link URL Extraction", () => {
  it("Scenario: Standard markdown link URL captured", () => {
    const m = "[paper](https://example.com)".match(MARKDOWN_LINK_URL as RegExp);
    expect(m).not.toBeNull();
    expect(m![2]).toBe("https://example.com");
  });

  it("Scenario: Link text captured in group 1", () => {
    const m = "[click here](http://doi.org/10.1/test)".match(MARKDOWN_LINK_URL as RegExp);
    expect(m![1]).toBe("click here");
    expect(m![2]).toBe("http://doi.org/10.1/test");
  });

  it("Scenario: Plain text (no markdown) does not match", () => {
    expect(MARKDOWN_LINK_URL.test("just text")).toBe(false);
  });

  it("Scenario: Markdown without URL does not match", () => {
    expect(MARKDOWN_LINK_URL.test("[text](not-a-url)")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Subagent Key Detection
// ═══════════════════════════════════════════════════════════════

describe("Feature: Subagent Key Detection", () => {
  it("Scenario: Subagent session key matches", () => {
    expect(SUBAGENT_KEY.test("agent:main:subagent:abc-123")).toBe(true);
  });

  it("Scenario: Topic session key does not match", () => {
    expect(SUBAGENT_KEY.test("agent:main:telegram:topic:1")).toBe(false);
  });

  it("Scenario: Case-insensitive match", () => {
    expect(SUBAGENT_KEY.test("agent:main:SubAgent:xyz")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Message Boundary Splitting
// ═══════════════════════════════════════════════════════════════

describe("Feature: Message Boundary Splitting", () => {
  it("Scenario: Transcript splits on double newline", () => {
    const parts = "msg1\n\nmsg2\n\nmsg3".split(messageBoundary() as RegExp);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("msg1");
    expect(parts[1]).toBe("msg2");
    expect(parts[2]).toBe("msg3");
  });

  it("Scenario: No boundaries means single chunk", () => {
    const parts = "single message".split(messageBoundary() as RegExp);
    expect(parts).toHaveLength(1);
  });

  it("Scenario: splitOn helper produces same result", () => {
    const parts = splitOn(messageBoundary(), "a\n\nb\n\nc");
    expect(parts).toEqual(["a", "b", "c"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: JSON Detection
// ═══════════════════════════════════════════════════════════════

describe("Feature: JSON Detection", () => {
  it("Scenario: Object string matches JSON_OBJECT_START", () => {
    expect(JSON_OBJECT_START.test('{"ok":true}')).toBe(true);
  });

  it("Scenario: Array string matches JSON_ARRAY_START", () => {
    expect(JSON_ARRAY_START.test("[1,2,3]")).toBe(true);
  });

  it("Scenario: Plain text does not match object start", () => {
    expect(JSON_OBJECT_START.test("not json")).toBe(false);
  });

  it("Scenario: Array does not match object start", () => {
    expect(JSON_OBJECT_START.test("[1,2]")).toBe(false);
  });

  it("Scenario: Object does not match array start", () => {
    expect(JSON_ARRAY_START.test('{"a":1}')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Helper Functions
// ═══════════════════════════════════════════════════════════════

describe("Feature: Helper Functions", () => {
  it("Scenario: matches() returns boolean", () => {
    expect(matches(DOI_FORMAT, "10.1038/test")).toBe(true);
    expect(matches(DOI_FORMAT, "not-a-doi")).toBe(false);
  });

  it("Scenario: extractFirst() returns first capture group", () => {
    expect(extractFirst(DOI_WITH_PREFIX, "doi:10.1038/paper")).toBe("10.1038/paper");
    expect(extractFirst(DOI_WITH_PREFIX, "no-doi-here")).toBeNull();
  });

  it("Scenario: replaceAll() replaces all matches", () => {
    expect(replaceAll(leadingTrailingWs(), "  hello  ", "")).toBe("hello");
  });

  it("Scenario: splitOn() splits on pattern", () => {
    expect(splitOn(messageBoundary(), "a\n\nb")).toEqual(["a", "b"]);
  });

  it("Scenario: Helpers do not mutate inputs", () => {
    const input = "  hello  ";
    const original = input;
    replaceAll(leadingTrailingWs(), input, "");
    expect(input).toBe(original);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Pattern Immutability
// ═══════════════════════════════════════════════════════════════

describe("Feature: Pattern Immutability", () => {
  it("Scenario: Non-global patterns are frozen (Object.isFrozen)", () => {
    expect(Object.isFrozen(TRAILING_COMMA)).toBe(true);
    expect(Object.isFrozen(DOI_FORMAT)).toBe(true);
    expect(Object.isFrozen(URL_HTTP)).toBe(true);
  });

  it("Scenario: Factory functions produce fresh RegExp instances", () => {
    const a = leadingTrailingWs();
    const b = leadingTrailingWs();
    expect(a).not.toBe(b); // different instances
    expect(a.flags).toBe(b.flags); // same flags
  });

  it("Scenario: Non-global patterns don't advance lastIndex", () => {
    expect(DOI_FORMAT.lastIndex).toBe(0);
    DOI_FORMAT.test("10.1038/test");
    expect(DOI_FORMAT.lastIndex).toBe(0);
  });

  it("Scenario: Global patterns can be reused without state issues", () => {
    // Factory returns fresh RegExp — no shared lastIndex
    expect(leadingTrailingWs().test("  hello  ")).toBe(true);
    expect(leadingTrailingWs().test("  world  ")).toBe(true);
  });
});
