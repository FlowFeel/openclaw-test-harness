# OpenClaw Test Harness & Patch Suite

**A discipline-first test pyramid and patch harness for OpenClaw (OC) modifications. Pure functional state machines, worker-thread offloading, hermetic Testcontainers E2E, and deterministic Design-for-Testability (DFT) primitives — built to phosphene axiomatic standards.**

---

## Why This Exists

OpenClaw runs on a single-threaded V8 event loop. All session serialization, context compaction, JSON parsing, and topic fan-out happen on one thread. Under heavy load with multiple active Telegram topics and subagent burst cascades, the event loop saturated:

- **P99 Event Loop Delay**: Spiked to **834ms** (peaks to 2,168ms).
- **Loop Utilization**: 73% of the single thread blocked.
- **`sessions.json` Bloat**: 30MB, 2,777 entries (2,500+ dead subagent records).
- **Stream Ingestion Stalls**: Incoming response chunks starved while V8 was locked in synchronous `JSON.stringify`.

This repo provides the **engineering discipline** around modifying OC. We don't fork OC — we ship minimal, tested patches against the compiled bundle, verified by a zero-regression, 4-layer CI test pipeline (unit → BDD integration → Docker Compose → Testcontainers E2E) before touching production.

---

## The Three Eras of the Harness

The work organizes into three sequential eras, each with its own focus and acceptance bar.

### Era 1 — Event-Loop Optimization (tickets #1–#6)

Systematically tackled every synchronous-CPU bottleneck on the main thread.

1. **Pure Functional State Machines** — Replaced XState v5 with zero-dependency `TRANSITIONS` dictionaries + `reduceAdaptiveContext` reducers. Pure functions accept immutable snapshots, compute in 0.08s, zero side-effects.
2. **Postinstall `patch-package` Infrastructure** — Patches applied directly to `node_modules/openclaw` on `npm install`, surviving gateway hot-reloads (`SIGUSR1`) and container reboots permanently.
3. **SQLite Session Registry (`better-sqlite3`)** — Indexed, C++ native `sqlite-accessor.ts` replaced 30MB `sessions.json` parsing. Microsecond lookups vs 100–500ms JSON freezes. **97% size reduction** (30MB → 914KB).
4. **Adaptive Spawning & SQLite Integration** — `child-admission.ts` dynamically queries the SQLite registry (`countActiveSessions`, `getTimedOut`) to block spawns when timed-out subagents exist.
5. **Offloaded Session Serialization** — `serialize.session` worker handler moves per-turn `JSON.stringify` off the main thread.
6. **In-Memory IPC + Parallel Topic Fan-out** — `ipc.transfer` (V8 Structured Clone, zero JSON encoding) and `fanout.topics` (concurrent multi-topic formatting) in the worker pool.

### Era 2 — Design-for-Testability (DFT) Hardening (tickets #7–#10)

A targeted pass eliminating the four classes of test flakiness flagged in the harness architectural review. Every addition is hermetic and deterministic.

7. **Deterministic Clock & ID Providers** — `SystemClock`, `DeterministicTestClock`, `SequenceGenerator` (`ts/src/core/test-context.ts`) replace direct `Date.now()` / `Math.random()`. Injectable `nowMs` wired into `TestStore.getTimedOut()` and `fanout.topics`; the `worker-pool.js` task IDs use a monotonic counter. Same inputs → byte-identical outputs across parallel suites.
8. **OpenRouter Mock Sidecar (wired into the OC container)** — `OpenRouterMockServer` serves fixed OpenAI-compatible JSON on an **ephemeral port** (no hardcoded `8080`/`9999` race). Self-starts as a long-lived container entrypoint (`node --experimental-strip-types`, zero `node_modules`). `startPatchedOpenClaw({ withSidecar: true })` starts it on a shared testcontainers `Network`, attaches the OC container (alias `openclaw`) with `OPENCLAW_OPENROUTER_BASE_URL` set, and exposes `executeModelCall` — an in-container `fetch` driving the full **admit spawn → LLM-call** flow 100% offline. (Reuse disabled on this path: testcontainers `reuseContainer` does not re-connect networks.)
9. **Programmatic V8 Heap Invariants** — `captureV8Snapshot()` / `assertV8HeapStability()` (`ts/src/core/v8-assert.ts`) assert bounded `used_heap_size` growth in-process. Hidden leaks fail CI without manual `--trace-gc`.
10. **Worker Fault Injection & Recovery** — `fault-injection.spec.ts` injects handler crashes, unknown-handler lookups, and worker-thread errors against both `MockWorkerPool` and the real `worker-pool.js` patch (CJS-loaded via `load-cjs.ts`). Asserts transparent recovery and `TestStore` integrity under `ERR_WORKER_OUT_OF_MEMORY`.

