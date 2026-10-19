/**
 * Recall Messages — centralized user-facing cues, signposts, and warning templates.
 *
 * @dft principle: Messages and print strings reside in utils/messages files.
 */

export const RECALL_MESSAGES = {
  SIGNPOST_PREFIX:
    "# [SIGNPOST] May be out of date; the current version is kept in memory:",
  REVISE_REQUIRED_BANNER:
    "[REVIEW GATE] Reply did not cite the required authoritative memory pointer.",
  RESUME_REFRESH_HEADER:
    "### Relevant Active Memory Notes",
  CUE_LINE_PREFIX:
    "[see ",
} as const;

export function formatSignpostBanner(source: string, content: string): string {
  return `${RECALL_MESSAGES.SIGNPOST_PREFIX} ${source}\n\n${content}`;
}

export function formatCueNotice(pointer: string, context?: string): string {
  if (context) {
    return `[see ${pointer} (${context})]`;
  }
  return `[see ${pointer}]`;
}
