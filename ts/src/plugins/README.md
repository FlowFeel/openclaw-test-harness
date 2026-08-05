# Plugin Directory

Each subdirectory is a standalone OC plugin with its own manifest, entry point, tests, and CI gating. All 11 plugins pass `foundry validate` (six DFT axioms) and use `api.on()` for typed lifecycle hooks.

## The `api.on()` rule

**All hooks are registered via `api.on()`, not `api.registerHook()`.** This is not a style preference — it's a correctness requirement:

- `api.on("hook", handler)` → registers to `typedHooks` → visible to `hasHooks()` → **fires**
- `api.registerHook("hook", handler, {name})` → registers to `legacyInternalHooks` → invisible → **never fires**

The gateway gates dispatch on `hasHooks()`. If the hook isn't visible, it's never called. See [`docs/oc-source-mod-testbed.md`](../../docs/oc-source-mod-testbed.md) for the full analysis.

## Plugins

| Plugin | Hooks | Tools | Tests | Purpose |
|--------|-------|-------|-------|---------|
| `oc-subagent-orchestrator` | 8 | 7 | 36 | Work queue dispatch, depth limits, adaptive admission |
| `oc-topic-worker-pool` | 6 | 0 | 33 | Semaphore admission control for Telegram topic sessions |
| `oc-sidecar` | 2 | 3 | 55 | Worker pool process for CPU offloading |
| `oc-compaction-helper` | 4 | 1 | 21 | Pre/post compaction bloat stripping |
| `oc-stream-relay` | 3 | 1 | 39 | Model stream relay design |
| `oc-context-cache` | 3 | 1 | 31 | System prompt + context caching |
| `oc-model-router` | 2 | 1 | 38 | Model fallback chain (P99, error rate, routing) |
| `oc-subagent-watchdog` | 2 | 1 | 17 | Subagent lifecycle tracking + stale detection |
| `oc-session-guard` | 2 | 2 | 16 | Session bloat management (direct file I/O) |
| `oc-event-loop-monitor` | 3 | 1 | 13 | Live telemetry (perf_hooks + v8 heap) |
| `oc-e2e-trace-test` | 1 | 0 | 5 | Test plugin for Level 2 E2E hook trace |

**Totals:** 36 hooks, 19 tools, 1,091 plugin tests.

## Hook inventory by plugin

### `oc-subagent-orchestrator` (8 hooks, 7 tools)

**Hooks:** `gateway_start`, `gateway_stop`, `after_compaction`, `agent_end`, `subagent_spawned`, `subagent_ended`, `model_call_started`, `model_call_ended`

**Tools:** `queue_work`, `queue_status`, `queue_results`, `subagent_health`, `session_health`, `merge_results`, `event_loop_health`

### `oc-topic-worker-pool` (6 hooks, 0 tools)

**Hooks:** `before_dispatch`, `before_agent_run`, `agent_end`, `subagent_spawning`, `subagent_ended`, `before_agent_reply`

Pure logic: counting semaphore, topic session key parsing, pool routing, dedup. Two pools (main + sub) prevent subagent starvation.

### `oc-sidecar` (2 hooks, 3 tools)

**Hooks:** `gateway_start`, `gateway_stop`

**Tools:** `sidecar_health`, `sidecar_exec`, `session_health`

### `oc-compaction-helper` (4 hooks, 1 tool)

**Hooks:** `before_prompt_build`, `before_compaction`, `agent_end`, `after_compaction`

**Tools:** `compact_check`

Strips bloat fields from sessions.json before prompt build (throttled: 60s + 10KB threshold).

### `oc-stream-relay` (3 hooks, 1 tool)

**Hooks:** `gateway_start`, `gateway_stop`, `model_call_started`

**Tools:** `stream_relay_health`

Pure logic: `shouldRelay`, `shouldFallback`, `createRelayState`.

### `oc-context-cache` (3 hooks, 1 tool)

**Hooks:** `before_prompt_build`, `gateway_start`, `gateway_stop`

**Tools:** `context_cache_stats`

Pure logic: `getCached`, `putCached`, `invalidateExpired`, `getCacheStats` (TTL-based, in-memory Map).

### `oc-model-router` (2 hooks, 1 tool)

