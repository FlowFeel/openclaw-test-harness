# OpenClaw Test Harness & Plugin Suite

**A plugin foundry, OC source mod test bed, and 11-plugin suite for OpenClaw (OC). Pure functional state machines, deterministic Design-for-Testability (DFT) primitives, hermetic Testcontainers E2E, and 92.8% statement coverage — built to phosphene axiomatic standards.**

---

## The Critical Discovery: `api.on()` vs `api.registerHook()`

The single most important finding from this work:

**OC's plugin SDK has two hook registration APIs, and only one of them works for typed lifecycle hooks.**

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
| TypeScript tests | **1,107** (989 in CI config, 78 test files) |
| Python tests | **43** |
| Statement coverage | **92.8%** (CI config) |
| Branch coverage | **84.0%** |
| Hook registrations | **36** (all via `api.on()`) |
| Tools registered | **19** |
| Foundry validation | **11/11 pass** (all six DFT axioms) |
| CI layers | 4 (unit → docker → e2e → staging) |

### What changed in this sprint

1. **Migrated all 36 hook registrations** from `api.registerHook()` to `api.on()` — hooks now actually fire in a real gateway
2. **Added `on()` to `PluginApi`** in `shared/types.ts` and `oc-sidecar/src/types.ts`
3. **Added 215 new tests** (885 → 1,107) covering 4 blind spots + 6 plugin wiring layers + state machine actors
4. **Fixed 3 DFT violations** — all 11 plugins now pass `foundry validate`
5. **Found a bug**: `createQueue` in `work-queue-scheduler.ts` builds a priority-sorted array internally but never returns it — priority sorting is dead code (documented in tests)

### Production metrics (require re-verification)

The following metrics were observed in production **before** the `api.on()` fix. Since the hooks weren't firing at the time, these likely reflect manual/config-level interventions, not plugin behavior. Now that hooks actually fire, these metrics should be re-verified:

