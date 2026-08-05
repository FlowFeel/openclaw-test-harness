**A session that migrated all 11 plugins from `api.registerHook()` to `api.on()`, added 248 tests (885→1,133), rewrote the README for the new architecture, and derived+implemented 26 efficiency tests from the six DFT axioms — all on branch `docs/architecture-update`, 6 commits ahead of `main`.**

## Goal

Evolve the test harness into (a) a plugin foundry producing DFT-compliant plugins, (b) an OC source mod test bed with upstreamable patch+test pairs, and (c) a plugin suite with hooks that actually fire — specifically fixing "hooks not working" and proving efficiency claims.

## Progress

### Done

- **`api.on()` migration** (commit `41ae199`, on `main`): All 36 hook registrations across 11 plugins migrated from `api.registerHook()` (legacy → `legacyInternalHooks` → invisible to `hasHooks()` → never fires) to `api.on()` (typed → `typedHooks` → visible → fires). Added `on()` to `PluginApi` in `shared/types.ts` and `oc-sidecar/src/types.ts`. Foundry scaffold generates `api.on()` by construction. **Why:** the E2E proved `registerHook` hooks never dispatched — plugins were no-ops in production.
- **Coverage sprint** (commits `0047b7d`, `54127f2`, `344b96a`, `409a920`, on `main`): 248 new tests. Covered 4 blind spots (subagent-tracker, sessions-io, work-queue-scheduler, model-router pure logic — 96 tests), 6 plugin wiring layers (session-guard, stream-relay, watchdog, event-loop-monitor, model-router, context-cache — 120 tests), state machine actors (SubagentActor, AdaptiveSubagentActor, checkAdmission Effect — 39 tests), orchestrator tools (7 tests). Coverage 85%→92.8%. All 11 plugins now pass `foundry validate` (added `@dft` docblocks to 3 plugins). Found a bug: `createQueue` builds a priority-sorted array but never returns it (dead code, documented in tests).
- **README + plugins/README rewrite** (commit `947b37f`, on branch): 67%/76% rewritten. New top section: "The Critical Discovery: `api.on()` vs `api.registerHook()`" with the dual API split table. Accurate counts (11 plugins, 1,107 tests, 92.8% coverage, 36 hooks, 19 tools). Honest metrics framing: production metrics were observed *before* the `api.on()` fix when hooks weren't firing — now need re-verification. Full hook inventory (all 36 by name).
- **Efficiency testing plan** (commit `be4d549`→`18b425c`, on branch): `docs/efficiency-testing.md` — rewritten as an axiomatic derivation. The six DFT axioms (A1-A6) are the *preconditions* that make efficiency measurable. A1 isolates I/O cost; A2 makes guarantees structural; A6 makes the report the proof. 7 hypotheses derived (H1-H7), ordered by axiomatic strength.
- **Hypothetico-axiomatic tie-in** (commit `8aa815d`, on branch): New README section "The Hypothetico-Axiomatic Method (at this vertex)" — the point where correctness is proven and the question shifts to efficiency. The same axioms that proved correctness generate the efficiency hypotheses. Added efficiency doc to the index.
- **Efficiency tests implemented** (commit `f71db78`, on branch): 26 tests, 4 files, 6 hypotheses. H5+H6 (bloat reduction + stale purge, Tier 1 deterministic, 11 tests). H3+H4 (semaphore concurrency + no starvation, Tier 2 runtime-det, 8 tests). H1 (sync I/O blocks, Tier 3 statistical, 3 tests). H2 (JSON.stringify scan cost, Tier 3 statistical, 4 tests). Infrastructure: `tests/support/event-loop-probe.ts` (setTimeout(0) sentinel — setInterval can't fire during a sync block). Exported `createAsyncSemaphore`.
- **Session handoff** (commit `4f34e98`, on branch): `docs/SESSION-HANDOFF.md` rewritten with gleaning strategy — recent turns preserved in detail, older context summarized.

### In Progress

- **Branch `docs/architecture-update`** (6 commits ahead of `main`, pushed): ready to merge. Contains the docs rewrite + efficiency tests. No PR opened yet.

### Blocked

- **Full OC source build**: `pnpm install --frozen-lockfile` times out (175 workspace projects). The npm-tarball + built-code patch path remains the workaround.
- **H7 (dispatch overhead)**: needs `createHookRunner` from E2E infrastructure (OC source patch applied). Lower priority; regression guard, not mechanism proof.

## Key Decisions

- **`api.on()` not `api.registerHook()`** — **Why:** E2E proved `registerHook` registers to `legacyInternalHooks` (invisible to `hasHooks()`, never fires). `on` registers to `typedHooks` (visible, fires). The gateway gates dispatch on `hasHooks()`. This was the root cause of "hooks not working." All 36 hooks migrated.
- **Axiomatic derivation of efficiency tests** — **Why:** the user asked for a "definitory axiomatic way." Instead of listing tests arbitrarily, each hypothesis is a logical consequence of the axioms. A1→I/O isolable→H1/H2. A2→structural guarantees→H3/H4. A6→report is proof→H5/H6. A5→real behavior→H7. The axioms generate the hypotheses; the hypotheses generate the tests.
- **`setTimeout(0)` sentinel, not `setInterval`** — **Why:** the first H1 attempt used `setInterval(1ms)` to probe the loop. It failed — `setInterval` *can't fire* during a sync block (that's the point of a sync block). The sentinel is scheduled *before* the sync work and fires *after* the block. The elapsed time = block time + ~1ms clamp.
- **Tier 3 generous bounds** — **Why:** A2 (determinism) doesn't apply to I/O timing. The timing is environment-dependent. The point is directional (sync blocks, async doesn't), not exact numbers. Bounds: sync >3ms, async <50ms, sync > async.
- **Token approximation in docblock, not assertion** — **Why:** tokens ≈ bytes/4, but the tokenizer is model-specific. CI asserts byte reduction (deterministic); production asserts token outcome. The README's "84K tokens saved" is a production observation, not a CI claim.
- **Two pools (main + sub) for worker pool** — **Why:** without a separate sub-pool, 20 subagents from one topic could consume all main slots, starving other topics. H4 proves the sub-pool doesn't starve the main pool (separate state machines, A1+A2).
- **Don't revert patch in `afterAll`** — **Why:** vitest runs test files in parallel. Both `hook-trace.spec.ts` and `hook-dispatch-proof.spec.ts` patch the same OC source tree. If one's `afterAll` reverts while the other tests, it fails. Fix: idempotent `isPatched()` check, leave patch applied.

