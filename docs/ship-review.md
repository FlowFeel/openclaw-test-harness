# Ship Readiness Review: Plugin Suite

> **Recommendation: Ship to staging after Phase 0 fixes (done in this commit).**
> Two crash blockers and one high-risk inconsistency have been fixed. The
> remaining blocker (B2: `shared/` outside plugin dirs) requires an
> architecture decision — bundle, publish, or suite-install. For staging,
> use suite-install. For production, bundle.

---

## Summary

| Risk | Severity | Plugins affected | Fix effort | Status |
|------|----------|-----------------|------------|--------|
| **B1**: Missing `openclaw.extensions` in `package.json` | 🔴 Crash on install | `oc-topic-worker-pool`, `oc-e2e-trace-test` | 2 lines | ✅ Fixed |
| **B2**: `shared/` dependency outside plugin dir | 🔴 Crash at runtime load | 10 of 11 (all except `oc-sidecar`) | Architecture decision | ⏳ Pending |
| **H1**: `.ts` import extensions in orchestrator | 🟠 Inconsistency / breaks if built | `oc-subagent-orchestrator` | 11 import edits | ✅ Fixed |
| **M1**: `main` points to nonexistent `dist/` | 🟡 Wrong, may not crash | 9 of 11 | 9 lines | ✅ Fixed |
| **M2**: No build step | 🟡 Can't produce compiled JS | All | Build script or document jiti reliance | ⏳ Pending |

**What's ready:** The pure logic (15 modules, 97%+ coverage), the `api.on()` migration (all 36 hooks fire), the foundry validation (11/11 pass), the efficiency tests (26 tests), and the three gap modules (76 tests) are all correct, tested, and typecheck-clean. The blockers are all in the **packaging/wiring layer**, not the logic.

---

## 🔴 Blocker B1: Missing `openclaw.extensions` (crash on install)

### The problem

OC's plugin installer requires `package.json` to declare `openclaw.extensions` — an array of entry paths. Without it, install fails immediately:

```
package.json missing openclaw.extensions; update the plugin package to include
openclaw.extensions (for example ["./dist/index.js"])
```

Source: `oc-source/upstream/src/plugins/install-shared.ts:41`

### Affected plugins

| Plugin | `main` | `openclaw.extensions` | Install result |
|--------|--------|-----------------------|----------------|
| `oc-topic-worker-pool` | `src/index.ts` | **missing** | 🔴 Crash |
| `oc-e2e-trace-test` | `src/index.ts` | **missing** | 🔴 Crash (test plugin, lower priority) |
| (other 9) | `./dist/index.js` | `["./src/index.ts"]` | ✅ Passes |

### The fix

Add `"openclaw": { "extensions": ["./src/index.ts"] }` to both plugins' `package.json`:

```json
{
  "name": "oc-topic-worker-pool",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "openclaw": {
    "extensions": ["./src/index.ts"]
  },
  "dependencies": {}
}
```

**Effort:** 2 lines across 2 files. **This alone blocks `oc-topic-worker-pool` install.**

**✅ Fixed in this commit.** Both `oc-topic-worker-pool` and `oc-e2e-trace-test`
now declare `openclaw.extensions`.

---

## 🔴 Blocker B2: `shared/` dependency outside plugin directory

### The problem

10 of 11 plugins import pure logic from `../../shared/*.js`:

```ts
// oc-session-guard/src/index.ts
import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";
import { cleanupSessions, type SessionsMap } from "../../shared/session-cleanup.js";
```

When OC installs a plugin via `openclaw plugins install ./ts/src/plugins/oc-session-guard`, it copies **only the plugin directory** to `extensions/oc-session-guard/`. The import `../../shared/types.js` then resolves to `extensions/shared/types.js` — which **does not exist**. The plugin crashes on load.

`shared/` has no `package.json` — it's not an installable package, just a source directory.

### Affected plugins

| Plugin | `../../shared` imports | Crash on individual install? |
|--------|----------------------|---------------------------|
| `oc-subagent-orchestrator` | 12 | 🔴 Yes |
| `oc-compaction-helper` | 2 | 🔴 Yes |
| `oc-session-guard` | 2 | 🔴 Yes |
| `oc-event-loop-monitor` | 2 | 🔴 Yes |
| `oc-context-cache` | 1 | 🔴 Yes |
| `oc-model-router` | 1 | 🔴 Yes |
| `oc-stream-relay` | 1 | 🔴 Yes |
| `oc-subagent-watchdog` | 1 | 🔴 Yes |
| `oc-topic-worker-pool` | 1 | 🔴 Yes |
| `oc-e2e-trace-test` | 1 | 🔴 Yes |
| `oc-sidecar` | 0 | ✅ No (self-contained) |

### How the E2E test works around this

The E2E test (`tests/e2e/plugin-e2e.spec.ts`) manually copies `shared/` as a sibling into the container. This is a test-only workaround — `openclaw plugins install` does not do this.

