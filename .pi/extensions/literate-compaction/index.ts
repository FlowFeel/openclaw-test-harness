/**
 * Literate Compaction — a pi extension.
 *
 * Replaces the default compaction summary with one in the phosphene literate
 * style: terse labels paired with their Why, preserving the rationale behind
 * decisions and conventions rather than just the outcomes.
 *
 * What it does:
 *   1. On session_before_compact, serialize the full conversation (messagesToSummarize
 *      + turnPrefixMessages) — same "summarize everything" approach as
 *      custom-compaction.ts.
 *   2. Build a literate-style prompt via the pure buildLiteratePrompt().
 *   3. Summarize with the active session model (no separate model lookup).
 *   4. Validate the result via validateLiterateSummary(). If the summary is
 *      structurally incomplete, fall back to default compaction rather than
 *      shipping a malformed summary.
 *
 * The pure logic lives in logic.ts (tested with node:test). This file is the
 * thin integration wiring around it.
 *
 * Install: drop this directory at .pi/extensions/literate-compaction/ (project-local)
 * or ~/.pi/agent/extensions/literate-compaction/ (global), then /reload.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

import { buildSummaryMessages, validateLiterateSummary } from "./logic.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary, customInstructions } =
			preparation;

		// Use the active session model for summarization — no separate model
		// lookup. The session model is already authenticated and configured, so
		// there's no provider/model resolution or secondary auth to fail.
		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("Literate compaction: no model available, using default compaction", "warning");
			return; // fall back to default
		}

		// Resolve the session model's API credentials to pass to complete(). This is
		// credential resolution for the HTTP call, NOT a separate model lookup —
		// the model is the live session model above, already authenticated by the
		// session. If credentials are somehow missing, fall back to default.
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.notify(
				`Literate compaction: auth failed for ${model.provider}/${model.id}, using default`,
				"warning",
			);
			return; // fall back to default
		}

		// Summarize the full conversation — messagesToSummarize + turnPrefixMessages.
		// This is the "discard all old turns, keep only the summary" approach: more
		// aggressive context recovery than the default (which keeps the last 20k tokens).
		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		const conversationText = serializeConversation(convertToLlm(allMessages));

		ctx.ui.notify(
			`Literate compaction: summarizing ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${model.provider}/${model.id}...`,
			"info",
		);

		const summaryMessages = buildSummaryMessages({
			conversationText,
			previousSummary: previousSummary ?? undefined,
			customInstructions: customInstructions ?? undefined,
		});

		try {
			const response = await complete(
				model,
				{ messages: summaryMessages },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					maxTokens: 8192,
					signal,
					cacheRetention: "none",
					sessionId: uuidv7(),
				},
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) {
				if (!signal.aborted) {
					ctx.ui.notify("Literate compaction: summary was empty, using default", "warning");
				}
				return; // fall back to default
			}

			// Validate the summary meets the literate structural bar. A malformed
			// summary (missing sections, no abstract) means the model did not follow
			// the style — fall back to default rather than ship it.
			const validation = validateLiterateSummary(summary);
			if (!validation.ok) {
				ctx.ui.notify(
					`Literate compaction: summary rejected (${validation.reason}), using default`,
					"warning",
				);
				return; // fall back to default
			}

			ctx.ui.notify("Literate compaction: summary accepted", "info");

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					usage: response.usage,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Literate compaction failed: ${message}, using default`, "error");
			return; // fall back to default
		}
	});
}
