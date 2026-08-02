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
- **Solution**: `PiscinaWorkerPool` serializes its handler registry into a CJS worker file via `Function.prototype.toString` — the #11 seam — so the worker thread runs the exact same handler logic as the inline path. `execute()` posts `{ handler, input }` to Piscina (`pool.run`), which dispatches on a real worker thread. The registry is constructor-injected (defaults to the `handlers.ts` builtins; the conformance spec passes the patch's `handlers` object so the Piscina worker runs the patch's code verbatim — one registry, two surfaces). `register()` bakes a handler into the worker file at init time, so it must precede the first `execute()` (a post-init register throws honestly — the pre-#12 register silently stored handlers in a Map that execute() never read). `minThreads === maxThreads` pins the thread count (no idle teardown, stable `poolSize`). `drain()` polls `activeTasks` to zero without closing (Protocol: drain = wait, destroy = terminate). The pre-worker fast path for unregistered handlers uses the SAME `'Unknown handler: <name>'` message as the worker's `dispatch` throw, so the pool-level and worker-level paths share one error identity (the #11 no-drift principle).
- **Acceptance**: (1) ✅ a thread-identity probe (`require('node:worker_threads').threadId`, serialized via `toString`) returns `threadId ≥ 1` (main is 0) — deterministic proof of off-main-thread execution, not "it's fast"; (2) ✅ constructed with the patch's `handlers`, `PiscinaWorkerPool.execute` returns deep-equal results to the patch's inline `dispatch` for all 7 built-in handlers, and the unknown-handler error identity matches; (3) ✅ `MockWorkerPool` passes its spec suite unchanged (the existing `tests/spec/worker-pool.spec.ts` is untouched and green).
- **Status**: ✅ Completed & Verified (`ts/tests/integration/piscina-pool.spec.ts`, 18 specs across 3 invariants: off-main-thread, registry conformance, Protocol compliance).

## Phase B — Thread resilience & fairness (multi-topic resource sharing)

## #13: Worker crash isolation & respawn (fix dead-slot degradation)
- **Problem**: `patches/worker-pool.js` registered **only `worker.on('message', …)`** — there was no `'error'` and no `'exit'` listener (confirmed by grep). If a worker thread crashed/exited, nothing fired; the in-flight task's callback never ran and only the 10s task timeout rejected. `cleanup()` then set `free.busy = false` but the **dead** `worker` object stayed in `workers[]`; the next `execute()` re-selected that slot (`find(w => !w.busy)`), `postMessage`d into a dead worker, and hit the 10s timeout again — permanently wasting one pool slot until the host process restarted. The #10 fault-injection suite tested handler errors, not worker **death**.
- **Solution**: Per-worker `'error'`/`'exit'` listeners (`createSlot()` in `worker-pool.js`) that (a) reject the in-flight task immediately via the slot's `current` state (no 10s wait), (b) mark the slot `dead` and splice it from the rotation, and (c) spawn a replacement to hold `MAX_THREADS`. A `dead` flag makes `die()` idempotent (`'error'` and `'exit'` can both fire for one death). `execute()`'s `finish()` is the single settle path for message/watchdog outcomes and is a no-op on a dead slot, so message, watchdog, and death never double-settle the same task. `stats()` now exposes `deadWorkers`.
- **Acceptance**: (1) ✅ a terminated mid-task worker rejects the in-flight task with `Worker thread terminated` (the exit path), not `timed out` (the watchdog), far below 10s; (2) ✅ the next task succeeds on a respawned worker; (3) ✅ `stats()` reports the death (`deadWorkers`) and recovery (`poolSize` invariant); (4) ✅ no slot is permanently lost across N killings — `poolSize` is invariant.
- **Status**: ✅ Completed & Verified (`ts/tests/integration/worker-crash-isolation.spec.ts`, 6 specs across 4 invariants; existing fault-injection/registry/worker-pool specs unchanged).

