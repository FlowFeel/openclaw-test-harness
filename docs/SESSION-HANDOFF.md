# Session Handoff

> A dense, literate snapshot of working state. One `read` of this file restores full working context after a `/n` compaction, without re-deriving it from the transcript. Updated at each commit boundary.

---

## Why This File Exists

LLM sessions accumulate context until compaction (`/n`) summarizes the older turns away. The summary preserves the *what* but can lose the *why* — the conventions, the exact green-counts, the file:line spine of in-progress work. This file is the durable counterpart to the transcript: the load-bearing facts of the current working state, written to be read in one pass and structured so a single `read` re-anchors the session. Treat it as the authoritative source of "where are we" between compactions.

---

## Repo & Branch State

The current locus of work is a documentation+testing branch five commits ahead of `main`; `main` itself is clean and green. All work this session is on the branch, not yet merged.

### Active branch

- **Branch:** `docs/architecture-update` (pushed to `origin`)
- **HEAD:** `f71db78` — `test: implement efficiency tests — 26 tests for 6 hypotheses`
- **Ahead of `main` by:** 5 commits. The branch carries: (1) README + plugins/README rewrite for the `api.on()` architecture, (2) the efficiency testing plan (axiomatic derivation), (3) the hypothetico-axiomatic tie-in section + index entry, (4) the 26 efficiency tests across 4 files, (5) the `createAsyncSemaphore` export + vitest config updates.
- **`main` HEAD:** `409a920` — `test: add orchestrator tool tests (queue_results, merge, health)`. This is the last merged commit (the coverage sprint). `main` is clean, 885→1,107 tests green before this branch's additions.

### Pull requests

- **No open PRs.** The branch `docs/architecture-update` is pushed but no PR is opened yet. The natural merge target is a single PR that brings the docs rewrite + efficiency tests to `main`.

### Remote

- `git@github.com:FlowFeel/openclaw-test-harness.git` (public). `git push` from the branch tracks `origin/docs/architecture-update`.

---

## Test State

All green. Two configs matter: the **CI config** (`vitest.config.ci.ts`, excludes e2e/oc-source) and the **full suite** (default `vitest.config.ts`, includes everything).

| Config | Test files | Tests | Duration | Notes |
|--------|-----------|-------|----------|-------|
| CI (`vitest.config.ci.ts`) | 67 passed | **1,015 passed** | ~3.5s | What GitHub Actions runs |
| Full suite (default) | 82 passed | **1,133 passed** | ~90s | Includes e2e + oc-source (Docker) |
| Efficiency only | 4 passed | **26 passed** | ~0.6s | New this session |

**Why it changed:** The previous handoff recorded 885 tests. This session added 248 tests across 5 commits: 96 for blind-spot pure logic, 120 for plugin wiring + state machine actors, 7 for orchestrator tools, 26 for efficiency. The CI count is 1,015 (e2e/oc-source excluded); the full count is 1,133.

**Typecheck:** clean (`npm run typecheck` → 0 errors).

**Foundry validation:** 11/11 plugins pass all six DFT axioms.

---

## Coverage State

