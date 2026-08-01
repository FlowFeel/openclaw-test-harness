# OC Modification Tickets

Issues to create on FlowFeel/openclaw-test-harness:

## #1: Replace sessions.json with SQLite-backed registry
- **Problem**: JSON blob (was 30MB, now 318KB) parsed/serialized on every session access. P99 hit 834ms.
- **Solution**: SQLite-backed registry. Built with `better-sqlite3` and indexed queries in `sqlite-accessor.ts`.
- **Status**: ✅ Completed & Verified (94 TS + 53 Python tests).

## #2: Move context compaction off the main event loop
- **Problem**: Compaction runs synchronously on main loop. 10MB transcript = 200-500ms CPU block.
- **Solution**: Worker thread via Piscina pool. Built: WorkerPool Protocol, `compact.context` handler.
- **Status**: ✅ Completed & Verified (worker pool patch live).

## #3: Stop passing JSON between session operations — use structured data
- **Problem**: OC serializes to JSON strings, passes them, parses them. Double CPU cost.
- **Solution**: V8 Structured Clone algorithm implementation via `ipc.transfer` handler in `handlers.ts` and `worker-pool.js`.
- **Status**: ✅ Completed & Verified.

## #4: Implement adaptive spawning with self-reporting subagents
- **Problem**: Static guards (maxConcurrent, runTimeoutSeconds) are blunt. No self-reporting.
- **Solution**: Dynamic lookup integration in `child-admission.ts` querying SQLite database for active session counts and stale timeouts at microsecond speeds.
- **Status**: ✅ Completed & Verified.

## #5: Move session serialization off the main event loop
- **Problem**: JSON.stringify on 1M context every turn. O(n) synchronous CPU.
- **Solution**: Dedicated `serialize.session` worker pool handler in `worker-pool.js`.
- **Status**: ✅ Completed & Verified.

## #6: Parallelize topic fan-out via worker pool
- **Problem**: 6 topics = 6 sequential JSON.stringify on main thread.
- **Solution**: Dedicated `fanout.topics` handler in `worker-pool.js` running concurrent formatting across worker threads.
- **Status**: ✅ Completed & Verified.

## DFT Hardening (Design-for-Testability)

Follow-on pass eliminating the four flakiness classes flagged in the harness
architectural review (dynamic non-determinism, unmocked upstream, implicit port
bindings, missing fault injection).

## #7: Deterministic Clock & ID providers
- **Problem**: `Date.now()` / `Math.random()` used directly in test payloads and worker task IDs (`worker-pool.js`), causing timing races and ID collisions across parallel suites.
- **Solution**: `SystemClock`, `DeterministicTestClock`, `SequenceGenerator` in `ts/src/core/test-context.ts`; injectable `nowMs` wired into `TestStore.getTimedOut()` and the `fanout.topics` handler; monotonic counter replacing `Date.now() + Math.random()` for worker task IDs.
- **Status**: ✅ Completed & Verified (`ts/tests/spec/test-context.spec.ts`, 13 specs).

## #8: OpenRouter mock sidecar (offline E2E, wired into the OC container)
- **Problem**: Containerized E2E depended on a live upstream at `127.0.0.1:9999/v1` that nothing served — network flakiness and API-key dependence. The existing admission E2E only tested `resolveChildAdmission` and never drove a model call.
- **Solution**: `OpenRouterMockServer` in `ts/src/containers/openrouter-mock-sidecar.ts` — fixed OpenAI-compatible JSON on an ephemeral port (no hardcoded `8080`), with request capture. Self-starts as a long-lived container entrypoint (`--experimental-strip-types`, `0.0.0.0:9876`, zero `node_modules`) on a shared testcontainers `Network` with the `openrouter-mock` alias via `ts/tests/support/openrouter-sidecar.ts`. `startPatchedOpenClaw({ withSidecar: true })` (`ts/tests/support/openclaw-container.ts`) attaches the OC container to that network (alias `openclaw`), sets `OPENCLAW_OPENROUTER_BASE_URL`, and exposes `executeModelCall` — an in-container `fetch` (base64-argv body, not string-interpolated) that drives the full spawn → LLM-call flow 100% offline. Sidecar path disables reuse + sets autoRemove (testcontainers `reuseContainer` does not re-connect networks, so reuse would leave stale attachments).
- **Status**: ✅ Completed & Verified (5 in-process integration specs + 3 cross-container E2E specs + 4 wired-in OC-container E2E specs).

