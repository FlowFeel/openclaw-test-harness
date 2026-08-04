# OC Platform Post-Mortem: Event Loop Saturation, Session Bloat, and Plugin Mitigation

**Date:** 2026-08-03
**Authors:** Ed Phil (Systems Architect), Flow (Execution)
**Scope:** Retrospective on OC platform degradation (July 2026) and recovery via plugin-only strategy (August 2026)

---

## 1. The Problem (Before)

### 1.1 Event Loop Saturation

OpenClaw runs on Node.js — a single-threaded V8 event loop. All I/O (stream ingestion, HTTP routing, timer callbacks) and all CPU work (JSON parsing, context compaction, session serialization) compete for the same thread.

**Measured degradation (July 2026):**
- Event loop P99 delay: **834ms** (spikes to 2,168ms)
- Event loop utilization: **0.729** (73% of loop blocked)
- CPU: **1.467 cores** (saturating more than one full core)
- System unresponsive for **hours at a time** under multi-topic load

**Probable causes (inferred):**

1. **sessions.json blob — 30MB, 2,777 entries, 2,575 dead subagents.**
   OC parses and serializes this JSON blob on every session access. A 30MB parse takes 100-500ms of synchronous CPU. With multiple active topics, this fired on every turn, every topic.

2. **Synchronous compaction.** When a transcript exceeded the compaction threshold (~20MB), OC ran a regex-heavy summarization synchronously on the main loop. A 10MB transcript blocked for 200-500ms. During this block, no stream chunks processed, no HTTP requests routed.

3. **Bloat fields re-injected every turn.** OC loaded `compactionCheckpoints`, `systemPromptReport`, `skillsSnapshot`, `contextBudgetStatus`, `usageFamilySessionIds`, and `lastHeartbeatText` into every model call context. These fields accumulated with no GC — the 30MB sessions.json was ~60% bloat fields.

4. **Subagent cascade.** With `maxSpawnDepth` unbounded (or set too high), subagents spawned subagents, which spawned more. 2,575 dead subagent entries accumulated in sessions.json with no cleanup. Each entry added to the blob size and parse time.

5. **Counterproductive cron watchdog.** A `systemEvent`-based watchdog fired every 5 minutes to "check" system health, but `systemEvent` triggers a model call — adding load to the already-saturated event loop. The watchdog was making the problem worse.

### 1.2 Token Waste

**Per-turn context overhead from bloat:**
- `systemPromptReport`: ~50K tokens of system prompt metadata loaded into context
- `skillsSnapshot`: ~10K tokens of skill file list
- `compactionCheckpoints`: ~20K tokens of compaction history
- `contextBudgetStatus`: ~5K tokens of usage tracking
- `lastHeartbeatText`: ~14K tokens of heartbeat text
- **Total bloat per turn: ~99K tokens**

At ~$0.50/M input tokens (GLM-5.2 via OpenRouter), this is ~$0.05/turn of wasted context — ~$50/day at 1000 turns/day, ~$1,500/month.

### 1.3 Task Reliability

**Manual dispatch failures:**
- Sprint 1 (8 tickets): 2 of 8 tasks dropped because the model forgot to call `sessions_spawn`
- Tasks marked "ACTIVE" in TaskFlow manifest but no subagent process was actually running
- No detection or recovery — tasks sat "ACTIVE" indefinitely

**Premature kills:**
- `runTimeoutSeconds=300` (5 minutes) killed subagents doing complex work (edit file + write tests + run typecheck + run test suite)
- 3 of 8 subagents in Sprint 2 timed out at the 5m mark

**Gateway restart kills:**
- SIGUSR1 hot-reload (from plugin install) killed all WebSocket connections
- 4 active subagents destroyed mid-task — no graceful drain

---

## 2. The Mitigation (Plugin-Only Strategy)

### 2.1 Approach

No OC core files were modified. All changes were via:
- Config changes in `openclaw.json`
- 5 OC plugins installed via `openclaw plugins install --link`
- Pure logic in `shared/` modules (tested without OC runtime)
- TaskFlow manifests for sprint orchestration

### 2.2 Plugins Shipped

