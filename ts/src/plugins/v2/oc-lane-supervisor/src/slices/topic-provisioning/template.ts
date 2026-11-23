/**
 * Topic Provisioning Care-Package Templates — pure markdown and frontmatter formatters.
 *
 * @invariants
 * - Pure formatting: zero I/O, zero clocks, zero regexes (A1, A2, A6).
 *
 * @dft
 * - Covered via slices/topic-provisioning/tests/logic.spec.ts.
 */

export interface CarePackageTemplateInput {
  topicId: number;
  topicName: string;
  chatId: string;
  sessionKey: string | null;
  createdUtc: string;
  createdBy: string;
  generatedBy: string;
  workspacePath: string;
  carePackageRelativePath: string;
}

export function renderCarePackageFrontmatter(input: CarePackageTemplateInput): string {
  const sessionKeyYaml = input.sessionKey ? `"${input.sessionKey}"` : "null";
  return [
    "---",
    `uri: topics/${input.chatId}/${input.topicId}/care-package`,
    `title: "${input.topicName}"`,
    `topic_id: ${input.topicId}`,
    `chat_id: "${input.chatId}"`,
    `session_key: ${sessionKeyYaml}`,
    `created: "${input.createdUtc}"`,
    `created_by: "${input.createdBy}"`,
    `generated_by: "${input.generatedBy}"`,
    "status: orientation",
    "---",
  ].join("\n");
}

export function renderCarePackageBody(input: CarePackageTemplateInput): string {
  return `
# Care Package & Topic Orientation: ${input.topicName} (Topic ${input.topicId})

> **Orientation Snapshot.** This package contains orientation only. The live transcript is the authoritative record of current state until the archive-time care package is written.

---

## 1. Your Dedicated Workspace Directory

Permanent scripts, utilities, and tests belong in your topic home:
\`${input.workspacePath}/\`
├── \`docs/\`        # Specifications, research notes, domain references
├── \`scripts/\`     # Reusable Python scripts and CLI utilities
├── \`tests/\`       # Automated tests (unit, property, hypothesis)
└── \`state/\`       # Persistent local states or manifests (avoid Git packfile churn)

---

## 2. Tool Discovery & Pre-Installed Stack

Before attempting ad-hoc package installations or writing duplicate helpers:
- **Inspect \`tools/CATALOG.md\`:** The living capability index for available packages.
- **Pre-installed CLI Binaries (in PATH):** \`pandoc\` · \`pdftotext\` · \`pdfinfo\` · \`pdfimages\` · \`pdftoppm\` · \`pdfunite\` · \`pdfseparate\` · \`R\` · \`Rscript\` · \`git-lfs\`.
- **Pre-installed Python Stack (\`lib/python\` via \`uv run\`):**
  - **Office Stack:** \`python-pptx\` (slides/shapes), \`openpyxl\` (spreadsheets/formulas), \`python-docx\` (manuscripts).
  - **PDF Tooling:** \`fitz\` (PyMuPDF), \`pypdf\`, \`reportlab\`, \`weasyprint\`.
  - **Science & Stats:** \`numpy\`, \`scipy\`, \`pandas\`, \`statsmodels\`, \`sklearn\`, \`sympy\`, \`hypothesis\`.
  - **Network & Parsing:** \`httpx\`, \`requests\`, \`beautifulsoup4\`.
  - **Specialized Toolchains:** \`lib/python/refverify\` (citation QC), \`anthro-tools\` (CLIP/image), \`lib/python/mdrag\` (AST parsing).

**Root Partition Warning:** The root partition (\`/\`) has only ~8GB total space. Never run bare \`pip install\` or download heavy weights directly to \`~/\`. Use \`lib/python\` via \`uv run\` or run inside container sandboxes.

---

## 3. Core Working Principles

- **No Production Access:** Zero SSH fixes or direct database mutations. CI/CD and deployment pipelines only.
- **Branch Policy:** Named feature branches (\`feat/*\`, \`fix/*\`), pull requests before merge, no direct commits to \`main\`.
- **Draft Persistence:** Persist all working notes, tables, and intermediate analyses to \`drafts/\` or your topic directory immediately; in-memory notes vanish at session close.
- **Open-World Assumption (OWA):** Ingestion boundaries accept unpredictable external inputs (\`extra="allow"\`); internal analytical records enforce strict invariant schemas (\`extra="forbid"\` via \`InvariantStatic\`).
- **Discrete Registration & Non-Interpolation:** Data curation is strictly registration, not narrative smoothing. Do not invent synthetic data or smooth away gaps; record fragmented witnesses exactly as they are.
- **ID-Path Parity:** Deterministic 1:1 correspondence between entity URNs/URIs and their filesystem paths.
- **Thoroughness Over Brevity:** Output and thinking require sufficient token length to optimize reasoning and analytical depth. Analytical completeness precedes compression.
- **Planning is First-Class:** Deliberate architecture and specification precede raw execution.
`.trim();
}

export function renderOrientationSummary(input: CarePackageTemplateInput): string {
  return `[Topic Orientation] Topic ${input.topicId} ("${input.topicName}") workspace provisioned at ${input.workspacePath}. Dedicated care package dropped at ${input.carePackageRelativePath}. Review tools/CATALOG.md before running package installs.`;
}