## #9: Programmatic V8 heap invariant assertions
- **Problem**: V8 memory claims relied on manual `--trace-gc` / `--trace-ic` flags; no in-CI leak detection.
- **Solution**: `captureV8Snapshot()` / `assertV8HeapStability()` in `ts/src/core/v8-assert.ts` assert bounded `used_heap_size` growth in-process.
- **Status**: ✅ Completed & Verified (`ts/tests/spec/v8-assert.spec.ts`, 5 specs).

## #10: Worker fault injection & recovery
- **Problem**: No mechanism to test behavior under worker-thread crashes, IPC disconnects, or handler errors.
- **Solution**: `ts/tests/integration/fault-injection.spec.ts` injects handler crashes, unknown-handler lookups, and worker errors against `MockWorkerPool` and the real `worker-pool.js` patch (CJS-loaded via `ts/tests/support/load-cjs.ts`); asserts transparent recovery and `TestStore` integrity.
- **Status**: ✅ Completed & Verified (8 specs).

---

# Phase 2: Threading & Process Isolation Roadmap

A phased path to eliminate the two remaining structural anti-patterns in the
multiagent/multitopic path: the **worker god function** (one string-eval'd
dispatch blob holding every handler, duplicated between worker body and inline
fallback) and the **god process** (one OC process + one global singleton pool
serving all topics and agents, with a purely logical state machine that owns no
real process lifecycle).

Design principles (carried from the phosphene axiomatics already in the repo):
Protocol interfaces first → pure logic → I/O behind the Protocol → immutable
snapshots → CheckResult. Every ticket below ships a Protocol + pure logic + a
Mock implementation + a test before any OC patch.

## Phase A — Kill the worker god function (threading internals)

## #11: Handler-module registry replaces the eval-blob dispatch
- **Problem**: `patches/worker-pool.js` built each worker via `new Worker(code, { eval: true })` where `code` was one giant `if (handler === 'json.stringify') … else if (handler === 'json.parse') …` string (worker body), and the **same** dispatch was duplicated again in the inline fallback. Two hand-maintained copies of every handler; the duplication had already drifted — the inline fallback was missing `json.parse` entirely (silently returned null), `measure.size` used `.reduce()` inline vs a `for`-loop in the worker, and unknown handlers rejected in the worker but resolved null inline.
- **Solution**: A single `handlers` registry map is the source of truth. `dispatch(handler, input)` does a generic `handlers[handler](input)` lookup (no handler-name literals). The worker body is generic scaffolding with the registry serialized in via `Function.prototype.toString` (`Object.entries(handlers).map(([n,fn]) => ...fn.toString())` + `dispatch.toString()`), so the worker runs the exact same handler logic as the inline path. The inline fallback calls `dispatch()` directly. Adding a handler = one entry in `handlers`. Exported `dispatch` + `handlers` for testability.
- **Acceptance**: (1) ✅ no handler logic appears twice — registry is the single location; (2) ✅ `dispatch.toString()` contains no handler-name literals, so adding a handler needs no dispatch edit; (3) ✅ `worker-pool-registry.spec.ts` asserts worker `execute` === inline `dispatch` for every built-in handler, plus conformance with `handlers.ts` for the 5 shared handlers.
- **Status**: ✅ Completed & Verified (`ts/tests/integration/worker-pool-registry.spec.ts`, 18 specs; existing fault-injection + worker-pool specs unchanged).