### The fix (three options — pick one)

**Option A: Bundle `shared/` into each plugin at build time (recommended).**
Add a build step that compiles each plugin + its `shared/` dependencies into a single `dist/` directory per plugin. The `openclaw.extensions` field then points to `./dist/index.js`. This is the standard OC plugin pattern (the install error message itself suggests `["./dist/index.js"]`).

**Option B: Publish `shared/` as an npm package.**
Give `shared/` a `package.json` (`@flowfeel/oc-plugin-shared`), publish it, and add it as a dependency to each plugin's `package.json`. OC's installer runs `npm install` for plugin dependencies, so `shared/` would resolve from `node_modules/`. The imports change from `../../shared/types.js` to `@flowfeel/oc-plugin-shared/types.js`.

**Option C: Install as a suite, not individual plugins.**
Document that the plugins must be installed as a group with `shared/` as a sibling. Use OC's `plugins.load.paths` config (not `plugins install`) to point at the `ts/src/plugins/` directory. This avoids the install-time copy but requires the team to manage the directory layout.

**Recommendation:** Option A (bundle) for production. Option C (suite install) as a quick stopgap for testing. Option B if the team wants to publish `shared/` as a reusable library.

---

## 🟠 High Risk H1: `.ts` import extensions in orchestrator

### The problem

`oc-subagent-orchestrator/src/index.ts` imports from `.ts` files:

```ts
import { definePluginEntry, Type, type PluginApi } from "../../shared/types.ts";       // ← .ts
import { ... } from "../../shared/work-queue-scheduler.ts";                             // ← .ts
import { ... } from "../../shared/depth-limiter.ts";                                    // ← .ts
// ... 9 more .ts imports
```

All other 10 plugins import from `.js` files (the correct convention):

```ts
import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";       // ← .js
```

### Why it matters

- **Today (jiti source transform):** Both `.ts` and `.js` imports work. OC's plugin loader falls back to `jiti` for TS sources, and jiti resolves both extensions.
- **After building (Blocker B2 Option A):** `.ts` imports **break**. Node ESM does not allow `.ts` extensions in compiled output. TypeScript with `allowImportingTsExtensions: true` allows it in source, but the compiled `.js` files would have `from "...types.ts"` — which Node cannot resolve.
- **Inconsistency:** 1 plugin uses `.ts`, 10 use `.js`. This is a smell that indicates the orchestrator was hand-edited or scaffolded before the convention was established.

### The fix

Change all 11 imports in `oc-subagent-orchestrator/src/index.ts` from `.ts` to `.js`:

```diff
- import { definePluginEntry, Type, type PluginApi } from "../../shared/types.ts";
+ import { definePluginEntry, Type, type PluginApi } from "../../shared/types.js";
```

**Effort:** 11 find-and-replace edits in one file. The foundry scaffold already generates `.js` imports — this plugin was the only outlier.

**✅ Fixed in this commit.** All 11 imports in `oc-subagent-orchestrator/src/index.ts` now use `.js` extensions, consistent with the other 10 plugins.

---

## 🟡 Medium Risk M1: `main` points to nonexistent `dist/`

### The problem

9 of 11 plugins declare `"main": "./dist/index.js"` in `package.json`, but no `dist/` directory exists and there is no build script. The `main` field is what npm and Node use to resolve the package entry point.

OC's plugin loader uses `openclaw.extensions` (not `main`) to find the entry, so this **may not crash** during `openclaw plugins install`. But:
- If any tooling reads `main` (npm pack, IDE, `require()`, OC fallback), it fails.
- It's factually wrong — the file doesn't exist.
- The 2 plugins with `"main": "src/index.ts"` are correct.

### The fix

Until a build step exists (Blocker B2 Option A), change `main` to match the actual entry:

```json
"main": "src/index.ts"
```

After a build step is added, change it to `"./dist/index.js"` and make it true.

**Effort:** 9 one-line edits.

**✅ Fixed in this commit.** All 9 plugins now have `"main": "src/index.ts"`.

---

## 🟡 Medium Risk M2: No build step

### The problem

There is no `tsc` or build script in any plugin's `package.json` or the root `package.json`. The `tsconfig.json` has `outDir: "./dist"` but no `npm run build` command. The plugins ship as TypeScript source, relying on OC's `jiti` source-transform fallback to load them.

### Why it matters

