# OpenClaw Test Harness & Patch Suite

**A test pyramid and patch harness for OpenClaw modifications — containerized Testcontainers, pure functional state machines, SQLite session registries, and worker thread offloading built to phosphene axiomatic standards.**

---

## Why This Exists

OpenClaw (OC) runs on a single-threaded V8 event loop. All session serialization, context compaction, JSON parsing, and topic fan-out happen on one thread. Under heavy load with multiple active Telegram topics and subagent burst cascades, the event loop saturated:

- **P99 Event Loop Delay**: Spiked to **834ms** (with peaks up to 2,168ms).
- **Loop Utilization**: Blocked 73% of the single thread.
- **`sessions.json` Bloat**: Grew to 30MB with 2,777 entries (over 2,500 dead subagent records).
- **Stream Ingestion Stalls**: Incoming response chunks were starved while V8 was locked in synchronous `JSON.stringify`.

This repository provides the **engineering discipline and test pyramid** around modifying OpenClaw. We maintain a zero-regression, 4-layer CI test pipeline (unit, BDD integration, Docker Compose, and Testcontainers E2E) to verify that every patch is rock-solid before touching production.

---

## Core Innovations: What We Built & Why

We systematically tackled every bottleneck on the event loop, completing all 6 architectural tickets in `ISSUES.md`.

### 1. Pure Functional State Machines (Design for Testability)
*   **What**: Replaced XState v5 with pure, zero-dependency transition dictionaries (`TRANSITIONS`) and context reducers (`reduceAdaptiveContext`).
*   **Why**: Stateful framework actors make unit testing difficult and introduce external dependency bloat. Pure functions accept immutable state snapshots, compute decisions in **0.08 seconds**, and operate with zero side-effects.

### 2. Postinstall `patch-package` Infrastructure (Path B)
*   **What**: Integrated `patch-package` into the `postinstall` lifecycle hook of `package.json`.
*   **Why**: Previously, internal gateway hot-reloads (`SIGUSR1`) re-read cached package files, reverting in-memory patches. By applying patches directly to `node_modules/openclaw` during `npm install`, Node resolves the modified files on disk, ensuring patches survive container reboots and hot-reloads permanently.

### 3. SQLite Session Registry (`better-sqlite3`)
*   **What**: Replaced the synchronous 30MB `sessions.json` file parsing with an indexed, C++ native SQLite database (`sqlite-accessor.ts`).
*   **Why**: Parsing and stringifying a 30MB JSON file on every turn froze the event loop for 100–500ms. Indexed SQL lookups (`sessionKey`, `spawnedBy`, `status`) execute in **microseconds**, reducing registry overhead by **97%** (from 30MB to 914KB).

### 4. Adaptive Spawning & SQLite Registry Integration
*   **What**: Enhanced `child-admission.ts` with dynamic fallback queries (`countActiveSessions`, `getTimedOut`) to `sqlite-accessor.js`.
*   **Why**: Static concurrency caps failed when rogue subagents hung. The admission patch automatically queries the SQLite database to count active sessions and block spawns if timed-out subagents exist, forcing yielding/cleanup before accepting new subagents.

### 5. Offloaded Session Serialization (`serialize.session`)
*   **What**: Created dedicated worker handlers in `worker-pool.js` to execute `JSON.stringify` on large session states across a pool of `worker_threads`.
*   **Why**: Large context serialization is O(n) CPU work. Relocating `JSON.stringify` off the main thread keeps the V8 event loop free for network I/O and stream ingestion.

### 6. In-Memory IPC Refactoring (Zero JSON Stringification)
*   **What**: Implemented `ipc.transfer` using V8's native **Structured Clone algorithm** in worker thread communication.
*   **Why**: Passing JSON strings between the main thread and worker threads incurred double CPU costs (stringify then parse). V8 Structured Cloning transfers complex JS objects in memory with **zero JSON encoding overhead**.

