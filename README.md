# OpenClaw Test Harness & Plugin Suite

**A plugin foundry, OC source mod test bed, and 11-plugin suite for OpenClaw (OC). Pure functional state machines, deterministic Design-for-Testability (DFT) primitives, hermetic Testcontainers E2E, and 89% statement coverage — built to phosphene axiomatic standards.**

---

## The Critical Discovery: `api.on()` vs `api.registerHook()`

The single most important finding from this work:

**OC's plugin SDK has two hook registration APIs, and only one works for typed lifecycle hooks.**

| API | Registers to | Visible to `hasHooks()`? | Actually fires? |
|-----|-------------|--------------------------|-----------------|
| `api.on("gateway_start", handler)` | `typedHooks` | ✅ Yes | ✅ Yes |
| `api.registerHook("gateway_start", handler, {name})` | `legacyInternalHooks` | ❌ No | ❌ No |

The gateway checks `hasHooks("gateway_start")` before dispatching. If false, the hook is **never called**. `hasHooks()` only checks `typedHooks`. `api.registerHook()` registers to `legacyInternalHooks` — invisible to the gate.

**This was the root cause of "hooks not working."** Every plugin originally used `api.registerHook()`. The hooks registered successfully (no error), but never dispatched. The plugins were no-ops in production.

**The fix:** All 11 plugins now use `api.on()`. The `shared/types.ts` `PluginApi` interface includes `on()`. The foundry scaffold generates `api.on()` calls by construction.

**Proven end-to-end** (commit `fa6f06a`, 9 E2E specs): a real running OC gateway from npm tarball, built hook runner patched in-container. `api.on("gateway_start", ...)` → hook fired immediately. `api.registerHook("gateway_start", ...)` → hook never fired.

See [`docs/oc-source-mod-testbed.md`](./docs/oc-source-mod-testbed.md) for the full dual-API analysis.

---

## Current State (August 2026)

| Metric | Value |
|--------|-------|
| Plugins | **11** (all DFT-valid, all use `api.on()`) |
| CI tests | **1,125** (71 files, `vitest.config.ci.ts`) |
| Full suite | **1,133** (82 files, includes e2e + oc-source) |
| Statement coverage | **88.5%** (CI config) |
| Branch coverage | **79.6%** |
| Hook registrations | **36** (all via `api.on()`) |
| Tools registered | **19** |
| Pure logic modules | **15** (in `shared/`, 97%+ coverage) |
| Efficiency tests | **26** (6 hypotheses, 3 tiers) |
| Foundry validation | **11/11 pass** (all six DFT axioms) |
| CI layers | 4 (unit → docker → e2e → staging) |

### The arc of this work

1. **The `api.on()` migration** — all 36 hook registrations migrated from `api.registerHook()` (never fires) to `api.on()` (fires). Hooks are now live for the first time. This alone explains most "plugins didn't help" observations.

2. **The coverage sprint** — 248 new tests (885 → 1,133) covering 4 blind spots in pure logic, 6 plugin wiring layers, state machine actors, and orchestrator tools. Coverage 85% → 89%.

3. **The efficiency derivation** — 7 hypotheses derived as logical consequences of the 6 DFT axioms. 6 implemented as tests (26 tests across 3 tiers: deterministic, runtime-deterministic, statistical). The axioms are the preconditions that make efficiency measurable.

4. **The three gaps** — the application layer on top of the concurrency infrastructure: outbound `sendMediaGroup` batching, configurable `timeoutMs` policy, and subagent progress heartbeats. Three pure-logic modules with 76 tests.

### Production metrics (require re-verification)

These metrics were observed in production **before** the `api.on()` fix. Since the hooks weren't firing at the time, they reflect manual/config-level interventions, not plugin behavior. Now that hooks actually fire, these need re-verification:

| Metric | Observed (pre-fix) | Mechanism (not hooks) |
|--------|-------------------|----------------------|
| Event loop P99 | 834ms → <50ms | Config changes + sidecar |
| sessions.json | 30MB → 530KB | Config changes (`deltaBytes` raised to 1MB) |
| Dead subagents | 2,575 → 0 | Manual cleanup |
| Bloat tokens/turn | ~99K → ~15K | Config changes |

