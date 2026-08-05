# Efficiency Testing Plan

A plan for proving (not just claiming) the efficiency properties of the plugin suite. This document defines what "efficiency" means here, what's testable in CI vs production-only, and the specific tests to build.

---

## The Problem

The README makes 6 efficiency claims. **None are tested.** The existing test suite proves *correctness* (the pure logic does the right thing) but not *efficiency* (the mechanism actually saves tokens, limits concurrency, avoids blocking). Worse, the claims were observed *before* the `api.on()` fix — when hooks weren't firing at all. The plugins were no-ops; the metrics reflected config changes, not plugin behavior.

Now that hooks actually fire, we need to:
1. Prove the mechanisms work (deterministic, CI-safe)
2. Prove the anti-patterns block (statistical, CI-safe with generous bounds)
3. Acknowledge what we can't prove in CI (production re-verification)

---

## What "Efficiency" Means Here

Six claims, three testability tiers:

| Claim | Tier | What we can prove in CI |
|-------|------|------------------------|
| Bloat tokens/turn: ~99K → ~15K (84K saved) | **Tier 1** (deterministic) | Byte reduction from `stripBloatFields` with realistic data |
| Event loop P99: 834ms → <50ms (17x) | **Tier 3** (statistical) | Sync I/O blocks, async doesn't (mechanism, not the 17x number) |
| sessions.json: 30MB → 530KB (99%) | **Tier 1** (deterministic) | Bloat stripping + stale purge reduces bytes by >90% |
| Dead subagents: 2,575 → 0 | **Tier 1** (deterministic) | `purgeStaleSubagents` removes entries past `maxAgeHours` |
| Dispatch reliability: 75% → 100% | **Proven** | E2E hook-trace (9 specs) — hooks now fire via `api.on()` |
| Subagent timeout: 3/8 → 0/9 | **Tier 2** (runtime) | Semaphore enforces concurrency; no starvation |

### Tier 1: Deterministic (pure logic, perfectly reproducible)

These test the *mechanism* — the pure functions that do the work. No timing, no I/O, no flakiness. They prove "the function reduces bytes by X%" not "it's fast on my machine."

### Tier 2: Runtime-deterministic (real runtime, behavior guaranteed)

These test runtime behavior where the guarantee is structural (not timing-dependent). The semaphore never exceeds `maxConcurrent` — this is guaranteed by the Promise plumbing, not a performance target.

### Tier 3: Runtime-statistical (real timing, environment-dependent)

These measure actual timing. They need generous bounds to avoid CI flakiness. They prove "sync I/O blocks the event loop" (directional), not "exactly 834ms" (environment-specific).

### What we cannot prove in CI

The production metrics (834ms P99, 30MB file, 2,575 dead subagents) require real production load and data. CI tests prove the *mechanism*; production re-verification proves the *outcome*. Both are needed.

---

## Two Anti-Patterns to Prove and Fix

### Anti-pattern 1: Synchronous file I/O on the main event loop

**Where:** `src/plugins/oc-session-guard/src/sessions-io.ts` and `src/plugins/oc-compaction-helper/src/sessions-io.ts` — both use `readFileSync`/`writeFileSync`.

**Why it's wrong:** These run in `after_compaction`, `session_end`, and `before_prompt_build` hooks — on the main event loop. Sync I/O blocks all model calls, stream ingestion, and channel polling for the duration of the read/write.

**Note:** `oc-sidecar/src/sidecar-server.ts` also uses sync I/O, but it runs in a *separate process* (the sidecar), so it doesn't block the main loop. That's acceptable.

**The fix cycle:**
1. Write a test that proves `readFileSync` blocks the event loop (Tier 3)
2. Migrate `sessions-io.ts` to `fs/promises` (`readFile`/`writeFile`)
3. Update hook handlers to `await` the async I/O
4. Write a test that proves `readFile` does NOT block (Tier 3)
5. The first test becomes a regression guard