### Era 3 — Threading & Process Isolation (tickets #11–#17, in progress on `feat/multiagent-process-isolation`)

Eliminating the two remaining structural anti-patterns in the multiagent/multitopic path: the **worker god function** and the **god process**.

11. **Handler-Module Registry** ✅ — Killed the worker god function. Handler logic lives once in a `handlers` registry; the worker body is generic dispatch with the registry serialized in via `Function.prototype.toString`; the inline fallback calls the same `dispatch()`. Zero duplication — fixed drift where the inline path was missing `json.parse` (silently returned null) and `measure.size` diverged. Proven by `worker-pool-registry.spec.ts` (worker execute === inline dispatch for every handler).
12. **Real Piscina Integration** 📋 — `piscina-pool.ts` currently admits "run inline"; will point Piscina's `filename` at the #11 registry worker entry so prod actually uses threads (prod ≠ spec today).
13. **Worker Crash Isolation & Respawn** 📋 — Only `on('message')` today; a crashed worker stays in the rotation and wastes its slot until the 10s timeout. Per-worker `error`/`exit` listeners → immediate reject + slot removal + respawn.
14. **Per-Topic Fairness & Backpressure** 📋 — `getPool()` is a module singleton; no per-topic queue/fairness. A `FairPool` Protocol with per-topic queues + a backpressure signal feeding admission.
15. **SubagentSupervisor Protocol** 🟡 — Binds the pure `transitionSubagent` table to real process lifecycle. `SubagentActor` was "a lightweight actor-like wrapper" holding only a state string. Scaffolded: `SubagentSupervisor` Protocol + `MockSupervisor` (in-process, deterministic, delegates all transitions to the pure table, backoff from the injected Clock) + 9 specs. `WorkerSupervisor`/`ProcessSupervisor` to follow.
16. **Per-Topic Actor Isolation** 📋 — Each active topic runs as an isolated supervised actor; the main process becomes a thin router. A topic crash is contained; siblings unaffected. Builds on #15.
17. **Live Process Telemetry → Admission** 📋 — `ProcessTelemetry` Protocol populates `SystemHealth` from real `monitorEventLoopDelay` / `captureV8Snapshot` readings; admission reacts to real pressure, not fixtures.

See [`ISSUES.md`](./ISSUES.md) for the full ticket spec with file:line evidence, and [`docs/WAR-STORY.md`](./docs/WAR-STORY.md) for the phase-by-phase narrative.

---

## Architectural Performance Metrics

| Metric | Before | After |
|--------|--------|-------|
| `sessions.json` size | 30MB | 914KB (97% reduction) |
| Registry entries | 2,777 | 263 active |
| Event loop P99 delay | 834ms | <50ms (estimated) |
| CPU utilization | 1.467 cores (saturated) | 0.6% (idle) |
| Global `maxConcurrent` | 2 (static) | 6 (with worker pool) |
| Automated tests | 0 | **197** (25 Python + 172 TS) |
| CI pipeline layers | 0 | 4 (unit → docker → staging → integration) |

---

## The Test Pyramid (197 Total Tests)

```
                     ┌───────────────────────────┐
                     │    Testcontainers E2E     │  17 E2E Specs (Docker-gated)
                     ├───────────────────────────┤
                     │   Docker Compose & BDD    │  49 Integration Specs
                     ├───────────────────────────┤
                     │  TypeScript Spec Unit     │  106 TS Unit Specs
                     ├───────────────────────────┤
                     │    Python Unit Tests      │  25 Pytest Specs
                     └───────────────────────────┘
```

