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
