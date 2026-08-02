/**
 * Pure logic for literate compaction.
 *
 * The literate style — established in README.md and docs/SESSION-HANDOFF.md —
 * pairs terse labels with their Why. It preserves rationale, not just outcomes.
 * This module builds the prompt that instructs a summarizer model to produce
 * that style, and validates that returned summaries meet its minimum bar.
 *
 * Zero dependencies. No pi imports. Fully testable with node:test.
 *
 * The extension wiring (index.ts) is thin integration around these three
 * functions: build the prompt → call the model → validate the result.
 */

// ---------------------------------------------------------------------------
// The style contract
// ---------------------------------------------------------------------------

/** The structural rules a literate summary must follow. */
export const LITERATE_STYLE_RULES = [
	"Open with a bold one-line abstract: a single sentence capturing the essence.",
	"Each section header (##) is followed by a one-sentence framing line.",
	"Expand each section into subsections (###), each pairing a terse label with its Why.",
	"Preserve the Why — not just what was done, but the rationale that load-bears it.",
	"Track conventions and decisions with their load-bearing rationale (the concrete bug or flake that justified them).",
	"Use file paths and ticket numbers as anchors, not vague references.",
] as const;

/** The minimum sections a literate summary must contain. */
export const REQUIRED_SECTIONS = [
	"## Goal",
	"## Progress",
	"## Key Decisions",
	"## Next Steps",
	"## Critical Context",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptInput {
	/** Serialized conversation text (from serializeConversation). */
	conversationText: string;
	/** Previous compaction summary, if any (iterative context). */
	previousSummary?: string;
	/** Optional user /compact instructions to focus the summary. */
	customInstructions?: string;
}

export interface SummaryMessage {
	role: "user";
	content: { type: "text"; text: string }[];
	timestamp: number;
}

export interface ValidationResult {
	ok: boolean;
	missing: string[];
	hasAbstract: boolean;
	reason?: string;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the instruction prompt for the summarizer model.
 *
 * The prompt has four parts: the style contract (what literate means), the
 * required structure (the sections to produce), the conversation to summarize,
 * and optional iterative context (previous summary + custom instructions).
 */
export function buildLiteratePrompt(input: PromptInput): string {
	const rules = LITERATE_STYLE_RULES.map((r) => `- ${r}`).join("\n");
	const sections = REQUIRED_SECTIONS.map((s) => `- ${s}`).join("\n");

	const parts: string[] = [];

	parts.push(
		[
			"You are a conversation summarizer. Produce a literate summary in the phosphene style.",
			"",
			"The literate style pairs terse labels with their Why. It preserves rationale, not just outcomes. The summary will replace the conversation history, so it must carry everything needed to continue the work — including the reasons behind each decision, not merely the decisions themselves.",
			"",
			"## Style rules",
			rules,
			"",
			"## Required structure",
			"Produce these sections (use ## headers). Under ## Progress, use ### Done, ### In Progress, and ### Blocked subsections:",
			sections,
		].join("\n"),
	);

	// Iterative context: the previous summary, if this is a repeat compaction.
	// Labeled explicitly so the model treats it as prior context to build on.
	if (input.previousSummary) {
		parts.push(
			[
				"## Previous summary (iterative context — build on this, do not restart)",
				input.previousSummary,
			].join("\n"),
		);
	}

	// User focus: /compact [instructions]. Passed verbatim — paraphrasing loses
	// the user's intent.
	if (input.customInstructions) {
		parts.push(`## User instructions for this summary\n${input.customInstructions}`);
	}

	// The conversation itself — the load-bearing input.
	parts.push(`<conversation>\n${input.conversationText}\n</conversation>`);

	parts.push(
		[
			"",
			"Summarize the conversation above as a literate document. Open with a bold one-line abstract. Preserve the Why behind every decision and convention. Use file paths and ticket numbers as anchors. Be thorough but concise.",
		].join("\n"),
	);

	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

/**
 * Wrap the prompt in a single user message ready for the model.
 *
 * Compaction is a one-shot task, not a conversation — one user turn carries the
 * whole instruction.
 */
export function buildSummaryMessages(input: PromptInput): SummaryMessage[] {
	return [
		{
			role: "user",
			content: [{ type: "text", text: buildLiteratePrompt(input) }],
			timestamp: Date.now(),
		},
	];
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate that a returned summary meets the literate structural bar.
 *
 * The bar is a minimum, not a maximum: all required sections present, plus a
 * bold (**) or blockquote (>) abstract line near the top. Extra sections are
 * welcome — they are the whole point of the literate style.
 *
 * Returns { ok: false, ... } when the summary is structurally incomplete; the
 * extension falls back to default compaction rather than shipping a malformed
 * summary.
 */
export function validateLiterateSummary(summary: string): ValidationResult {
	const missing = REQUIRED_SECTIONS.filter((s) => !summary.includes(s));

	// An abstract is a **bold** or > blockquote line in the first 8 lines.
	// Scanning the head (not the whole document) avoids matching a bold label
	// buried in a subsection.
	const head = summary.split("\n").slice(0, 8);
	const hasAbstract = head.some((line) => /^\s*(\*\*|>)/.test(line));

	if (missing.length > 0 || !hasAbstract) {
		const reasons: string[] = [];
		if (missing.length > 0) reasons.push(`missing sections: ${missing.join(", ")}`);
		if (!hasAbstract) reasons.push("no bold (**) or blockquote (>) abstract in the first 8 lines");
		return { ok: false, missing, hasAbstract, reason: reasons.join("; ") };
	}

	return { ok: true, missing, hasAbstract };
}
