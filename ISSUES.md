# OC Modification Tickets

Issues to create on FlowFeel/openclaw-test-harness:

## #1: Replace sessions.json with SQLite-backed registry
- **Problem**: JSON blob (was 30MB, now 318KB) parsed/serialized on every session access. P99 hit 834ms.
- **Solution**: SQLite-backed registry. Already built: SessionRegistry (Python), session-query.py CLI, heartbeat sync.
- **Modify**: Patch OC's session-accessor.ts to read from SQLite instead of JSON.
- **Tests**: 30 Python tests, SQLite store parity tests.
- **Status**: ✅ Python side live. OC patch remaining.

## #2: Move context compaction off the main event loop
- **Problem**: Compaction runs synchronously on main loop. 10MB transcript = 200-500ms CPU block.
- **Solution**: Worker thread via Piscina pool. Already built: WorkerPool Protocol, compact.context handler, MockWorkerPool, PiscinaWorkerPool, 89 TS tests.
- **Modify**: Patch OC compaction to call pool.execute() instead of inline.
- **Tests**: 13 worker pool tests, Docker integration in CI.
- **Status**: ✅ Pool built and tested. OC patch remaining.

## #3: Stop passing JSON between session operations — use structured data
- **Problem**: OC serializes to JSON strings, passes them, parses them. Double CPU cost.
- **Solution**: Structured-cloneable objects for worker IPC, SQLite queries for registry, Effect Schema for contracts.
- **Modify**: Session store reads SQLite, worker IPC uses postMessage objects, compaction receives objects.
- **Blocked by**: #1 and #2.

## #4: Implement adaptive spawning with self-reporting subagents
- **Problem**: Static guards (maxConcurrent, runTimeoutSeconds) are blunt. No self-reporting.
- **Solution**: Adaptive spawning based on real-time health. Subagents self-report to SQLite. Stale detection (yielding, not killing). XState v5 machine.
- **Already built**: 25 tests, adaptive logic, machine, schemas.
- **Modify**: Patch child-admission.ts, add progress contract, replace timed_out+kill with stale→yield→checkpoint.
- **Blocked by**: #1 (SQLite registry).

## #5: Move session serialization off the main event loop
- **Problem**: JSON.stringify on 1M context every turn. O(n) synchronous CPU.
- **Solution**: Worker pool. serialize.session handler already built and tested.
- **Blocked by**: #2 (worker pool).

## #6: Parallelize topic fan-out via worker pool
- **Problem**: 6 topics = 6 sequential JSON.stringify on main thread.
- **Solution**: Promise.all with worker pool — all in parallel.
- **Blocked by**: #2 (worker pool).
