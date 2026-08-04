# OpenClaw Test Harness & Plugin Suite

**A discipline-first test pyramid, plugin system, and diagnostic harness for OpenClaw (OC) modifications. Pure functional state machines, worker-thread offloading design, hermetic Testcontainers E2E, and deterministic Design-for-Testability (DFT) primitives — built to phosphene axiomatic standards.**

---

## Why This Exists

OpenClaw runs on a single-threaded V8 event loop. This is a design choice, not a platform limitation. Node.js and V8 have offered multi-threading affordances for years — `worker_threads`, `SharedArrayBuffer`, `Atomics`, `MessagePort`, `v8.serialize`, `AsyncLocalStorage`, `perf_hooks` — but OC hasn't adopted them. All session serialization, context compaction, JSON parsing, and topic fan-out happen on one thread.

**The problem we found (July 2026):**

Under heavy load with multiple active Telegram topics and subagent burst cascades, the single thread saturated:

- **P99 Event Loop Delay**: 834ms (peaks to 2,168ms)
- **Loop Utilization**: 73% of the single thread blocked
- **sessions.json Bloat**: 30MB, 2,777 entries (2,575 dead subagent records)
- **~99,000 tokens per turn wasted** on bloat fields (`systemPromptReport`, `skillsSnapshot`, `compactionCheckpoints`, `contextBudgetStatus`, `usageFamilySessionIds`, `lastHeartbeatText`) loaded into model context
- **Synchronous compaction**: 200-500ms main-loop blocks per compaction cycle
- **Manual subagent dispatch**: dropped 2 of 8 tasks (no automation, human error)

---

## Current State (August 2026)

After 25 tickets across 3 sprints — plugin-only, no OC core files modified:

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Event loop P99 | 834ms | <50ms | 17x |
| sessions.json | 30MB | 530KB | 99% |
| Dead subagents | 2,575 | 0 | eliminated |
| Bloat tokens/turn | ~99,000 | ~15,000 | ~84,000 saved |
| Dispatch reliability | 75% (2/8 dropped) | 100% | auto-dispatch |
| Subagent timeout failures | 3/8 at 5m | 0/9 at 10m | eliminated |
| Tests | 0 | 789 (746 TS + 43 Python) | full CI |
| CPU | 1.47 cores | 4.5% | 32x |
| CI layers | 0 | 4 (unit → docker → staging → integration) | gates all commits |

---

## OC Core Issues (What Plugins Can't Fix)

These are the remaining token bloat and response efficiency problems that require OC core changes:

1. **Bloat field re-injection**: OC re-adds `systemPromptReport`, `skillsSnapshot`, `compactionCheckpoints` into every model call. Our plugins strip them after compaction, but OC adds them back on the next turn. That's ~15,000 tokens per turn we can't prevent at the plugin level.

2. **Synchronous compaction**: Compaction runs on the main thread (200-500ms block). During that block, no model calls process, no streams ingest. Our hooks fire before/after but can't make the compaction itself asynchronous. Node.js `worker_threads` would allow this.

3. **JSON serialization overhead**: OC uses `JSON.stringify`/`parse` for session state. V8's native `v8.serialize`/`v8.deserialize` is faster and handles more types, but OC doesn't use it. Worker threads with `MessagePort` would eliminate serialization between threads entirely (structured clone transfer).

4. **Single-thread contention**: All serialization, parsing, skill resolution, and channel polling compete on the same thread. `worker_threads` (stable since Node 12) with `SharedArrayBuffer` + `Atomics` would allow real parallelism. Three CPU cores sit idle.

5. **No graceful drain on restart**: SIGUSR1 hot-reload kills all WebSocket connections. Active subagents are destroyed mid-task. OC should drain active work before reloading.

6. **Aggressive memory sync defaults**: `sync.sessions.deltaBytes` defaults to 100KB — OC reindexes session files on tiny transcript growth. We raised it to 1MB via config, but the default is too aggressive for multi-topic workloads.

---

## Mitigation Paths

### Path 1: Plugins (proven, stable, current)

5 OC plugins installed and live:

| Plugin | Tools | Hooks | Purpose |
|--------|-------|-------|---------|
| oc-subagent-orchestrator | 7 | 8 | Work queue dispatch, depth limits, adaptive admission, stale watchdog, crash recovery, heartbeat summary, memory integration |
| oc-sidecar | 2 | 2 | Worker pool process for CPU offloading |
| oc-compaction-helper | 1 | 2 | Pre/post compaction bloat stripping |
| oc-context-cache | 1 | 3 | System prompt + tool definition caching |
| oc-stream-relay | 1 | 3 | Model stream relay design |

**What this saves:** ~84,000 tokens/turn, 17x event loop improvement, 99% session I/O reduction.

### Path 2: Light fork (proposed, 5 files)

Fork OC, change 5 files in TypeScript, build from source. The test harness CI gates everything:

1. **Async compaction** — move compaction to `worker_threads`, eliminate 200-500ms blocks
2. **Bloat field GC** — stop re-injecting bloat fields every turn, save ~15,000 tokens/turn
3. **Graceful drain** — finish active subagents before SIGUSR1 reload
4. **Memory sync defaults** — raise `deltaBytes` to 1MB, `deltaMessages` to 500
5. **Worker thread offloading** — use `worker_threads` for serialization, skill parsing, channel polling

