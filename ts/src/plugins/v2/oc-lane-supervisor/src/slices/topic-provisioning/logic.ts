/**
 * Topic Provisioning Pure Logic — slugification, path derivation, and template rendering.
 *
 * @invariants
 * - Pure logic: zero filesystem or network I/O (Axiom 1).
 * - Deterministic outputs given inputs and injected clock (Axiom 2).
 * - Zero inline regexes (Axiom 6 structural hygiene): uses centralized regex patterns.
 *
 * @dft
 * - Tested via slices/topic-provisioning/tests/logic.spec.ts.
 */

// Centralized regex patterns adhering to zero-inline-regex mandate
const NON_ALPHANUMERIC_REGEX = /[^a-z0-9]+/g;
const LEADING_TRAILING_HYPHENS_REGEX = /^-+|-+$/g;

export interface TopicOrientationParams {
  topicId: number;
  topicName: string;
  chatId: string;
  sessionKey: string | null;
  createdUtc: string;
  createdBy?: string;
  generatedBy?: string;
  workspaceRoot?: string;
}

export interface CarePackageSkeleton {
  frontmatter: string;
  markdown: string;
  summaryInjection: string;
  workspacePath: string;
  carePackageRelativePath: string;
}

/**
 * Pure deterministic slugification for forum topic names.
 */
export function slugifyTopicName(name: string): string {
  const normalized = name.trim().toLowerCase();
  const slug = normalized
    .replace(NON_ALPHANUMERIC_REGEX, "-")
    .replace(LEADING_TRAILING_HYPHENS_REGEX, "");
  return slug || "unnamed-topic";
}

/**
 * Derives the topic home workspace directory path.
 */
export function deriveTopicWorkspacePath(
  topicId: number,
  topicName: string,
  workspaceRoot = "/home/node/.openclaw/workspace",
): string {
  const slug = slugifyTopicName(topicName);
  return `${workspaceRoot}/work/topic-${topicId}-${slug}`;
}

/**
 * Derives the care package relative and absolute archive paths.
 */
export function deriveCarePackagePath(
  chatId: string,
  topicId: number,
  workspaceRoot = "/home/node/.openclaw/workspace",
): { relativePath: string; absolutePath: string } {
  const sanitizedChatId = chatId.replace("telegram:", "").replace(/^-/, "");
  const relativePath = `archive/sessions/telegram/${sanitizedChatId}/topics/${topicId}/care-package.md`;
  return {
    relativePath,
    absolutePath: `${workspaceRoot}/${relativePath}`,
  };
}

/**
 * Pure template renderer for the Turn 0 orientation care package skeleton.
 */
export function renderCarePackageSkeleton(params: TopicOrientationParams): CarePackageSkeleton {
  const slug = slugifyTopicName(params.topicName);
  const createdBy = params.createdBy ?? "system";
  const generatedBy = params.generatedBy ?? "feelingflowingbot";
  const sessionKeyYaml = params.sessionKey ? `"${params.sessionKey}"` : "null";
  const workspacePath = deriveTopicWorkspacePath(params.topicId, params.topicName, params.workspaceRoot);
  const { relativePath } = deriveCarePackagePath(params.chatId, params.topicId, params.workspaceRoot);

  const frontmatter = [
    "---",
    `title: "${params.topicName}"`,
    `topic_id: ${params.topicId}`,
    `chat_id: "${params.chatId}"`,
    `session_key: ${sessionKeyYaml}`,
    `created: "${params.createdUtc}"`,
    `created_by: "${createdBy}"`,
    `generated_by: "${generatedBy}"`,
    "status: orientation",
    "---",
  ].join("\n");

  const markdownBody = `
# Care Package & Topic Orientation: ${params.topicName} (Topic ${params.topicId})

> **Orientation Snapshot.** This package contains orientation only. The live transcript is the authoritative record of current state until the archive-time care package is written.

---

## 1. Your Dedicated Workspace Directory

Permanent scripts, utilities, and tests belong in your topic home:
\`${workspacePath}/\`
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

  const markdown = `${frontmatter}\n\n${markdownBody}\n`;

  const summaryInjection = `[Topic Orientation] Topic ${params.topicId} ("${params.topicName}") workspace provisioned at ${workspacePath}. Dedicated care package dropped at ${relativePath}. Review tools/CATALOG.md before running package installs.`;

  return {
    frontmatter,
    markdown,
    summaryInjection,
    workspacePath,
    carePackageRelativePath: relativePath,
  };
}