### 7. Parallelized Topic Fan-out (`fanout.topics`)
*   **What**: Created a parallelized multi-topic formatting handler (`fanout.topics`) in the worker pool.
*   **Why**: Distributing messages to multiple Telegram topics previously required sequential `JSON.stringify` loops on the main thread. Worker threads now format topic payloads concurrently in parallel.

### 8. Testcontainers with Docker Socket Mounting
*   **What**: Automated real-container E2E tests using Testcontainers, mounting `/var/run/docker.sock` to orchestrate sibling containers inside Docker-in-Docker environments.
*   **Why**: Avoids flaky static ports and ensures containerized OpenClaw instances are built, patched, and verified against SHA-cached images with automatic Ryuk garbage collection.

---

## Design-for-Testability (DFT) Hardening

A targeted pass eliminating the four classes of test flakiness identified in the harness architectural review. Each addition is hermetic and deterministic.

### 9. Deterministic Clock & ID Providers
*   **What**: `SystemClock`, `DeterministicTestClock`, and `SequenceGenerator` (`ts/src/core/test-context.ts`) replace direct `Date.now()` / `Math.random()` calls. `TestStore.getTimedOut()` and the `fanout.topics` handler now accept an injectable `nowMs`; the `worker-pool.js` patch's task IDs use a monotonic counter instead of `Date.now() + Math.random()`.
*   **Why**: Removes timing races and ID collisions across parallel test suites — the same inputs now yield byte-identical outputs.

### 10. OpenRouter Mock Sidecar (wired into the OC container)
*   **What**: `OpenRouterMockServer` (`ts/src/containers/openrouter-mock-sidecar.ts`) serves fixed OpenAI-compatible chat-completion JSON on an **ephemeral port** (port 0) for in-process integration tests, and self-starts as a long-lived container entrypoint (`node --experimental-strip-types`, bound to `0.0.0.0:9876`, zero `node_modules`) for E2E. `startPatchedOpenClaw({ withSidecar: true })` (`ts/tests/support/openclaw-container.ts`) starts the sidecar on a shared testcontainers `Network`, attaches the OC container (alias `openclaw`) with `OPENCLAW_OPENROUTER_BASE_URL=http://openrouter-mock:9876/v1`, and exposes `executeModelCall` — an in-container `fetch` against the sidecar. The request body is base64-encoded as argv (not string-interpolated) to avoid quote-escaping fragility.
*   **Why**: The full containerized spawn → LLM-call flow now runs 100% offline — no live API keys, no external network, no hardcoded-port race (the `8080` / `9999` anti-pattern). The sidecar is the deterministic upstream the review calls for, exercised at three levels: in-process (integration), cross-container (E2E), and wired into the patched OC container (E2E).
*   **Reuse trade-off**: the sidecar path disables `withReuse()` and sets `withAutoRemove(true)` — testcontainers' `reuseContainer` only restarts a stopped container and does **not** re-connect networks, so a reused OC container would keep stale attachments from the previous run's (now-removed) network. The default (no-sidecar) path keeps its reuse optimization unchanged.
*   **Constraint**: The sidecar avoids TypeScript parameter properties (unsupported by `--experimental-strip-types` strip-only mode) so it loads in a bare `node:22-bookworm-slim` image with no build step.

### 11. Programmatic V8 Heap Invariants
*   **What**: `captureV8Snapshot()` and `assertV8HeapStability()` (`ts/src/core/v8-assert.ts`) assert bounded `used_heap_size` growth between snapshots, in-process.
*   **Why**: Catches hidden memory leaks in CI without manual `--trace-gc` inspection.

### 12. Worker Fault Injection & Recovery
*   **What**: `ts/tests/integration/fault-injection.spec.ts` injects handler crashes, unknown-handler lookups, and worker-thread errors against both the `MockWorkerPool` and the real `worker-pool.js` patch (loaded as CJS via `ts/tests/support/load-cjs.ts`).
*   **Why**: Verifies transparent recovery and that `TestStore` state remains uncorrupted under worker crashes, IPC errors, and `ERR_WORKER_OUT_OF_MEMORY`.

