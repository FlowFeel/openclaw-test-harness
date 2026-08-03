# Subagent Efficiency & Parallel Orchestration

**Project:** Multi-agent capacity for Jan's research workload
**Created:** 2026-08-03
**Owner:** Ed Phil (Systems Architect)
**Status:** Planning

---

## Context

When Jan (Research Principal) returns, he will want to:
- Spawn multiple research subagents in parallel (literature searches, paper analysis, cartography)
- Chain research → analysis → synthesis workflows (depth 2+)
- Run multiple topics simultaneously (human origins, environment, social issues)
- Execute heavy CPU work (embedding generation, GIS processing, PDF analysis)

Tickets #1-#17 built the infrastructure: SQLite registry, worker pool, FairPool
scheduling, SubagentSupervisor, TopicRouter, live telemetry, 3 live plugins.
Now we need the orchestration layer on top.

---

## Phase D — Subagent Orchestration

### #18: Subagent Work Queue Dispatcher

**Problem:** Currently `sessions_spawn` creates one subagent per call. Jan needs to
queue 20 research tasks and have them dispatch across the 6 concurrent slots
automatically, with results collecting as they complete. There's no batch API
or work-stealing dispatcher.

**Solution:** A `WorkQueue` plugin (`oc-work-queue`) that:
- Accepts a batch of tasks: `queue_work(tasks: TaskSpec[])`
- Dispatches across `maxConcurrent` slots (reads from `oc-subagent-watchdog`)
- Replaces completed slots with next queued task
- Collects results into an ordered result set
- Reports progress via `queue_status` tool
- Uses `sessions_spawn` for each task (OC native spawning)
- Respects `canSpawn` from the watchdog before dispatching

**Pure logic:** `work-queue-scheduler.ts` — `dispatchNext(queue, activeSlots, maxConcurrent)`,
`collectResult(results, task)`, `computeProgress(queue, completed, failed, active)`

**Hooks:** `subagent_ended` → check queue for next task to dispatch

**Tools:** `queue_work`, `queue_status`, `queue_results`

**Acceptance:**
1. Queue 10 tasks with maxConcurrent=3 → 3 dispatch immediately, 7 queue
2. When 1 completes → next queued task dispatches within 1s
3. Results collected in original task order (not completion order)
4. `queue_status` reports active/queued/completed/failed counts
5. If `canSpawn` returns false → queue holds, doesn't error

**Status:** 📋 Planned

---

### #19: Nested Subagent Chains (depth 2+)

**Problem:** `maxSpawnDepth=1` prevents nesting. Jan needs research → analysis →
synthesis chains where a subagent spawns its own children. But depth 3+ caused
the original bloat cascade (2,575 dead subagents).

**Solution:** Increase `maxSpawnDepth` to 2 with safety guards:
- `maxSpawnDepth=2` allows: main → research subagent → analysis subagent
- The `oc-subagent-watchdog` tracks depth per subagent
- Depth 2 subagents have a stricter `runTimeoutSeconds` (180s vs 300s)
- Depth 2 subagents cannot spawn their own children (depth 3 blocked)
- The `oc-session-guard` purges depth 2 subagents more aggressively
  (archiveAfterMinutes=5 vs 10)

**Config change:** `maxSpawnDepth: 1 → 2`

**Pure logic:** `depth-limiter.ts` — `canSpawnAtDepth(currentDepth, maxDepth)`,
`getTimeoutForDepth(depth, baseTimeout, depthReduction)`,
`getArchiveAfterForDepth(depth, baseArchive, depthReduction)`

