/**
 * BDD tests for #21: Result Aggregation Worker.
 *
 * @dft
 * - Pure logic only — no file I/O, no sidecar, no network
 * - Deterministic: no clock, no random
 * - All data inline
 * - Injectable scorer for relevance sorting
 *
 * Pattern: Feature/Scenario
 */

import { describe, it, expect } from "vitest";
import {
  deduplicateCitations,
  deduplicateFindings,
  sortByRelevance,
  mergeResults,
  groupByTaskType,
  formatMergedDocument,
  type SubagentResult,
  type Citation,
} from "../../src/plugins/shared/result-merger.js";

// ── Test data ─────────────────────────────────────────────────

function makeResults(): SubagentResult[] {
  return [
    {
      taskId: "search-1",
      taskType: "search",
      findings: ["Australopithecus afarensis had bipedal locomotion"],
      citations: [
        { key: "doi:10.1038/lucy", title: "Lucy discovery", doi: "10.1038/lucy", year: 1974, authors: ["Johanson"] },
        { key: "url:https://example.com/hominin", title: "Hominin evolution", url: "https://example.com/hominin", year: 2020 },
      ],
    },
    {
      taskId: "search-2",
      taskType: "search",
      findings: ["Australopithecus afarensis had bipedal locomotion", "Homo erectus used fire"],
      citations: [
        { key: "doi:10.1038/lucy", title: "Lucy discovery (duplicate)", doi: "10.1038/lucy", year: 1974, authors: ["Johanson", "Lovejoy"] },
        { key: "doi:10.1126/fire", title: "Early fire use", doi: "10.1126/fire", year: 2016 },
      ],
    },
    {
      taskId: "analyze-1",
      taskType: "analyze",
      findings: ["Bipedalism preceded brain enlargement"],
      citations: [
        { key: "doi:10.1038/bipedal", title: "Bipedal origins", doi: "10.1038/bipedal", year: 2018 },
        { key: "url:https://example.com/hominin", title: "Hominin evolution (dup)", url: "https://example.com/hominin", year: 2020 },
      ],
    },
  ];
}

// ═══════════════════════════════════════════════════════════════
// Feature: Citation Deduplication
// ═══════════════════════════════════════════════════════════════