**Hooks:** `model_call_started`, `model_call_ended`

**Tools:** `model_health`

Pure logic: `computeP99`, `computeErrorRate`, `shouldFallback`, `getFastestModel`.

### `oc-subagent-watchdog` (2 hooks, 1 tool)

**Hooks:** `subagent_spawned`, `subagent_ended`

**Tools:** `subagent_health`

Pure logic: `trackSpawn`, `trackEnd`, `detectStale`, `getActiveCount`, `canSpawn` (in `subagent-tracker.ts`).

### `oc-session-guard` (2 hooks, 2 tools)

**Hooks:** `after_compaction`, `session_end`

**Tools:** `session_health`, `session_cleanup`

Direct file I/O (no sidecar). Uses `shared/session-cleanup.ts` pure logic + `sessions-io.ts` for read/write.

### `oc-event-loop-monitor` (3 hooks, 1 tool)

**Hooks:** `model_call_started`, `model_call_ended`, `gateway_stop`

**Tools:** `event_loop_health`

Uses real `perf_hooks` (monitorEventLoopDelay, eventLoopUtilization) + `v8.getHeapStatistics`. Aggregation logic is pure (`shared/telemetry-logic.ts`).

### `oc-e2e-trace-test` (1 hook, 0 tools)

**Hooks:** `gateway_start`

Test plugin for Level 2 E2E hook trace verification. Foundry-scaffolded.

## Design Principles

- **`api.on()` for all hooks** — `api.registerHook()` doesn't fire for typed lifecycle hooks (see above)
- **No OC core files modified** — plugin hooks + tool registration only (the `oc-source/` test bed handles OC core mods separately)
- **DFT: Design for Testability** — pure logic separated from I/O, deterministic clocks, injectable dependencies
- **CI Constitution: all commits gated** — typecheck, lint, unit, integration, Docker
- **Protocol-first** — each plugin declares its contract in the manifest
- **Composable** — plugins can be installed independently or together
- **Foundry-scaffolded** — new plugins are generated via `foundry new` and pass all six DFT axioms by construction

## Structure

```
plugins/
├── shared/                         # Shared pure logic (12 modules, 97% coverage)
│   ├── types.ts                    # PluginApi interface (includes on())
│   ├── session-cleanup.ts          # stripBloatFields, purgeStaleSubagents
│   ├── subagent-tracker.ts         # trackSpawn, trackEnd, detectStale
│   ├── work-queue-scheduler.ts     # createQueue, dispatchNext, recordResult
│   ├── telemetry-logic.ts          # aggregateSystemHealth
│   ├── sessions-io.ts              # readSessions, writeSessions (injectable path)
│   └── ... (6 more)
├── oc-subagent-orchestrator/       # 8 hooks, 7 tools
├── oc-topic-worker-pool/           # 6 hooks (semaphore admission)
├── oc-sidecar/                     # 2 hooks, 3 tools (worker pool process)
├── oc-compaction-helper/           # 4 hooks, 1 tool (bloat stripping)
├── oc-stream-relay/                # 3 hooks, 1 tool (stream relay)
├── oc-context-cache/               # 3 hooks, 1 tool (TTL cache)
├── oc-model-router/                # 2 hooks, 1 tool (model fallback)
├── oc-subagent-watchdog/           # 2 hooks, 1 tool (lifecycle tracking)
├── oc-session-guard/               # 2 hooks, 2 tools (direct file I/O)
├── oc-event-loop-monitor/          # 3 hooks, 1 tool (live telemetry)
└── oc-e2e-trace-test/              # 1 hook (test plugin)
```

## Installation

```bash
# Install individual plugins
openclaw plugins install ./ts/src/plugins/oc-session-guard
openclaw plugins install ./ts/src/plugins/oc-subagent-watchdog
openclaw plugins install ./ts/src/plugins/oc-event-loop-monitor

# Or install the full sidecar (includes all of the above)
openclaw plugins install ./ts/src/plugins/oc-sidecar
```

## Testing

Each plugin has its own test suite (wiring tests fire hooks + call tools via mock PluginApi). Shared pure logic is tested in `tests/plugins/shared/` and `tests/spec/`. All tests run in CI (typecheck → lint → unit → Docker integration).
