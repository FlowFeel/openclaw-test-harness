# Efficiency Testing: An Axiomatic Derivation

We do not pick efficiency tests arbitrarily. We derive them as logical consequences of the axioms we already accept. The six DFT axioms are not just code-quality rules — they are the *preconditions* that make efficiency measurable. Each axiom enables a specific measurement capability, and from that capability follows a hypothesis, and from that hypothesis follows a test.

This document derives the efficiency test plan from first principles.

---

## The Axioms (accepted, codified in the foundry validator)

```
A1. pure-io-separation — logic files import no I/O; index.ts imports no node:fs directly
A2. determinism        — logic files have no Date.now()/Math.random()/new Date()
A3. manifest-conformance — declared tools/hooks match registered tools/hooks
A4. dft-docs           — every source .ts file declares its testability contract
A5. mock-doubles       — integration tests use real in-process implementations, not vi.fn() stand-ins
A6. check-result       — mutating logic functions return a report, not void
```

These are not aspirations. They are checked by `foundry validate` on every commit. 11/11 plugins pass. A change that violates an axiom fails CI.

---

## The Derivation

### From A1 (pure-io-separation) → the I/O cost is isolable

**Axiom A1 states:** logic files import no I/O. The I/O lives in `*-io.ts` wrappers behind Protocol interfaces.

**Proposition P1:** If the I/O is separated from the logic, then the *cost* of the I/O is measurable independently of the logic. The logic can be tested for correctness without I/O. The I/O can be tested for cost without logic.

**Corollary P1a:** If the I/O layer uses synchronous primitives (`readFileSync`), that cost is borne on the event loop. If it uses async primitives (`readFile`), that cost is yielded. The difference is measurable because the I/O is isolated — we can swap the implementation without touching the logic.

**Hypothesis H1 (the sync-blocking hypothesis):** The `sessions-io.ts` wrapper, which uses `readFileSync`/`writeFileSync`, blocks the event loop for the duration of the read/write. An async wrapper (`readFile`/`writeFile`) would not.

**Test T1:** Run an event-loop delay probe during a `readFileSync` of a 1MB file. Assert the probe gap exceeds a threshold (sync blocks). Run the same probe during `readFile`. Assert the probe gap stays small (async yields). The I/O is isolable (A1), so we can test the wrapper directly without the logic or the plugin.

**Hypothesis H2 (the JSON.stringify-scan hypothesis):** The `before_prompt_build` hook handler calls `JSON.stringify(fieldValue).length` for every bloat field in every session. This is CPU work on the main loop. Because the logic is separated (A1), we can measure the scan cost without the file I/O — feed the logic in-memory data and time the scan loop.

**Test T2:** Feed `stripBloatFields`'s scan path 100 sessions × 6 bloat fields. Measure the CPU time of the `JSON.stringify`-per-field loop. Compare to `statSync(path).size` (one syscall, no serialization). Assert the scan loop costs measurably more. The scan is pure logic (A1), so this is deterministic and CI-safe.

---

### From A2 (determinism) → runtime behavior is structurally guaranteed, not statistical

**Axiom A2 states:** logic files have no `Date.now()`/`Math.random()`. Clocks are injected.

**Proposition P2:** If the logic is deterministic (injected clock, no randomness), then any runtime guarantee that depends on the logic is *structural* — it holds by construction, not by probability. A counting semaphore with injected state transitions will never exceed `maxConcurrent` because the state machine forbids it, not because "it's usually fast enough."

**Corollary P2a:** The semaphore concurrency limit is not a performance target — it is an invariant. We do not need to measure "is it fast?" We need to prove "does it ever exceed the limit?" The answer is determined by the state machine, which is pure (A2).

**Hypothesis H3 (the semaphore-invariant hypothesis):** The `AsyncSemaphore` wrapper, which adds Promise plumbing to the pure semaphore state, never allows more than `maxConcurrent` simultaneous active slots, regardless of how many concurrent `acquire()` calls are made.

**Test T3:** Create `AsyncSemaphore(3)`. Fire 10 concurrent `acquire()` calls, each holding the slot for 10ms. Track the peak `active` count across all hold intervals. Assert peak ≤ 3. Assert all 10 eventually complete (no leaked promises). The hold time (10ms) creates overlap to exercise the queue; the assertion is structural (peak ≤ max), not timing-based. This is CI-safe because the invariant is guaranteed by construction (A2), not by the scheduler.