---

## Architectural Performance Metrics

| Metric | Before Optimization | After Optimization (v0.2.0) |
|--------|─────────────────────|────────────────────────────|
| `sessions.json` size | 30MB | 914KB (97% reduction) |
| Registry entries | 2,777 | 263 active entries |
| Event loop P99 delay | 834ms | <50ms (estimated) |
| CPU Utilization | 1.467 cores (saturated) | 0.6% (idle) |
| Global `maxConcurrent` | 2 (static) | 6 (with worker pool) |
| Automated Tests | 0 | 170 (25 Python + 145 TS) |
| CI Pipeline Layers | 0 | 4 (unit → docker → staging → integration) |

---

## The Test Pyramid (170 Total Tests)

```
                     ┌───────────────────────────┐
                     │    Testcontainers E2E     │  17 E2E Specs (Docker-gated)
                     ├───────────────────────────┤
                     │   Docker Compose & BDD    │  31 Integration Specs
                     ├───────────────────────────┤
                     │  TypeScript Spec Unit     │  97 TS Unit Specs
                     ├───────────────────────────┤
                     │    Python Unit Tests      │  25 Pytest Specs
                     └───────────────────────────┘
```

1. **Python Unit Layer (`tests/unit/`)**: 25 pure logic tests running in **0.11s** with zero fixtures.
2. **TypeScript Unit Layer (`ts/tests/spec/`)**: 97 specs testing pure transition tables, context reducers, worker pool protocols, deterministic clocks, and V8 heap invariants.
3. **Integration Layer (`ts/tests/integration/`)**: 31 specs testing SQLite accessors, BDD scenarios, `patch-package` validation, the OpenRouter mock sidecar, and worker fault injection.
4. **Testcontainers E2E Layer (`ts/tests/e2e/`)**: 17 containerized tests — patched OpenClaw admission checks, the OpenRouter mock sidecar served as a real long-lived container on a shared Docker network, and the sidecar **wired into the OC container** so a containerized agent drives a real offline chat-completion call (`admit spawn → model call` flow, 100% offline).

---

## System Architecture

```
┌─────────────────────────────────────────────┐
│ Main Event Loop (I/O only)                  │
│  ├─ Stream ingestion (model → agent)        │
│  ├─ HTTP transport (agent → channel)        │
│  ├─ Timer callbacks                         │
│  └─ IPC from worker threads                  │
│         │                                    │
│         ▼                                    │
│  Worker Thread Pool (CPU Count - 1)         │
│  ├─ json.stringify (offloaded)              │
│  ├─ compact.transcript (offloaded)          │
│  ├─ serialize.session (offloaded)           │
│  ├─ ipc.transfer (V8 structured clone)      │
│  └─ fanout.topics (parallelized)            │
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

## Local Verification Commands

To run the complete test suite locally:

```bash
# 1. Run Python Unit Tests
uv run pytest tests/unit/ -v

# 2. Run TypeScript Unit & Integration Tests in Docker Compose
docker compose -f docker/docker-compose.test.yml up --build --abort-on-container-exit
```

---

## Repository Details

- **GitHub Repository**: [FlowFeel/openclaw-test-harness](https://github.com/FlowFeel/openclaw-test-harness) (Public Repository)
- **Target OpenClaw Version**: `2026.6.8` (commit `f47542c5`)
- **License**: MIT License
- **Target Production Host**: EC2 Instance (Amazon Linux 2023, Node.js v22.22.2, 4 cores, 30GB RAM)
- **Documentation**: See [WAR-STORY.md](file:///Users/edphillips/projects/new/openclaw-test-harness/docs/WAR-STORY.md) for full phase-by-phase timeline details.
