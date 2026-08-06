# Code Review: Junior Team PRs #18, #19, #20

> **Overall: Good direction, solid DFT instincts, but one foundry violation
> (now failing CI), several code-quality issues, and meaningful coverage gaps
> in the wiring layer. The pure logic is excellent; the wiring needs work.**

---

## What the junior team shipped (3 PRs, 7 commits)

| PR | Title | What it did |
|----|-------|-------------|
| #18 | fix: sidecar not starting — bundle sidecar-server.js + worker-entry.js | Extended `build-plugins.mjs` to bundle sidecar-server.ts + worker-entry.ts as extra entry points. Removed duplicate tool registrations (`subagent_health`, `session_health`, `event_loop_health`) from the orchestrator (they belonged to the sidecar). |
| #19 | feat: wire sidecar into compaction-helper via DFT pattern | New pure logic: `sidecar-protocol.ts` (Protocol interface + NullSidecar), `sidecar-registry.ts` (globalThis singleton), `sidecar-router.ts` (offload decision logic). Wired compaction-helper to use the sidecar for JSON.stringify offloading. 294 new tests. |
| #20 | fix: statSync path resolution — sessionsPath was undefined | Fixed the `statSync` path bug where `sessionsPath` was undefined in default config, causing `shouldOffload` to always return false. Changed registry singleton from module-level to `globalThis` so it survives esbuild bundling. |

---

## What's good (the junior team got right)

### 1. The DFT pattern is correctly applied

The three new `shared/` modules follow the established pattern exactly:

- **`sidecar-protocol.ts`** — Protocol interface (`SidecarProtocol`) + `NullSidecar` fallback. A5 (mock-doubles) compliant: real impl uses `fetch`, test impl is in-process.
- **`sidecar-registry.ts`** — Injectable singleton with `resetSidecarRegistry()` for tests. A5 compliant.
- **`sidecar-router.ts`** — Pure logic, no I/O, no `Date.now()`, returns `SidecarDecision` with rationale. A1, A2, A6 compliant. **This is the best file in the batch.**

### 2. The `globalThis` singleton insight is correct and well-documented

PR #20's fix — moving the sidecar registry from a module-level variable to `globalThis` — is the right call. The comment explains why: each plugin bundles its own copy of `sidecar-registry.ts` via esbuild, but they share `globalThis`. Without this, `oc-sidecar` would register to its bundle's copy and `oc-compaction-helper` would read from its own copy — never seeing the registration. This is a subtle esbuild bundling issue that's easy to miss. Good catch.

### 3. The `sidecar-router.ts` tests are thorough (21 tests)

The pure logic tests cover all decision paths: threshold checks, sidecar unavailable, pool full, unknown operation, fallback rationale, edge cases (exactly at threshold, threshold - 1). The circular reference test for `estimatePayloadBytes` is a nice touch. This is what A5 (real behavior, not mocks) looks like.

### 4. The build script extension is clean

