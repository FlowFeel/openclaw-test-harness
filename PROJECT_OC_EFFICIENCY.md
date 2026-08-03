# OC Efficiency Improvement Tickets

**Project:** Plugin-based OC efficiency improvements
**Created:** 2026-08-03
**Owner:** Ed Phil (Systems Architect)
**Status:** Planning

---

## Context

The oc-subagent-orchestrator plugin is live with 7 tools and 8 hooks.
691 tests across the test harness. sessions.json at 317K (cleaned).
Event loop healthy. But there are gaps between the pure logic
(tickets #18-#25) and the live OC runtime that need wiring.

---

## Phase F — Runtime Wiring (P0)

### #26: Wire sessions-io into orchestrator

**Problem:** The `after_compaction` hook in the orchestrator logs but
doesn't actually write to sessions.json. Bloat fields accumulate between
manual cleanups (721K observed after 6 hours). The pure logic
(`cleanupSessions()`) and the I/O module (`sessions-io.ts`) both exist
but aren't connected.

**Solution:** Wire the `sessions-io.ts` module into the orchestrator's
`after_compaction` and `session_end` hooks:
- `after_compaction` → read sessions.json, `cleanupSessions()`, write back
- `session_end` → `purgeStaleSubagents()`, write back
- The `session_health` tool reports the actual file size (not just orchestrator state)
- Bloat fields list comes from plugin config

**Files:** Update `oc-subagent-orchestrator/src/index.ts`, import from `sessions-io.ts`

**Acceptance:**
1. After compaction runs, sessions.json is automatically stripped of bloat fields
2. `session_health` tool reports actual sessions.json file size + entry count
3. No manual cleanup needed — bloat stays under 5% of total size
4. Hook errors don't block agent runs (catch, log, continue)

**Status:** 📋 Planned

---

### #27: Update maxSpawnDepth to 2

**Problem:** OC's native config has `maxSpawnDepth: 1` which blocks
nested spawning at the OC level before the orchestrator's depth limiter
(#19) even gets a chance. Jan needs research → analysis chains (depth 2).

**Solution:** Update `openclaw.json` to set `maxSpawnDepth: 2`. The
orchestrator's depth limiter pure logic enforces the safety guards:
- Depth 2 gets 180s timeout (vs 300s at depth 1)
- Depth 2 gets 5min archive (vs 10min at depth 1)
- Depth 2 gets aggressive cleanup (5h vs 15h purge)
- Depth 3+ is blocked by the depth limiter

**Config change:** `agents.defaults.subagents.maxSpawnDepth: 1 → 2`

**Acceptance:**
1. Main spawns subagent A (depth 1) → A spawns subagent B (depth 2) ✅
2. B cannot spawn subagent C (depth 3) — blocked by orchestrator ✅
3. B has 180s timeout (not 300s) ✅
4. `subagent_health` tool reports depth-aware limits ✅

**Status:** 📋 Planned

---

### #28: Wire sessions_spawn into queue dispatcher

**Problem:** The `queue_work` tool creates the queue and computes what
to dispatch, but doesn't actually call `sessions_spawn` for each task.
It's a planning brain without hands — tasks are "dispatched" in state
but never actually run.

**Solution:** The orchestrator's `subagent_spawned` hook already tracks
spawns. When `queue_work` dispatches tasks, it should:
- Call OC's native `sessions_spawn` API for each dispatched task
- The `subagent_spawned` hook fires when the spawn succeeds → tracked in queue
- The `subagent_ended` hook fires when the task completes → `recordResult()`
- Then `dispatchNext()` fires for the next queued task

**Challenge:** The plugin API doesn't expose `sessions_spawn` directly.
Options:
1. Use `api.registerGatewayMethod` to expose an RPC the model can call
2. Use the `before_tool_call` hook to intercept and spawn
3. Have the model call `sessions_spawn` as a tool (current path) and
   have the orchestrator track it via the `subagent_spawned` hook

Option 3 is the simplest — the model calls `sessions_spawn` with the
task prompt, the `subagent_spawned` hook tracks it, and the orchestrator
manages the queue state.

**Acceptance:**
1. `queue_work` with 3 tasks and maxConcurrent=2 → 2 tasks spawn immediately
2. When 1 completes → next queued task spawns within 1s
3. `queue_status` shows accurate dispatched/active/queued counts
4. Results collected via `queue_results` in original task order

**Status:** 📋 Planned

---

## Phase G — Telemetry & Compaction (P1)

### #29: Wire real perf_hooks into orchestrator

**Problem:** The orchestrator's `healthSnapshot` is hardcoded to "healthy"
with zeros. The `model_call_started/ended` hooks fire but don't read
`perf_hooks`. Adaptive admission (#20) can't throttle because it has no
real telemetry.

**Solution:** Add a `TelemetryCollector` to the orchestrator that reads:
- `monitorEventLoopDelay().percentile(99)` → eventLoopP99Ms
- `performance.eventLoopUtilization()` → utilization (0-1)
- `v8.getHeapStatistics().used_heap_size` → heap bytes
- `process.cpuUsage()` delta → cpuRatio

Wire into `model_call_started` hook → collect, store in `healthSnapshot`.
The `event_loop_health` tool returns real values. The `getAdmissionDecision()`
call in `queue_work` uses real telemetry.

**Acceptance:**
1. `event_loop_health` returns real P99 > 0 (not zero)
2. Under load (busy loop), `event_loop_health` shows degraded/critical
3. `queue_work` rejects when health is critical
4. `subagent_health` shows effective maxConcurrent reduced when degraded

**Status:** 📋 Planned

---

### #30: Build oc-compaction-helper plugin

**Problem:** Compaction runs synchronously on the main loop. A 10MB
transcript blocks the event loop for 200-500ms. There's no pre-check
before compaction starts, and no post-compaction cleanup.

**Solution:** A separate `oc-compaction-helper` plugin that:
- `before_compaction` hook: check transcript size, warn if > 5MB
- `after_compaction` hook: strip bloat fields (delegates to orchestrator
  or does its own cleanup)
- Registers a `compact_check` tool: model can check if compaction is
  needed before it happens
- Uses the `compact.context` handler from the regex library for
  safe transcript truncation

**Acceptance:**
1. Pre-compaction: warns when transcript > 5MB
2. Post-compaction: bloat fields stripped within 1s of compaction
3. `compact_check` tool reports transcript size + recommendation
4. No main-loop blocking during cleanup (async hooks)

**Status:** 📋 Planned

---

## Phase H — Advanced Caching (P2)

### #31: Build oc-context-cache plugin

**Problem:** Every turn, OC resolves the system prompt, tool definitions,
and skill files from scratch. This is redundant CPU work that produces
the same result across turns within the same session.

**Solution:** A `oc-context-cache` plugin that:
- Caches resolved system prompt per session (invalidate on config change)
- Caches tool definitions (invalidate on plugin change)
- Caches skill file contents (invalidate on file change)
- `before_prompt_build` hook: inject cached values, skip resolution
- Registers `context_cache_stats` tool: hit rate, cache size, invalidations

**Acceptance:**
1. Second turn in same session skips system prompt resolution
2. Cache invalidates when `openclaw.json` changes
3. `context_cache_stats` reports > 80% hit rate in steady state
4. No stale prompts (invalidation works)

**Status:** 📋 Planned

---

### #32: Build oc-stream-relay plugin

**Problem:** Model responses stream through the main event loop. Large
responses (10K+ tokens) cause ingestion stalls — the main loop can't
process other I/O while parsing SSE chunks.

**Solution:** A `oc-stream-relay` plugin that:
- Starts a sidecar HTTP relay process on `gateway_start`
- Intercepts model response streams via `model_call_started` hook
- Relays the stream through the sidecar (worker thread parses SSE)
- Returns parsed chunks to the main loop at a controlled rate
- Registers `stream_relay_health` tool

**Acceptance:**
1. Large response (10K tokens) doesn't block other topics
2. Stream relay adds < 50ms latency overhead
3. `stream_relay_health` shows relay process status
4. Sidecar crash → fallback to direct streaming (graceful degradation)

**Status:** 📋 Planned

---

## Summary

| Ticket | Title | Phase | Priority | Status |
|--------|-------|-------|----------|--------|
| #26 | Wire sessions-io into orchestrator | F | P0 | 📋 Planned |
| #27 | Update maxSpawnDepth to 2 | F | P0 | 📋 Planned |
| #28 | Wire sessions_spawn into queue dispatcher | F | P0 | 📋 Planned |
| #29 | Wire real perf_hooks into orchestrator | G | P1 | 📋 Planned |
| #30 | Build oc-compaction-helper plugin | G | P1 | 📋 Planned |
| #31 | Build oc-context-cache plugin | H | P2 | 📋 Planned |
| #32 | Build oc-stream-relay plugin | H | P2 | 📋 Planned |
| #33 | Restore oc-sidecar (worker-pool only, no conflicts) | I | P0 | 📋 Planned |

## Build Order

```
#26 (sessions-io) ──→ #30 (compaction helper)
#27 (maxSpawnDepth) — independent, config change
#28 (sessions_spawn) ──→ depends on #27 for depth 2 chains
#29 (perf_hooks) ──→ feeds #28's adaptive admission
#31 (context cache) — independent
#32 (stream relay) — independent, needs sidecar process (#33)
#33 (oc-sidecar) — independent, restores worker pool
```

## DFT & CI Requirements

- All pure logic in `shared/` modules, tested without OC runtime
- BDD Feature/Scenario tests for each ticket
- CI: 4-layer pipeline gates all commits
- Coverage target: 80%+ for new code
- No OC core files modified — plugin hooks + tools only

---

## Phase I — Sidecar Restoration

### #33: Restore oc-sidecar as a pure worker-pool plugin (no tool conflicts)

**Problem:** We removed `oc-sidecar` because it had tool name conflicts with
the orchestrator (both registered `session_health` and `event_loop_health`).
But the sidecar process is the only way to offload CPU-heavy work (JSON
serialization, transcript compaction, result merging) off the main event loop.
Without it, all CPU work happens in-process on the V8 main thread.

**Solution:** Restore `oc-sidecar` as a focused worker-pool-only plugin:
- Remove ALL hooks except `gateway_start`/`gateway_stop` (boot/kill sidecar)
- Remove ALL tools except `sidecar_health` and `sidecar_exec`
- No `session_health`, no `event_loop_health`, no `after_compaction` —
  the orchestrator owns those
- The sidecar process runs `worker_threads` with handlers:
  `json.stringify`, `json.parse`, `serialize.session`, `compact.context`
- The orchestrator can call `sidecar_exec` to offload merge/dedup work
- Clean separation: orchestrator = scheduling brain, sidecar = CPU muscle

**Plugin structure:**
```
oc-sidecar/
  openclaw.plugin.json  (contracts: sidecar_health, sidecar_exec only)
  src/index.ts          (2 hooks: gateway_start, gateway_stop)
  src/sidecar-manager.ts
  src/sidecar-client.ts
  src/sidecar-server.ts
  src/worker-entry.ts
```

**Config:**
```json
{
  "oc-sidecar": {
    "enabled": true,
    "config": {
      "port": 18900,
      "workerThreads": 3,
      "startupTimeoutMs": 10000
    }
  }
}
```

**Acceptance:**
1. Sidecar process starts on gateway_start (PID visible)
2. `sidecar_health` returns worker pool stats (active, completed, poolSize)
3. `sidecar_exec` with `json.stringify` returns serialized result
4. No tool name conflicts with orchestrator
5. Sidecar crash → graceful fallback (sidecar_exec returns error, doesn't crash OC)
6. Sidecar starts in < 2s

**Status:** 📋 Planned
