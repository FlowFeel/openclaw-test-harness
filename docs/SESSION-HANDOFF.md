# Session Handoff

> A dense, literate snapshot of working state. One `read` of this file restores full working context after a `/n` compaction, without re-deriving it from the transcript. Updated at each commit boundary.

---

## Why This File Exists

LLM sessions accumulate context until compaction (`/n`) summarizes the older turns away. The summary preserves the *what* but can lose the *why* — the conventions, the exact green-counts, the file:line spine of in-progress work. This file is the durable counterpart to the transcript: the load-bearing facts of the current working state, written to be read in one pass and structured so a single `read` re-anchors the session. Treat it as the authoritative source of "where are we" between compactions; treat `ISSUES.md` and `docs/WAR-STORY.md` as the authoritative sources of "what and why historically."

---

## Repo & Branch State

The current locus of work is a feature branch one commit ahead of `main`; `main` itself just received a CI hotfix. Two PRs have landed.

### Active branch

- **Branch:** `feat/multiagent-process-isolation`
- **HEAD:** `5a08949` — `docs: add SESSION-HANDOFF for context recovery after /n compaction`
- **Ahead of `main` by:** 1 commit (this file). The substantive Era 3 commits — #11, #13, #15 scaffold, the README/WAR-STORY rewrite — already merged to `main` via PR #1.

### `main` HEAD