1. **Python Unit Layer (`tests/unit/`)** — 25 pure logic tests in ~0.11s, zero fixtures.
2. **TypeScript Unit Layer (`ts/tests/spec/`)** — 106 specs: pure transition tables, context reducers, worker-pool protocols, deterministic clocks, V8 heap invariants, and the `SubagentSupervisor` Protocol.
3. **Integration Layer (`ts/tests/integration/`)** — 49 specs: SQLite accessors, BDD scenarios, `patch-package` validation, the OpenRouter mock sidecar, worker fault injection, and the handler-registry conformance suite.
4. **Testcontainers E2E Layer (`ts/tests/e2e/`)** — 17 containerized specs: patched-OC admission checks, the OpenRouter mock sidecar as a real long-lived container on a shared Docker network, and the sidecar **wired into the OC container** so a containerized agent drives a real offline chat-completion call (`admit spawn → model call`, 100% offline).

---

## System Architecture

```
┌─────────────────────────────────────────────┐
│ Main Event Loop (I/O only)                  │
│  ├─ Stream ingestion (model → agent)        │
│  ├─ HTTP transport (agent → channel)        │
│  ├─ Timer callbacks                         │
│  └─ IPC from worker threads / supervisor    │
│         │                                    │
│         ▼                                    │
│  Worker Thread Pool (CPU Count - 1)         │
│  ├─ json.stringify (offloaded)              │
│  ├─ compact.transcript (offloaded)          │
│  ├─ serialize.session (offloaded)           │
│  ├─ ipc.transfer (V8 structured clone)      │
│  ├─ fanout.topics (parallelized)            │
│  └─ [handler registry — single source]      │
└─────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│ SubagentSupervisor Protocol (Era 3, #15)    │
│  ├─ MockSupervisor (in-process, tests)      │
│  ├─ WorkerSupervisor (worker_threads) 📋    │
│  └─ ProcessSupervisor (child_process) 📋    │
└─────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│ SQLite Registry (indexed, fast)             │
│  ├─ better-sqlite3 accessor                 │
│  ├─ session-query.py CLI                    │
│  └─ Bloat fields stripped automatically     │
└─────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│ child-admission guards (live in bundle)     │
│  ├─ maxSpawnDepth (original)               │
│  ├─ maxConcurrent (our extension)           │
│  ├─ runTimeoutSeconds (our extension)       │
│  ├─ maxChildrenPerAgent (original)          │
│  └─ swarm total (original, collect mode)    │
└─────────────────────────────────────────────┘
```

---

## Design Principles (the phosphene axiomatics)

Every component follows the same discipline, applied uniformly across Python and TypeScript:

- **Protocol interfaces first** — I/O behind Protocols (`WorkerPool`, `SubagentSupervisor`, `SpawnAdmission`). Production and test implementations share one contract.
- **Pure logic** — evaluation functions take immutable snapshots, return result dataclasses, never throw, never call I/O. Unit tests run in 0.08s with zero fixtures.
- **Mock doubles, not mocks** — `MockWorkerPool`, `MockSupervisor`, `TestStore`, `OpenRouterMockServer` are real in-process implementations of the Protocol, not patch-over mocks.
- **Determinism as a first-class concern** — injectable `Clock`/`SequenceGenerator`; no `Date.now()`/`Math.random()` in test paths; ephemeral ports, never hardcoded.
- **CheckResult pattern** — `{ ok, cap, reason, evidence }` everywhere; decisions carry their own proof.

---

## Local Verification

```bash
# Python unit + integration (pure logic, SQLite, lifecycle)
uv run pytest tests/unit tests/integration -v

# TypeScript unit + integration (Vitest, no Docker needed)
cd ts && npx vitest run tests/spec tests/integration

# Full TypeScript suite including Testcontainers E2E (needs Docker)
cd ts && npx vitest run

# Full CI pipeline via Docker Compose
docker compose -f docker/docker-compose.test.yml up --build --abort-on-container-exit
```

---

## Repository Details

- **GitHub Repository**: [FlowFeel/openclaw-test-harness](https://github.com/FlowFeel/openclaw-test-harness) (Public)
- **Target OpenClaw Version**: `2026.6.8` (commit `f47542c5`)
- **License**: MIT
- **Target Production Host**: EC2 (Amazon Linux 2023, Node.js v22.22.2, 4 cores, 30GB RAM)
- **Active Branch**: `feat/multiagent-process-isolation` — Era 3 threading/process-isolation work (tickets #11–#17)
- **Documentation**: [`docs/WAR-STORY.md`](./docs/WAR-STORY.md) (phase-by-phase narrative) · [`ISSUES.md`](./ISSUES.md) (full ticket specs)
