# Next Improvements — Auto-Dispatch, Hardening, Coverage

**Project:** Post-sprint improvements
**Created:** 2026-08-03
**Owner:** Ed Phil (Systems Architect)
**Status:** Planning

---

## Context

Sprint #26-#33 shipped 5 plugins + 751 tests. The key post-mortem finding:
manual dispatch dropped 2 of 8 tasks because the model forgot to call
sessions_spawn. The pure logic is correct but the wiring between "queue
says dispatch" and "actually spawn" is manual and unreliable.

---

## Phase J — Auto-Dispatch & Reliability (P0)

### #34: Wire SubagentBridge to orchestrator (auto-dispatch)

**Problem:** The `queue_work` tool creates the queue, computes which tasks
to dispatch, and returns dispatch instructions — but the model must
manually call `sessions_spawn` for each. This is exactly what failed in
the sprint (#30 and #31 stalled).

The TaskFlow `SubagentBridge` already exists (`lib/python/taskflow/bridge.py`)
and does exactly this: `plan_wave()` → generate spawn specs → model spawns
→ `plan_wave()` again. It just needs to be wired to the orchestrator.

**Solution:**
- The `queue_work` tool calls `SubagentBridge.plan_wave()` instead of
  returning dispatch instructions
- Each `SpawnSpec.task_instruction` is passed to `sessions_spawn`
- The `subagent_spawned` hook tracks the spawn in the queue
- The `subagent_ended` hook triggers `plan_wave()` for the next batch
- No manual model intervention — fully automatic dispatch

**Acceptance:**
1. `queue_work` with 10 tasks, maxConcurrent=3 → 3 subagents spawn immediately
2. When 1 completes → next queued task spawns within 2s (automatic)
3. `queue_status` shows accurate dispatched/active/queued counts
4. No manual sessions_spawn calls needed from the model

**Status:** 📋 Planned

---

### #35: Stale step watchdog (detect + re-dispatch)

**Problem:** In the sprint, steps were marked ACTIVE in the TaskFlow
manifest but no subagent was actually running. There was no detection
or recovery — the steps sat "ACTIVE" forever.

**Solution:** A watchdog that periodically checks:
- TaskFlow manifest steps in ACTIVE state with no corresponding subagent
- Subagents tracked by `oc-subagent-watchdog` that have exceeded
  `runTimeoutSeconds`
- Queue tasks in "dispatched" state with no `subagent_spawned` event

When detected:
- Mark the step as FAILED in the manifest (with "stale" reason)
- Re-queue the task for dispatch
- Log the detection + recovery

**Acceptance:**
1. ACTIVE step with no subagent for 60s → marked stale, re-queued
2. Subagent exceeding runTimeoutSeconds → detected and cleaned up
3. Watchdog runs every 30s via a `session_end` or heartbeat hook
4. Recovery preserves task dependencies (re-queued tasks wait for deps)

**Status:** 📋 Planned

---

### #36: Install all 5 plugins on live OC instance

**Problem:** Only `oc-subagent-orchestrator` is installed on this OC
instance. The other 4 plugins (`oc-sidecar`, `oc-compaction-helper`,
`oc-context-cache`, `oc-stream-relay`) exist in the repo but aren't
installed or enabled in the live config.

**Solution:**
- `openclaw plugins install --link` for each of the 4 plugins
- Add to `openclaw.json` plugins.entries + plugins.allow
- Restart gateway
- Verify all 5 plugins load, no tool name conflicts, all hooks register

**Acceptance:**
1. All 5 plugins show as enabled in `openclaw plugins list`
2. No tool name conflicts (sidecar has sidecar_health/exec only)
3. Total hooks: orchestrator (8) + sidecar (2) + compaction-helper (2) +
   context-cache (3) + stream-relay (3) = 18 hooks
4. Gateway starts cleanly with all 5 plugins

**Status:** 📋 Planned

---

## Phase K — Coverage & Hardening (P1)

### #37: E2E container tests for all 5 plugins

**Problem:** The production-sim E2E test only verifies the orchestrator
and the 3 original standalone plugins. The new plugins
(compaction-helper, context-cache, stream-relay) have no E2E container
verification.

**Solution:** Extend `production-sim.spec.ts` to:
- Copy all 5 plugins into the container
- Verify each plugin's manifest is valid in-container
- Run each plugin's pure logic in-container
- Verify the full plugin set loads without conflicts

**Acceptance:**
1. All 5 plugin manifests valid in container
2. All 5 plugins' pure logic runs in container
3. No tool name conflicts when all 5 are present
4. CI runs the E2E tests with Docker

**Status:** 📋 Planned

---

### #38: Coverage audit — fill gaps in plugin entry points

**Problem:** The orchestrator's plugin entry (`index.ts`) is at ~60%
coverage. The new plugins (compaction-helper, context-cache, stream-relay)
have manifest tests but limited entry-point tests. Hook handlers and
tool execute functions need coverage.

**Solution:**
- Add mock PluginApi tests for each plugin's register() function
- Test each tool's execute() with valid and invalid inputs
- Test each hook handler with edge cases (null events, missing fields)
- Target: 80%+ coverage on all plugin entry points

**Acceptance:**
1. Each plugin has entry-point tests (hooks registered, tools registered)
2. Each tool tested with valid input, invalid input, error case
3. Each hook tested with event payload, empty event, null fields
4. Overall coverage ≥ 80% on plugin source files

**Status:** 📋 Planned

---

### #39: Error recovery — subagent crash mid-task

**Problem:** If a subagent crashes mid-task, the queue marks it as
"dispatched" forever. The `subagent_ended` hook never fires, so
`recordResult()` is never called, and `dispatchNext()` never runs.

**Solution:**
- The stale watchdog (#35) detects this case
- On detection: call `recordResult()` with `success=false` and
  `error="subagent crashed or timed out"`
- `failBlockedTasks()` cascades the failure to dependents
- `dispatchNext()` fills the freed slot

**Acceptance:**
1. Subagent crash → detected within 60s by watchdog
2. Crashed task marked as failed in queue
3. Dependent tasks marked as blocked
4. Next queued task dispatches to fill the freed slot
5. `queue_results` shows the failed task with error message

**Status:** 📋 Planned

---

## Phase L — Model & Memory (P2)

### #40: Model fallback chain optimization

**Problem:** Current fallback is static: GLM-5.2 → DeepSeek V4 Flash →
Qwen 3.6. No latency-aware routing. If GLM is slow (10s+ per call),
we don't fall back to a faster model.

**Solution:** A `oc-model-router` plugin that:
- Tracks per-model latency (rolling 10-call average)
- If primary model P99 > 15s → route to fastest fallback
- If primary model 5xx error rate > 10% → route to fallback
- `model_call_started`/`ended` hooks collect latency
- Registers `model_health` tool

**Acceptance:**
1. Slow primary (P99 > 15s) → automatic fallback to faster model
2. Error rate > 10% → automatic fallback
3. Recovery: when primary recovers, switch back
4. `model_health` reports per-model latency + error rates

**Status:** 📋 Planned

---

### #41: Memory/search integration with orchestrator

**Problem:** The orchestrator's result cache (#25) is in-memory only.
When the gateway restarts, the cache is lost. The phosphene search index
and SQLite session registry persist across restarts but aren't connected
to the orchestrator.

**Solution:**
- Wire the result cache to use the SQLite registry for persistence
- Search results from `phosphene_search.py` feed into the cache
- The `queue_work` tool checks the SQLite cache (not just in-memory)
- Cache invalidation tied to memory file modification times

**Acceptance:**
1. Cache survives gateway restart (persisted to SQLite)
2. `phosphene_search` results cached automatically
3. `queue_work` checks SQLite cache before spawning
4. Cache hit rate reported in `session_health`

**Status:** 📋 Planned

---

### #42: Heartbeat integration — orchestrator reports to heartbeat

**Problem:** The orchestrator has rich state (queue, subagents, telemetry,
cache) but doesn't report it to the heartbeat system. The daily business
report and heartbeat don't know about subagent activity.

**Solution:**
- The orchestrator's `session_end` hook writes a summary to the heartbeat
- The business report includes: subagent count, queue throughput, cache
  hit rate, event loop health, compaction count
- The nightly commit includes the orchestrator state

**Acceptance:**
1. Heartbeat includes orchestrator metrics
2. Business report shows subagent activity for the day
3. Nightly commit persists orchestrator state summary

**Status:** 📋 Planned

---

## Summary

| Ticket | Title | Phase | Priority | Status |
|--------|-------|-------|----------|--------|
| #34 | Wire SubagentBridge (auto-dispatch) | J | P0 | 📋 Planned |
| #35 | Stale step watchdog (detect + re-dispatch) | J | P0 | 📋 Planned |
| #36 | Install all 5 plugins on live OC | J | P0 | 📋 Planned |
| #37 | E2E container tests for all 5 plugins | K | P1 | 📋 Planned |
| #38 | Coverage audit — plugin entry points | K | P1 | 📋 Planned |
| #39 | Error recovery — subagent crash mid-task | K | P1 | 📋 Planned |
| #40 | Model fallback chain optimization | L | P2 | 📋 Planned |
| #41 | Memory/search integration with orchestrator | L | P2 | 📋 Planned |
| #42 | Heartbeat integration — orchestrator reports | L | P2 | 📋 Planned |

## Build Order

```
#36 (install plugins) — do first, unblocks everything
#34 (auto-dispatch) ──→ #35 (stale watchdog) ──→ #39 (crash recovery)
#37 (E2E tests) — independent
#38 (coverage) — independent
#40 (model router) — independent
#41 (memory integration) — depends on #34
#42 (heartbeat) — depends on #34
```

## DFT & CI Requirements

- All pure logic in `shared/` modules, tested without OC runtime
- BDD Feature/Scenario tests for each ticket
- CI: 4-layer pipeline gates all commits
- Coverage target: 80%+ for new code
- No OC core files modified — plugin hooks + tools only
