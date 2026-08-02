# Literate Compaction

**A pi extension that replaces the default compaction summary with one in the phosphene literate style — terse labels paired with their Why, preserving the rationale behind decisions and conventions rather than just the outcomes.**

---

## Why This Exists

Pi's built-in compaction produces a structured summary (Goal / Progress / Key Decisions / Next Steps / Critical Context) that preserves the *what* but can lose the *why* — the load-bearing rationale behind a decision, the concrete bug that justified a convention, the file:line spine of in-progress work. After a compaction, the session often knows *what* was done but not *why* it was done that way, so the next turn re-derives decisions from scratch or, worse, contradicts them.

This extension hooks `session_before_compact` and instructs the summarizer model to produce a **literate** summary: the same structure, but with each terse label paired with its *Why*. It matches the prose density established in `README.md` and `docs/SESSION-HANDOFF.md`.

---

## How It Works

### The testable seam: pure logic

The extension is split into two layers. The **pure logic** (`logic.ts`) builds the prompt and validates the result — zero dependencies, no pi imports, fully testable with `node:test`. The **wiring** (`index.ts`) is thin integration: serialize the conversation, call the model, validate, return.

This split is the phosphene "pure logic as the seam" convention (see `docs/SESSION-HANDOFF.md` § Conventions). The pure functions are the part that matters; the wiring is boilerplate around them.

### The compaction flow

1. **Serialize the full conversation** — `messagesToSummarize` + `turnPrefixMessages` via `serializeConversation(convertToLlm(...))`. This is the "discard all old turns" approach: more aggressive context recovery than the default (which keeps the last 20k tokens of turns verbatim).
2. **Build the literate prompt** — `buildLiteratePrompt()` assembles the style contract (six rules), the required structure (five sections), the conversation, and any iterative context (previous summary + custom `/compact` instructions).
3. **Summarize with the active session model** — no separate model lookup. The session model is already authenticated, so there's no provider resolution or secondary auth to fail.
4. **Validate the result** — `validateLiterateSummary()` checks all five required sections are present and a bold (`**`) or blockquote (`>`) abstract appears in the first 8 lines. A malformed summary falls back to default compaction rather than shipping.

### Graceful fallback

Every failure path — no model, auth failure, empty summary, validation failure, LLM error — returns `undefined`, letting pi's default compaction run. The extension never blocks compaction; it only *replaces* the summary when it can produce a valid literate one.

---

## The Literate Style Contract

The six rules the prompt instructs the model to follow (exported from `logic.ts` as `LITERATE_STYLE_RULES`):

1. Open with a bold one-line abstract: a single sentence capturing the essence.
2. Each section header (`##`) is followed by a one-sentence framing line.
3. Expand each section into subsections (`###`), each pairing a terse label with its Why.
4. Preserve the Why — not just what was done, but the rationale that load-bears it.
5. Track conventions and decisions with their load-bearing rationale (the concrete bug or flake that justified them).
6. Use file paths and ticket numbers as anchors, not vague references.

The validator enforces a minimum bar, not a maximum: the five required sections plus an abstract. Extra sections (Conventions, DFT Primitives, etc.) are welcome — they are the whole point.

---

## Install

### Project-local (this repo)

Already placed at `.pi/extensions/literate-compaction/`. Run `/reload` in pi to load it. Project-local extensions load after the project is trusted.

### Global (all projects)

Copy the directory to `~/.pi/agent/extensions/literate-compaction/` and `/reload`.

### One-off test

```bash
pi -e .pi/extensions/literate-compaction/index.ts
```

---

## Test

The pure logic is tested with `node:test` (built into Node 24, zero install):

```bash
cd .pi/extensions/literate-compaction
node --test logic.test.ts
```

13 tests, all green:

- `buildLiteratePrompt` (6) — conversation text, previous summary, custom instructions, all style rules, all required sections.
- `buildSummaryMessages` (2) — single user message, positive timestamp.
- `validateLiterateSummary` (5) — accepts valid (bold + blockquote), rejects missing section, rejects no abstract, accepts extra sections.

---

## Files

| File | Role |
|------|------|
| `logic.ts` | Pure functions: `buildLiteratePrompt`, `buildSummaryMessages`, `validateLiterateSummary`. Zero deps. |
| `logic.test.ts` | `node:test` specs for the pure logic. |
| `index.ts` | Extension wiring: `session_before_compact` hook around the pure logic. |
| `package.json` | `"type": "module"` marker. No dependencies. |
