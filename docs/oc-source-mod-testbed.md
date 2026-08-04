# OC Source Mod Test Bed

The `oc-source/` directory is a test bed for modifying and testing the OpenClaw (OC) source repository itself. Unlike the plugin suite (which operates within OC's plugin API), the source mod test bed patches OC's internal code — specifically the hook runner — and proves the patches work with upstreamable patch+test pairs.

---

## Architecture

```
oc-source/
├── upstream/          ← git submodule: FlowFeel/openclaw@1aedd8f3 (clean mirror)
├── patches/
│   └── 0001-hook-debug-instrumentation.patch   ← code + OC-native test
└── README.md          ← this file's sibling
```

### Submodule, not clone-on-demand

The OC source is pinned as a git submodule (`oc-source/upstream/` → `FlowFeel/openclaw@1aedd8f3`). This gives us:

- **Reproducibility** — the exact commit is pinned in `.gitmodules`
- **Clean tree** — patches live as `.patch` files, the submodule stays pristine
- **Patch discipline** — mirrors `patch-package` conventions: patches are the source of truth, applied on top of a clean checkout

The submodule URL is HTTPS (not SSH) for CI portability.

### Patches as the source of truth

Each `.patch` file in `oc-source/patches/` is a single upstreamable PR. A patch contains:

1. **The code change** — modifications to OC source files (e.g., `src/plugins/hooks.ts`)
2. **An OC-native test** — a co-located test file using OC's own conventions (e.g., `src/plugins/hooks.trace.test.ts`)

Patch + test = one PR that can be submitted to `openclaw/openclaw` directly.

---

## Patch 0001: Hook Debug Instrumentation

**File**: `oc-source/patches/0001-hook-debug-instrumentation.patch` (510 lines)

### The problem

"Hooks not working" was a debugging black hole. Three root causes:

1. **Swallowed errors** — `catchErrors=true` (default) + no logger → errors vanished completely. A hook handler throws, the runner catches it, logs nothing (no logger configured), and returns as if nothing happened. Zero visibility.

2. **"Didn't fire" was invisible** — 9 silent `if (hooks.length === 0) return;` paths. When a hook has zero registered handlers, the runner returns immediately with no trace. The developer sees "my hook didn't fire" with no explanation — was it not registered? Filtered out? Gated by `hasHooks()`?

3. **No structured lifecycle** — there was no way to observe the full hook dispatch lifecycle. No event for "dispatch started with N handlers." You couldn't tell if a hook was called at all without adding temporary `console.log` statements.

### The fix

The patch adds a structured trace to `createHookRunner` in `src/plugins/hooks.ts`:

```typescript
const enableTrace = options.enableTrace ?? process.env.OPENCLAW_HOOK_DEBUG === "1";
const traceFile = process.env.OPENCLAW_HOOK_TRACE_FILE;
const traceEvents: TraceEvent[] = [];

const captureTrace = (event: TraceEvent) => {
  if (enableTrace) {
    const fullEvent = { ts: Date.now(), ...event };
    traceEvents.push(fullEvent);
    if (traceFile) {
      try { appendFileSync(traceFile, JSON.stringify(fullEvent) + "\n"); } catch {}
    }
  }
};
```

Three trace event types:

| Event type | When it fires | Key fields |
|-----------|---------------|------------|
| `dispatch` | A hook fires with ≥1 handlers | `hookName`, `handlerCount` |
| `error` | A handler throws | `hookName`, `pluginId`, `error`, `swallowed` |
| `no-handlers` | A hook fires with 0 handlers | `hookName`, `reason` (`not-registered` or `filtered-out`) |

### The `no-handlers` reason

When `hooks.length === 0`, the trace captures *why*:

```typescript
captureTrace({
  type: "no-handlers",
  hookName,
  reason: registry.typedHooks.filter(h => h.hookName === hookName).length > 0
    ? "filtered-out"
    : "not-registered"
});
```

- `not-registered` — no handler was ever registered for this hook name
- `filtered-out` — a handler exists but was filtered out (e.g., by tool matcher or eligible triggers)

### File trace output

The in-memory trace (`runner.getTrace()`) is inaccessible from outside the gateway process. The `OPENCLAW_HOOK_TRACE_FILE` env var appends each event as JSONL to a file, making the trace E2E-observable without in-process access:

```bash
OPENCLAW_HOOK_DEBUG=1 \
OPENCLAW_HOOK_TRACE_FILE=/tmp/hook-trace.jsonl \
openclaw gateway run
```

```json
{"ts":1785866135280,"type":"dispatch","hookName":"gateway_start","handlerCount":1}
{"ts":1785866135280,"type":"error","hookName":"gateway_start","pluginId":"oc-e2e-trace-test","error":"...","swallowed":true}
{"ts":1785866139637,"type":"dispatch","hookName":"gateway_stop","handlerCount":1}
```

### Zero overhead when disabled

When `enableTrace` is false (the default), `captureTrace` is a no-op — the `if (enableTrace)` guard short-circuits before any allocation or I/O. The Level 2 E2E test proves this: a gateway started without `OPENCLAW_HOOK_DEBUG` produces no trace file even when `OPENCLAW_HOOK_TRACE_FILE` is set.

### Opt-in

Trace is enabled via:
- `enableTrace: true` option to `createHookRunner` (programmatic)
- `OPENCLAW_HOOK_DEBUG=1` env var (runtime, no code change)

---

## Verification: Two Levels

### Level 1: Harness verification (`ts/tests/oc-source/hook-trace.spec.ts`)

6 specs. Applies the patch in `beforeAll`, dynamic-imports the patched `createHookRunner`, and asserts the three claims directly:

1. **Swallowed errors are captured** — a hook that throws with `catchErrors=true` + no logger produces a trace event with `swallowed: true`
2. **"Didn't fire" is explained** — a hook with no registered handlers produces a `no-handlers` event with `reason: "not-registered"`
3. **Successful dispatch is traced** — a hook that fires produces a `dispatch` event with `handlerCount`
4. **Zero overhead** — `enableTrace` not set → `getTrace()` returns `[]`
5-6. **OC-native test ships in the patch** — the co-located `hooks.trace.test.ts` exists and uses OC conventions

The patch is reverted in `afterAll` so the submodule stays clean.

### Level 2: E2E gateway verification (`ts/tests/oc-source/e2e-gateway-trace.spec.ts`)

9 specs. The real proof — a running OC gateway with all five trace event types verified end-to-end:

```
Container (node:24-bookworm)
  ├─ npm install openclaw@2026.6.8
  ├─ patch built hook runner (patch-built-hooks.mjs)
  ├─ install test plugin (oc-e2e-trace-test)
  ├─ start gateway with OPENCLAW_HOOK_DEBUG=1
  ├─ wait for gateway_start trace
  ├─ kill gateway → wait for gateway_stop trace
  ├─ read trace file → assert dispatch + error + dispatch
  ├─ zero-overhead test (no env → no trace)
  └─ no-handlers test (direct import → empty registry)
```

| Test group | What it proves |
|-----------|---------------|
| Lifecycle (5 tests) | `gateway_start` dispatch + swallowed error + `gateway_stop` dispatch + JSONL validity |
| Zero-overhead (2 tests) | Gateway starts without `OPENCLAW_HOOK_DEBUG` → no trace file created |
| No-handlers (2 tests) | Direct import from built dist → `no-handlers` event with `reason: "not-registered"` |

---

## Built-code patching (`ts/tests/support/patch-built-hooks.mjs`)

The full OC source build (`pnpm install` + `tsdown`) takes 15-20+ minutes. Instead, the E2E uses the npm tarball (`openclaw@2026.6.8`) which is already built, and patches the built dist directly.

The built `hook-runner-global-*.js` chunk is readable (tsdown doesn't minify — variable names are preserved), so string replacement is reliable. The patch script:

1. **Finds the chunk** — globs `hook-runner-global-*.js`, filters to the one containing `function createHookRunner` (the other is a 1-line re-export stub)
2. **Adds trace infrastructure** — `enableTrace`, `traceFile`, `traceEvents`, `captureTrace` (with `appendFileSync` import)
3. **Instruments the error handler** — captures `{ type: "error", swallowed }` before the swallow/throw decision
4. **Instruments all no-handlers returns** — 8 `if (hooks.length === 0) return;` paths → each captures `{ type: "no-handlers", reason }`
5. **Instruments dispatch** — 3 `logger?.debug?.(...)` lines → each captures `{ type: "dispatch", handlerCount }`
6. **Adds `getTrace`/`clearTrace`** to the runner return value
7. **Exposes `createHookRunner` on `globalThis`** — the built dist minifies exports, so `createHookRunner` can't be imported by name. The patch adds `globalThis.__createHookRunner = createHookRunner` so the no-handlers E2E test can call it directly.

The script reports match statistics for verification:
```
[patch-built-hooks] dispatch pattern matches: 3
[patch-built-hooks] no-handlers pattern matches: 8
[patch-built-hooks] error handler match: yes
[patch-built-hooks] patched hook-runner-global-Quvi-RcW.js (+2242 chars)
```

---

## Key discoveries during E2E development

### The dual API split

OC's plugin system has two hook registration APIs:

| API | Registry | Visible to `hasHooks()`? |
|-----|----------|--------------------------|
| `api.registerHook(events, handler, opts)` | `legacyInternalHooks` | ❌ NO |
| `api.on(hookName, handler, opts)` | `typedHooks` | ✅ YES |

`hasHooks()` and `getHooksForName()` only check `typedHooks`, which gates whether `gateway_start`/`gateway_stop` are dispatched. A plugin using `api.registerHook()` (legacy) registers the hook, but it's invisible to the dispatch gate — the hook is never called.

**All plugins that want their hooks to fire must use `api.on()`, not `api.registerHook()`.**

### `gateway_start` fires asynchronously

`gateway_start` fires ~2-4 seconds after `[gateway] ready` via `setImmediate`. The E2E polls for the trace file (up to 30s) rather than assuming immediate availability.

### Plugin manifest requires `configSchema`

OC rejects plugin manifests without a `configSchema` field. The minimal schema is:
```json
{ "type": "object", "additionalProperties": false, "properties": {} }
```

### `plugins.allow` whitelists external plugins

Non-bundled plugins must be explicitly allowed in the gateway config:
```json
{ "plugins": { "enabled": true, "allow": ["oc-e2e-trace-test"] } }
```

Without this, the plugin is discovered but not loaded.
