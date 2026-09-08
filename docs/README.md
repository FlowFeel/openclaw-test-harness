# Documentation Map

Everything the team has written, organized by what you're trying to do. Docs
marked **[point-in-time]** capture a specific review or incident — historical
evidence, not living standards. Docs without the marker are load-bearing:
keep them current when the thing they describe changes.

## Start here (new human or agent)

Read in this order. ~30 minutes total.

1. **[`README.md`](../README.md)** — what this repo is, the `api.on()` vs
   `registerHook()` discovery, current state.
2. **[`docs/testing-policy.md`](./testing-policy.md)** — how we test:
   agents execute everything in GHA; the OC runtime is never run locally
   (enforced by a guard in `openclaw-container.ts`). *Load-bearing.*
3. **[`docs/plugin-foundry.md`](./plugin-foundry.md)** — the standard:
   the six phosphene DFT axioms (A1–A6), what `foundry validate` checks, how
   pure logic is separated from thin I/O. *Load-bearing.*
4. **[`docs/oc-plugin-capability-map.md`](./oc-plugin-capability-map.md)** —
   what the OC runtime gives our plugins: all 44 hooks and their
   timeout/fail-open semantics, the plugin API surface, telegram capabilities
   and hard limits, the crash-insurance table, and the e2e gate plan. *Load-
   bearing; re-verify citations on OC bumps.*

## By task

### Ship or modify a plugin
- [`docs/plugin-foundry.md`](./plugin-foundry.md) — the axioms and validator
- [`docs/ship-review.md`](./ship-review.md) **[point-in-time]** — packaging
  model (self-contained esbuild bundles, Option A/B/C decision) and the
  five ship-readiness risks; the *decision* is durable even though the review
  is dated
- [`ts/src/plugins/README.md`](../ts/src/plugins/README.md) — per-plugin
  reference (hooks, tools, test counts)
- Workflow: `foundry scaffold` → code (pure logic in `*-logic.ts`, thin I/O in
  `index.ts`) → `npx tsc --noEmit -p tsconfig.ci.json` + `validate:foundry`
  locally → **open a PR and let GHA run everything else** (see testing policy)

### Run or interpret tests
- [`docs/testing-policy.md`](./testing-policy.md) — GHA-only execution,
  environment map (which layer needs which setup, which job runs it)
- [`docs/efficiency-testing.md`](./efficiency-testing.md) — how efficiency
  claims are derived from the axioms (T1–T7); H7 (dispatch overhead) still
  open — see the capability map's gate plan

### Debug a live OC incident
- [`docs/oc-plugin-capability-map.md`](./oc-plugin-capability-map.md) §4 —
  which failure modes OC defends (hook timeouts, throw swallowing) and which
  are ours (boot, event-loop blocking); `OPENCLAW_HOOK_DEBUG=1` trace usage
- [`docs/postmortem-sunday-senddocument-timeout.md`](./postmortem-sunday-senddocument-timeout.md)
  **[point-in-time]** — the event-loop blocking war story and the
  document-send policy that came out of it
- [`docs/WAR-STORY.md`](./WAR-STORY.md) **[point-in-time]** — moving OC's
  event loop from 834ms P99 to worker threads

### Work on OC itself (patches / fork)
- [`ts/patches/README.md`](../ts/patches/README.md) and
  [`oc-source/README.md`](../oc-source/README.md) — patch inventory
- [`docs/oc-source-mod-testbed.md`](./oc-source-mod-testbed.md) — the patch +
  testbed pattern (patch and its OC-native test ship as one PR)
- [`docs/oc-fork-pivot.md`](./oc-fork-pivot.md) **[point-in-time]** — the fork
  decision analysis

### Telegram topic management
- [`tests/features/topic-recovery.feature`](../ts/tests/features/topic-recovery.feature)
  — the executable spec (every Rule has a matching test)
- [`docs/oc-plugin-capability-map.md`](./oc-plugin-capability-map.md) §3 —
  what the telegram plugin exposes (topic keys, threadId hooks, lifecycle
  actions) and what it doesn't (per-topic last-activity, direct Bot API access)
- `ts/src/plugins/oc-topic-manager/` — audit + idempotent recovery; the
  session-key grammar is contract-pinned in
  `ts/tests/oc-source/topic-session-key-contract.spec.ts`

## Review & history archive **[point-in-time]**

Evidence of how decisions were made. Read when you need the reasoning, not
for current procedure.

| Document | What it captured |
|---|---|
| [`docs/sidecar-dft-review.md`](./sidecar-dft-review.md) | Review of sidecar wiring PR #19 (H1 async-write-in-sync-hook, M1 injection path) |
| [`docs/junior-team-review.md`](./junior-team-review.md) | Review of PRs #18–#20: P0 foundry violation, P1 path bug, P2 fetch race |
| [`docs/plugin-gaps.md`](./plugin-gaps.md) | Gap analysis: media batching, timeout policy, progress heartbeats |
| [`docs/topic-worker-pool.md`](./topic-worker-pool.md) | oc-topic-worker-pool design (semaphore admission control) |
| [`docs/COMPACTION-SUMMARY.md`](./COMPACTION-SUMMARY.md) | Session compaction summary |
| [`docs/SESSION-HANDOFF.md`](./SESSION-HANDOFF.md) | Dense working-state snapshot (check staleness before trusting) |
| [`ISSUES.md`](../ISSUES.md), [`POST_MORTEM.md`](../POST_MORTEM.md) | OC core issues and the original incident report |

## Maintenance rules

1. New doc → add it to this map under the right task, and mark it
   **[point-in-time]** if it is a review/incident record.
2. A load-bearing doc that no longer matches reality is a bug — fix it in the
   same PR as the change it describes (same standard as tests).
3. Metrics in the root README's "Current State" table are point-in-time; the
   test-count truth lives in CI.