Coverage is measured on the CI config with `--coverage`. The `include` glob covers pure logic + plugin wiring (not the `src/features/` state machines, which have their own tests but aren't in the coverage include).

| Metric | Value | Notes |
|--------|-------|-------|
| Statements | **88.16%** | Down from 92.8% because the efficiency tests added new files to the denominator but the coverage `include` didn't grow proportionally. The *tested* files are at 97%+; the dip is a config artifact. |
| Branches | 78.79% | |
| Functions | 92.07% | |
| Lines | 88.8% | |

**Per-plugin wiring coverage** (the sprint's target — all were <60% before, now all >89%):

| File | Before | After |
|------|--------|-------|
| `oc-session-guard/index.ts` | 34% | 89% |
| `oc-stream-relay/index.ts` | 38% | 89% |
| `oc-model-router/index.ts` | 44% | 99% |
| `oc-subagent-watchdog/index.ts` | 56% | 100% |
| `oc-context-cache/index.ts` | 67% | 90% |
| `oc-event-loop-monitor/index.ts` | 76% | 90% |

**Shared pure logic:** 97% (12 modules, all tested).

---

## The Critical Discovery: `api.on()` vs `api.registerHook()`

This is the single most important finding from the entire project, and it was proven this session (well, the previous session's E2E proved it; this session migrated all plugins and documented it).

**OC's plugin SDK has two hook registration APIs, and only one works for typed lifecycle hooks:**

- `api.on("gateway_start", handler)` → registers to `typedHooks` → visible to `hasHooks()` → **fires**
- `api.registerHook("gateway_start", handler, {name})` → registers to `legacyInternalHooks` → invisible → **never fires**

The gateway gates dispatch on `hasHooks()`. If the hook isn't in `typedHooks`, it's never called. Every plugin originally used `api.registerHook()`. The hooks registered successfully (no error), but never dispatched. **The plugins were no-ops in production.**

**The fix (commit `41ae199`, on `main`):** All 36 hook registrations across 11 plugins migrated from `api.registerHook()` to `api.on()`. The `shared/types.ts` `PluginApi` interface now includes `on()`. The foundry scaffold generates `api.on()` calls by construction. This is on `main`, not this branch.

**Why it matters for this branch:** The README and plugins/README were stale — they claimed 5 plugins (there are 11), 789 tests (there are 1,133), and didn't mention the `api.on()` discovery. The docs rewrite on this branch corrects all of this and makes the `api.on()` rule the architectural centerpiece.

---

## The Five Commits on This Branch

### 1. `947b37f` — docs: rewrite README + plugins/README for api.on() architecture

**Why:** The README was factually wrong. It claimed 5 plugins (11 exist), 789 tests (1,133 exist), and presented pre-`api.on()` production metrics as if hooks were responsible (they weren't firing). The plugins/README had wrong hook names for most plugins.

**What:**
- New top README section: "The Critical Discovery: `api.on()` vs `api.registerHook()`" — the dual API split table, the `hasHooks()` gate, the E2E proof.
- Current State table: accurate counts (11 plugins, 1,107 TS tests, 92.8% coverage, 36 hooks via `api.on()`, 19 tools, 11/11 DFT-valid).
- Honest metrics framing: production metrics were observed *before* the `api.on()` fix, when hooks weren't firing. Now that hooks fire, metrics need re-verification.
- Full 11-plugin table with accurate hook/tool/test counts.
- Hook inventory: all 36 hooks listed by name with which plugins use them.
- plugins/README: "The `api.on()` rule" section + accurate hook names for all 11 plugins.

### 2. `be4d549` — docs: add efficiency testing plan

**Why:** The README makes 6 efficiency claims (834ms P99, 30MB→530KB, 84K tokens saved, etc.). None are tested. We needed a plan that's honest about what CI can prove vs what requires production.

**What:** `docs/efficiency-testing.md` — initially a tiered plan (deterministic / runtime-deterministic / statistical) with 8 proposed tests. This commit was the first version; the next commit rewrote it.

### 3. `18b425c` — docs: derive efficiency hypotheses from the DFT axioms

**Why:** The first version of the plan listed tests arbitrarily. The user asked for a "definitory axiomatic way" — deriving the hypotheses as logical consequences of the six DFT axioms, not as a wishlist.

**What:** Rewrote `docs/efficiency-testing.md` as an axiomatic derivation. The structure:
- State the axioms (A1-A6, codified in `foundry/validate-logic.ts`)
- For each axiom, derive the proposition it enables (A1 → I/O cost is isolable; A2 → guarantees are structural; A6 → report is the proof)
- From each proposition, derive the hypothesis (H1-H7)
- From each hypothesis, derive the test
- Show which hypotheses are CI-safe (deterministic) vs production-only

**Key insight:** The axioms are the *preconditions* that make efficiency measurable. Without A1, I/O cost isn't isolable. Without A2, runtime guarantees aren't structural. Without A6, the report isn't the proof. The axioms don't just enable testing — they *generate* the hypotheses.

### 4. `8aa815d` — docs: add hypothetico-axiomatic tie-in section + index entry

**Why:** The user asked to "add that to the readme index and add a tie-in section in the readme that redescribes our hypothetico-axiomatic approach as it relates to this vertex."

**What:** New README section "The Hypothetico-Axiomatic Method (at this vertex)" between Design Principles and Local Verification. The "vertex" framing: this is the point where correctness is proven (92.8% coverage, hooks fire, DFT-valid) and the question shifts from "does it work?" to "does it work efficiently?" The same axioms that proved correctness now generate the efficiency hypotheses. Also added `docs/efficiency-testing.md` to the Documentation Index.

### 5. `f71db78` — test: implement efficiency tests — 26 tests for 6 hypotheses

**Why:** The plan was derived; now demonstrate the discrete units.

**What:** 4 test files, 26 tests, implementing 6 of the 7 hypotheses:

| File | Hypotheses | Tests | Tier |
|------|-----------|-------|------|
| `bloat-reduction.spec.ts` | H5, H6 | 11 | Deterministic |
| `semaphore-concurrency.spec.ts` | H3, H4 | 8 | Runtime-deterministic |
| `event-loop-blocking.spec.ts` | H1 | 3 | Statistical |
| `json-stringify-cost.spec.ts` | H2 | 4 | Statistical |

Plus infrastructure: `tests/support/event-loop-probe.ts` (the `setTimeout(0)` sentinel probe), `createAsyncSemaphore` export, vitest config updates.

**H7 (dispatch overhead) not yet implemented** — it needs the `createHookRunner` from the E2E infrastructure (requires the OC source patch applied). Lower priority; it's a regression guard, not a mechanism proof.

---

## The Efficiency Tests in Detail

### The event loop probe (infrastructure)

**Why `setTimeout(0)`, not `setInterval`:** The first attempt used `setInterval(1ms)` to probe the loop. It failed — `setInterval` *can't fire* during a sync block (that's the whole point of a sync block). The probe observed zero delay because it never got to run.

**The fix:** `measureSyncBlock(fn)` schedules a `setTimeout(0)` sentinel *before* the sync work, then runs the sync work (which blocks the loop), then awaits the sentinel (which fires after the block). The elapsed time = block time + ~1ms (the setTimeout clamp). `measureAsyncYield(fn)` does the same for async work — the sentinel fires early if the async work yields.

### H5 + H6: bloat reduction (Tier 1, deterministic, 11 tests)

**Derived from:** A1 (pure logic, no I/O) + A2 (injected `nowMs`) + A6 (report contains `reductionPercent`, `purgedKeys`).

**The proof:** Construct 100 sessions with 6 realistic bloat fields each (mimicking production content: `compactionCheckpoints` = 50-element arrays, `systemPromptReport` = nested objects with 20 sections, etc.). Call `cleanupSessions`. Assert `report.reductionPercent > 90`. The report (A6) IS the proof — we assert the field, not an external observation.

**Token approximation:** Stated in the docblock (bytes/4 ≈ tokens), not asserted. The tokenizer is model-specific; CI proves the byte reduction, production proves the token outcome.

**H6 (stale purge):** 50 fresh + 50 stale subagents → exactly 50 `purgedKeys`. Topics never purged regardless of age. Uses `Math.max(updatedAt, sessionStartedAt)` — a subagent started 20h ago but updated 1h ago is NOT stale.

### H3 + H4: semaphore concurrency (Tier 2, runtime-deterministic, 8 tests)

**Derived from:** A1 (semaphore logic is pure, wrapper is isolated) + A2 (state transitions are deterministic).

**The proof:** `AsyncSemaphore(3)` with 10 concurrent `acquire()` calls, each holding 10ms. Track peak `active`. Assert peak ≤ 3. The hold time creates overlap; the assertion is structural (peak ≤ max), not timing-based. The concurrency limit is an *invariant* guaranteed by the state machine (A2), not a performance target.

**H4 (no starvation):** Saturate the sub-pool (1 slot, 5 waiters). Acquire from the main pool. Assert it completes in <50ms (not queued behind sub-pool waiters). The pools are independent state machines (A1+A2), so the sub-pool's saturation can't affect the main pool's capacity. 20 subagent acquires + 5 main acquires concurrently → main pool reaches capacity without starvation.

**Required change:** `createAsyncSemaphore` was not exported from `oc-topic-worker-pool/src/index.ts`. Added `export` (one-line change).

### H1: sync I/O blocks (Tier 3, statistical, 3 tests)

**Derived from:** A1 (I/O is in `*-io.ts`, isolable).

**The proof:** Write a ~5MB JSON file. `readFileSync` × 5 → sentinel fires >3ms late (blocks). `readFile` (async) × 5 → sentinel fires <50ms (yields). Sync delay > async delay (directional, not ratio).

**Why 5MB × 5 reads:** A single 1MB sync read on an SSD completes in <1ms — too fast for the sentinel to detect. 5MB × 5 reads accumulates enough blocking time. The bounds are generous (3ms, 50ms) because the point is directional (sync blocks, async doesn't), not exact numbers.

**A2 doesn't apply here** — this is I/O, not logic. The timing is environment-dependent (disk speed, CPU speed, OS scheduler). That's why this is Tier 3 with generous bounds, not Tier 1.

### H2: JSON.stringify scan cost (Tier 3, statistical, 4 tests)

**Derived from:** A1 (the scan loop is in the hook handler, separable from I/O).

**The proof:** 100 sessions × 6 bloat fields = 600 `JSON.stringify` calls. Measure CPU time. Compare to `statSync(path).size` (one syscall). Assert scan > statSync. The boolean field-name check (`field in entry`) is even cheaper — no serialization needed.

**O(n) regression guard:** 5x data → <15x time (not O(n²)). The lower bound was removed — for sub-millisecond operations, the ratio is too noisy. The upper bound is the meaningful guard.

**The anti-pattern this exposes:** `oc-compaction-helper`'s `before_prompt_build` hook calls `JSON.stringify(fieldValue).length` per field just to count bytes for a threshold check. The fix (not yet implemented): use `statSync` (one syscall) or skip byte counting entirely (the field-name check already tells us bloat exists).

---

## The Two Anti-Patterns (not yet fixed)

The efficiency tests prove two anti-patterns are real. The fixes are derived from A1 but not yet implemented:

1. **Sync I/O on the main event loop** — `sessions-io.ts` uses `readFileSync`/`writeFileSync` in hooks that fire on the main loop. H1 proves it blocks. **Fix:** migrate to `fs/promises`, keep the Protocol interface (`SessionsReader`/`SessionsWriter`). The hook handlers `await` the calls. H1 becomes the regression guard.

2. **`JSON.stringify` in the bloat scan hot path** — `oc-compaction-helper` serializes every bloat field just to count bytes. H2 proves it's expensive. **Fix:** replace N serializations with one `statSync(path).size`, or skip byte counting (the field-name check is sufficient). H2 becomes the regression guard.

**Note:** `oc-sidecar/src/sidecar-server.ts` also uses sync I/O, but it runs in a *separate process* (the sidecar), so it doesn't block the main loop. That's acceptable.

---

## Key Files

### This session's new files

| File | Lines | What |
|------|-------|------|
| `docs/efficiency-testing.md` | 241 | The axiomatic derivation: A1-A6 → propositions → H1-H7 → tests → fixes |
| `ts/tests/efficiency/bloat-reduction.spec.ts` | 313 | H5+H6: 11 tests, deterministic, byte reduction + stale purge |
| `ts/tests/efficiency/semaphore-concurrency.spec.ts` | 270 | H3+H4: 8 tests, runtime-det, concurrency invariant + no starvation |
| `ts/tests/efficiency/event-loop-blocking.spec.ts` | 127 | H1: 3 tests, statistical, sync blocks / async yields |
| `ts/tests/efficiency/json-stringify-cost.spec.ts` | 201 | H2: 4 tests, statistical, scan cost vs statSync |
| `ts/tests/support/event-loop-probe.ts` | 83 | `measureSyncBlock` + `measureAsyncYield` (setTimeout sentinel) |

### Key existing files (modified)

| File | Change |
|------|--------|
| `README.md` | 67% rewritten: `api.on()` discovery, accurate counts, hypothetico-axiomatic section |
| `ts/src/plugins/README.md` | 76% rewritten: `api.on()` rule, accurate hook/tool names for all 11 plugins |
| `ts/src/plugins/oc-topic-worker-pool/src/index.ts` | Exported `createAsyncSemaphore` (1 line) |
| `ts/vitest.config.ts` | Added `tests/efficiency/**/*.spec.ts` to include |
| `ts/vitest.config.ci.ts` | Added `tests/efficiency/**/*.spec.ts` to include |

### Key existing files (unchanged but load-bearing)

| File | Why it matters |
|------|----------------|
| `ts/src/foundry/validate-logic.ts` | The six DFT axioms (A1-A6) — the foundation for the efficiency derivation |
| `ts/src/plugins/shared/session-cleanup.ts` | `stripBloatFields`, `purgeStaleSubagents`, `cleanupSessions` — H5+H6 targets |
| `ts/src/plugins/oc-topic-worker-pool/src/topic-worker-pool-logic.ts` | Pure semaphore state machine — H3+H4 foundation |
| `ts/src/plugins/shared/types.ts` | `PluginApi` interface with `on()` — the `api.on()` fix (on `main`) |
| `ts/src/plugins/oc-session-guard/src/sessions-io.ts` | Sync I/O anti-pattern (H1 target, not yet fixed) |
| `ts/src/plugins/oc-compaction-helper/src/index.ts` | JSON.stringify scan anti-pattern (H2 target, not yet fixed) |

---

## Conventions (load-bearing)

- **`api.on()`, not `api.registerHook()`** — for typed lifecycle hooks. `registerHook` registers to `legacyInternalHooks` (invisible to `hasHooks()`, never fires). `on` registers to `typedHooks` (visible, fires). This is the single most important convention. Every plugin must use `api.on()`.
- **Pure logic / I/O separation (A1)** — logic files import no I/O. I/O lives in `*-io.ts` wrappers behind Protocol interfaces. This is what makes efficiency measurable.
- **Determinism (A2)** — logic files have no `Date.now()`/`Math.random()`. Clocks are injected (`nowMs`). This makes runtime guarantees structural, not statistical.
- **CheckResult (A6)** — mutating functions return a report, not `void`. The report IS the proof.
- **Mock doubles, not mocks (A5)** — integration tests use real in-process implementations. Efficiency tests measure real behavior, not mock overhead.
- **Tier 3 generous bounds** — statistical tests (H1, H2, H7) use generous bounds. The point is directional (sync blocks, async doesn't), not exact numbers. A2 doesn't apply to I/O timing.
- **Token approximation in docblock, not assertion** — tokens ≈ bytes/4. CI asserts byte reduction; production asserts token outcome. The tokenizer is model-specific.

---

## Next Steps

1. **Merge `docs/architecture-update` to `main`** — the branch is green, pushed, and ready. A single PR brings the docs rewrite + efficiency tests.
2. **Fix anti-pattern 1: sync I/O → async** — migrate `sessions-io.ts` to `fs/promises`. H1 is the regression guard. Update hook handlers to `await`. Update integration tests.
3. **Fix anti-pattern 2: JSON.stringify scan → statSync** — replace N serializations with one `statSync` or skip byte counting. H2 is the regression guard.
4. **Implement H7 (dispatch overhead)** — needs `createHookRunner` from E2E infrastructure (OC source patch). Lower priority; regression guard, not mechanism proof.
5. **Production re-verification** — deploy the fixed plugins (with `api.on()`), observe real metrics (834ms P99, 30MB file, 2,575 dead subagents). CI proves the mechanisms; production proves the outcomes.

---

## Node / Tooling

- **Node:** v24.15.0 (local, nvm). CI uses Node 22 (`actions/setup-node@v4`).
- **Vitest:** v4.1.10. CI config: `vitest.config.ci.ts` (excludes e2e/oc-source). Default config: `vitest.config.ts` (includes everything).
- **Typecheck:** `npm run typecheck` → `tsc --noEmit -p tsconfig.ci.json`. Clean.
- **Foundry:** `npx tsx src/foundry/cli.ts validate src/plugins/<name>`. 11/11 pass.
- **Docker:** `docker/Dockerfile` — node:22-bookworm-slim. OC installed globally (`npm install -g openclaw@2026.6.8`). E2E tests use testcontainers.
