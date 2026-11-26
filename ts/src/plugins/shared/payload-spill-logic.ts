/**
 * Payload Spill Logic — pure detection and formatting for large tool results.
 *
 * @behavior
 * - Pure logic: zero direct I/O, zero network calls, zero Date.now() (passes clock).
 * - Detects tool results whose serialized representation exceeds maxInlineBytes (default 4096).
 * - Extracts leading preview lines from the content.
 * - Generates clean deterministic descriptor card with relative/absolute spill path hints.
 *
 * @dft
 * - Tested with inline string and object fixtures.
 * @see team/specs/incentive-durable-offload-and-auto-spill-architecture.md
 */

export interface SpillDecision {
  shouldSpill: boolean;
  totalBytes: number;
  preview: string;
  inferredExtension: string;
}

export interface SpillOptions {
  maxInlineBytes?: number;
  maxPreviewLines?: number;
}

export const DEFAULT_MAX_INLINE_BYTES = 4096;
export const DEFAULT_MAX_PREVIEW_LINES = 8;

/**
 * Infer file extension from tool result payload or toolName.
 */
export function inferSpillExtension(toolName?: string, rawText?: string): string {
  if (toolName === "ast_parse" || rawText?.trim().startsWith("{:") || rawText?.trim().startsWith("(")) {
    return "edn";
  }
  if (rawText?.trim().startsWith("{") || rawText?.trim().startsWith("[")) {
    try {
      JSON.parse(rawText.trim());
      return "json";
    } catch {
      // not JSON
    }
  }
  if (toolName === "exec" || toolName === "exec_pipeline" || toolName === "process") {
    return "log";
  }
  return "txt";
}

/**
 * Pure evaluation of whether a message or content should spill to disk.
 */
export function evaluatePayloadSpill(
  rawContent: string,
  toolName?: string,
  options?: SpillOptions,
): SpillDecision {
  const maxBytes = options?.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
  const maxLines = options?.maxPreviewLines ?? DEFAULT_MAX_PREVIEW_LINES;
  const totalBytes = Buffer.byteLength(rawContent, "utf8");

  if (totalBytes <= maxBytes) {
    return {
      shouldSpill: false,
      totalBytes,
      preview: rawContent,
      inferredExtension: "txt",
    };
  }

  const lines = rawContent.split("\n");
  const preview = lines.slice(0, maxLines).join("\n").slice(0, 1000);
  const ext = inferSpillExtension(toolName, rawContent);

  return {
    shouldSpill: true,
    totalBytes,
    preview,
    inferredExtension: ext,
  };
}

/**
 * Pure function to format the in-transcript offload pointer card.
 */
export function formatSpillPointerCard(params: {
  spillPath: string;
  totalBytes: number;
  preview: string;
  toolName?: string;
}): string {
  const kb = (params.totalBytes / 1024).toFixed(1);
  return [
    `📦 [Large payload offloaded: ${params.totalBytes} bytes (~${kb} KB) spilled to disk]`,
    `File: ${params.spillPath}`,
    `Preview:`,
    params.preview,
    `... [remainder offloaded to disk]`,
    `👉 Hint: Query slices via read(path="${params.spillPath}", offset=1, limit=30) or process via sidecar.`,
  ].join("\n");
}