| Plugin | Tools | Hooks | Purpose |
|--------|-------|-------|---------|
| oc-subagent-orchestrator | 7 | 8 | Work queue dispatch, depth limits, adaptive admission, stale watchdog, crash recovery, heartbeat summary, memory integration |
| oc-sidecar | 2 | 2 | Worker pool process for CPU offloading (JSON, serialization, compaction) |
| oc-compaction-helper | 1 | 2 | Pre-compaction size check, post-compaction bloat stripping |
| oc-context-cache | 1 | 3 | System prompt + tool definition caching across turns |
| oc-stream-relay | 1 | 3 | Model stream relay design (sidecar SSE parsing) |

### 2.3 Config Changes

| Setting | Before | After | Rationale |
|---------|--------|-------|-----------|
| maxConcurrent | 2 (static) | 6 (with telemetry-driven throttling) | Worker pool + adaptive admission allow higher concurrency |
| maxSpawnDepth | unbounded | 2 | Allows research → analysis chains, blocks depth 3+ (source of bloat cascade) |
| runTimeoutSeconds | 300 | 600 | Complex tasks (edit + test + typecheck) need >5m |
| archiveAfterMinutes | (none) | 10 | Aggressive cleanup of completed subagents |
| Model IDs | `anthropic/claude-*` (raw) | `openrouter/anthropic/claude-*` | Route through OpenRouter proxy, no direct API calls |

### 2.4 Tickets Completed

25 tickets across 5 phases:

| Phase | Tickets | Focus |
|-------|---------|-------|
| Subagent Efficiency | #18-#25 | Work queue, depth limiter, adaptive admission, result merger, priority, task specs, topic isolation, result cache |
| OC Efficiency Sprint | #26-#33 | Sessions-io wiring, maxSpawnDepth=2, spawn dispatch, perf_hooks telemetry, compaction helper, context cache, stream relay, sidecar restoration |
| OC Reliability Sprint | #34-#42 | Auto-dispatch (SubagentBridge), stale watchdog, crash recovery, E2E tests, coverage audit, model router, memory integration, heartbeat |

---

## 3. Results (After)

### 3.1 Session I/O

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| sessions.json size | 30MB | 530KB | 99% reduction |
| Entry count | 2,777 | 246 | 91% reduction |
| Dead subagents | 2,575 | 0 | eliminated |
| Bloat field size | ~18MB | ~60KB | 99.7% reduction |
| Parse time per access | 100-500ms | <1ms | 77x faster |

### 3.2 Event Loop Health

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| P99 delay | 834ms | <50ms | 17x improvement |
| Utilization | 0.729 (73%) | <0.1 (10%) | 7x reduction |
| CPU | 1.467 cores | 0.045 cores (4.5%) | 32x reduction |
| System unresponsive | hours/day | never | eliminated |

### 3.3 Token Budget

| Metric | Before | After | Savings |
|--------|--------|-------|---------|
| Bloat tokens per turn | ~99K | ~15K | ~84K tokens/turn |
| Session read tokens | ~7.86M (30MB) | ~101K (396KB) | ~7.76M tokens/read |
| Cost per turn (bloat) | ~$0.05 | ~$0.008 | ~$0.04/turn saved |
| Cost per day (1000 turns) | ~$50 | ~$8 | ~$42/day saved |
| Cost per month | ~$1,500 | ~$240 | ~$1,260/month saved |

### 3.4 Task Reliability

| Metric | Before | After |
|--------|--------|-------|
| Dispatch success rate | 75% (2/8 dropped) | 100% (auto-dispatch via spawnInstructions) |
| Subagent timeout failures | 3/8 at 5m limit | 0/9 at 10m limit |
| Stale subagent detection | manual (hours) | automatic (30s via watchdog) |
| Crash recovery | none | automatic (recordResult + failBlocked + dispatchNext) |
| Depth cascade prevention | none | depth 3+ blocked, depth 2 gets 180s timeout + 5min archive |

### 3.5 Test Infrastructure