## #14: Per-topic fairness & backpressure in the worker pool
- **Problem**: `getPool()` is a module-level singleton (`let pool = null`) — one global pool shared by every topic and every agent. `execute()` grabs the first free worker (`find(w => !w.busy)`); there is no per-topic queue, no fairness, no priority. A single topic's burst (e.g. 6-way `fanout.topics` + serial `serialize.session`) can consume every worker and starve sibling topics' latency-sensitive stream-ingestion work.
- **Solution**: A `FairPool` class (`ts/src/features/worker-pool/fair-pool.ts`) implementing the `WorkerPool` Protocol, wrapping an inner pool (Mock for tests, Piscina for prod) and adding per-topic fairness. The pure scheduling seam lives in `fair-scheduler.ts`: `pickNextTopic(nonEmpty, cursor)` (round-robin — advance past the cursor, wrap cyclically, restart at head if the cursor drained) and `evaluateBackpressure(depth, threshold)` (strict `>` → `BackpressureResult { apply, queueDepth, threshold }`). `FairPool.executeForTopic(topic, handler, input)` enters a per-topic queue; `pump()` dispatches while `inFlight < maxConcurrent`, picking the next topic via the pure scheduler — so FairPool is the scheduling bottleneck and the dispatch ORDER is the deterministic fairness guarantee. `backpressure(topic)` returns the pure `BackpressureResult` the admission layer reads to admit/reject (per-topic; one flood does not pressure a sibling). No-topic `execute(handler, input)` goes straight to the inner pool (backward compatible; Protocol unchanged). `drain()` waits for queued + in-flight; `destroy()` rejects pending queued tasks with "pool destroyed".
- **Acceptance**: (1) ✅ Flood test: under maxConcurrent=1 with A flooding 5 tasks + B submitting 1, the completion order is `[A0, B0, A1, A2, A3, A4]` — B at index 1, not 5 (round-robin interleaves, proven by deep-equal on ordered tags, not "P99 ≤ 2×" wall-clock); alternation (`A,B,A,B,...`) and drained-topic-skipping also asserted; (2) ✅ backpressure flips `apply=true` when a topic's queue depth exceeds the threshold (strict `>`), per-topic (A floods, B stays `apply=false`); (3) ✅ FairPool implements `WorkerPool` — register/execute/stats/drain/destroy delegate/overlay correctly; the existing `worker-pool.spec.ts` is untouched and green, and the FairPool Protocol-compliance block mirrors its contract (execute, error-as-ok-false, stats overlay, drain, destroy).
- **Status**: ✅ Completed & Verified (`ts/tests/spec/fair-scheduler.spec.ts`, 11 pure-logic specs + `ts/tests/integration/fair-pool.spec.ts`, 14 integration specs across fairness / backpressure / Protocol compliance).

## Phase C — Kill the god process (multiagent process isolation)