Adding `sidecar-server.ts` and `worker-entry.ts` as extra entry points (PR #18) is the right approach. The `extraEntries` array is data-driven — adding a new process/worker entry is a one-line change. The `build-artifacts.spec.ts` test verifies all three artifacts exist and don't reference `.ts` paths. Good defensive testing.

### 5. The duplicate tool removal is correct

PR #18 removed `subagent_health`, `session_health`, and `event_loop_health` from the orchestrator — they were duplicates of tools the sidecar already registers. The manifest was updated to match. A3 (manifest-conformance) is maintained. The skipped tests were correctly marked `.skip` rather than deleted (they document the old behavior and can be re-enabled if the tools move back).

---

## What needs fixing

### 🔴 P0: Foundry violation — `oc-compaction-helper` fails DFT validation

```
✗ [pure-io-separation] src/index.ts: Entry file imports "node:fs" directly
  — I/O must go through the Protocol wrapper (*-io.ts), not node:fs.
```

`oc-compaction-helper/src/index.ts:34` imports `writeFileSync` and `statSync` from `node:fs` directly. This violates A1 (pure-io-separation) — the I/O should go through `sessions-io.ts`.

**The fix:** Move the `fsWriteFileSync` and `statSync` calls into `sessions-io.ts` behind the existing `SessionsReader`/`SessionsWriter` Protocol. The `sidecarWriter` should call a `writeSessionsString(path, string)` function from `sessions-io.ts`, not `fsWriteFileSync` directly. The `statSync` for payload size should be a `getSessionFileSize(path)` function in `sessions-io.ts`.

**Why it matters:** This is the first foundry failure since we got to 11/11. CI will reject any future commit to `oc-compaction-helper`. The violation was introduced in PR #19 and not caught because the foundry doesn't run in CI (it's a local check). **The foundry should be added to CI.**

### 🟠 P1: `sidecarWriter` ignores its `path` argument for the `statSync` estimate

```ts
const sidecarWriter = async (data: SessionsMap, path?: string) => {
  const payloadBytes = (() => {
    try {
      return statSync(sessionsPath ?? resolve(process.env.HOME || "/home/node", ".openclaw/agents/main/sessions/sessions.json")).size;
    } catch { return 0; }
  })();
```

The `statSync` uses the closure's `sessionsPath`, not the `path` argument. When `path` is passed (e.g., in tests with a temp dir), the estimate reads the wrong file (or throws and returns 0). PR #20's fix addressed the `sessionsPath ??` fallback but didn't fix the fundamental issue: **the `path` argument is ignored for the size estimate**.

**The fix:** `statSync(path ?? sessionsPath ?? defaultPath)`.

### 🟠 P2: `oc-sidecar/src/index.ts` has 0% coverage and a top-level `fetch` race

The hot-restart check at the top of `register()` fires a `fetch()` at module load time (not inside a hook):

```ts
register(api: PluginApi, config?: Record<string, unknown>) {
  const hotRestartPort = (config as any)?.sidecar?.port ?? 18900;
  fetch(`http://127.0.0.1:${hotRestartPort}/health`)
    .then(...)
    .catch(() => { /* Sidecar not running — will be started by gateway_start hook */ });
```

This is a **fire-and-forget async operation during plugin registration**. If `gateway_start` fires before the fetch resolves, both paths may try to register a sidecar — a race condition. The fetch has no timeout. If the port is closed, the OS takes ~1s to return ECONNREFUSED, during which the plugin is half-initialized.

**The fix:** Move the hot-restart check into the `gateway_start` hook (before `startSidecar`). Use `Promise.race` with a 200ms timeout. Only register if the fetch succeeds; otherwise fall through to `startSidecar`.

### 🟠 P3: `sidecar-manager.ts` has 5% coverage

`sidecar-manager.ts` (the process spawn/stop logic) is almost entirely untested. The `startSidecar` and `stopSidecar` functions spawn a child process — hard to test, but the `build-artifacts.spec.ts` only checks that files exist, not that they load or spawn correctly.

**The fix:** Add an integration test that starts the sidecar on an ephemeral port, verifies `/health` responds, and stops it. Use the same testcontainers pattern as the E2E suite, or a simpler `child_process.spawn` + `fetch` test with a 5s timeout.

### 🟡 P4: Duplicated bloat-scan loop in `oc-compaction-helper`

The `before_prompt_build` and `agent_end` hooks have **identical** 20-line bloat-scan loops:

```ts
let hasBloat = false;
let bloatBytes = 0;
for (const entry of Object.values(raw)) {
  if (typeof entry === "object" && entry !== null) {
    for (const field of bloatFields) {
      if (field in entry) {
        hasBloat = true;
        const fieldValue = (entry as Record<string, unknown>)[field];
        bloatBytes += JSON.stringify(fieldValue).length;
      }
    }
  }
}
```

This is the exact anti-pattern H2 (JSON.stringify scan cost) was written to expose. The scan loop is duplicated, and both copies do the expensive `JSON.stringify(fieldValue).length` per field.

**The fix:** Extract a `scanForBloat(sessions, bloatFields)` function into `session-cleanup.ts` (pure logic, tested). Replace both copies with a call to it. This also makes H2's regression guard more meaningful — the scan is in one place.

### 🟡 P5: `(config as any)` casts in `oc-sidecar/src/index.ts`

```ts
const hotRestartPort = (config as any)?.sidecar?.port ?? 18900;
```

The `SidecarPluginConfig` interface exists but isn't used for the config cast. The `as any` bypasses type safety. This appears twice (hot-restart check and the `gateway_start` hook).

**The fix:** `const cfg: SidecarPluginConfig = (config as SidecarPluginConfig) ?? {};` then `cfg.sidecar?.port ?? 18900`.

### 🟡 P6: Inconsistent port variable usage in `oc-sidecar/src/index.ts`

The `gateway_start` hook uses `hotRestartPort` for the client URL, but `sidecarPort` for `startSidecar`:

```ts
const sidecarPort = cfg.sidecar?.port ?? 18900;
// ...
sidecar = await startSidecar({ port: sidecarPort, ... });
client = createSidecarClient(`http://127.0.0.1:${hotRestartPort}`);  // ← different variable
```

They happen to have the same default (18900), but this is a latent bug — if someone changes `sidecarPort` without changing `hotRestartPort`, the client connects to the wrong port.

**The fix:** Use `sidecarPort` consistently. Remove `hotRestartPort` or alias it.

---

## Coverage assessment

### Overall: 80.5% statements (down from 88.5%)

The coverage dropped **8 percentage points** (88.5% → 80.5%) because the new wiring code (`oc-sidecar/src/index.ts` at 0%, `sidecar-manager.ts` at 5%, `oc-compaction-helper/src/index.ts` at 3.2%) is mostly untested. The pure logic is well-tested; the wiring is not.

| File | Coverage | Assessment |
|------|----------|------------|
| `sidecar-router.ts` (pure) | ~100% | ✅ Excellent — 21 tests |
| `sidecar-registry.ts` (pure) | 81.8% | ✅ Good — 6 tests |
| `sidecar-protocol.ts` (pure) | 80% | ✅ Good — covered via registry tests |
| `oc-sidecar/src/index.ts` (wiring) | **0%** | 🔴 Untested — all hook handlers + tools |
| `sidecar-manager.ts` (wiring) | **5%** | 🔴 Untested — spawn/stop logic |
| `oc-compaction-helper/src/index.ts` (wiring) | **3.2%** | 🔴 Untested — the new sidecarWriter + all hooks |
| `sidecar-client.ts` (wiring) | 88.2% | ✅ Good |
| `build-artifacts.spec.ts` | — | ✅ Good — verifies dist/ artifacts |

### The wiring coverage gap

The pure logic modules (`sidecar-router`, `sidecar-registry`, `sidecar-protocol`) are well-tested. But the wiring that *uses* them — the hook handlers in `oc-compaction-helper` and `oc-sidecar` — is almost entirely untested. This is the same pattern we saw before the wiring-test sprint: pure logic at 97%+, wiring at <10%.

**The fix:** Add wiring tests (like the 120 wiring tests we added for the other 6 plugins) that:
1. Create a mock `PluginApi` that captures hooks + tools
2. Fire the hook handlers with real temp dirs
3. Verify the sidecarWriter falls back to inline when sidecar is unavailable
4. Verify the offload decision is logged
5. Verify the throttle works
6. Verify the tool execute paths return correct JSON

---

## The foundry-in-CI gap

The P0 issue (foundry violation) was merged to `main` because **the foundry doesn't run in CI**. It's a local check (`npx tsx src/foundry/cli.ts validate`). This means any DFT violation can ship to main without being caught.

**Recommendation:** Add a "Foundry validation" step to the TypeScript Unit CI job, between typecheck and build:

```yaml
- name: Foundry validation
  run: |
    for d in src/plugins/oc-*/; do
      npx tsx src/foundry/cli.ts validate "$d" || exit 1
    done
```

This would have caught the `node:fs` import in PR #19 before it merged.

---

## Summary

| Area | Rating | Notes |
|------|--------|-------|
| Pure logic (`sidecar-router`, `sidecar-registry`, `sidecar-protocol`) | ✅ Excellent | DFT-compliant, well-tested, good rationale returns |
| Build script extension | ✅ Good | Clean extra-entry-points pattern, artifact tests |
| Duplicate tool removal | ✅ Good | Correct A3 (manifest-conformance) fix |
| `globalThis` singleton fix | ✅ Good | Subtle esbuild issue, well-documented |
| `oc-compaction-helper` wiring | 🔴 Needs work | Foundry violation (node:fs), 3.2% coverage, duplicated scan loop, path arg ignored |
| `oc-sidecar` wiring | 🔴 Needs work | 0% coverage, top-level fetch race, `as any` casts, inconsistent port vars |
| `sidecar-manager.ts` | 🟠 Needs tests | 5% coverage, spawn/stop untested |
| Foundry in CI | 🟠 Missing | DFT violations can ship to main undetected |

**Verdict:** The pure logic is ship-ready. The wiring needs one P0 fix (foundry violation), two P1-P2 fixes (path arg, fetch race), and wiring tests before it's production-ready. The foundry must be added to CI to prevent future violations.
