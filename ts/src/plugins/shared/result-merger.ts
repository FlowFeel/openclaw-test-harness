/**
 * Result Merger — pure logic for aggregating subagent results.
 *
 * #21: When 6 subagents return research results, merge them into a single
 * structured document without blocking the main event loop.
 *
 * @behavior
 * Accepts an array of subagent results (each may contain citations, findings,
 * summaries), merges them with deduplication by key (DOI, URL, title),
 * sorts by relevance score, and produces a single aggregated document.
 *
 * The pure merge logic lives here. The I/O (reading result files, writing
 * the merged output) lives in the plugin layer, which can offload to the
 * sidecar worker pool.
 *
 * @invariants
 * - All functions are pure (input → output, no mutation)
 * - No I/O — no file system, no network
 * - No Date.now() — deterministic
 * - Deduplication is by exact key match (DOI, URL, or title hash)
 *
 * @dft
 * - All functions testable with inline data
 * - Injectable scorer function for relevance sorting
 * - No fixtures — data is inline in tests
 */

// ── Types ─────────────────────────────────────────────────────

export interface Citation {
  key: string;        // DOI, URL, or title hash — used for dedup
  title?: string;
  authors?: string[];
  year?: number;
  doi?: string;
  url?: string;
  source?: string;    // which subagent found this
}

export interface SubagentResult {
  taskId: string;
  taskType: string;    // "search" | "analyze" | "synthesize" | etc.
  findings: string[];  // free-form text findings
  citations: Citation[];
  metadata?: {
    tokenCount?: number;
    durationMs?: number;
    depth?: number;
  };
}

export interface MergedResult {
  findings: string[];           // merged findings, deduplicated
  citations: Citation[];        // merged citations, deduplicated by key
  citationCount: number;
  findingCount: number;
  duplicatesRemoved: number;
  byTaskType: Record<string, number>;  // citation count per task type
  bySource: Record<string, number>;    // citation count per subagent
}

export interface MergeReport {
  inputCount: number;
  outputCitations: number;
  outputFindings: number;
  duplicatesRemoved: number;
  mergeMs?: number;   // populated by the I/O layer (sidecar)
}

// ── Pure logic ────────────────────────────────────────────────

/**
 * Deduplicate citations by key (DOI, URL, or title hash).
 * When duplicates are found, merge metadata (prefer the first occurrence,
 * but fill in missing fields from later occurrences).
 */
export function deduplicateCitations(
  citations: Citation[]
): { unique: Citation[]; duplicatesRemoved: number } {
  const seen = new Map<string, Citation>();
  let duplicatesRemoved = 0;

  for (const citation of citations) {
    const key = citation.key;
    if (seen.has(key)) {
      // Merge: fill in missing fields from the duplicate
      const existing = seen.get(key)!;
      seen.set(key, {
        ...existing,
        title: existing.title ?? citation.title,
        authors: existing.authors ?? citation.authors,
        year: existing.year ?? citation.year,
        doi: existing.doi ?? citation.doi,
        url: existing.url ?? citation.url,
        source: existing.source
          ? `${existing.source},${citation.source ?? ""}`.replace(/,$/, "")
          : citation.source,
      });
      duplicatesRemoved++;
    } else {
      seen.set(key, { ...citation });
    }
  }

  return {
    unique: Array.from(seen.values()),
    duplicatesRemoved,
  };
}

/**
 * Deduplicate findings by exact string match.
 * Preserves order (first occurrence wins).
 */
export function deduplicateFindings(
  findings: string[]
): { unique: string[]; duplicatesRemoved: number } {
  const seen = new Set<string>();
  const unique: string[] = [];
  let duplicatesRemoved = 0;

  for (const finding of findings) {
    const normalized = finding.trim();
    if (seen.has(normalized)) {
      duplicatesRemoved++;
    } else {
      seen.add(normalized);
      unique.push(finding);
    }
  }

  return { unique, duplicatesRemoved };
}

/**
 * Sort citations by a relevance scorer function.
 * Default scorer: more recent year + has DOI + has URL = higher relevance.
 */