## #15: SubagentSupervisor Protocol — bind the state machine to real process lifecycle
- **Problem**: `SubagentActor` (`subagent-admission.machine.ts`) is self-described as _"a lightweight, zero-dependency actor-like wrapper"_ holding only a `currentState` string. The lifecycle states `dispatched → running → yielding → completed` are **purely logical** — nothing binds them to a real process or thread. `child-admission.ts` admits a spawn but spawns/supervises nothing. So the whole multiagent system runs inside the single OC god process; a crash of one agent's work takes down the event loop for all topics, and the state machine cannot observe real exits.
- **Solution**: A `SubagentSupervisor` Protocol (`ts/src/features/supervision/supervisor.schema.ts`) that owns real lifecycle: `spawn()` → a supervised child (worker_thread or child_process), `signal()` → lifecycle events bound to the state machine (`dispatch`/`start`/`finish`/`error`/`timeout`), `restart()` with exponential backoff, `reap()` on terminal. The existing `transitionSubagent` / `TRANSITIONS` table stays pure; the supervisor *applies* it to real process events. The shared lifecycle spine lives in `BaseSupervisor` (`base-supervisor.ts`) — actor map, event listeners, injected `Clock` (#7), `RestartPolicy`, counters, and the `apply()`/`require()`/`mapEvent()`/`emit()`/`snapshot()` helpers — with `doSpawn`/`doTerminate` as the only seams. Three implementations: `MockSupervisor` (in-process, deterministic, no-op seams), `WorkerSupervisor` (worker_threads — `doSpawn` wires `'online'`→start, `'message'{ok:true}`→finish, `'error'`/non-zero `'exit'`→error; `doTerminate` detaches listeners + `worker.terminate()`), `ProcessSupervisor` (child_process — `doSpawn` wires `'spawn'`→start, `'exit'` 0→finish, non-zero/`'error'`→error; `doTerminate` detaches + `SIGKILL`). Listeners detach BEFORE terminating so a reap/restart cannot re-enter `apply()` via the dying resource's terminal event.
- **Acceptance**: (1) ✅ `MockSupervisor` drives `created → dispatched → running → completed` against `transitionSubagent` and emits matching events (`supervisor.spec.ts`, 9 specs — unchanged after the BaseSupervisor extraction); (2) ✅ `restart()` asserts `retryCount` increments on the snapshot (Mock + Worker + Process); (3) ✅ the Protocol is the only thing the state machine depends on (no I/O import in `*.machine.ts`); (4) ✅ `WorkerSupervisor` binds REAL worker_threads — threadId ≥ 1, event sequence `[spawned, started, completed]`/`[spawned, started, failed]` from real `'online'`/`'message'`/`'error'` events, restart produces a DIFFERENT threadId (`worker-supervisor.spec.ts`, 9 specs); (5) ✅ `ProcessSupervisor` binds REAL child_process — pid ≥ 1, event sequence from real `'spawn'`/`'exit'` events, restart produces a different pid (`process-supervisor.spec.ts`, 9 specs).
- **Status**: ✅ Completed & Verified (Protocol + `BaseSupervisor` + Mock/Worker/Process impls + 27 specs: 9 Mock unit + 9 Worker integration + 9 Process integration).

## #16: Per-topic actor isolation (main process becomes a thin router)
- **Problem**: Every active Telegram topic shares the one OC process and the one global pool (#14). Topic fan-out (`fanout.topics`) and per-turn serialization (`serialize.session`) all compete on the same event loop; a pathological topic (runaway subagent, huge transcript compaction) degrades every other topic. There is no isolation boundary between topics.
- **Solution**: A `TopicRouter` class (`ts/src/features/topic-router/topic-router.ts`) that `extends BaseSupervisor` (#15's lifecycle spine) and adds an RPC layer. Each topic runs as an ISOLATED supervised actor — a dedicated long-lived worker_thread (the actor entry is a constructor-injected source string, mirroring #12/#15). `dispatch(topic, request)` routes to the topic's actor (lazy-spawn; terminal → restart/self-heal; live → route), awaits the reply. The pure seam (`topic-router-logic.ts`): `selectActorForTopic` (route-vs-spawn), `aggregateTopicStats` (per-topic attribution), `crashContainment` (after a crash, which topics still serve). `doSpawn` wires `'online'`→start, `'message'`→RPC-reply-routing-by-id (NOT one-shot `finish` — the actor is long-lived), `'error'`/non-zero `'exit'`→error+reject-in-flight. `doTerminate` detaches listeners + rejects pending + `terminate()`. Crash containment: a crash of topic A rejects A's in-flight dispatch (via the exit listener) but B's worker is a SEPARATE thread — B continues serving. The main process is a thin router: `dispatch` → owning topic actor → reply.
- **Acceptance**: (1) ✅ Crash containment: after topic A crashes (dispatch `{crash:true}` → `process.exit(1)`), dispatch to B SUCCEEDS with the exact echoed value (B's worker is a separate thread — proven by deep-equal, not "B is fast"; bounded-latency <2000ms is a secondary sanity guard); A's in-flight dispatch REJECTS with a crash identity ("crashed"/"exited"); `crashContainment("A")` returns `{ crashed: "A", serving: ["B"] }`; dispatch to A after crash self-heals (restart → fresh actor, new threadId, retryCount+1); (2) ✅ per-topic attribution: `topicStats()` returns per-topic `{ topic, state, retryCount, active }` — after A crashes, A is `failed`/inactive, B is `running`/active (crash attributed to A only); (3) ✅ the router composes #14's per-topic model — per-topic isolation lets admission see each topic independently (per-topic stats + `crashContainment` are the per-topic signals).
- **Status**: ✅ Completed & Verified (`ts/tests/spec/topic-router-logic.spec.ts`, 10 pure-logic specs + `ts/tests/integration/topic-router.spec.ts`, 13 integration specs across isolation / crash-containment / attribution / lifecycle).

## #17: Live process telemetry feeding admission
- **Problem**: `evaluateAdaptiveSpawn` consumes a `SystemHealth` snapshot (`eventLoopP99Ms`, `eventLoopUtilization`, `cpuCoreRatio`, `activeSubagents`), but in tests those values were hardcoded — nothing populated them from real processes. `assertV8HeapStability` (#9) exists only as a test assertion, not as a live signal. So adaptive admission is exercised against synthetic health, never real telemetry.
- **Solution**: A `ProcessTelemetry` seam (`ts/src/features/telemetry/`). The pure aggregation (`telemetry-logic.ts`: `aggregateSystemHealth(readings, active, stale) → SystemHealth`) takes the MAX across actors for eventLoopP99/utilization/cpuRatio (worst-actor pressure — a single saturated actor throttles, not masked by averaging) and the SUM for usedHeapSize (additive — each actor's heap is real memory); counts pass through verbatim. The I/O wiring (`telemetry-collector.ts`: `TelemetryCollector`) reads REAL signals — `perf_hooks.monitorEventLoopDelay` (percentile(99) → p99 ms), `performance.eventLoopUtilization()` (0–1), `v8.getHeapStatistics().used_heap_size` (#9's approach), `process.cpuUsage` (delta-style cpuRatio) — and feeds them through the pure aggregation into the `SystemHealth` the admission layer (`evaluateAdaptiveSpawn`) reads. `collect(actorId)` is per-actor attributable. The histogram is enabled on construct, disabled on `stop()` (no leaked perf hooks).
- **Acceptance**: (1) ✅ Under a 50ms busy loop, a `setTimeout(0)` is deterministically ~50ms late — the histogram records the delay, so p99 > 0; with `eventLoopP99Threshold=0` and activeSubagents ≥ softLimit, `evaluateAdaptiveSpawn` rejects with a reason containing the REAL p99 value (populated from real `monitorEventLoopDelay`, not a fixture); the decision's `healthSnapshot` === the aggregated real health (carries real readings); `usedHeapSize > 0` on every reading (the process always has a heap); (2) ✅ per-actor attribution: `collect(actorId)` carries the actorId into the aggregation — different actorIds produce attributable readings; (3) ✅ the existing adaptive spec suite (`tests/spec/adaptive.spec.ts`, 26 specs) passes unchanged — it uses injected (mock) `SystemHealth`; the collector is a NEW source of real `SystemHealth`, not a change to the pure admission logic.
- **Status**: ✅ Completed & Verified (`ts/tests/spec/telemetry-logic.spec.ts`, 8 pure specs + `ts/tests/integration/telemetry.spec.ts`, 5 integration specs: real readings, per-actor attribution, real-telemetry-feeds-admission).