describe("Feature: Citation Deduplication", () => {
  it("Scenario: Duplicate DOI is merged into one citation", () => {
    const citations: Citation[] = [
      { key: "doi:10.1038/lucy", title: "Lucy", doi: "10.1038/lucy", year: 1974 },
      { key: "doi:10.1038/lucy", title: "Lucy discovery (dup)", authors: ["Johanson"] },
    ];
    const { unique, duplicatesRemoved } = deduplicateCitations(citations);
    expect(unique).toHaveLength(1);
    expect(duplicatesRemoved).toBe(1);
  });

  it("Scenario: Different DOIs are kept separate", () => {
    const citations: Citation[] = [
      { key: "doi:A", title: "Paper A", doi: "A" },
      { key: "doi:B", title: "Paper B", doi: "B" },
    ];
    const { unique } = deduplicateCitations(citations);
    expect(unique).toHaveLength(2);
  });

  it("Scenario: Merged citation fills in missing fields from duplicate", () => {
    const citations: Citation[] = [
      { key: "doi:10.1038/lucy", title: "Lucy", doi: "10.1038/lucy", year: 1974 },
      { key: "doi:10.1038/lucy", authors: ["Johanson", "Lovejoy"], url: "https://example.com" },
    ];
    const { unique } = deduplicateCitations(citations);
    expect(unique[0].title).toBe("Lucy");
    expect(unique[0].authors).toEqual(["Johanson", "Lovejoy"]);
    expect(unique[0].url).toBe("https://example.com");
    expect(unique[0].year).toBe(1974);
  });

  it("Scenario: Merged source attribution combines both sources", () => {
    const citations: Citation[] = [
      { key: "doi:10.1038/lucy", source: "search-1" },
      { key: "doi:10.1038/lucy", source: "search-2" },
    ];
    const { unique } = deduplicateCitations(citations);
    expect(unique[0].source).toBe("search-1,search-2");
  });

  it("Scenario: Empty citations list returns empty", () => {
    const { unique, duplicatesRemoved } = deduplicateCitations([]);
    expect(unique).toHaveLength(0);
    expect(duplicatesRemoved).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Finding Deduplication
// ═══════════════════════════════════════════════════════════════

describe("Feature: Finding Deduplication", () => {
  it("Scenario: Exact duplicate findings are removed", () => {
    const findings = [
      "Bipedalism preceded brain growth",
      "Bipedalism preceded brain growth",
      "Fire use was early",
    ];
    const { unique, duplicatesRemoved } = deduplicateFindings(findings);
    expect(unique).toHaveLength(2);
    expect(duplicatesRemoved).toBe(1);
  });

  it("Scenario: Whitespace-only differences are normalized", () => {
    const findings = [
      "Bipedalism preceded brain growth",
      "  Bipedalism preceded brain growth  ",
    ];
    const { unique, duplicatesRemoved } = deduplicateFindings(findings);
    expect(unique).toHaveLength(1);
    expect(duplicatesRemoved).toBe(1);
  });

  it("Scenario: Different findings are kept separate", () => {
    const { unique } = deduplicateFindings([
      "Finding A",
      "Finding B",
      "Finding C",
    ]);
    expect(unique).toHaveLength(3);
  });

  it("Scenario: Order preserved (first occurrence wins)", () => {
    const { unique } = deduplicateFindings([
      "First",
      "Second",
      "First",
      "Third",
    ]);
    expect(unique).toEqual(["First", "Second", "Third"]);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Relevance Sorting
// ═══════════════════════════════════════════════════════════════

describe("Feature: Relevance Sorting", () => {
  it("Scenario: Newer citations rank higher", () => {
    const citations: Citation[] = [
      { key: "old", title: "Old paper", year: 1990 },
      { key: "new", title: "New paper", year: 2024 },
    ];
    const sorted = sortByRelevance(citations);
    expect(sorted[0].key).toBe("new");
  });

  it("Scenario: DOI presence boosts ranking", () => {
    const citations: Citation[] = [
      { key: "no-doi", title: "No DOI", year: 2020 },
      { key: "with-doi", title: "With DOI", year: 2020, doi: "10.1/test" },
    ];
    const sorted = sortByRelevance(citations);
    expect(sorted[0].key).toBe("with-doi");
  });

  it("Scenario: Custom scorer overrides default", () => {
    const citations: Citation[] = [
      { key: "a", title: "A" },
      { key: "b", title: "B" },
    ];
    const sorted = sortByRelevance(citations, (c) => (c.key === "a" ? 100 : 0));
    expect(sorted[0].key).toBe("a");
  });

  it("Scenario: Empty list returns empty", () => {
    expect(sortByRelevance([])).toHaveLength(0);
  });

  it("Scenario: Does not mutate original array", () => {
    const citations: Citation[] = [
      { key: "a", year: 2020 },
      { key: "b", year: 1990 },
    ];
    const original = [...citations];
    sortByRelevance(citations);
    expect(citations).toEqual(original);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Full Merge Pipeline
// ═══════════════════════════════════════════════════════════════

describe("Feature: Full Merge Pipeline", () => {
  it("Scenario: Merge 3 subagent results with deduplication", () => {
    const results = makeResults();
    const { merged, report } = mergeResults(results);

    // 4 unique citations (lucy dup, hominin dup, fire, bipedal)
    expect(merged.citationCount).toBe(4);
    expect(merged.findingCount).toBe(3); // bipedal dup, fire, brain
    expect(merged.duplicatesRemoved).toBe(3); // 2 citation dupes + 1 finding dupe
    expect(report.inputCount).toBe(3);
  });

  it("Scenario: Merged citations are sorted by relevance", () => {
    const results = makeResults();
    const { merged } = mergeResults(results);
    // Newest + has DOI should be near top
    const keys = merged.citations.map((c) => c.key);
    expect(keys).toContain("doi:10.1126/fire");
    expect(keys).toContain("doi:10.1038/lucy");
  });

  it("Scenario: Per-task-type attribution is correct", () => {
    const results = makeResults();
    const { merged } = mergeResults(results);
    expect(merged.byTaskType.search).toBe(4); // 2 from each search
    expect(merged.byTaskType.analyze).toBe(2);
  });

  it("Scenario: Per-source attribution is correct", () => {
    const results = makeResults();
    const { merged } = mergeResults(results);
    expect(merged.bySource["search-1"]).toBe(2);
    expect(merged.bySource["search-2"]).toBe(2);
    expect(merged.bySource["analyze-1"]).toBe(2);
  });

  it("Scenario: Empty results produce empty merged", () => {
    const { merged, report } = mergeResults([]);
    expect(merged.citationCount).toBe(0);
    expect(merged.findingCount).toBe(0);
    expect(report.inputCount).toBe(0);
  });

  it("Scenario: Single result passes through unchanged", () => {
    const results: SubagentResult[] = [{
      taskId: "solo",
      taskType: "search",
      findings: ["only finding"],
      citations: [{ key: "doi:solo", title: "Solo", doi: "doi:solo" }],
    }];
    const { merged } = mergeResults(results);
    expect(merged.citationCount).toBe(1);
    expect(merged.findingCount).toBe(1);
    expect(merged.duplicatesRemoved).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Grouping by Task Type
// ═══════════════════════════════════════════════════════════════

describe("Feature: Grouping by Task Type", () => {
  it("Scenario: Results grouped by type", () => {
    const results = makeResults();
    const groups = groupByTaskType(results);
    expect(groups.search).toHaveLength(2);
    expect(groups.analyze).toHaveLength(1);
  });

  it("Scenario: Missing type produces no group", () => {
    const groups = groupByTaskType(makeResults());
    expect(groups.synthesize).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Document Formatting
// ═══════════════════════════════════════════════════════════════

describe("Feature: Document Formatting", () => {
  it("Scenario: Formatted document includes citation and finding counts", () => {
    const { merged } = mergeResults(makeResults());
    const doc = formatMergedDocument(merged);
    expect(doc).toContain("Citations:");
    expect(doc).toContain("Findings:");
    expect(doc).toContain("Duplicates removed:");
  });

  it("Scenario: Formatted document includes findings as bullet list", () => {
    const { merged } = mergeResults(makeResults());
    const doc = formatMergedDocument(merged);
    expect(doc).toContain("## Findings");
    expect(doc).toContain("- "); // bullet points
  });

  it("Scenario: Formatted document includes citations with URLs", () => {
    const { merged } = mergeResults(makeResults());
    const doc = formatMergedDocument(merged);
    expect(doc).toContain("## Citations");
    expect(doc).toContain("[https://");
  });

  it("Scenario: Formatted document includes attribution section", () => {
    const { merged } = mergeResults(makeResults());
    const doc = formatMergedDocument(merged);
    expect(doc).toContain("## Attribution");
    expect(doc).toContain("search-1:");
    expect(doc).toContain("search-2:");
  });

  it("Scenario: Empty merged produces minimal document", () => {
    const doc = formatMergedDocument({
      findings: [],
      citations: [],
      citationCount: 0,
      findingCount: 0,
      duplicatesRemoved: 0,
      byTaskType: {},
      bySource: {},
    });
    expect(doc).toContain("Citations:** 0");
    expect(doc).toContain("Findings:** 0");
  });
});

// ═══════════════════════════════════════════════════════════════
// Feature: Immutability & Purity
// ═══════════════════════════════════════════════════════════════

describe("Feature: Immutability & Purity", () => {
  it("Scenario: deduplicateCitations does not mutate input", () => {
    const citations: Citation[] = [
      { key: "a", title: "A" },
      { key: "a", title: "A dup" },
    ];
    const original = JSON.stringify(citations);
    deduplicateCitations(citations);
    expect(JSON.stringify(citations)).toBe(original);
  });

  it("Scenario: mergeResults does not mutate input results", () => {
    const results = makeResults();
    const original = JSON.stringify(results);
    mergeResults(results);
    expect(JSON.stringify(results)).toBe(original);
  });

  it("Scenario: formatMergedDocument does not mutate merged", () => {
    const { merged } = mergeResults(makeResults());
    const original = JSON.stringify(merged);
    formatMergedDocument(merged);
    expect(JSON.stringify(merged)).toBe(original);
  });
});