## Next Steps

1. **Merge `docs/architecture-update` to `main`** — green, pushed, ready. Single PR for docs + efficiency tests.
2. **Fix anti-pattern 1: sync I/O → async** — migrate `sessions-io.ts` to `fs/promises`. H1 is the regression guard. Update hook handlers to `await`. Update integration tests.
3. **Fix anti-pattern 2: JSON.stringify scan → statSync** — replace N serializations with one `statSync` or skip byte counting. H2 is the regression guard.
4. **Implement H7 (dispatch overhead)** — needs `createHookRunner` from E2E infrastructure.
5. **Production re-verification** — deploy fixed plugins (with `api.on()`), observe real metrics. CI proves mechanisms; production proves outcomes.

## Critical Context

- **Repo:** `git@github.com:FlowFeel/openclaw-test-harness.git` (public). Branch `docs/architecture-update`, HEAD `4f34e98`, 6 commits ahead of `main` (`409a920`). Clean working tree.
- **Test state:** CI config (`vitest.config.ci.ts`): 1,015 passed (67 files). Full suite: 1,133 passed (82 files). Typecheck clean. 11/11 foundry-valid.
- **Key files:**
  - `docs/efficiency-testing.md` — the axiomatic derivation (A1-A6 → H1-H7 → tests)
  - `ts/tests/efficiency/` — 4 test files, 26 tests (bloat-reduction, semaphore-concurrency, event-loop-blocking, json-stringify-cost)
  - `ts/tests/support/event-loop-probe.ts` — `measureSyncBlock` + `measureAsyncYield` (setTimeout sentinel)
  - `ts/src/plugins/shared/types.ts` — `PluginApi` with `on()` (on `main`)
  - `ts/src/foundry/validate-logic.ts` — the six DFT axioms (A1-A6)
  - `ts/src/plugins/oc-session-guard/src/sessions-io.ts` — sync I/O anti-pattern (H1 target, not fixed)
  - `ts/src/plugins/oc-compaction-helper/src/index.ts` — JSON.stringify scan anti-pattern (H2 target, not fixed)
  - `ts/src/plugins/oc-topic-worker-pool/src/index.ts` — `createAsyncSemaphore` exported (H3/H4)
- **Node:** v24.15.0 local (nvm). CI uses Node 22. Vitest v4.1.10.
- **The two anti-patterns the efficiency tests expose:** (1) `sessions-io.ts` uses `readFileSync`/`writeFileSync` in main-loop hooks — H1 proves it blocks. (2) `oc-compaction-helper` calls `JSON.stringify(fieldValue).length` per bloat field (600 serializations per scan) just for a threshold check — H2 proves it's expensive. Both fixes derive from A1. `oc-sidecar/src/sidecar-server.ts` also uses sync I/O but runs in a separate process — acceptable.
- **Coverage:** 88.16% statements (CI config). The dip from 92.8% is a config artifact — efficiency tests added files to the denominator but the coverage `include` didn't grow proportionally. Tested files are 97%+.
