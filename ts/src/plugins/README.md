# Plugin Builder Directory

Each subdirectory is a standalone OC plugin with its own manifest, entry point, tests, and CI gating.

## Plugins

| Plugin | Focus | Hooks | Tools |
|--------|-------|-------|-------|
| `oc-sidecar` | Worker pool offloading + sidecar process | `gateway_start/stop` | `sidecar_health`, `sidecar_exec`, `session_health` |
| `oc-session-guard` | Session bloat management | `after_compaction`, `session_end` | `session_health`, `session_cleanup` |
| `oc-subagent-watchdog` | Subagent lifecycle tracking | `subagent_spawned`, `subagent_ended` | `subagent_health` |
| `oc-event-loop-monitor` | Live telemetry | `model_call_started/ended`, `agent_end` | `event_loop_health` |

## Design Principles

- **No OC core files modified** — plugin hooks + tool registration only
- **DFT: Design for Testability** — pure logic separated from I/O, deterministic clocks, injectable dependencies
- **CI Constitution: all commits gated** — typecheck, lint, unit, integration, Docker
- **Protocol-first** — each plugin declares its contract in the manifest
- **Composable** — plugins can be installed independently or together

## Structure

```
plugins/
├── oc-sidecar/              # Sidecar process + worker pool
│   ├── openclaw.plugin.json
│   ├── package.json
│   └── src/
│       ├── index.ts         # Plugin entry
│       ├── types.ts         # Local type declarations
│       ├── session-cleanup.ts   # Pure cleanup logic (shared)
│       ├── telemetry-logic.ts   # Pure telemetry logic (shared)
│       ├── sidecar-manager.ts
│       ├── sidecar-client.ts
│       ├── sidecar-server.ts
│       └── worker-entry.ts
├── oc-session-guard/        # Session bloat management (standalone)
│   ├── openclaw.plugin.json
│   ├── package.json
│   └── src/
│       ├── index.ts         # Plugin entry (hooks only, no sidecar)
│       ├── session-cleanup.ts   # Shared pure logic
│       └── sessions-io.ts      # Direct file I/O (no sidecar needed)
├── oc-subagent-watchdog/    # Subagent lifecycle tracking
│   ├── openclaw.plugin.json
│   ├── package.json
│   └── src/
│       ├── index.ts         # Plugin entry
│       ├── subagent-tracker.ts  # Pure tracking logic
│       └── stale-detector.ts    # Pure stale detection
├── oc-event-loop-monitor/   # Live telemetry (standalone)
│   ├── openclaw.plugin.json
│   ├── package.json
│   └── src/
│       ├── index.ts         # Plugin entry
│       ├── telemetry-logic.ts   # Shared pure logic
│       └── telemetry-collector.ts  # Real perf_hooks collector
└── shared/                  # Shared pure logic
    ├── session-cleanup.ts   # Pure: stripBloat, purgeStale, cleanupReport
    ├── telemetry-logic.ts   # Pure: aggregateSystemHealth
    └── types.ts             # Shared type declarations
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

Each plugin has its own test suite. Shared pure logic is tested in `tests/plugins/shared/`.
All tests run in CI (typecheck → lint → unit → Docker integration).