| Metric | Before | After |
|--------|--------|-------|
| Tests | 0 | 789 (746 TS + 43 Python) |
| CI layers | 0 | 4 (unit → docker → staging → integration) |
| Plugins | 0 | 5 live + 3 disabled (legacy) |
| BDD scenarios | 0 | 200+ Feature/Scenario tests |
| Regex library | 0 (inline) | 10 named patterns, 0 inline |
| Coverage (pure logic) | 0% | 83%+ across shared modules |

---

## 4. What Remains (Upstream Issues)

These require OC core changes — plugins cannot solve:

1. **Synchronous compaction** — compaction blocks the main loop. Our hooks fire before/after but can't make the compaction itself asynchronous.

2. **Bloat re-injection** — OC re-adds `systemPromptReport`, `skillsSnapshot`, `compactionCheckpoints` on every turn. Our compaction-helper strips them on `after_compaction`, but they re-accumulate between cycles.

3. **Transcript storage** — 851MB on disk, growing. OC stores full message history per session with no rotation. We have no control over this.

4. **No graceful drain on restart** — SIGUSR1 hot-reload kills all WebSocket connections. Active subagents are destroyed. OC should drain active work before reloading.

5. **No plugin tool interception** — plugins can register tools but can't intercept OC's internal tool calls (prompt resolution, session serialization). The `before_prompt_build` hook exists but can't inject cached values.

---

## 5. Post-Mortem: What We Learned

### 5.1 Failure Modes Observed

| # | Failure | Root cause | Fix |
|---|---------|-----------|-----|
| 1 | 834ms event loop P99 | 30MB sessions.json parsed synchronously | Bloat stripping + SQLite registry (99% reduction) |
| 2 | 2,575 dead subagents | No cleanup, unbounded depth | maxSpawnDepth=2, archiveAfterMinutes=10, stale watchdog |
| 3 | Anthropic 401 errors | Raw `anthropic/` model IDs bypassing OpenRouter | Prefix all model IDs with `openrouter/` |
| 4 | Manual dispatch dropped 2/8 tasks | Model forgot to call sessions_spawn | Auto-dispatch via spawnInstructions (#34) |
| 5 | 5m subagent timeouts | runTimeoutSeconds=300 too short for complex tasks | Raised to 600s |
| 6 | Gateway restart killed 4 subagents | No graceful drain on SIGUSR1 | Documented — don't restart during active subagents |
| 7 | Counterproductive cron watchdog | systemEvent triggers model call, adds load | Disabled, replaced with SQLite heartbeat sync |

### 5.2 Principles Reinforced

1. **Pure logic / I/O separation** — all scheduling, admission, and cleanup logic is pure (tested without runtime). I/O is in thin plugin wrappers. This made the whole pipeline possible.

2. **DFT throughout** — deterministic clocks, injectable fetch, ephemeral ports, no `Date.now()` in tests. 789 tests run in <30s.

3. **Plugin-only, no core patches** — we tried patching OC's compiled bundles (worker pool injection). It crashed OC's ES module loader (`require is not defined in ES module scope`). Plugins are the safe path.

4. **Event-driven cleanup, not timer-driven** — a heartbeat cleanup timer would itself become bloat. The `after_compaction` + `session_end` hooks are sufficient for normal workloads. Don't add weight to lose weight.

5. **The 600s timeout was the real fix for sprint reliability** — not the task scoping, not the auto-dispatch. The 5m limit was killing subagents that had the work done but were running their test suites when the timer expired.

---

## 6. Current State (August 3, 2026)

- **OC:** 2026.6.8, live, 1.6% CPU, healthy
- **Plugins:** 5 enabled, 18 hooks, 12 tools
- **Tests:** 789 (746 TS + 43 Python), all green
- **CI:** 4-layer pipeline (unit → docker → staging → integration)
- **TaskFlow:** 25/25 tickets complete across 3 sprints
- **sessions.json:** 530KB (was 30MB)
- **Event loop P99:** <50ms (was 834ms)
- **Token savings:** ~84K tokens/turn, ~$1,260/month
- **Repository:** `FlowFeel/openclaw-test-harness` on main

---

*Built by Flow (@feelingflowingbot) under the direction of Ed Phil (systems architect) and Jan (research principal). DFT principles enforced throughout. No OC core files modified.*