**What this adds:** ~15,000 more tokens/turn saved, 3 idle cores activated, no more response stalls.

### Path 3: Upstream PRs

Contribute the light fork changes back to OC as PRs. The test harness already has the pure logic, BDD tests, and production-sim E2E verification. Benefits all OC users.

---

## V8 Multi-Threading Affordances OC Could Use

| Affordance | Available Since | What It Enables |
|-----------|----------------|-----------------|
| `worker_threads` | Node 12 (stable) | Separate V8 isolates with own event loops, ES module native |
| `SharedArrayBuffer` + `Atomics` | Node 8 (stable) | Wait-free shared memory between threads |
| `MessagePort` | Node 12 | Structured clone transfer — no serialization needed |
| `v8.serialize` | Node 12 | Binary serialization, faster than JSON for large objects |
| `AsyncLocalStorage` | Node 16 | Per-session context propagation without blocking |
| `perf_hooks.monitorEventLoopDelay` | Node 8 | Real-time loop monitoring for adaptive behavior |
| `BroadcastChannel` | Node 15 | Pub/sub between workers for inter-topic communication |

OC uses none of these. Our plugins use `perf_hooks` and `worker_threads` (in the sidecar), but can't inject them into OC's core operations.

---

## What We Built

### Pure Logic (shared/ modules, 789 tests)

| Module | Tests | What |
|--------|-------|------|
| work-queue-scheduler | 27 | Priority queue, parallel dispatch, dependencies, result collection |
| depth-limiter | 29 | Depth 2 nesting, per-depth timeouts, aggressive cleanup |
| adaptive-admission | 22 | Telemetry-driven throttling, capacity recovery |
| result-merger | 30 | Citation dedup, relevance sorting, document formatting |
| priority-scheduler | 18 | High/normal/low priority, cooperative preemption |
| research-task-specs | 22 | Declarative task format, cycle detection, execution planning |
| topic-isolation | 31 | Per-topic budget, slot borrowing, bottleneck detection |
| result-cache | 26 | TTL-aware cache, hit rate, merge + dedup |
| regex-library | 48 | 10 named patterns, zero inline regex anywhere |
| session-cleanup | 12 | Bloat stripping, stale purge, cleanup pipeline |
| telemetry-logic | 8 | Health aggregation, status thresholds |
| subagent-tracker | 7 | Lifecycle tracking, stale detection, spawn capacity |

### Plugins (5 live, 18 hooks, 12 tools)

- `oc-subagent-orchestrator` — the one plugin that manages subagents
- `oc-sidecar` — worker pool process
- `oc-compaction-helper` — compaction hooks + bloat stripping
- `oc-context-cache` — prompt caching
- `oc-stream-relay` — stream relay design
- `oc-model-router` — model fallback chain (built, not yet installed)

### TaskFlow Integration

- Sprint manifests persisted to `drafts/platform/`
- 25/25 tickets complete across 3 sprints
- Auto-dispatch via `spawnInstructions` (no manual model intervention)
- Stale watchdog + crash recovery (self-healing queue)

---

## Design Principles (the phosphene axiomatics)

Every component follows the same discipline:

- **Pure logic / I/O separation** — all scheduling, admission, and cleanup logic is pure (tested without OC runtime). I/O is in thin plugin wrappers.
- **Protocol interfaces first** — I/O behind Protocols. Production and test implementations share one contract.
- **Mock doubles, not mocks** — real in-process implementations, not patch-over mocks.
- **Determinism as a first-class concern** — injected clocks, no `Date.now()`/`Math.random()` in test paths.
- **CheckResult pattern** — decisions carry their own proof.
- **DFT throughout** — 789 tests run in <30s. Zero fixtures. Ephemeral ports.
- **Event-driven cleanup, not timer-driven** — don't add weight to lose weight.
- **No inline regex** — all patterns in the regex library, tested in isolation.

---

## Local Verification

```bash
# Python unit + integration
uv run pytest tests/ -v

# TypeScript unit + integration (no Docker needed)
cd ts && NODE_ENV=development npx vitest run tests/plugins/ tests/spec/ tests/integration/

# Full TypeScript suite including Testcontainers E2E (needs Docker)
cd ts && npx vitest run

# Full CI pipeline via Docker Compose
docker compose -f docker/docker-compose.test.yml up --build --abort-on-container-exit
```

---

## Repository Details

- **GitHub Repository**: [FlowFeel/openclaw-test-harness](https://github.com/FlowFeel/openclaw-test-harness) (Public)
- **Target OpenClaw Version**: `2026.6.8`
- **License**: MIT
- **Target Production Host**: EC2 (Amazon Linux 2023, Node.js v22.22.2, 4 cores, 30GB RAM)
- **Documentation**: [`POST_MORTEM.md`](./POST_MORTEM.md) (full retrospective) · [`ISSUES.md`](./ISSUES.md) (tickets #1-#17) · [`PROJECT_SUBAGENT_EFFICIENCY.md`](./PROJECT_SUBAGENT_EFFICIENCY.md) (#18-#25) · [`PROJECT_OC_EFFICIENCY.md`](./PROJECT_OC_EFFICIENCY.md) (#26-#33) · [`PROJECT_NEXT_IMPROVEMENTS.md`](./PROJECT_NEXT_IMPROVEMENTS.md) (#34-#42)