## #12: Real Piscina integration (production pool actually uses threads)
- **Problem**: `ts/src/features/worker-pool/piscina-pool.ts:105` admits: _"For now, run inline — real Piscina integration requires serializable handlers."_ `PiscinaWorkerPool.execute()` calls `fn(input)` on the main thread — it uses **no worker_threads**. So the production Protocol implementation is functionally identical to `MockWorkerPool`; prod ≠ spec, and the only real parallelism lives inside the #11 god-function patch. The Protocol abstraction is undermined because swapping implementations changes nothing about execution.
- **Solution**: Wire `PiscinaWorkerPool` to a real worker entry (the #11 registry module) via Piscina's `filename` + `{ handler, input }` task shape. Implement `drain()`/`destroy()` against the real Piscina lifecycle. Keep `MockWorkerPool` as the no-thread test double.
- **Acceptance**: (1) A thread-identity test asserts `PiscinaWorkerPool` work executes off the main thread (e.g. via `workerData` / a `tid` echo handler); (2) `PiscinaWorkerPool` and the patched `worker-pool.js` share the same handler registry; (3) `MockWorkerPool` still passes the existing spec suite unchanged.
- **Status**: 📋 Planned

## Phase B — Thread resilience & fairness (multi-topic resource sharing)

## #13: Worker crash isolation & respawn (fix dead-slot degradation)
- **Problem**: `patches/worker-pool.js` registers **only `worker.on('message', …)`** — there is no `'error'` and no `'exit'` listener (confirmed by grep). If a worker thread crashes/exits, nothing fires; the in-flight task's callback never runs and only the 10s task timeout rejects. `cleanup()` then sets `free.busy = false` but the **dead** `worker` object stays in `workers[]`; the next `execute()` re-selects that slot (`find(w => !w.busy)`), `postMessage`s into a dead worker, and hits the 10s timeout again — permanently wasting one pool slot until the host process restarts. The #10 fault-injection suite tests handler errors, not worker **death**.
- **Solution**: Per-worker `'error'`/`'exit'` listeners that (a) reject the in-flight task immediately (no 10s wait), (b) mark the slot dead and remove it from the rotation, and (c) spawn a replacement to hold the target thread count. Expose a `stats().deadWorkers` counter. Extend the #10 fault-injection suite with a worker-termination case.
- **Acceptance**: (1) A test terminates a worker mid-task; the in-flight task rejects within <500ms (not 10s); (2) the next task succeeds on a respawned worker; (3) `stats()` reports the death and recovery; (4) no slot is permanently lost across N killings.
- **Status**: 📋 Planned

## #14: Per-topic fairness & backpressure in the worker pool
- **Problem**: `getPool()` is a module-level singleton (`let pool = null`) — one global pool shared by every topic and every agent. `execute()` grabs the first free worker (`find(w => !w.busy)`); there is no per-topic queue, no fairness, no priority. A single topic's burst (e.g. 6-way `fanout.topics` + serial `serialize.session`) can consume every worker and starve sibling topics' latency-sensitive stream-ingestion work.
- **Solution**: A `FairPool` Protocol implementation with per-topic (or per-agent) request queues and a fair dispatcher (round-robin / deficit round-robin). When a topic's queued depth exceeds a threshold, emit a backpressure signal that the admission layer (#4/#8) reads to throttle that topic's spawns. Keep `MockWorkerPool` as the unfair fast path for unit tests.
- **Acceptance**: (1) A test with one topic flooding the pool shows a sibling topic's tasks still complete within a bounded latency (e.g. P99 ≤ 2× the uncontended time); (2) backpressure flips a topic's admission decision from admit to reject under flood; (3) the existing worker-pool spec suite passes against `FairPool` unchanged.
- **Status**: 📋 Planned

## Phase C — Kill the god process (multiagent process isolation)

## #15: SubagentSupervisor Protocol — bind the state machine to real process lifecycle
- **Problem**: `SubagentActor` (`subagent-admission.machine.ts`) is self-described as _"a lightweight, zero-dependency actor-like wrapper"_ holding only a `currentState` string. The lifecycle states `dispatched → running → yielding → completed` are **purely logical** — nothing binds them to a real process or thread. `child-admission.ts` admits a spawn but spawns/supervises nothing. So the whole multiagent system runs inside the single OC god process; a crash of one agent's work takes down the event loop for all topics, and the state machine cannot observe real exits.
- **Solution**: A `SubagentSupervisor` Protocol (`ts/src/features/supervision/supervisor.schema.ts`, scaffolded on this branch) that owns real lifecycle: `spawn()` → a supervised child (worker_thread or child_process), `monitor()` → lifecycle events bound to the state machine (`dispatch`/`start`/`finish`/`error`/`timeout`), `restart()` with exponential backoff, `reap()` on terminal. The existing `transitionSubagent` / `TRANSITIONS` table stays pure; the supervisor *applies* it to real process events. First implementation: `MockSupervisor` (in-process, deterministic, no real children) so the Protocol is testable today; `WorkerSupervisor` and an OC-patch `ProcessSupervisor` follow.
- **Acceptance**: (1) A `MockSupervisor` test drives `created → dispatched → running → completed` against `transitionSubagent` and asserts the supervisor emits the matching events; (2) a `restart()` test asserts backoff and that `retryCount` increments on the snapshot; (3) the Protocol is the only thing the state machine depends on (no I/O import in `*.machine.ts`).
- **Status**: 🟡 Scaffolded (Protocol + types + Mock spec on this branch); `WorkerSupervisor` implementation 📋 Planned

## #16: Per-topic actor isolation (main process becomes a thin router)
- **Problem**: Every active Telegram topic shares the one OC process and the one global pool (#14). Topic fan-out (`fanout.topics`) and per-turn serialization (`serialize.session`) all compete on the same event loop; a pathological topic (runaway subagent, huge transcript compaction) degrades every other topic. There is no isolation boundary between topics.
- **Solution**: Each active topic runs as an isolated supervised actor (a dedicated worker_thread, or a child process for hard isolation) with its own queue and a partitioned worker budget. The main process becomes a thin router/supervisor: dispatch inbound messages to the owning topic actor, collect results. A topic actor crash is contained — the supervisor restarts only that actor; siblings are unaffected. Builds on #15's Protocol.
- **Acceptance**: (1) A test crashes one topic actor and asserts sibling topics continue serving within a latency bound; (2) per-topic heap/CPU is attributable (the supervisor reports per-actor stats); (3) the admission layer sees per-topic backpressure independently (#14).
- **Status**: 📋 Planned (depends on #15)

## Phase D — Close the loop with live telemetry

## #17: Live process telemetry feeding admission
- **Problem**: `evaluateAdaptiveSpawn` consumes a `SystemHealth` snapshot (`eventLoopP99Ms`, `eventLoopUtilization`, `cpuCoreRatio`, `activeSubagents`), but in tests those values are hardcoded — nothing populates them from real processes. `assertV8HeapStability` (#9) exists only as a test assertion, not as a live signal. So adaptive admission is exercised against synthetic health, never real telemetry.
- **Solution**: A `ProcessTelemetry` Protocol that each supervisor actor (#15/#16) emits (event-loop P99 via `perf_hooks.monitorEventLoopDelay`, `used_heap_size` via #9's `captureV8Snapshot`, CPU ratio). The router/supervisor aggregates per-actor telemetry into the `SystemHealth` the admission layer reads. Admission decisions now react to real pressure, not fixtures.
- **Acceptance**: (1) Under synthetic load, a test asserts admission rejects with `subagents.maxConcurrent`-equivalent health reasons populated from real `monitorEventLoopDelay` / heap readings; (2) telemetry is per-actor attributable; (3) the existing adaptive spec suite still passes with injected (mock) telemetry unchanged.
- **Status**: 📋 Planned (depends on #15, #16)