**Hypothesis H4 (the no-starvation hypothesis):** A separate sub-pool prevents subagent acquires from starving main-pool acquires. Because the pools are independent state machines (A2 determinism, A1 separation), the sub-pool's saturation does not affect the main-pool's capacity.

**Test T4:** Fill the sub-pool to capacity with pending waiters. Acquire from the main pool. Assert the main pool acquire completes immediately (not queued behind the sub-pool waiters). The independence is structural (separate state), not timing-based.

---

### From A6 (check-result) → the report IS the proof

**Axiom A6 states:** mutating logic functions return a report, not `void`.

**Proposition P3:** If the function returns a report, then the report *contains the evidence* for the efficiency claim. We do not need to measure the effect externally — the function tells us what it did. `stripBloatFields` returns `{cleaned, strippedCount}`. `purgeStaleSubagents` returns `{cleaned, purgedKeys}`. `cleanupSessions` returns `{cleaned, report}` where `report` includes `beforeBytes`, `afterBytes`, `reductionPercent`.

**Corollary P3a:** The efficiency claim "99% session I/O reduction" is not a measurement we take — it is a field in the report. The test asserts the report field, not an external observation. This is why the claim is CI-safe: the report is computed by pure logic (A1, A2) and returned (A6).

**Hypothesis H5 (the bloat-reduction hypothesis):** For a session map with realistic bloat (6 default bloat fields populated with production-sized content), `cleanupSessions` returns a report with `reductionPercent > 90`.

**Test T5:** Construct a realistic bloated session map (100 sessions, each with the 6 default bloat fields: `compactionCheckpoints` = 50-element array, `systemPromptReport` = 8KB text, `skillsSnapshot` = 4KB object, etc.). Call `cleanupSessions`. Assert `report.reductionPercent > 90`. Assert `report.afterBytes < report.beforeBytes / 10`. The report is the proof (A6). The logic is pure (A1, A2), so this is deterministic.

**Corollary P3b:** The token approximation follows. Tokens ≈ bytes / 4 (rough BPE ratio). If before ≈ 400KB and after ≈ 40KB, then ~100K tokens → ~10K tokens, ~90K saved. The test does not claim "90K tokens" (that depends on the tokenizer) — it claims the byte reduction, and the token claim follows as an approximation stated in the test docblock.

**Hypothesis H6 (the stale-purge hypothesis):** `purgeStaleSubagents` removes exactly the entries past `maxAgeHours` and preserves all others.

**Test T6:** Construct a session map with 50 fresh subagents (within timeout), 50 stale subagents (past timeout), and 20 topic entries (any age). Call `purgeStaleSubagents({maxAgeHours: 15, nowMs})`. Assert `purgedKeys.length === 50`. Assert all 50 fresh subagents remain. Assert all 20 topic entries remain (topics are never purged by subagent logic). The report (`purgedKeys`) is the proof (A6). Injected `nowMs` makes it deterministic (A2).

---

### From A5 (mock-doubles) → efficiency tests measure real behavior

**Axiom A5 states:** integration tests use real in-process implementations, not `vi.fn()` stand-ins.

**Proposition P4:** If we use real implementations, then our efficiency tests measure the actual code path — the real `AsyncSemaphore`, the real `stripBloatFields`, the real event loop. A `vi.fn()` mock would measure the mock's overhead, not the real behavior.