The efficiency tests (below) prove the *mechanisms* (sync blocks, async yields; bloat stripping reduces bytes >90%). Production re-verification proves the *outcomes*. The axioms tell us which is which.

---

## Architecture

```
openclaw-test-harness/
├── ts/
│   ├── src/
│   │   ├── plugins/              ← 11 OC plugins (all use api.on())
│   │   │   ├── shared/           ← Pure logic (15 modules, 97%+ coverage)
│   │   │   │   ├── types.ts      ← PluginApi interface (includes on())
│   │   │   │   ├── media-batcher.ts          ← Gap 1: sendMediaGroup batching
│   │   │   │   ├── document-send-policy.ts   ← Gap 2: timeout/retry/chunk policy
│   │   │   │   ├── subagent-progress-tracker.ts ← Gap 3: heartbeat progress tracking
│   │   │   │   └── ... (12 more)
│   │   │   ├── oc-subagent-orchestrator/   ← 8 hooks, 7 tools
│   │   │   ├── oc-topic-worker-pool/       ← 6 hooks (semaphore admission)
│   │   │   ├── oc-sidecar/                 ← 2 hooks, 3 tools
│   │   │   ├── oc-compaction-helper/       ← 4 hooks, 1 tool
│   │   │   └── ... (7 more)
│   │   ├── foundry/              ← Plugin factory: scaffold + validate
│   │   └── features/             ← Pure state machines + supervisors
│   ├── scripts/
│   │   └── build-plugins.mjs     ← esbuild bundler: 11 plugins → self-contained dist/
│   ├── tests/                    ← 1,133 tests (spec, integration, e2e, efficiency, bundle)
│   └── patches/                  ← OC source patches (child-admission)
├── oc-source/
│   ├── upstream/                 ← git submodule: FlowFeel/openclaw
│   └── patches/
│       └── 0001-hook-debug-instrumentation.patch   ← 510 lines
├── docs/                         ← Architecture docs
└── docker/                       ← CI image + compose
```

### The three layers

**Layer 1 — Plugin Suite** (11 plugins, 36 hooks, 19 tools): OC plugins that hook into the gateway lifecycle via `api.on()`. Pure logic in `shared/`, thin I/O wiring in each plugin's `index.ts`. All pass the foundry's six DFT axioms. No OC core files modified — plugin hooks + tool registration only.

**Layer 2 — Plugin Foundry** (`ts/src/foundry/`): Scaffolds new plugins and validates them against six DFT axioms. `scaffoldPlugin → validatePlugin → zero errors` — templates cannot produce a non-compliant plugin.

**Layer 3 — OC Source Mod Test Bed** (`oc-source/`): Patches OC's internal hook runner with upstreamable patch+test pairs. Patch 0001 adds structured trace instrumentation (dispatch, error, no-handlers events). Verified at two levels: Level 1 (6 specs, direct import) and Level 2 (9 specs, real running gateway). These patches are upstreamable PRs — the test harness has the pure logic, BDD tests, and E2E verification.

---

## The 11 Plugins

| Plugin | Hooks | Tools | Tests | Purpose |
|--------|-------|-------|-------|---------|
| `oc-subagent-orchestrator` | 8 | 7 | 36 | Work queue dispatch, depth limits, adaptive admission |
| `oc-topic-worker-pool` | 6 | 0 | 33 | Semaphore admission control for Telegram topic sessions |
| `oc-sidecar` | 2 | 3 | 55 | Worker pool process for CPU offloading |
| `oc-compaction-helper` | 4 | 1 | 21 | Pre/post compaction bloat stripping |
| `oc-stream-relay` | 3 | 1 | 39 | Model stream relay design |
| `oc-context-cache` | 3 | 1 | 31 | System prompt + context caching |
| `oc-model-router` | 2 | 1 | 38 | Model fallback chain (P99, error rate, routing) |
| `oc-subagent-watchdog` | 2 | 1 | 17 | Subagent lifecycle tracking + stale detection |
| `oc-session-guard` | 2 | 2 | 16 | Session bloat management (direct file I/O) |
| `oc-event-loop-monitor` | 3 | 1 | 13 | Live telemetry (perf_hooks + v8 heap) |
| `oc-e2e-trace-test` | 1 | 0 | 5 | Test plugin for Level 2 E2E hook trace |