- `99a6660` — `ci: fix ship-patches — content-hash versioning + idempotent release + upload all patches (#2)`. This is the Ship Patches CI hotfix (PR #2). It is *not* on the feature branch; it lives only on `main`.

### Pull requests

- **PR #1** (merged to `main`): Era 3 roadmap (`ISSUES.md` #11–#17) + #11 handler registry + #15 supervisor scaffold + README three-era rewrite + WAR-STORY Phase 17.
- **PR #2** (merged to `main`): the Ship Patches CI fix — see the "Ship Patches CI" section below.

### Remote

- `git@github.com:FlowFeel/openclaw-test-harness.git` (public). `git push` from the feature branch tracks `origin/feat/multiagent-process-isolation`.

---

## Test State

The suite is green at HEAD across all four layers. These counts are the single most useful sanity check after a compaction — if a post-compaction edit changes them unexpectedly, something has regressed.

### Total counts

- **Total: 203 tests, all green.**
- **Python: 25** — `uv run pytest tests/unit tests/integration` (~0.2s).
- **TypeScript: 178** — `cd ts && ./node_modules/.bin/vitest run` (~1–6s; E2E needs Docker).

### TypeScript breakdown

- **Spec (unit): 112** — pure transition tables, context reducers, worker-pool protocols, deterministic clocks, V8 heap invariants, the `SubagentSupervisor` Protocol.
- **Integration: 49** — SQLite accessors, BDD scenarios, `patch-package` validation, the OpenRouter mock sidecar, worker fault injection, the #11 handler-registry conformance suite, the #13 crash-isolation suite.
- **E2E (Testcontainers, Docker-gated): 17** — patched-OC admission checks, the OpenRouter mock sidecar as a real long-lived container, and the sidecar wired into the OC container for the offline `admit spawn → model call` flow.

### Typecheck

- `cd ts && ./node_modules/.bin/tsc --noEmit` — **clean.** Run before every commit; it is the first thing to break when a patch diverges from the harness types.

---

## Era 3 — Threading & Process Isolation

The active era. It targets the two structural anti-patterns the prior eras left untouched: the **worker god function** (one string-eval'd dispatch blob, duplicated between worker body and inline fallback) and the **god process** (one OC process + one global singleton pool serving all topics/agents, with `SubagentActor` owning no real process lifecycle). The full ticket specs with file:line evidence live in `ISSUES.md` #11–#17.

### Ticket status

| # | Ticket | Status | Notes |
|---|--------|--------|-------|
| 11 | Handler-module registry | ✅ Done | Killed the god function. |
| 12 | Real Piscina integration | 📋 Planned | Prod pool admits "run inline". |
| 13 | Worker crash isolation & respawn | ✅ Done | Fixed dead-slot degradation. |
| 14 | Per-topic fairness & backpressure | 📋 Planned | `getPool()` is a singleton. |
| 15 | SubagentSupervisor Protocol | 🟡 Scaffolded | `MockSupervisor` done; real impls to follow. |
| 16 | Per-topic actor isolation | 📋 Planned | Depends on #15. |
| 17 | Live telemetry → admission | 📋 Planned | Depends on #15, #16. |

### #11 — Handler-Module Registry (✅ Done)

- **What:** Handler logic lives exactly once in a `handlers` registry map of pure, closure-free arrow functions. `dispatch(handler, input)` is a generic `handlers[handler](input)` lookup with no handler-name literals. The worker body is generic scaffolding with the registry serialized in via `Function.prototype.toString`; the inline fallback calls `dispatch()` directly.
- **Why it mattered:** The pre-#11 worker body and inline fallback each hand-maintained a parallel `if/else` over handler names. That duplication had already drifted — the inline path was missing `json.parse` entirely (silently returned `null`), `measure.size` diverged (`.reduce()` vs `for`-loop), and unknown handlers rejected in the worker but resolved `null` inline.
- **The seam:** Purity is what makes `Function.prototype.toString` work across the process boundary. Every handler is pure (input → output, no module-scope captures), so its serialized body reconstructs faithfully in the worker realm. The phosphene axiomatic "pure logic" principle stops being a style preference here and becomes the engineering enabler of cross-realm sharing.
- **Proof:** `ts/tests/integration/worker-pool-registry.spec.ts` (18 specs) asserts worker `execute` === inline `dispatch` for every built-in handler, that `dispatch.toString()` contains no handler-name literals, and conformance with `handlers.ts` for the 5 shared handlers.

### #13 — Worker Crash Isolation & Respawn (✅ Done)

- **What:** Each worker owns `'error'`/`'exit'` listeners (`createSlot()` → `die()`). On death, `die()` rejects the in-flight task immediately via the slot's `current` state, marks the slot `dead`, splices it from the rotation, and spawns a replacement to hold `MAX_THREADS`. `execute()`'s `finish()` is the single settle path for message/watchdog and is a no-op on a dead slot, so message, watchdog, and death never double-settle. `stats()` exposes `deadWorkers`.
- **Why it mattered:** Pre-#13 the patch registered only `worker.on('message')`. The `'message'` listener cannot fire on a dead thread, so a crashed worker's in-flight task hung until the 10s watchdog — and the watchdog only rejected, it never restored the slot. The dead worker stayed in the rotation, was re-selected, `postMessage`'d into, and timed out again on every subsequent `execute`. A death permanently shrank the pool until process restart.
- **The deterministic claim:** The spec proves the exit-listener path fired by the *error message identity* (`"Worker thread terminated"`, not `"timed out"`) — not by "it didn't hang." Bounded-latency (<2000ms vs 10000ms watchdog) is a secondary sanity check. `poolSize` invariance across N killings is the deterministic core of "no permanent loss."
- **Proof:** `ts/tests/integration/worker-crash-isolation.spec.ts` (6 specs, 4 invariants).

### #15 — SubagentSupervisor Protocol (🟡 Scaffolded)

- **What:** A `SubagentSupervisor` Protocol (`ts/src/features/supervision/supervisor.schema.ts`) + `MockSupervisor` (`mock-supervisor.ts`) that bind the pure `transitionSubagent` table to supervisor lifecycle events. The supervisor never invents a transition — it delegates every state change to the pure table. Restart backoff is computed from the injected `Clock` (#7); restart terminates the active run then creates a fresh `created → dispatched` actor with `retryCount+1` (respecting that the table forbids `failed → dispatch`).
- **Why it mattered:** `SubagentActor` was self-described as "a lightweight, zero-dependency actor-like wrapper" holding only a `currentState` string — it owned no process, no thread, no IPC. The lifecycle states (`dispatched → running → yielding → completed`) were purely logical; nothing bound them to real process lifecycle, so the whole multiagent system ran inside the single OC god process.
- **What's scaffolded vs. planned:** The Protocol + `MockSupervisor` + 9 specs are done (the testable foundation). `WorkerSupervisor` (worker_threads) and an OC-patch `ProcessSupervisor` (child_process) are the #15 follow-ons — the real process-binding implementations.
- **Proof:** `ts/tests/spec/supervisor.spec.ts` (9 specs): lifecycle binding, invalid-transition no-ops, deterministic event timestamps, restart backoff + `maxRetries`, terminal reap.

### Planned tickets (brief)

- **#12 Real Piscina** — `piscina-pool.ts:105` admits "run inline"; point Piscina's `filename` at a worker entry importing the #11 registry so prod actually uses threads. Can adopt the #13 slot/respawn pattern against Piscina's task lifecycle.
- **#14 Per-topic fairness** — `getPool()` is a module singleton; no per-topic queue/fairness. A `FairPool` Protocol with per-topic queues + a backpressure signal feeding admission.
- **#16 Per-topic actor isolation** — each topic runs as an isolated supervised actor; main process becomes a thin router. Builds on #15.
- **#17 Live telemetry → admission** — `ProcessTelemetry` Protocol populates `SystemHealth` from real `monitorEventLoopDelay` / `captureV8Snapshot` readings; admission reacts to real pressure, not fixtures.

---

## Key Files — The Spine of the Work

These are the files touched most often. Knowing their role and their literate conventions is the fastest way back to productive editing after a compaction.

### `ts/patches/worker-pool.js`

- **Role:** The CJS patch that ships into OC's `dist/`. #11 (handler registry + `dispatch` + `Function.prototype.toString` worker source) and #13 (`createSlot`/`die`/`finish` crash isolation) live here.
- **Literate convention:** The header docblock and each key function carry narrative `why` prose — not just `what`. Read the header before editing; it states the anti-pattern being fixed and the constraint (closure-free handlers) that makes the fix work.
- **Exports:** `{ getPool, dispatch, handlers }`. `dispatch` and `handlers` are exported for testability (the #11 registry spec asserts against them).

### `ts/tests/support/load-cjs.ts`

- **Role:** `loadCjsModule()` — loads a CJS patch's source in the ESM harness via `vm.compileFunction`, evaluating it in a CJS module wrapper with a real `require`. Required because the repo is `"type":"module"` but the production patch is CJS.
- **Why it exists:** Without it, `require()` of a `.js` patch fails with "require is not defined in ES module scope." This helper is the seam that lets the integration specs exercise the *real* patch rather than a reimplemented copy.

### `ts/src/features/supervision/supervisor.schema.ts` & `mock-supervisor.ts`

- **Role:** The #15 `SubagentSupervisor` Protocol + Effect schemas (`ActorHandle`, `RestartPolicy`, `SupervisorEvent`) and the `MockSupervisor` in-process implementation.
- **Convention:** The supervisor delegates *all* state transitions to the pure `transitionSubagent` table — it never invents a transition. This keeps `*.machine.ts` pure and I/O-free, with the supervisor as the only component that owns real process lifecycle.

### `ISSUES.md`

- **Role:** The authoritative ticket spec. #11–#17 each carry file:line evidence for the problem, the solution, the acceptance criteria, and the status. Update a ticket's status line when its work lands.

---

## Ship Patches CI (Fixed, Working)

`Ship Patches` was failing on **every run since v0.2.0** with `HTTP 422: Release.tag_name already exists`. Fixed on `main` via PR #2; the fix is *not* on the feature branch.

### Root cause

- The release tag was `v0.${PATCH_COUNT}.0-oc-…` where `PATCH_COUNT=$(ls ts/patches/*.ts | wc -l)` = **2** (a constant — it only counted `.ts` files). Once `v0.2.0-oc-2026.6.8` existed, every run recomputed the same tag and `gh release create` 422'd. Five consecutive failures.

### The fix (`.github/workflows/ship-patches.yml`, on `main`)

- **Content-hash versioning:** tag is now `v0.{PATCH_COUNT}.{PATCH_SHA12}-oc-{OC_VERSION}` where `PATCH_SHA` is a sha256 of all patch files. Any patch content change → new hash → new tag → new release. Same pattern as the testcontainers reuse hash.
- **Idempotent release:** `gh release view "$TAG"` before `gh release create` — a re-run for unchanged patch state skips instead of 422-ing.
- **Upload all patches:** the asset loop globs `ts/patches/*` (was `*.ts` and `*.patch`, so `worker-pool.js` was never uploaded).

### Last shipped release

- `v0.4.3b9cee3a72d2-oc-2026.6.8` — content-hash tag, all 4 patch assets (`child-admission.patch`, `child-admission.ts`, `sqlite-accessor.ts`, `worker-pool.js`). `Ship Patches` run 30715771301 succeeded (45s) — the first green run since v0.2.0.

---

## Conventions Established — The Phosphene Style

These are the discipline rules the harness follows uniformly. They are load-bearing: each one exists because violating it caused a concrete bug or a flaky test in this repo's history.

### 1. Protocol-first

- I/O lives behind Protocols (`WorkerPool`, `SubagentSupervisor`, `SpawnAdmission`). Production and test implementations share one contract. Mock doubles (`MockWorkerPool`, `MockSupervisor`, `TestStore`, `OpenRouterMockServer`) are *real in-process implementations* of the Protocol, not patch-over mocks — they exercise the same code path the prod implementation will.

### 2. Pure logic as the seam

- Evaluation functions take immutable snapshots, return result dataclasses (`AdmissionDecision`, `SpawnDecision`), never throw, never call I/O. The pure table (`transitionSubagent`, the `handlers` registry) is the seam that lets one definition serve two realms — the main thread and the worker thread, or the test and the prod path. Purity stops being a style preference at #11 and becomes the engineering enabler of cross-realm sharing.

### 3. Determinism as correctness

- Tests assert deterministic *identities* — error message text, exact counts, invariants — not "it doesn't hang" or "it's fast." Wall-clock measures latency but is never a controlled input (ticket #7's clock discipline: injectable `Clock`/`nowMs`, no `Date.now()`/`Math.random()` in test paths). A regression changes a message or a count, not a timeout.

### 4. Literate source & tests

- Source headers and key functions carry narrative `why` prose, not just `what`. Specs are written to be read as specifications: each `describe` block names an invariant; each `it` states the proposition that proves it; prose before each assertion says *why* that assertion is the one that matters. The #13 crash-isolation spec is the canonical example — read it before writing a new fault/edge spec.

### 5. DFT framing documented in spec headers

- Each fault/edge spec header declares what is deterministic (load-bearing), what is bounded-latency (sanity check), and what the only upstream is (hermeticity). This makes the test's *claim* explicit, so a future reader knows which assertions are structural and which are incidental.

---

## DFT Primitives on `main` (Era 2)

These building blocks are already merged to `main` and are depended on by Era 3 work. They live in `ts/src/core/` and `ts/src/containers/`.

### Deterministic clocks & IDs (#7)

- `ts/src/core/test-context.ts` — `SystemClock`, `DeterministicTestClock`, `SequenceGenerator`. Injectable `nowMs` is wired into `TestStore.getTimedOut()` and the `fanout.topics` handler; the `worker-pool.js` task IDs use a monotonic counter (the repo's only `Math.random()` is gone).

### V8 heap invariants (#9)

- `ts/src/core/v8-assert.ts` — `captureV8Snapshot()` / `assertV8HeapStability()` assert bounded `used_heap_size` growth in-process. Hidden leaks fail CI without manual `--trace-gc`.

### OpenRouter mock sidecar (#8)

- `ts/src/containers/openrouter-mock-sidecar.ts` — `OpenRouterMockServer`: fixed OpenAI-compatible JSON on an ephemeral port (no hardcoded `8080`/`9999`), self-starts as a long-lived container entrypoint (`node --experimental-strip-types`, zero `node_modules`). Constraint: avoids TS parameter properties (unsupported by strip-only mode).

### Offline spawn→LLM E2E (#8)

- `ts/tests/support/openclaw-container.ts` — `startPatchedOpenClaw({ withSidecar: true })` starts the sidecar on a shared testcontainers `Network`, attaches the OC container (alias `openclaw`) with `OPENCLAW_OPENROUTER_BASE_URL` set, and exposes `executeModelCall` — an in-container `fetch` (base64-argv body, not string-interpolated) driving the full `admit spawn → model call` flow 100% offline. Sidecar path disables `withReuse()` (testcontainers `reuseContainer` does not re-connect networks).

---

## Next Steps

When resuming, start here.

### 1. #12 — Real Piscina integration

- `piscina-pool.ts:105` admits "run inline — real Piscina integration requires serializable handlers." Point Piscina's `filename` at a worker entry that imports the #11 registry. The registry is now a real seam (#11), so this is wiring, not redesign. Consider adopting the #13 slot/respawn pattern against Piscina's task lifecycle so prod and the harness patch converge on one crash model.

### 2. #15 follow-on — real supervisor implementations

- `WorkerSupervisor` (worker_threads) and `ProcessSupervisor` (child_process) implementations of the scaffolded `SubagentSupervisor` Protocol. The `MockSupervisor` is the test double; these bind the Protocol to real process lifecycle.

### 3. PRs & shipping

- Open PRs against `main`. On green main CI, `Ship Patches` auto-runs and ships a content-hash-tagged release with all patch assets. No manual release step.

---

## Local Environment

### Tooling

- **Node:** v24.14.1
- **Docker:** via OrbStack (live; needed for E2E)
- **Python:** via `uv` (venv at `.venv/`)

### Install state

- `ts/node_modules/` installed via `npm ci` (run from `ts/`).
- `ts/registry.db*` are gitignored (test artifacts from the SQLite accessor specs).

### Run timings

- TS spec + integration: ~1s. Full TS suite (incl. E2E): ~6s. E2E reuse path: ~900ms; sidecar path: ~360ms fresh create per run (reuse disabled — see #8). Python: ~0.2s.