- **OC has jiti:** The plugins will load via source transform. This works today.
- **Production performance:** jiti adds per-load overhead (several seconds on slower hosts, per OC's own comments in `plugin-module-loader-cache.ts`). Compiled JS is preferred for production.
- **Blocker B2:** If the team chooses Option A (bundle `shared/`), a build step is required anyway.
- **Node ESM compliance:** TypeScript source with `allowImportingTsExtensions: true` and `moduleResolution: "bundler"` is non-standard. Compiled JS with `.js` import extensions is standard.

### The fix

Add a build script to the root `package.json`:

```json
"scripts": {
  "build:plugins": "tsc -p tsconfig.plugins.json"
}
```

With a `tsconfig.plugins.json` that emits to `dist/` per plugin. Or use `tsdown`/`esbuild` for bundling (which also solves Blocker B2 Option A by bundling `shared/` into each plugin).

**Effort:** Medium — requires a tsconfig and build script. Not a crash blocker if the team accepts jiti loading.

---

## What IS ship-ready

The **logic layer** is correct, tested, and proven. None of the blockers are in the logic — they're all in the packaging/wiring layer:

| Layer | Status | Evidence |
|-------|--------|----------|
| Pure logic (15 modules) | ✅ Ship-ready | 97%+ coverage, 327 spec tests, DFT A1/A2/A6 compliant |
| `api.on()` migration | ✅ Ship-ready | All 36 hooks fire, E2E proven (commit `fa6f06a`) |
| Foundry validation | ✅ Ship-ready | 11/11 pass all six DFT axioms |
| Plugin wiring (hook handlers + tool execute) | ✅ Ship-ready | 120 wiring tests, mock PluginApi fires hooks + calls tools |
| Efficiency tests | ✅ Ship-ready | 26 tests, 6 hypotheses, 3 tiers |
| Gap modules (media-batcher, send-policy, progress-tracker) | ✅ Ship-ready | 76 tests, pure logic, DFT compliant |
| Typecheck | ✅ Clean | `tsc --noEmit` passes |
| **Plugin packaging** | 🔴 **Not ready** | B1, B2, H1, M1, M2 above |

---

## Recommended ship sequence

### Phase 0: Stopgap (ship to staging, not production) — ✅ DONE

Fix B1 + H1 + M1 (30 minutes of edits, no architecture changes):

1. **B1:** Add `openclaw.extensions` to `oc-topic-worker-pool` and `oc-e2e-trace-test` `package.json`.
2. **H1:** Change 11 `.ts` imports to `.js` in `oc-subagent-orchestrator/src/index.ts`.
3. **M1:** Change `main` from `./dist/index.js` to `src/index.ts` in 9 plugins.

After Phase 0, the plugins install and load via jiti (source transform). This is sufficient for **staging** — the team can verify hooks fire, tools register, and the `api.on()` fix works in a real OC.

**Blocker B2 workaround for staging:** Install the plugins as a suite using `plugins.load.paths` (Option C), not `openclaw plugins install`. Point OC at the `ts/src/plugins/` directory so `shared/` resolves as a sibling.

### Phase 1: Production ship (bundle + build)

Fix B2 (Option A) + M2:

1. Add a build step (`tsdown` or `tsc` + copy) that compiles each plugin with `shared/` bundled into `dist/`.
2. Update `openclaw.extensions` to `["./dist/index.js"]`.
3. Update `main` to `"./dist/index.js"` (now true).
4. Verify `openclaw plugins install ./ts/src/plugins/oc-session-guard` works for each plugin individually.

After Phase 1, the plugins are production-ready: individually installable, compiled JS (no jiti overhead), standard ESM.

### Phase 2: OC source mod (Gap 2 application)

The `document-send-policy.ts` pure logic is done, but applying the per-call `timeoutMs` requires an OC source mod (the gateway dispatcher doesn't read `timeoutMs` from the tool call payload). This is Phase C work, separate from the plugin ship.

---

## Verification commands

After Phase 0 fixes, the team can verify:

```bash
# Typecheck (must be clean)
cd ts && npm run typecheck

# CI suite (must be 1,091 passed)
cd ts && npx vitest run --config vitest.config.ci.ts

# Foundry validation (must be 11/11)
cd ts && for d in src/plugins/oc-*/; do
  npx tsx src/foundry/cli.ts validate "$d"
done

# Individual plugin install (after Phase 1 build)
openclaw plugins install ./ts/src/plugins/oc-session-guard
openclaw plugins install ./ts/src/plugins/oc-subagent-watchdog
openclaw plugins install ./ts/src/plugins/oc-event-loop-monitor

# Suite install (Phase 0 stopgap)
# In OC config:
# plugins.load.paths: ["./ts/src/plugins"]
```

---

## The bottom line

**The logic is proven. The packaging is not.** The plugin team should not `openclaw plugins install` any plugin until at least Phase 0 (B1 + H1 + M1) is done. For staging verification, use the suite-install workaround (Option C). For production, complete Phase 1 (bundle + build).

The good news: every blocker is a packaging/wiring issue, not a logic issue. The 15 pure-logic modules, the 36 `api.on()` hooks, the 19 tools, and the 1,091 tests are all correct. The ship blockers are mechanical fixes — package.json edits, import extension normalization, and a build step. None of them require rethinking the logic.