**Acceptance:**
1. Main spawns subagent A (depth 1) → A spawns subagent B (depth 2) ✅
2. B cannot spawn subagent C (depth 3 blocked) ✅
3. B has 180s timeout (vs A's 300s) ✅
4. B archives after 5min (vs A's 10min) ✅
5. Watchdog reports per-depth active counts ✅

**Status:** 📋 Planned

---

### #20: Telemetry-Driven Adaptive Admission

**Problem:** The `oc-event-loop-monitor` collects telemetry but doesn't feed it
into spawn decisions. Under load, new subagents should be throttled automatically.

**Solution:** Wire the `oc-event-loop-monitor` into `oc-subagent-watchdog`:
- Before each spawn, check `event_loop_health` tool output
- If status=`degraded` → reduce effective maxConcurrent by 2
- If status=`critical` → block new spawns entirely
- If status=`healthy` → normal maxConcurrent
- The watchdog's `subagent_health` tool reports the effective maxConcurrent

**Pure logic:** `adaptive-admission.ts` — `computeEffectiveMaxConcurrent(health, configured)`,
  `shouldThrottle(health)`, `getAdmissionDecision(health, activeCount, maxConcurrent)`

**Acceptance:**
1. Healthy (P99<50ms) → effective maxConcurrent = 6 (normal)
2. Degraded (P99>200ms) → effective maxConcurrent = 4 (throttled)
3. Critical (P99>500ms) → canSpawn = false (blocked)
4. Recovery: when health returns to healthy → maxConcurrent restores to 6
5. Decision includes reason: "throttled: event loop P99 250ms > 200ms threshold"

**Status:** 📋 Planned

---

### #21: Result Aggregation Worker

**Problem:** When 6 subagents return research results, merging them blocks the
main loop (JSON.parse + merge + summarize = 200-500ms CPU).

**Solution:** A `merge_results` tool registered by `oc-session-guard` that:
- Accepts an array of subagent result paths
- Reads each result file
- Merges into a single structured document
- Returns the merged result
- Runs the merge in the sidecar worker pool (if available) or inline

**Pure logic:** `result-merger.ts` — `mergeResults(results: ResultSpec[])`,
  `deduplicateByKey(results, key)`, `sortByRelevance(results, scorer)`

**Acceptance:**
1. Merge 6 results → single document with all findings
2. Deduplicate by citation key (no duplicate papers)
3. Sort by relevance score
4. Merge completes in <50ms when offloaded to worker

**Status:** 📋 Planned

---

### #22: Subagent Priority & Preemption

**Problem:** All subagents have equal priority. If 6 research tasks are running
and Jan needs a quick lookup, the lookup waits behind the queue.

**Solution:** Priority levels in the work queue:
- `priority: "high"` → jumps to front of queue
- `priority: "normal"` → FIFO (default)
- `priority: "low"` → only dispatches when no other work
- High-priority tasks can preempt: if a low-priority task is running and a
  high-priority task arrives, the low-priority task is signaled to yield
  (cooperative preemption via `session_end`)

**Pure logic:** `priority-scheduler.ts` — `insertByPriority(queue, task)`,
  `shouldPreempt(running, incoming)`, `yieldSignal(runningTask)`

**Acceptance:**
1. Queue [low, normal, high] → high dispatches first
2. High-priority preempts low-priority running task
3. Normal-priority does not preempt
4. Yielded task's partial results are preserved

**Status:** 📋 Planned

---

## Phase E — Research Workflow Integration

### #23: Research Task Specifications

**Problem:** Jan needs to describe research tasks declaratively, not as
free-form prompts.

**Solution:** A `ResearchTaskSpec` format:
```typescript
interface ResearchTaskSpec {
  id: string;
  type: "search" | "read" | "analyze" | "synthesize" | "cartograph";
  query: string;
  depth: 1 | 2;  // spawn depth
  priority: "high" | "normal" | "low";
  dependsOn?: string[];  // task IDs this depends on
  outputFormat: "summary" | "citations" | "full" | "mindmap";
  maxTokens: number;
}
```

The work queue dispatcher (#18) accepts `ResearchTaskSpec[]` and handles
dependencies (a task with `dependsOn` doesn't dispatch until its dependencies
complete).

**Acceptance:**
1. Tasks with dependencies don't dispatch until deps complete
2. Failed dependency → dependent tasks marked as blocked
3. Each task type produces the right output format
4. Task ID is stable across the lifecycle

**Status:** 📋 Planned

---

### #24: Session Isolation Per Topic

**Problem:** Multiple topics active simultaneously share the same event loop.
A heavy compaction in topic A blocks topic B's stream ingestion.

**Solution:** The `oc-event-loop-monitor` already collects telemetry. Add:
- Per-topic telemetry attribution (which topic is causing load)
- Per-topic spawn budget (topic A gets 3 slots, topic B gets 3 slots)
- When topic A exhausts its budget, B can borrow unused slots
- The watchdog tracks per-topic active counts

**Acceptance:**
1. Topic A with 3 active subagents → cannot spawn 4th (budget exhausted)
2. Topic B with 0 active → can borrow A's unused slots
3. Per-topic telemetry shows which topic is the bottleneck
4. Budget resets when subagents complete

**Status:** 📋 Planned

---

### #25: Research Result Cache & Deduplication

**Problem:** Multiple subagents may search the same papers or produce
overlapping results. No cache means redundant work.

**Solution:** A result cache that:
- Indexes by query hash + task type
- Returns cached results for identical queries
- Deduplicates overlapping citations across subagents
- Lives in the SQLite registry (already available)

**Acceptance:**
1. Same query dispatched twice → second returns cached result
2. Overlapping citations merged (dedup by DOI/URL)
3. Cache invalidates after configurable TTL (default 24h)
4. Cache hit rate reported in `queue_status`

**Status:** 📋 Planned

---

## Summary

| Ticket | Title | Phase | Priority | Status |
|--------|-------|-------|----------|--------|
| #18 | Subagent Work Queue Dispatcher | D | P0 | 📋 Planned |
| #19 | Nested Subagent Chains (depth 2+) | D | P0 | 📋 Planned |
| #20 | Telemetry-Driven Adaptive Admission | D | P1 | 📋 Planned |
| #21 | Result Aggregation Worker | D | P1 | 📋 Planned |
| #22 | Subagent Priority & Preemption | D | P2 | 📋 Planned |
| #23 | Research Task Specifications | E | P1 | 📋 Planned |
| #24 | Session Isolation Per Topic | E | P1 | 📋 Planned |
| #25 | Research Result Cache & Deduplication | E | P2 | 📋 Planned |

## Build Order

```
#18 (work queue) ──→ #19 (depth 2+) ──→ #23 (task specs)
                    │
                    ├──→ #20 (adaptive admission) ──→ #24 (per-topic isolation)
                    │
                    └──→ #21 (result merge) ──→ #25 (cache & dedup)
                    
                    #22 (priority) — independent, can be built anytime after #18
```

## DFT & CI Requirements

- Every ticket produces pure logic in `shared/` or `src/features/`
- Pure logic is tested without OC runtime, Docker, or file system
- BDD Feature/Scenario tests for each ticket
- CI: 4-layer pipeline (unit → docker → staging → integration) gates all commits
- Coverage target: 80%+ for new code
- No OC core files modified — plugin hooks + tools only

## Dependencies on Existing Work

- #18 depends on: `oc-subagent-watchdog` (canSpawn), `sessions_spawn` API
- #19 depends on: #18 (work queue manages depth), `oc-session-guard` (cleanup)
- #20 depends on: `oc-event-loop-monitor` (telemetry), `oc-subagent-watchdog` (admission)
- #21 depends on: `oc-sidecar` (worker pool) or inline merge
- #22 depends on: #18 (work queue)
- #23 depends on: #18 (work queue accepts task specs)
- #24 depends on: #20 (per-topic telemetry), `oc-subagent-watchdog`
- #25 depends on: #21 (result merge), SQLite registry
