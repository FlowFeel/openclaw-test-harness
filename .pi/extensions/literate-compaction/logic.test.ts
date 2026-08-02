/**
 * Pure logic for literate compaction — tests.
 *
 * These tests specify the behavior of the three pure functions that form the
 * testable seam of the literate-compaction extension: the prompt builder, the
 * message builder, and the summary validator. The extension wiring
 * (session_before_compact) is thin integration around these and is not tested
 * here — it is verified by loading the extension and running /compact.
 *
 * Run:  node --test logic.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	buildLiteratePrompt,
	buildSummaryMessages,
	validateLiterateSummary,
	LITERATE_STYLE_RULES,
	REQUIRED_SECTIONS,
} from "./logic.ts";

// ---------------------------------------------------------------------------
// buildLiteratePrompt
// ---------------------------------------------------------------------------

describe("buildLiteratePrompt", () => {
	it("includes the conversation text verbatim", () => {
		// The conversation text is the load-bearing input — the model cannot
		// summarize what it cannot see. It must appear unmodified.
		const prompt = buildLiteratePrompt({
			conversationText: "[User]: hello world\n[Assistant]: hi there",
		});
		assert.ok(
			prompt.includes("[User]: hello world"),
			"conversation text must appear in the prompt unmodified",
		);
		assert.ok(prompt.includes("[Assistant]: hi there"));
	});

	it("includes previous summary when provided", () => {
		// On repeated compactions, the previous summary is iterative context —
		// the model builds on it rather than restarting from scratch. It must
		// be labeled so the model treats it as prior context, not new input.
		const prompt = buildLiteratePrompt({
			conversationText: "conv",
			previousSummary: "## Goal\nPrior goal text",
		});
		assert.ok(
			prompt.includes("Prior goal text"),
			"previous summary must be included as iterative context",
		);
		assert.ok(
			/previous summary/i.test(prompt),
			"must label the previous summary so the model treats it as prior context",
		);
	});

	it("omits the previous-summary section when absent", () => {
		// A first compaction has no previous summary. The section must be
		// absent, not present-but-empty — an empty section confuses the model.
		const prompt = buildLiteratePrompt({ conversationText: "conv" });
		assert.ok(
			!/previous summary/i.test(prompt),
			"must not mention previous summary when none was provided",
		);
	});

	it("includes custom instructions when provided", () => {
		// /compact [instructions] focuses the summary. The user's instruction
		// must reach the model verbatim — paraphrasing would lose the focus.
		const prompt = buildLiteratePrompt({
			conversationText: "conv",
			customInstructions: "Focus on the worker-pool crash isolation work",
		});
		assert.ok(
			prompt.includes("Focus on the worker-pool crash isolation work"),
			"custom instructions must appear verbatim",
		);
	});

	it("includes every literate style rule", () => {
		// The style rules ARE the literate style — if one is missing from the
		// prompt, the model will not follow it. Each rule is load-bearing.
		const prompt = buildLiteratePrompt({ conversationText: "conv" });
		for (const rule of LITERATE_STYLE_RULES) {
			assert.ok(prompt.includes(rule), `style rule must appear in prompt: ${rule}`);
		}
	});

	it("includes every required section header", () => {
		// The required sections are the structural bar the validator enforces.
		// The prompt must ask for exactly the sections it will later check for.
		const prompt = buildLiteratePrompt({ conversationText: "conv" });
		for (const section of REQUIRED_SECTIONS) {
			assert.ok(prompt.includes(section), `required section must appear in prompt: ${section}`);
		}
	});
});

// ---------------------------------------------------------------------------
// buildSummaryMessages
// ---------------------------------------------------------------------------

describe("buildSummaryMessages", () => {
	it("returns a single user message containing the prompt", () => {
		// The model receives one user turn — the prompt is the whole instruction.
		// Multiple messages would imply a conversation; this is a one-shot task.
		const messages = buildSummaryMessages({ conversationText: "conv text" });
		assert.equal(messages.length, 1, "must produce exactly one message");
		assert.equal(messages[0].role, "user");
		assert.ok(messages[0].content.length >= 1, "must have at least one content part");
		assert.equal(messages[0].content[0].type, "text");
		assert.ok(
			messages[0].content[0].text.includes("conv text"),
			"the prompt (and thus the conversation) must be in the message text",
		);
	});

	it("sets a positive numeric timestamp", () => {
		// The timestamp is required by the message schema. It need not be the
		// real time — only present and positive — but using Date.now() is free.
		const messages = buildSummaryMessages({ conversationText: "conv" });
		assert.equal(typeof messages[0].timestamp, "number");
		assert.ok(messages[0].timestamp > 0, "timestamp must be a positive epoch ms");
	});
});

// ---------------------------------------------------------------------------
// validateLiterateSummary
// ---------------------------------------------------------------------------

describe("validateLiterateSummary", () => {
	// A canonical well-formed summary exercising every required section, a bold
	// one-line abstract, and subsections pairing terse labels with their Why.
	const validSummary = [
		"# Session Summary",
		"",
		"**A literate snapshot of the work — pairing terse labels with their Why.**",
		"",
		"## Goal",
		"Build a literate compaction extension.",
		"",
		"## Progress",
		"### Done",
		"- [x] Wrote tests first.",
		"",
		"### In Progress",
		"- [ ] Implementing the logic.",
		"",
		"### Blocked",
		"- None.",
		"",
		"## Key Decisions",
		"- **Pure logic**: testable without the pi runtime.",
		"",
		"## Next Steps",
		"1. Wire the extension.",
		"",
		"## Critical Context",
		"- The literate style preserves the Why, not just the what.",
		"",
	].join("\n");

	it("accepts a well-formed summary with all sections and a bold abstract", () => {
		const result = validateLiterateSummary(validSummary);
		assert.equal(result.ok, true, `should accept valid summary: ${result.reason ?? ""}`);
		assert.deepEqual(result.missing, []);
		assert.equal(result.hasAbstract, true);
	});

	it("accepts a summary with a blockquote abstract instead of bold", () => {
		// The README uses **bold**; SESSION-HANDOFF uses > blockquote. Both are
		// valid literate abstracts. The validator must accept either.
		const summary = validSummary.replace(
			"**A literate snapshot of the work — pairing terse labels with their Why.**",
			"> A literate snapshot of the work — pairing terse labels with their Why.",
		);
		const result = validateLiterateSummary(summary);
		assert.equal(result.ok, true);
		assert.equal(result.hasAbstract, true);
	});

	it("rejects a summary missing a required section", () => {
		// A missing section means the summary is structurally incomplete — the
		// extension should fall back to default compaction rather than ship it.
		const summary = validSummary.replace("## Key Decisions\n", "");
		const result = validateLiterateSummary(summary);
		assert.equal(result.ok, false);
		assert.deepEqual(result.missing, ["## Key Decisions"]);
	});

	it("rejects a summary with no bold or blockquote abstract", () => {
		// Without an abstract, the summary is a flat list — not literate. The
		// abstract is the one-line essence; its absence is the tell that the
		// model did not follow the style.
		const summary = "# Session Summary\n\n## Goal\nBuild something.\n";
		const result = validateLiterateSummary(summary);
		assert.equal(result.ok, false);
		assert.equal(result.hasAbstract, false);
		assert.ok(result.reason, "must provide a human-readable failure reason");
	});

	it("accepts a summary with extra sections beyond the required ones", () => {
		// The validator enforces a minimum, not a maximum. Extra sections
		// (Conventions, DFT Primitives, etc.) are the whole point of the
		// literate style — they must not cause rejection.
		const summary = validSummary + "\n## Conventions\n- Protocol-first.\n";
		const result = validateLiterateSummary(summary);
		assert.equal(result.ok, true);
		assert.deepEqual(result.missing, []);
	});
});