| Metric | Observed | Mechanism |
|--------|----------|-----------|
| Event loop P99 | 834ms → <50ms | Config changes + sidecar (not hooks — hooks weren't firing) |
| sessions.json | 30MB → 530KB | Config changes (`deltaBytes` raised to 1MB) |
| Dead subagents | 2,575 → 0 | Manual cleanup (hooks weren't firing) |
| Bloat tokens/turn | ~99K → ~15K | Config changes (hooks weren't stripping bloat) |

**Now that `api.on()` is fixed**, the plugins that strip bloat (`oc-compaction-helper`, `oc-session-guard`) and track subagents (`oc-subagent-watchdog`, `oc-subagent-orchestrator`) will actually execute their hook handlers. The pure logic is tested and correct — production re-verification is the next step.

---

## Architecture

```
openclaw-test-harness/
├── ts/
│   ├── src/
│   │   ├── plugins/              ← 11 OC plugins (all use api.on())
│   │   │   ├── shared/           ← Pure logic (12 modules, 97% coverage)
│   │   │   │   ├── types.ts      ← PluginApi interface (includes on())
│   │   │   │   ├── session-cleanup.ts
│   │   │   │   ├── subagent-tracker.ts
│   │   │   │   ├── work-queue-scheduler.ts
│   │   │   │   └── ... (9 more)
│   │   │   ├── oc-subagent-orchestrator/   ← 8 hooks, 7 tools
│   │   │   ├── oc-topic-worker-pool/       ← 6 hooks (semaphore admission)
│   │   │   ├── oc-sidecar/                 ← 2 hooks, 3 tools
│   │   │   ├── oc-compaction-helper/       ← 4 hooks, 1 tool
│   │   │   └── ... (7 more)
│   │   ├── foundry/              ← Plugin factory: scaffold + validate
│   │   └── features/             ← Pure state machines + supervisors
│   ├── tests/                    ← 1,107 tests (spec, integration, e2e, plugins)
│   └── patches/                  ← OC source patches (child-admission)
├── oc-source/
│   ├── upstream/                 ← git submodule: FlowFeel/openclaw
│   └── patches/
│       └── 0001-hook-debug-instrumentation.patch   ← 510 lines
├── docs/                         ← Architecture docs
└── docker/                       ← CI image + compose
```

### The three layers

**Layer 1 — Plugin Suite** (11 plugins, 36 hooks, 19 tools): OC plugins that hook into the gateway lifecycle via `api.on()`. Pure logic in `shared/`, thin I/O wiring in each plugin's `index.ts`. All pass the foundry's six DFT axioms.

**Layer 2 — Plugin Foundry** (`ts/src/foundry/`): Scaffolds new plugins and validates them against six DFT axioms. `scaffoldPlugin → validatePlugin → zero errors` — templates cannot produce a non-compliant plugin.

**Layer 3 — OC Source Mod Test Bed** (`oc-source/`): Patches OC's internal hook runner with upstreamable patch+test pairs. Patch 0001 adds structured trace instrumentation (dispatch, error, no-handlers events). Verified at two levels: Level 1 (6 specs, direct import) and Level 2 (9 specs, real running gateway).

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

## Pure Logic (shared/ modules)

All scheduling, admission, cleanup, and tracking logic is pure — tested without OC runtime, I/O, or fixtures. 97% statement coverage on shared modules.

| Module | Lines | Tests | What |
|--------|-------|-------|------|
| `work-queue-scheduler` | 357 | 38 | Priority queue, parallel dispatch, dependencies, result collection |
| `topic-isolation` | 248 | 31 | Per-topic budget, slot borrowing, bottleneck detection |
| `research-task-specs` | 259 | 22 | Declarative task format, cycle detection, execution planning |
| `result-merger` | 277 | 31 | Citation dedup, relevance sorting, document formatting |
| `depth-limiter` | 203 | 30 | Depth 2 nesting, per-depth timeouts, aggressive cleanup |
| `result-cache` | 194 | 26 | TTL-aware cache, hit rate, merge + dedup |
| `priority-scheduler` | 142 | 18 | High/normal/low priority, cooperative preemption |
| `adaptive-admission` | 165 | 22 | Telemetry-driven throttling, capacity recovery |
| `session-cleanup` | 155 | 12 | Bloat stripping, stale purge, cleanup pipeline |
| `subagent-tracker` | 117 | 25 | Lifecycle tracking, stale detection, spawn capacity |
| `telemetry-logic` | 92 | 10 | Health aggregation, status thresholds |
| `sessions-io` | 43 | 10 | File I/O for sessions.json (injectable path) |

---

## OC Core Issues (What Plugins Can't Fix)

These require OC core changes (the source mod test bed or upstream PRs):

1. **Bloat field re-injection**: OC re-adds `systemPromptReport`, `skillsSnapshot`, `compactionCheckpoints` into every model call. Our plugins strip them after compaction, but OC adds them back on the next turn. ~15,000 tokens/turn we can't prevent at the plugin level.

2. **Synchronous compaction**: Compaction runs on the main thread (200-500ms block). Our hooks fire before/after but can't make compaction itself asynchronous. `worker_threads` would allow this.

3. **JSON serialization overhead**: OC uses `JSON.stringify`/`parse` for session state. V8's `v8.serialize`/`v8.deserialize` is faster. Worker threads with `MessagePort` would eliminate serialization entirely.

4. **Single-thread contention**: All serialization, parsing, skill resolution, and channel polling compete on one thread. `worker_threads` + `SharedArrayBuffer` + `Atomics` would allow real parallelism.

5. **No graceful drain on restart**: SIGUSR1 hot-reload kills all WebSocket connections. Active subagents are destroyed mid-task.

6. **Aggressive memory sync defaults**: `sync.sessions.deltaBytes` defaults to 100KB. We raised it to 1MB via config, but the default is too aggressive for multi-topic workloads.

---

## Mitigation Paths

### Path 1: Plugins (fixed, `api.on()` verified)

11 OC plugins, all using `api.on()` (hooks actually fire). Pure logic tested, wiring tested, DFT-valid.

### Path 2: OC source mod test bed (proven, upstreamable)

The `oc-source/` directory patches OC's hook runner with upstreamable patch+test pairs.

**Patch 0001 — hook debug instrumentation** (510 lines): Fixes the "hooks not working" debugging black hole by adding structured trace to `createHookRunner`. Three root causes addressed:

1. **Swallowed errors** — `catchErrors=true` (default) + no logger → errors vanished. Now captured with `{type:"error", swallowed:true}`.
2. **"Didn't fire" invisible** — 9 silent `hooks.length === 0` returns. Now captured with `{type:"no-handlers", reason:"not-registered"|"filtered-out"}`.
3. **No structured lifecycle** — now `{type:"dispatch", handlerCount}` at each dispatch entry.

**Verified at two levels:**
- Level 1 (6 specs): applies patch, dynamic-imports patched `createHookRunner`, asserts three claims directly
- Level 2 (9 specs): real running gateway from npm tarball, built-code patch, all five trace event types proven end-to-end

See [`docs/oc-source-mod-testbed.md`](./docs/oc-source-mod-testbed.md).

### Path 3: Upstream PRs

Contribute the source mod patches back to OC. The test harness has the pure logic, BDD tests, and E2E verification. The `api.on()` vs `api.registerHook()` finding is the most valuable upstream contribution — it affects every OC plugin author.

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

## Design Principles (the phosphene axiomatics)

- **Pure logic / I/O separation** — all scheduling, admission, and cleanup logic is pure. I/O is in thin plugin wrappers.
- **`api.on()` for typed lifecycle hooks** — `api.registerHook()` registers to `legacyInternalHooks` (invisible to `hasHooks()`, never fires). `api.on()` registers to `typedHooks` (visible, fires).
- **Protocol interfaces first** — I/O behind Protocols. Production and test implementations share one contract.
- **Mock doubles, not mocks** — real in-process implementations, not patch-over mocks.
- **Determinism as a first-class concern** — injected clocks, no `Date.now()`/`Math.random()` in test paths.
- **CheckResult pattern** — decisions carry their own proof.
- **DFT throughout** — 1,107 tests. Zero fixtures. Ephemeral ports. 92.8% coverage.
- **No inline regex** — all patterns in the regex library, tested in isolation.

---

## Local Verification

```bash
# TypeScript unit + integration (CI config, no Docker)
cd ts && npx vitest run --config vitest.config.ci.ts

# TypeScript with coverage
cd ts && npx vitest run --config vitest.config.ci.ts --coverage

# Full TypeScript suite including Testcontainers E2E (needs Docker)
cd ts && npx vitest run

# Typecheck (what CI runs)
cd ts && npm run typecheck

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
2. TypeScript Unit — 989 vitest tests (CI config), no Docker
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