### Anti-pattern 2: `JSON.stringify` in the bloat scan hot path

**Where:** `src/plugins/oc-compaction-helper/src/index.ts`, lines 107 and 197:
```typescript
bloatBytes += JSON.stringify(fieldValue).length;
```

**Why it's wrong:** The `before_prompt_build` hook scans every session, and for every bloat field found, serializes the entire field value just to count bytes. With 100 sessions × 6 bloat fields, that's 600 `JSON.stringify` calls per scan. The throttle (60s) limits frequency, but when it fires, the CPU cost is O(sessions × fields × field_size).

**The deeper problem:** The byte count is only used for a threshold check (`bloatBytes < bloatThresholdBytes`). The field-name check (`field in entry`) already tells us bloat exists. The serialization is unnecessary for the decision — it's just for logging.

**The fix cycle:**
1. Write a test that measures the CPU cost of `JSON.stringify` on realistic bloat (Tier 3)
2. Fix: check file size via `statSync` (one syscall) instead of serializing every field
3. Or: skip the byte count entirely — if bloat fields exist, strip them. The threshold is a premature optimization that costs more than it saves.
4. The test becomes a regression guard against reintroducing serialization in the scan

---

## Test Plan

### Test 1: Bloat stripping byte reduction (Tier 1) ⭐ highest value

**File:** `tests/efficiency/bloat-reduction.spec.ts`
**What it proves:** `stripBloatFields` reduces session bytes by >90% for heavily bloated sessions. Directly supports the "99% session I/O reduction" and "84K tokens saved" claims.

**Design:**
- Construct a realistic bloated session: 100 sessions, each with the 6 default bloat fields populated with realistic content (`compactionCheckpoints` = 50 checkpoint objects, `systemPromptReport` = 10KB text, etc.)
- Call `stripBloatFields`, measure `JSON.stringify(before).length` vs `JSON.stringify(after).length`
- Assert: reduction > 90%
- Assert: real data (model, updatedAt) preserved
- Token approximation: bytes / 4 ≈ tokens. For 400 sessions at ~850 bytes bloat each = ~340KB = ~85K tokens — matches the README claim

**Why deterministic:** Pure function, no I/O, no timing. Same result every run, every machine.

### Test 2: Stale subagent purge (Tier 1)

**File:** `tests/efficiency/bloat-reduction.spec.ts` (same file)
**What it proves:** `purgeStaleSubagents` removes all entries past `maxAgeHours`. Supports "2,575 → 0 dead subagents" claim.

**Design:**
- Construct a session map with 100 subagent entries: 50 fresh (within timeout), 50 stale (past timeout)
- Call `purgeStaleSubagents`, assert exactly 50 removed, 50 kept
- Assert: non-subagent entries (topics) are never purged regardless of age

### Test 3: Semaphore concurrency enforcement (Tier 2) ⭐ high value

**File:** `tests/efficiency/semaphore-concurrency.spec.ts`
**What it proves:** `AsyncSemaphore` never exceeds `maxConcurrent` active slots. All waiters eventually acquire (no starvation). Supports "dispatch reliability 100%" and "no subagent starvation" claims.

**Design:**
- Create `AsyncSemaphore(3)`
- Fire 10 concurrent `acquire()` calls, each holding the slot for 10ms
- Track `active` count, assert peak ≤ 3 at all times
- Assert all 10 complete (no leaked promises, no starvation)
- Test with separate sub-pool: 20 subagent acquires don't starve main pool

**Why runtime-deterministic:** The Promise plumbing guarantees the concurrency limit. The timing (10ms hold) is just to create overlap — the assertion is structural (peak ≤ max), not timing-based.

### Test 4: Sync I/O blocks event loop (Tier 3) ⭐ proves the anti-pattern

**File:** `tests/efficiency/event-loop-blocking.spec.ts`
**What it proves:** `readFileSync` on a 1MB file causes measurable event loop delay. `readFile` (async) does not. This is the mechanism behind "834ms P99" — sync I/O on the main loop.