**Corollary P4a:** For Tier 3 (statistical) tests, this means the measurements reflect production behavior modulo environment (CPU speed, disk speed). The *direction* (sync blocks, async doesn't) is real. The *magnitude* (834ms vs 50ms) is environment-specific and belongs in production, not CI.

**Hypothesis H7 (the dispatch-overhead hypothesis):** Hook dispatch with zero handlers is negligible (< 0.1ms). This is the "zero-overhead when disabled" claim from patch 0001.

**Test T7:** Use the real `createHookRunner` (from the E2E infrastructure, not a mock). Measure dispatch latency with 0 handlers, 1 handler, 10 handlers. Assert 0 handlers < 0.1ms. Assert 10 handlers < 10ms. This uses the real implementation (A5), so it measures real dispatch cost. Generous bounds make it CI-safe.

---

### From A3 (manifest-conformance) → every declared hook is measurable

**Axiom A3 states:** declared tools/hooks match registered tools/hooks.

**Proposition P5:** If the manifest declares a hook and `index.ts` registers it via `api.on()`, then that hook is in the dispatch path. Every declared hook is therefore measurable for overhead. There are no "phantom" hooks declared but not registered, and no "hidden" hooks registered but not declared.

**Corollary P5a:** The 36 registered hooks (across 11 plugins) are the complete set. The dispatch-overhead test (T7) covers the mechanism; the manifest-conformance check (A3) guarantees completeness. We don't need to test "are there hooks we forgot?" — the axiom forbids it.

---

### From A4 (dft-docs) → the testability contract is explicit

**Axiom A4 states:** every source file declares its testability contract via `@dft` or `@invariants`.

**Proposition P6:** If the contract is explicit, then the efficiency hypotheses are documented in the source, not just in tests. A reader of `session-cleanup.ts` sees `@dft: All functions testable without file system access. Deterministic: uses injected timestamp.` and knows the efficiency claims are CI-verifiable.

**Corollary P6a:** When we add efficiency tests, we update the `@dft` docblock of the tested file to reference the efficiency spec. The contract stays explicit.

---

## The Hypotheses, Ordered by Axiomatic Strength

| ID | Hypothesis | Derived from | Tier | CI-safe? |
|----|-----------|--------------|------|----------|
| H5 | Bloat stripping reduces bytes >90% | A1+A2+A6 | Deterministic | ✅ |
| H6 | Stale purge removes exactly past-timeout entries | A2+A6 | Deterministic | ✅ |
| H3 | Semaphore never exceeds maxConcurrent | A1+A2 | Runtime-deterministic | ✅ |
| H4 | Sub-pool doesn't starve main pool | A1+A2 | Runtime-deterministic | ✅ |
| H1 | Sync I/O blocks event loop, async doesn't | A1 | Statistical | ✅ (generous bounds) |
| H2 | JSON.stringify scan costs more than statSync | A1 | Statistical | ✅ |
| H7 | Dispatch with 0 handlers is < 0.1ms | A5 | Statistical | ✅ (generous bounds) |

The deterministic hypotheses (H5, H6) are the strongest — they follow from three axioms (A1, A2, A6) and are perfectly reproducible. The runtime-deterministic hypotheses (H3, H4) follow from two axioms (A1, A2) and are structurally guaranteed. The statistical hypotheses (H1, H2, H7) follow from one axiom (A1 or A5) and need generous bounds.

---

## What the Axioms Forbid (and therefore what we do not test)

The axioms also tell us what we *cannot* claim in CI:

- **A1 forbids** logic files from doing I/O. Therefore, we cannot measure "real file read latency" in a logic test — that's the I/O layer's job. The logic test measures byte reduction (H5), not disk speed.
- **A2 forbids** `Date.now()` in logic. Therefore, we cannot measure wall-clock latency in a logic test — we inject `nowMs`. Wall-clock latency (the 834ms claim) belongs in production, not CI.
- **A5 forbids** `vi.fn()` stand-ins. Therefore, we cannot mock the event loop — we use the real one and measure it with generous bounds.

The production metrics (834ms P99, 30MB file, 2,575 dead subagents) are not derivable from the axioms. They are *observations* of a specific production system under specific load. The axioms give us the *mechanisms* (H1-H7); production gives us the *outcomes*. Both are needed, and the axioms tell us which is which.

---

## The Tests, Derived

Each test is the operationalization of its hypothesis. The test structure follows from the axiom that generated the hypothesis:

```
tests/efficiency/
├── bloat-reduction.spec.ts         ← H5, H6 (A1+A2+A6: deterministic, report-is-proof)
├── semaphore-concurrency.spec.ts   ← H3, H4 (A1+A2: runtime-deterministic, structural)
├── event-loop-blocking.spec.ts     ← H1     (A1: I/O isolable, sync vs async)
├── json-stringify-cost.spec.ts     ← H2     (A1: scan is pure, measurable)
└── dispatch-overhead.spec.ts       ← H7     (A5: real implementation, generous bounds)
```

### Test T5+T6: `bloat-reduction.spec.ts` (H5, H6)

**Derived from:** A1 (pure logic, no I/O), A2 (injected `nowMs`), A6 (report contains `reductionPercent`, `purgedKeys`).

**Structure:**
- Construct realistic bloated sessions inline (no fixtures — A1/A5 discipline).
- Call `cleanupSessions` / `purgeStaleSubagents` with injected `nowMs` (A2).
- Assert on report fields: `reductionPercent > 90`, `purgedKeys.length === 50` (A6).
- Token approximation stated in docblock, not asserted (tokenizer-dependent).

### Test T3+T4: `semaphore-concurrency.spec.ts` (H3, H4)

**Derived from:** A1 (semaphore logic is pure, wrapper is isolated), A2 (state transitions are deterministic).

**Structure:**
- Create real `AsyncSemaphore` (A5: no mocks).
- Fire concurrent `acquire()` calls with hold delays to create overlap.
- Assert peak `active ≤ max` (structural invariant from A2, not timing).
- Assert all waiters complete (no leaked promises).
- For H4: fill sub-pool, acquire main-pool, assert immediate completion.

### Test T1: `event-loop-blocking.spec.ts` (H1)

**Derived from:** A1 (I/O is in `*-io.ts`, isolable).

**Structure:**
- Event loop probe: `setInterval` every 1ms, measure gap.
- Write 1MB file to temp dir.
- Read with `readFileSync` — measure max probe gap during read.
- Read with `readFile` (async) — measure max probe gap.
- Assert: sync gap > 10ms (blocks), async gap < 5ms (yields).
- Generous bounds — the claim is directional (A1 lets us isolate; A2 does not apply because this is I/O, not logic).

### Test T2: `json-stringify-cost.spec.ts` (H2)

**Derived from:** A1 (the scan loop is in the logic/handler, separable from I/O).

**Structure:**
- Construct 100 sessions × 6 bloat fields in-memory (A1: no file read).
- Measure CPU time of `for each field: JSON.stringify(value).length`.
- Compare to `statSync(path).size` (one syscall).
- Assert: scan loop > statSync by a measurable margin.
- This is the regression guard for the fix (replace serialization with statSync).

### Test T7: `dispatch-overhead.spec.ts` (H7)

**Derived from:** A5 (real implementation, not mocks), A3 (all 36 hooks are declared and registered — no phantoms).

**Structure:**
- Use real `createHookRunner` from E2E infrastructure (A5).
- Measure dispatch with 0, 1, 10 handlers.
- Assert: 0 handlers < 0.1ms, 10 handlers < 10ms.
- Generous bounds — regression guard, not a performance target.

---

## The Fix Cycles, Derived

The axioms don't just generate tests — they generate the fixes. When a test reveals a violation, the fix follows from the axiom that was violated:

### Fix 1: Sync I/O → async (H1 → fix)

**The violation:** `sessions-io.ts` uses `readFileSync`/`writeFileSync`. This doesn't violate A1 (I/O is allowed in `*-io.ts`), but it violates the *spirit* of A1 — the I/O layer's cost should be yieldable, not blocking.

**The fix (derived from A1):** Migrate to `fs/promises`. The Protocol interface (`SessionsReader`/`SessionsWriter`) already exists (A1). Change the implementation, keep the interface. The hook handlers `await` the calls. Test T1 proves the fix (async doesn't block).

### Fix 2: JSON.stringify scan → statSync (H2 → fix)

**The violation:** The `before_prompt_build` handler calls `JSON.stringify(fieldValue).length` per field. This is CPU work in the hot path.

**The fix (derived from A1):** The byte count is only used for a threshold check. Replace N serializations with one `statSync(path).size`. The logic (strip if bloat exists) is unchanged. The `check-result` (A6) report still includes `strippedFieldCount` — it just doesn't include `bloatBytes` computed via serialization. Test T2 proves the fix is cheaper.

---

## Summary: The Axiomatic Method

We do not test efficiency by guessing what might be slow. We:

1. **Accept the axioms** (A1-A6, codified in the foundry, checked on every commit).
2. **Derive propositions** — each axiom enables a measurement capability.
3. **Form hypotheses** — each proposition implies a testable claim.
4. **Operationalize as tests** — each hypothesis becomes a test with bounds derived from the axiom's strength.
5. **Derive fixes** — when a test fails, the fix follows from the axiom that was violated.

The axioms are the foundation. The hypotheses are the logical consequences. The tests are the proofs. The fixes are the restorations. This is the definitory axiomatic way.