All hooks registered via `api.on()` (typed, fires). All 11 pass `foundry validate` (six DFT axioms).

### Hook inventory (all 36 use `api.on()`)

| Hook | Plugins |
|------|---------|
| `gateway_start` | orchestrator, sidecar, stream-relay, context-cache, e2e-trace-test |
| `gateway_stop` | orchestrator, sidecar, stream-relay, context-cache, event-loop-monitor |
| `model_call_started` | orchestrator, stream-relay, model-router, event-loop-monitor |
| `model_call_ended` | orchestrator, model-router, event-loop-monitor |
| `after_compaction` | orchestrator, session-guard |
| `agent_end` | orchestrator, compaction-helper, topic-worker-pool |
| `session_end` | session-guard |
| `subagent_spawned` | orchestrator, subagent-watchdog |
| `subagent_ended` | orchestrator, subagent-watchdog, topic-worker-pool |
| `before_prompt_build` | compaction-helper, context-cache |
| `before_compaction` | compaction-helper |
| `before_dispatch` | topic-worker-pool |
| `before_agent_run` | topic-worker-pool |
| `before_agent_reply` | topic-worker-pool |
| `subagent_spawning` | topic-worker-pool |

---

## Pure Logic (`shared/` modules)

All scheduling, admission, cleanup, tracking, and send policy logic is pure — tested without OC runtime, I/O, or fixtures. 97%+ statement coverage on shared modules.

| Module | Tests | What |
|--------|-------|------|
| `work-queue-scheduler` | 38 | Priority queue, parallel dispatch, dependencies, result collection |
| `topic-isolation` | 31 | Per-topic budget, slot borrowing, bottleneck detection |
| `research-task-specs` | 22 | Declarative task format, cycle detection, execution planning |
| `result-merger` | 31 | Citation dedup, relevance sorting, document formatting |
| `depth-limiter` | 30 | Depth 2 nesting, per-depth timeouts, aggressive cleanup |
| `result-cache` | 26 | TTL-aware cache, hit rate, merge + dedup |
| `priority-scheduler` | 18 | High/normal/low priority, cooperative preemption |
| `adaptive-admission` | 22 | Telemetry-driven throttling, capacity recovery |
| `session-cleanup` | 12 | Bloat stripping, stale purge, cleanup pipeline |
| `subagent-tracker` | 25 | Lifecycle tracking, stale detection, spawn capacity |
| `telemetry-logic` | 10 | Health aggregation, status thresholds |
| `sessions-io` | 10 | File I/O for sessions.json (injectable path) |
| **`media-batcher`** | 22 | Gap 1: outbound sendMediaGroup batching (90% API call reduction) |
| **`document-send-policy`** | 26 | Gap 2: load-aware timeout, exponential retry, chunk fallback |
| **`subagent-progress-tracker`** | 28 | Gap 3: heartbeat progress tracking, stuck detection |

---

## The Three Gaps: The Application Layer

The concurrency infrastructure (work queues, adaptive admission, per-topic isolation, crash recovery) is the foundation. Three gaps sit on top — the outbound and observability layers the foundation doesn't cover. Each is pure logic with tests — the contract the plugin team wires against.

### Gap 1: Outbound `sendMediaGroup` (media batching)

**The problem:** None of the 11 plugins touch the message tool's outbound path. When the agent sends 10 documents in one turn, that's 10 separate `sendDocument` gateway round-trips — 10 chances to hit the 30s timeout under load.

**The solution:** Telegram's `sendMediaGroup` sends 2–10 items to one chat in a single API call. The `media-batcher.ts` module groups sends by chat, chunks into ≤10, and collapses them. 10 docs to one chat → 1 round-trip (**90% API call reduction**). `shouldBatch()` is the hook's quick gate.

### Gap 2: Configurable `timeoutMs` (document send policy)