export function sortByRelevance(
  citations: Citation[],
  scorer?: (c: Citation) => number
): Citation[] {
  const defaultScorer = (c: Citation): number => {
    let score = 0;
    if (c.year) score += Math.min(c.year / 100, 50); // newer = higher
    if (c.doi) score += 10;
    if (c.url) score += 5;
    if (c.authors && c.authors.length > 0) score += 3;
    return score;
  };

  const fn = scorer ?? defaultScorer;
  return [...citations].sort((a, b) => fn(b) - fn(a));
}

/**
 * Merge multiple subagent results into a single aggregated document.
 * Deduplicates citations and findings, computes per-source attribution.
 */
export function mergeResults(results: SubagentResult[]): {
  merged: MergedResult;
  report: MergeReport;
} {
  // Collect all citations
  const allCitations: Citation[] = [];
  const allFindings: string[] = [];
  const byTaskType: Record<string, number> = {};
  const bySource: Record<string, number> = {};

  for (const result of results) {
    for (const citation of result.citations) {
      allCitations.push({
        ...citation,
        source: citation.source ?? result.taskId,
      });
    }
    allFindings.push(...result.findings);

    byTaskType[result.taskType] = (byTaskType[result.taskType] ?? 0) + result.citations.length;
    for (const citation of result.citations) {
      const source = citation.source ?? result.taskId;
      bySource[source] = (bySource[source] ?? 0) + 1;
    }
  }

  // Deduplicate
  const { unique: uniqueCitations, duplicatesRemoved: citationDupes } =
    deduplicateCitations(allCitations);
  const { unique: uniqueFindings, duplicatesRemoved: findingDupes } =
    deduplicateFindings(allFindings);

  // Sort citations by relevance
  const sortedCitations = sortByRelevance(uniqueCitations);

  const merged: MergedResult = {
    findings: uniqueFindings,
    citations: sortedCitations,
    citationCount: sortedCitations.length,
    findingCount: uniqueFindings.length,
    duplicatesRemoved: citationDupes + findingDupes,
    byTaskType,
    bySource,
  };

  const report: MergeReport = {
    inputCount: results.length,
    outputCitations: sortedCitations.length,
    outputFindings: uniqueFindings.length,
    duplicatesRemoved: citationDupes + findingDupes,
  };

  return { merged, report };
}

/**
 * Group merged results by task type for sectioned output.
 */
export function groupByTaskType(
  results: SubagentResult[]
): Record<string, SubagentResult[]> {
  const groups: Record<string, SubagentResult[]> = {};
  for (const result of results) {
    if (!groups[result.taskType]) groups[result.taskType] = [];
    groups[result.taskType].push(result);
  }
  return groups;
}

/**
 * Format merged results as a structured document (markdown-like).
 * Pure: produces a string, no file I/O.
 */
export function formatMergedDocument(merged: MergedResult): string {
  const sections: string[] = [];

  sections.push(`# Merged Research Results\n`);
  sections.push(`**Citations:** ${merged.citationCount}`);
  sections.push(`**Findings:** ${merged.findingCount}`);
  sections.push(`**Duplicates removed:** ${merged.duplicatesRemoved}\n`);

  if (merged.findings.length > 0) {
    sections.push(`## Findings\n`);
    for (const finding of merged.findings) {
      sections.push(`- ${finding}`);
    }
    sections.push("");
  }

  if (merged.citations.length > 0) {
    sections.push(`## Citations\n`);
    for (const citation of merged.citations) {
      const parts: string[] = [];
      if (citation.authors?.length) parts.push(citation.authors.join(", "));
      if (citation.year) parts.push(`(${citation.year})`);
      if (citation.title) parts.push(citation.title);
      const line = parts.join(" ");
      if (citation.url) {
        sections.push(`- ${line} [${citation.url}]`);
      } else if (citation.doi) {
        sections.push(`- ${line} DOI:${citation.doi}`);
      } else {
        sections.push(`- ${line}`);
      }
    }
  }

  if (Object.keys(merged.bySource).length > 0) {
    sections.push(`\n## Attribution\n`);
    for (const [source, count] of Object.entries(merged.bySource)) {
      sections.push(`- ${source}: ${count} citations`);
    }
  }

  return sections.join("\n");
}
