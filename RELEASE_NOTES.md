# Release Notes: Track B Plugin Suite Readiness & Release Toolchain

**Release Date:** September 11, 2026  
**Scope:** Track B OpenClaw Plugin Suite (`ts/src/plugins/`)  
**Target OpenClaw Compatibility:** `>=2026.6.8` (Tested on `2026.7.1`)

---

## Highlights

1. **Automated Packaging & Release Pipeline**:
   - Added `npm run pack:plugins` (`ts/scripts/pack-plugins.mjs`) to produce standalone, distributable `.tgz` archives for all 12 OpenClaw plugins via standard `npm pack`.
   - Created `.github/workflows/ship-plugins.yml` to automatically verify, package, tag (`plugins-v0.1.<count>.<sha>-oc-<version>`), and publish GitHub Releases with tarball assets and SHA256 checksum catalogs upon successful CI runs on `main`.
2. **Metadata & Manifest Uniformity**:
   - Standardized all plugins to `@flowfeel/` scoped package names in `package.json`.
   - Added explicit `openclaw.compat` declarations (`pluginApi: ">=2026.6.8"`, `minGatewayVersion: "2026.6.8"`) across all plugins.
3. **Crash-Safe File Persistence**:
   - Hardened `ts/src/plugins/shared/sessions-io.ts` with serialize-before-touch validation, `.bak` file preservation, and atomic temp-file replacement (`renameSync`). A process termination or crash mid-write cannot corrupt or truncate `sessions.json`.
4. **CI & Gherkin Traceability Integration**:
   - Integrated `ts/tests/features/traceability.spec.ts` ensuring 1:1 executable mapping between Gherkin `.feature` specifications and Vitest test scenarios.
   - Enforced automated foundry DFT validation (`npm run validate:foundry`) in CI to guarantee all plugins satisfy the six phosphene Design-for-Testability axioms.
5. **H7 Hook Loop Budget Verification**:
   - Implemented `ts/tests/oc-source/hook-loop-budget.spec.ts` verifying that 0-handler hook dispatch overhead is negligible (<1ms) against the real `createHookRunner`.

---

## Plugin Suite Inventory (12 Plugins)

| Plugin | Package Name | Entry Point | Tools | Hooks | Purpose |
|---|---|---|:---:|:---:|---|
| `oc-subagent-orchestrator` | `@flowfeel/oc-subagent-orchestrator` | `dist/index.js` | 4 | 8 | Priority work queue, depth limits, adaptive admission, result merging. |
| `oc-topic-worker-pool` | `@flowfeel/oc-topic-worker-pool` | `dist/index.js` | 0 | 6 | Counting semaphore admission per Telegram forum topic. |
| `oc-sidecar` | `@flowfeel/oc-sidecar` | `dist/index.js` | 2 | 2 | External worker pool process for CPU offloading and telemetry. |
| `oc-compaction-helper` | `@flowfeel/oc-compaction-helper` | `dist/index.js` | 1 | 4 | Throttled pre/post compaction bloat stripping with sidecar offloading. |
| `oc-stream-relay` | `@flowfeel/oc-stream-relay` | `dist/index.js` | 1 | 3 | Intercepts model calls to stream through worker pool with fallback. |
| `oc-context-cache` | `@flowfeel/oc-context-cache` | `dist/index.js` | 1 | 3 | TTL-based in-memory system prompt and context caching. |
| `oc-model-router` | `@flowfeel/oc-model-router` | `dist/index.js` | 1 | 2 | Latency and error rate tracking; routes calls to fastest healthy model. |
| `oc-subagent-watchdog` | `@flowfeel/oc-subagent-watchdog` | `dist/index.js` | 1 | 2 | Lifecycle tracking, active count limits, and stale subagent reaping. |
| `oc-session-guard` | `@flowfeel/oc-session-guard` | `dist/index.js` | 2 | 2 | Direct sessions bloat stripper and stale subagent purger. |
| `oc-event-loop-monitor` | `@flowfeel/oc-event-loop-monitor` | `dist/index.js` | 1 | 3 | Real `perf_hooks` (P99 delay, ELU) and V8 heap telemetry. |
| `oc-topic-manager` | `@flowfeel/oc-topic-manager` | `dist/index.js` | 2 | 1 | Forum topic orphan detection, idle/compact rules, idempotent recovery. |
| `oc-e2e-trace-test` | `oc-e2e-trace-test` | `dist/index.js` | 0 | 1 | Verification probe for Level 2 E2E hook tracing. |

---

## Verification & Build Commands

```bash
cd ts

# Run static checks
npm run typecheck
npm run validate:foundry

# Build bundles and package tarballs
npm run build:plugins
npm run pack:plugins

# Verify linting
npx eslint src/
```

## Installation by End Users / Agents

Using packaged `.tgz` archives:
```bash
openclaw plugins install ./dist-plugins/flowfeel-oc-session-guard-0.1.0.tgz
```

Using plugin directories:
```bash
openclaw plugins install ./ts/src/plugins/oc-session-guard
```
