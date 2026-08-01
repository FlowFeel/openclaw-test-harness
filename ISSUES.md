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
