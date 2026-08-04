# OC Source Mod Test Bed

Patches and tests for the OpenClaw (OC) source repository.

## Structure

```
oc-source/
├── upstream/          ← git submodule: FlowFeel/openclaw (clean mirror, pinned commit)
├── patches/
│   └── 0001-hook-debug-instrumentation.patch   ← code + OC-native test
└── README.md          ← this file
```

## Patches

### 0001: Hook Debug Instrumentation

Fixes the "hooks not working" debugging black hole by adding a structured trace to `createHookRunner`. Three trace event types: `dispatch`, `error` (with `swallowed` flag), `no-handlers` (with `reason`). JSONL file output via `OPENCLAW_HOOK_TRACE_FILE`. Zero overhead when disabled.

- **Code change**: `src/plugins/hooks.ts` — adds `captureTrace()`, instruments error handler, no-handlers returns, dispatch entries
- **OC-native test**: `src/plugins/hooks.trace.test.ts` — co-located, uses `createHookRunnerWithRegistry` + `TEST_PLUGIN_AGENT_CTX`
- **Patch + test = one upstreamable PR** for `openclaw/openclaw`

## Verification

- **Level 1** (`ts/tests/oc-source/hook-trace.spec.ts`, 6 specs): applies patch, dynamic-imports patched `createHookRunner`, asserts three claims directly
- **Level 2 E2E** (`ts/tests/oc-source/e2e-gateway-trace.spec.ts`, 9 specs): real running gateway, built-code patch, all five trace event types proven end-to-end

See [`docs/oc-source-mod-testbed.md`](../docs/oc-source-mod-testbed.md) for full architecture.

## Working with the submodule

```bash
# Initialize the submodule (after cloning)
git submodule update --init --recursive

# The submodule stays clean — patches are the source of truth
# To apply a patch locally for development:
cd upstream
git apply ../patches/0001-hook-debug-instrumentation.patch

# To revert:
git checkout -- .
```