**Design:**
- Event loop probe: `setInterval` every 1ms, measure gap between expected and actual fire time
- Write a 1MB JSON file to temp dir
- Read it with `readFileSync` — measure max probe gap during the read
- Read it with `readFile` (async) — measure max probe gap
- Assert: sync gap > 10ms (blocks), async gap < 5ms (doesn't block)
- **Generous bounds** — the point is directional (sync blocks, async doesn't), not exact numbers

**Infrastructure needed:** Event loop delay probe utility (reusable `createEventLoopProbe()` function).

### Test 5: `JSON.stringify` scan cost (Tier 3) ⭐ proves the anti-pattern

**File:** `tests/efficiency/json-stringify-cost.spec.ts`
**What it proves:** Serializing bloat fields to count bytes is measurable CPU work that scales with field count and size. Motivates the fix (use `statSync` or skip byte counting).

**Design:**
- Construct 100 session entries, each with 6 bloat fields of varying sizes
- Measure CPU time of the current scan loop: `for each field: JSON.stringify(value).length`
- Compare to: `statSync(sessionsPath).size` (one syscall, no serialization)
- Assert: the scan loop takes measurably more time than `statSync`
- Assert: `statSync` is sub-millisecond

### Test 6: Hook dispatch overhead (Tier 3)

**File:** `tests/efficiency/dispatch-overhead.spec.ts`
**What it proves:** Hook dispatch with zero handlers is negligible (the "zero-overhead when disabled" claim from patch 0001). With handlers, dispatch adds <1ms per hook.

**Design:**
- Use the real `createHookRunner` (from the E2E test infrastructure)
- Measure dispatch latency with 0 handlers vs 1 handler vs 10 handlers
- Assert: 0 handlers < 0.1ms, 10 handlers < 10ms
- This is a regression guard — catches if someone adds synchronous work to dispatch

### Test 7: Cache lookup latency (Tier 3) — low priority

**File:** `tests/efficiency/cache-latency.spec.ts`
**What it proves:** `getCached`/`putCached` are sub-millisecond (Map O(1)).

**Design:**
- Populate cache with 1000 entries
- Benchmark 10,000 `getCached` calls
- Assert: average < 0.01ms per lookup
- Low value — Map operations are trivially fast, but it's a regression guard

### Test 8: Admission decision latency (Tier 3) — low priority

**File:** `tests/efficiency/admission-latency.spec.ts`
**What it proves:** `resolveAdmission` and `computeP99` are sub-millisecond. Catches O(n²) regressions in `computeP99` (which sorts).

**Design:**
- Benchmark `resolveAdmission` with typical inputs
- Benchmark `computeP99` with 100, 1000, and 10,000 latencies
- Assert: `resolveAdmission` < 0.1ms, `computeP99(10000)` < 5ms
- Regression guard for sort-based algorithms

---

## Infrastructure

### Event loop delay probe

A reusable utility for Tier 3 tests:

```typescript
// tests/support/event-loop-probe.ts
export function createEventLoopProbe(intervalMs = 1) {
  let maxDelay = 0;
  let expected = performance.now();
  const timer = setInterval(() => {
    const actual = performance.now();
    const delay = actual - expected - intervalMs;
    if (delay > maxDelay) maxDelay = delay;
    expected = actual + intervalMs;
  }, intervalMs);
  return {
    get maxDelay() { return maxDelay; },
    stop() { clearInterval(timer); },
  };
}
```

### Timing harness

Use `process.hrtime.bigint()` for nanosecond precision (already used in `v8-assert.spec.ts`). For millisecond precision, `performance.now()` (already used in `topic-router.spec.ts`).

### Test directory structure

```
tests/efficiency/
├── bloat-reduction.spec.ts          ← Tier 1 (deterministic)
├── semaphore-concurrency.spec.ts    ← Tier 2 (runtime-deterministic)
├── event-loop-blocking.spec.ts      ← Tier 3 (statistical)
├── json-stringify-cost.spec.ts      ← Tier 3 (statistical)
├── dispatch-overhead.spec.ts        ← Tier 3 (statistical)
├── cache-latency.spec.ts            ← Tier 3 (statistical, low priority)
└── admission-latency.spec.ts        ← Tier 3 (statistical, low priority)
```

### CI integration

- Tier 1 + Tier 2: include in CI config (`vitest.config.ci.ts`) — deterministic, no flakiness risk
- Tier 3: include in CI config with generous bounds. If flaky, move to a separate `--config vitest.config.efficiency.ts` that runs with retry logic. But start with generous bounds — the assertions are directional (sync blocks, async doesn't), not exact numbers.

---

## The Fix Cycles

### Fix 1: Migrate sync I/O to async (test-driven)

1. **Write** `event-loop-blocking.spec.ts` — proves `readFileSync` blocks (red — the test passes because sync does block, but it proves the problem exists)
2. **Migrate** `sessions-io.ts` to `fs/promises`:
   ```typescript
   import { readFile, writeFile, access } from "node:fs/promises";
   export async function readSessions(path?: string): Promise<SessionsMap | null> { ... }
   export async function writeSessions(data: SessionsMap, path?: string): Promise<void> { ... }
   ```
3. **Update** hook handlers in `oc-session-guard` and `oc-compaction-helper` to `await reader()` / `await writer()`
4. **Update** the test to prove `readFile` does NOT block
5. **Update** all integration tests that call `reader()`/`writer()` synchronously

### Fix 2: Eliminate `JSON.stringify` from bloat scan (test-driven)

1. **Write** `json-stringify-cost.spec.ts` — proves the scan loop is expensive (measures CPU time)
2. **Fix** the `before_prompt_build` hook:
   - Remove the `JSON.stringify(fieldValue).length` byte counting
   - If bloat fields exist (boolean check via `field in entry`), strip them
   - Use `statSync(sessionsPath).size` for the threshold check (one syscall vs N serializations)
3. **Update** the test to prove `statSync` is cheaper than the scan loop
4. **Update** integration tests that assert on `bloatBytes` logging

---

## What This Plan Does NOT Do

- **Does not prove 834ms → <50ms** — that's a production observation requiring real load. CI proves sync blocks and async doesn't (the mechanism).
- **Does not prove 30MB → 530KB** — that's a production observation. CI proves `stripBloatFields` + `purgeStaleSubagents` reduce bytes by >90% (the mechanism).
- **Does not prove ~84K tokens saved** — token count depends on the model tokenizer. CI proves byte reduction and approximates tokens (bytes/4).
- **Does not run production load tests** — that's a separate step (deploy fixed plugins, observe real metrics).

The CI tests prove the **mechanisms** are correct and the **anti-patterns** are real. Production re-verification proves the **outcomes**.

---

## Priority

| Priority | Test | Effort | Value |
|----------|------|--------|-------|
| 1 | Bloat stripping byte reduction (Tier 1) | Small | Directly proves "99% reduction" + "84K tokens saved" |
| 2 | Stale subagent purge (Tier 1) | Small | Directly proves "2,575 → 0" |
| 3 | Semaphore concurrency enforcement (Tier 2) | Medium | Proves dispatch reliability + no starvation |
| 4 | Sync I/O blocks event loop (Tier 3) | Medium | Proves the anti-pattern, enables the fix |
| 5 | `JSON.stringify` scan cost (Tier 3) | Small | Proves the anti-pattern, enables the fix |
| 6 | Hook dispatch overhead (Tier 3) | Medium | Regression guard for "zero-overhead" claim |
| 7 | Cache lookup latency (Tier 3) | Small | Regression guard |
| 8 | Admission decision latency (Tier 3) | Small | Regression guard |

Start with 1-3 (deterministic, no flakiness risk, highest value). Then 4-5 (prove the anti-patterns, enable the fix cycles). Then 6-8 (regression guards).