**The problem:** On Sunday, a 232KB synthesis file's `sendDocument` hit the gateway's default 30s timeout while 5 subagents were completing. The retry hit the same contention and failed. Root cause: gateway websocket contention under concurrent load, with a timeout calibrated for text, not documents.

**The solution:** The `document-send-policy.ts` module computes the right timeout for each send. The Sunday scenario: 90s base + 5×15s load headroom = **165s** (was 30s). Plus exponential retry (30s → 60s → 120s) and chunk fallback after a first timeout. The gateway client already supports a per-request `timeoutMs` override — the message tool just never passed one.

**Note:** Applying the policy requires an OC source mod (the gateway dispatcher doesn't read `timeoutMs` from the tool call payload yet). The pure logic is the contract; the source mod is deferred Phase C work. See [`docs/postmortem-sunday-senddocument-timeout.md`](./docs/postmortem-sunday-senddocument-timeout.md).

### Gap 3: Subagent progress events (heartbeat tracking)

**The problem:** The `oc-subagent-watchdog` detects terminal failures (crash, timeout). But a subagent running for 2 minutes could be on track (50% done) or stuck (hung on a bad web search). Without intermediate progress, the orchestrator can't tell until the run timeout fires.

**The solution:** The `subagent-progress-tracker.ts` module records heartbeat signals (`{pct, ts}`) and categorizes tasks as `onTrack`, `staleHeartbeat`, or `noHeartbeat`-past-grace. A grace period prevents false positives on fresh subagents. `computeProgressRate` catches the subtle case: a subagent that's heartbeating but stuck at the same pct (stalled in a retry loop) — flaggable before the heartbeat goes stale.

See [`docs/plugin-gaps.md`](./docs/plugin-gaps.md) for the full gap analysis, DFT mapping, and wiring instructions for the plugin team.

---

## Efficiency Testing: The Hypothetico-Axiomatic Method

We arrived at this vertex having proven *correctness* — 89% coverage, hooks fire via `api.on()`, 11/11 DFT-valid. The question shifts from "does it work?" to "does it work efficiently?" We do not guess what might be slow; we derive testable claims as logical consequences of the axioms we already accept.

### The axioms are preconditions for measurement

The six DFT axioms are not just code-quality rules — they are the *preconditions* that make efficiency measurable:

| Axiom | Measurement capability it enables |
|-------|-----------------------------------|
| **A1** pure-io-separation | I/O cost is isolable from logic cost — measure one without the other |
| **A2** determinism | Runtime guarantees are structural (by construction), not statistical |
| **A3** manifest-conformance | Every declared hook is in the dispatch path — no phantoms |
| **A4** dft-docs | The testability contract is explicit in the source |
| **A5** mock-doubles | Efficiency tests measure real behavior, not mock overhead |
| **A6** check-result | The report returned by the function *is* the proof |

### Six hypotheses derived, by axiomatic strength

| Hypothesis | Derived from | Tier | Tests | Status |
|-----------|--------------|------|-------|--------|
| **H5**: Bloat stripping reduces bytes >90% | A1+A2+A6 | Deterministic | 5 | ✅ Implemented |
| **H6**: Stale purge removes exactly past-timeout | A2+A6 | Deterministic | 6 | ✅ Implemented |
| **H3**: Semaphore never exceeds `maxConcurrent` | A1+A2 | Runtime-det | 5 | ✅ Implemented |
| **H4**: Sub-pool doesn't starve main pool | A1+A2 | Runtime-det | 3 | ✅ Implemented |
| **H1**: Sync I/O blocks, async doesn't | A1 | Statistical | 3 | ✅ Implemented |
| **H2**: `JSON.stringify` scan costs more than `statSync` | A1 | Statistical | 4 | ✅ Implemented |
| **H7**: Dispatch with 0 handlers is <0.1ms | A5 | Statistical | — | ⏳ Not yet implemented (needs E2E `createHookRunner`) |

### What the axioms forbid (the CI/production boundary)

- **A2 forbids** `Date.now()` in logic → wall-clock claims (834ms P99) belong in production, not CI. CI proves the *mechanism*; production proves the *outcome*.
- **A1 forbids** I/O in logic → we test byte reduction (the mechanism), not disk speed (the environment).
- **A5 forbids** `vi.fn()` mocks → we measure real behavior, not mock overhead.

### Two anti-patterns the axioms expose

1. **Sync I/O on the main event loop** — `sessions-io.ts` uses `readFileSync`/`writeFileSync` in hooks. H1 proves it blocks. Fix: migrate to `fs/promises` (derived from A1).

2. **`JSON.stringify` in the bloat scan hot path** — `oc-compaction-helper` serializes every bloat field just to count bytes. H2 proves it's expensive. Fix: replace with one `statSync` (derived from A1).

See [`docs/efficiency-testing.md`](./docs/efficiency-testing.md) for the full derivation: axioms → propositions → hypotheses → tests → fixes.

---

## OC Core Issues (What Plugins Can't Fix)

These require OC core changes (the source mod test bed or upstream PRs):

1. **Bloat field re-injection**: OC re-adds `systemPromptReport`, `skillsSnapshot`, `compactionCheckpoints` into every model call. Our plugins strip them after compaction, but OC adds them back on the next turn. ~15,000 tokens/turn we can't prevent at the plugin level.

2. **Per-call `timeoutMs` not applied**: The gateway client supports a per-request `timeoutMs` override, but the tool-call dispatcher doesn't read it from the payload. Gap 2's policy computes the right timeout; applying it requires an OC source mod (deferred).

3. **Synchronous compaction**: Compaction runs on the main thread (200-500ms block). Our hooks fire before/after but can't make compaction itself asynchronous. `worker_threads` would allow this.

4. **JSON serialization overhead**: OC uses `JSON.stringify`/`parse` for session state. V8's `v8.serialize`/`v8.deserialize` is faster. Worker threads with `MessagePort` would eliminate serialization entirely.

5. **Single-thread contention**: All serialization, parsing, skill resolution, and channel polling compete on one thread. `worker_threads` + `SharedArrayBuffer` + `Atomics` would allow real parallelism.

6. **No graceful drain on restart**: SIGUSR1 hot-reload kills all WebSocket connections. Active subagents are destroyed mid-task.

---

## Plugin Foundry

The foundry (`ts/src/foundry/`) produces and tests DFT-compliant plugins. It codifies the six phosphene DFT axioms into templates and a validator.

```bash
cd ts
npx tsx src/foundry/cli.ts new oc-my-plugin --hooks agent_end,session_end --tools my_health
npx tsx src/foundry/cli.ts validate src/plugins/oc-my-plugin  # ✓ all six DFT axioms pass
npx tsx src/foundry/cli.ts test src/plugins/oc-my-plugin
```

**Round-trip proof**: `scaffoldPlugin → validatePlugin → zero errors`. The scaffold template generates `api.on()` calls (not `api.registerHook()`) by construction.

See [`docs/plugin-foundry.md`](./docs/plugin-foundry.md) for the six axioms and validator internals.

---

## Plugin Build & Distribution

Each plugin builds to a **self-contained `dist/index.js`** — a single ES module with all `shared/` logic bundled in, node builtins external. This is the artifact OC installs. No jiti source-transform overhead, no cross-plugin dependencies, no network calls during install.

### Why bundling (and not npm packages or suite install)

10 of 11 plugins import pure logic from `../../shared/*.js`. When OC installs a plugin individually via `openclaw plugins install`, it copies **only the plugin directory** — `shared/` is not included. Three options were evaluated (full analysis in [`docs/ship-review.md`](./docs/ship-review.md)):

| Option | Works for directory install? | Lasts? |
|--------|-----------------------------|--------|
| **A: Bundle with esbuild** ✅ | ✅ Self-contained `dist/index.js` | ✅ Standard OC pattern |
| B: Publish `shared/` as npm package | ❌ OC doesn't run `npm install` for directory installs (`install-package.ts:280`) | ❌ Dead for local install |
| C: Suite install via `plugins.load.paths` | ⚠️ Dev stopgap only | ❌ Not a distribution model |

**Option A was chosen** because it works for all install methods (directory, archive, `plugins.load.paths`), requires no network dependency or npm publishing, and follows the standard OC plugin pattern (the install error message itself suggests `["./dist/index.js"]`).

### The build

`scripts/build-plugins.mjs` uses esbuild to bundle each plugin's `src/index.ts` + all `shared/` imports into `dist/index.js`. Node builtins (`node:fs`, `node:perf_hooks`, etc.) are external; everything else is inlined and tree-shaken.

```bash
# Build all 11 plugins (~70ms)
cd ts && npm run build:plugins

# Each plugin gets a self-contained bundle:
#   src/plugins/oc-session-guard/dist/index.js   (8KB, shared/ inlined)
#   src/plugins/oc-subagent-orchestrator/dist/index.js  (40KB, 12 shared/ modules inlined)
```

### The smoke test

`tests/spec/plugin-bundle.spec.ts` (34 tests) loads each `dist/index.js` and verifies it exports a valid `PluginDefinition` with `id` + `register` matching the manifest. This catches the entire class of packaging bugs (missing `shared/`, broken exports, mismatched ids) that source-only testing misses.

### Installing plugins

```bash
# Build first (produces dist/index.js in each plugin dir)
cd ts && npm run build:plugins

# Install any plugin individually — it's self-contained
openclaw plugins install ./ts/src/plugins/oc-session-guard
openclaw plugins install ./ts/src/plugins/oc-subagent-watchdog
openclaw plugins install ./ts/src/plugins/oc-event-loop-monitor

# Or load from source via config (development)
# In OC config: plugins.load.paths: ["./ts/src/plugins"]
```

Each plugin's `package.json` declares `openclaw.extensions: ["./dist/index.js"]` and `main: "./dist/index.js"` — both point to the bundled entry point.

### Design principles (the phosphene axiomatics)

- **Pure logic / I/O separation** — all scheduling, admission, and cleanup logic is pure. I/O is in thin plugin wrappers.
- **`api.on()` for typed lifecycle hooks** — `api.registerHook()` doesn't fire. `api.on()` does.
- **Protocol interfaces first** — I/O behind Protocols. Production and test implementations share one contract.
- **Mock doubles, not mocks** — real in-process implementations, not patch-over mocks.
- **Determinism as a first-class concern** — injected clocks, no `Date.now()`/`Math.random()` in logic.
- **CheckResult pattern** — decisions carry their own proof.
- **No inline regex** — all patterns in the regex library, tested in isolation.

---

## Local Verification

```bash
# Build all plugins (esbuild bundle, ~70ms)
cd ts && npm run build:plugins

# TypeScript unit + integration (CI config, no Docker)
cd ts && npx vitest run --config vitest.config.ci.ts

# TypeScript with coverage
cd ts && npx vitest run --config vitest.config.ci.ts --coverage

# Full TypeScript suite including Testcontainers E2E (needs Docker)
cd ts && npx vitest run

# Typecheck (what CI runs)
cd ts && npm run typecheck

# Plugin bundle smoke test (verify each dist/index.js loads + exports)
cd ts && npx vitest run tests/spec/plugin-bundle.spec.ts

# Foundry: scaffold + validate + test
cd ts
npx tsx src/foundry/cli.ts new oc-demo-plugin --hooks agent_end
npx tsx src/foundry/cli.ts validate src/plugins/oc-demo-plugin
npx tsx src/foundry/cli.ts test src/plugins/oc-demo-plugin

# OC source mod Level 1 (applies patch, imports patched createHookRunner)
cd ts && npx vitest run tests/oc-source/hook-trace.spec.ts

# OC source mod Level 2 E2E (real running gateway, needs Docker)
cd ts && npx vitest run tests/oc-source/e2e-gateway-trace.spec.ts

# Python unit + integration
uv run pytest tests/ -v

# Full CI pipeline via Docker Compose
docker compose -f docker/docker-compose.test.yml up --build --abort-on-container-exit
```

---

## Docker

One image. Volume mounts for code. No multi-stage.

**Image:** `docker/Dockerfile` — node:22-bookworm-slim with OC + tsx baked in.

**Three consumers, same image:**

| Consumer | How | What it runs |
|----------|-----|-------------|
| CI Docker Integration | `docker compose -f docker/docker-compose.test.yml up` | tsc + vitest in container |
| CI E2E Integration | testcontainers `fromDockerfile().build()` | e2e + oc-source tests |
| Local dev | `docker compose up` | same as CI |

**CI pipeline (4 layers):**

1. Python Unit — pytest, no Docker
2. TypeScript Unit — 1,125 vitest tests (CI config), no Docker
3. Docker Integration — builds image, runs tsc + vitest inside container
4. E2E Integration — testcontainers, runs e2e + oc-source tests
5. Staging — main branch only

See `docker/README.md` for build/run/debug instructions.

---

## Repository Details

- **GitHub Repository**: [FlowFeel/openclaw-test-harness](https://github.com/FlowFeel/openclaw-test-harness) (Public)
- **Target OpenClaw Version**: `2026.6.8`
- **License**: MIT
- **Node.js**: v22 (CI) / v24+ (local dev)

---

## Documentation Index

### Architecture docs (`docs/`)

| Document | Description |
|----------|-------------|
| [`docs/plugin-foundry.md`](./docs/plugin-foundry.md) | The foundry: scaffold, validate, test. Six DFT axioms, round-trip proof, pure seams vs thin I/O |
| [`docs/oc-source-mod-testbed.md`](./docs/oc-source-mod-testbed.md) | OC source mod test bed: patch 0001, Level 1 + Level 2 E2E, the dual API split (`on()` vs `registerHook()`) |
| [`docs/efficiency-testing.md`](./docs/efficiency-testing.md) | Efficiency testing: an axiomatic derivation — 7 hypotheses from the 6 DFT axioms, 3 testability tiers, 2 anti-patterns |
| [`docs/postmortem-sunday-senddocument-timeout.md`](./docs/postmortem-sunday-senddocument-timeout.md) | Postmortem: Sunday gateway websocket timeout on sendDocument — diagnosis, the document send policy, wiring instructions |
| [`docs/plugin-gaps.md`](./docs/plugin-gaps.md) | The three gaps: outbound sendMediaGroup batching (Gap 1), configurable timeoutMs policy (Gap 2), subagent progress heartbeats (Gap 3) |
| [`docs/ship-review.md`](./docs/ship-review.md) | Ship readiness review: all five packaging risks (B1/B2/H1/M1/M2) fixed, the Option A/B/C bundling decision, build + smoke test, install instructions |
| [`docs/topic-worker-pool.md`](./docs/topic-worker-pool.md) | oc-topic-worker-pool: semaphore admission control for concurrent Telegram topic sessions |
| [`docs/SESSION-HANDOFF.md`](./docs/SESSION-HANDOFF.md) | Dense literate snapshot of working state — restores context after compaction |
| [`docs/WAR-STORY.md`](./docs/WAR-STORY.md) | War story: patching OC's event loop from 834ms P99 to worker threads |

### Component docs

| Document | Description |
|----------|-------------|
| [`ts/src/plugins/README.md`](./ts/src/plugins/README.md) | All 11 plugins: hooks, tools, test counts, design principles |
| [`oc-source/README.md`](./oc-source/README.md) | OC source mod test bed: submodule structure, patch listing |
| [`ts/patches/README.md`](./ts/patches/README.md) | OC patches: child-admission, worker-pool, sqlite-accessor |

### Project history & tickets

| Document | Description |
|----------|-------------|
| [`POST_MORTEM.md`](./POST_MORTEM.md) | Retrospective: event loop saturation, bloat fields, plugin-only mitigation |
| [`ISSUES.md`](./ISSUES.md) | Tickets #1-#17: initial plugin suite, pure logic, session cleanup |
| [`PROJECT_SUBAGENT_EFFICIENCY.md`](./PROJECT_SUBAGENT_EFFICIENCY.md) | Tickets #18-#25: subagent dispatch, depth limits, adaptive admission |
| [`PROJECT_OC_EFFICIENCY.md`](./PROJECT_OC_EFFICIENCY.md) | Tickets #26-#33: context cache, stream relay, compaction helper, model router |
| [`PROJECT_NEXT_IMPROVEMENTS.md`](./PROJECT_NEXT_IMPROVEMENTS.md) | Tickets #34-#42: foundry, OC source mod test bed, E2E verification, worker pool |
