# Session Handoff

> A dense, literate snapshot of working state. One `read` of this file restores
> context after a `/n` compaction. Updated at each commit boundary.

## Repo & Branch

- **Repo:** `git@github.com:FlowFeel/openclaw-test-harness.git` (public)
- **Active branch:** `feat/multiagent-process-isolation` (1 commit ahead of `main`)
  - HEAD: `a40294e` — `feat(worker-pool): #13 worker crash isolation & respawn — literate DFT`
- **`main` HEAD:** `99a6660` — `ci: fix ship-patches … (#2)` (PR #2 merged)
- **PR #1** (Era 3 roadmap + #11 + #15 scaffold + docs rewrite): merged to main.
- **PR #2** (ship-patches CI fix): merged to main.

## Test State (green at HEAD)

- **Total: 203** — 25 Python (`uv run pytest tests/unit tests/integration`) + 178 TS
- TS breakdown: 112 spec + 49 integration + 17 E2E (Docker-gated)
- `tsc --noEmit`: clean
- TS run: `cd ts && ./node_modules/.bin/vitest run` (or `npx vitest run`)

## Era 3 — Threading & Process Isolation (tickets #11–#17)

| # | Ticket | Status |
|---|--------|--------|
| 11 | Handler-module registry (kill god function) | ✅ Done |
| 12 | Real Piscina integration (prod uses threads) | 📋 Planned |
| 13 | Worker crash isolation & respawn | ✅ Done |
| 14 | Per-topic fairness & backpressure | 📋 Planned |
| 15 | SubagentSupervisor Protocol | 🟡 Scaffolded |
| 16 | Per-topic actor isolation | 📋 Planned (deps #15) |
| 17 | Live telemetry → admission | 📋 Planned (deps #15,#16) |

### Key files (the spine of the work)

- `ts/patches/worker-pool.js` — the CJS patch that ships into OC. #11 (handler
  registry + `dispatch` + `Function.prototype.toString` worker source) and #13
  (`createSlot`/`die`/`finish` crash isolation) live here. **Literate**: header
  + each function carry narrative `why` prose. Exports `{ getPool, dispatch, handlers }`.
- `ts/tests/support/load-cjs.ts` — `loadCjsModule()`: loads CJS patch source in
  the ESM harness via `vm.compileFunction`. Required because the repo is
  `"type":"module"` but the patch is CJS.
- `ts/src/features/supervision/supervisor.schema.ts` — #15 `SubagentSupervisor`
  Protocol + `ActorHandle`/`RestartPolicy`/`SupervisorEvent` Effect schemas.
- `ts/src/features/supervision/mock-supervisor.ts` — #15 `MockSupervisor`:
  delegates all transitions to the pure `transitionSubagent` table, backoff from
  injected `Clock` (#7), restart = terminate + fresh `created→dispatched` actor.
- `ISSUES.md` — full ticket specs (#11–#17) with file:line evidence + status.

## Ship Patches CI (fixed, working)

- Was failing every run since v0.2.0 with `HTTP 422: tag_name already exists`.
- Root cause: tag was `v0.${PATCH_COUNT}.0-oc-…` where `PATCH_COUNT=$(ls *.ts)`
  = constant 2. Fixed in `.github/workflows/ship-patches.yml` (PR #2):
  content-hash versioning (`v0.{count}.{sha12}-oc-{ocver}`), idempotent
  `gh release view` before `create`, upload glob `ts/patches/*` (was missing
  `worker-pool.js`).
- Last release shipped: `v0.4.3b9cee3a72d2-oc-2026.6.8` (all 4 patch assets).

## Conventions Established (the phosphene style)

1. **Protocol-first.** I/O behind Protocols (`WorkerPool`, `SubagentSupervisor`).
   Mock doubles are real in-process implementations, not patch-over mocks.
2. **Pure logic.** Evaluation functions take immutable snapshots, return result
   dataclasses, never throw, never call I/O. The pure table (`transitionSubagent`,
   `handlers` registry) is the seam that lets one definition serve two realms.
3. **Determinism as correctness.** Tests assert deterministic identities (error
   message text, exact counts, invariants) — *not* "it doesn't hang." Wall-clock
   measures latency but is never a controlled input (ticket #7 clock discipline).
4. **Literate source & tests.** Source headers and key functions carry narrative
   `why` prose. Specs are written to be read as specifications: each `describe`
   names an invariant, each `it` states the proposition, prose before each
   assertion says *why* that assertion is the one that matters.
5. **DFT framing documented in spec headers.** Each fault/edge spec declares
   what is deterministic (load-bearing) vs bounded-latency (sanity check) vs
   hermeticity (what the only upstream is).

## DFT Primitives Already Built (Era 2, on main)

- `ts/src/core/test-context.ts` — `SystemClock` / `DeterministicTestClock` / `SequenceGenerator`
- `ts/src/core/v8-assert.ts` — `captureV8Snapshot()` / `assertV8HeapStability()`
- `ts/src/containers/openrouter-mock-sidecar.ts` — `OpenRouterMockServer` (ephemeral port, self-starts as container)
- `ts/tests/support/openclaw-container.ts` — `startPatchedOpenClaw({ withSidecar: true })` + `executeModelCall` (offline spawn→LLM E2E)

## Next Steps (when resuming)

1. **#12** Real Piscina — `piscina-pool.ts:105` admits "run inline"; point
   Piscina's `filename` at a worker entry importing the #11 registry. Can adopt
   the #13 slot/respawn pattern against Piscina's task lifecycle.
2. **#15 follow-on** — `WorkerSupervisor` (worker_threads) and
   `ProcessSupervisor` (child_process) implementations of the scaffolded Protocol.
3. PRs: open against `main`; `Ship Patches` auto-runs on green main CI.

## Local Environment

- Node v24.14.1, Docker via OrbStack (live), Python via `uv` (venv at `.venv/`).
- `ts/node_modules/` installed (`npm ci`); `ts/registry.db*` gitignored.
- TS suite ~1–6s (E2E needs Docker; reuse path ~900ms, sidecar path ~360ms fresh).
