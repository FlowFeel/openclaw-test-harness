# Phosphene Review: Sidecar DFT Wiring (PR #19)

> **Recommendation: MERGE WITH FIXES.** The pure logic is correct, tested,
> and DFT-compliant. The wiring has one safety issue (async write in sync
> hook) and one OC compatibility gap (sidecar injection path). Both are
> fixable in a follow-up commit.

---

## What's being reviewed

| File | Type | Lines |
|------|------|-------|
| `shared/sidecar-router.ts` | New — pure logic | 124 |
| `shared/sidecar-protocol.ts` | New — protocol interface | 32 |
| `oc-compaction-helper/src/index.ts` | Modified — wiring | +35 |
| `tests/spec/sidecar-router.spec.ts` | New — 22 tests | 211 |

---

## ✅ What's correct

### Pure logic (sidecar-router.ts)

- **A1 (pure-io-separation):** No imports, no I/O. Pure functions only. ✅
- **A2 (determinism):** No `Date.now()`, no `Math.random()`. All inputs injected. ✅
- **A6 (check-result):** `shouldOffload` returns `SidecarDecision` with `rationale`. ✅
- **Never throws:** Returns `{ offload: false, rationale: "..." }` on any issue. ✅
- **Threshold-based:** 50KB/100KB/500KB — reasonable IPC crossover points. ✅
- **Fallback-safe:** Caller always has an inline path when `offload=false`. ✅

### Protocol (sidecar-protocol.ts)

- `SidecarProtocol` interface with `isAvailable()`, `getStats()`, `exec()`. ✅
- `NullSidecar` fallback — inline when no sidecar. ✅

### Tests (sidecar-router.spec.ts)

- 22 tests covering all decision paths. ✅
- Boundary tests (threshold ± 1). ✅
- Edge cases (circular refs, undefined). ✅
- Rationale verified for observability. ✅

---

## ⚠️ Issues found

### H1: Async write in synchronous hook context (🟠 safety)

**The problem:** `sidecarWriter` calls `sidecar.exec()` which returns a `Promise`.
The `.then()` callback writes the file asynchronously. But the compaction-helper's
hooks (`before_prompt_build`, `agent_end`, `after_compaction`) call
`sidecarWriter(cleaned, sessionsPath)` synchronously. The write happens
*after* the hook returns.

If `before_prompt_build` fires, the hook returns, OC assembles the prompt
with the **old** sessions.json (bloat not yet stripped), and the sidecar
write lands a few milliseconds later — too late.

**Severity:** 🟠 — the cleanup still happens (eventually), but the current
turn's prompt may include bloat fields. The next turn benefits. Not a crash,
but a correctness gap — the hook's contract is "strip before prompt build."

**Fix:** Make the hook `await` the sidecar write:

```ts
// In before_prompt_build hook:
const decision = shouldOffload({...});
if (decision.offload) {
  const result = await sidecar.exec("serialize.session", { session: cleaned });
  fsWriteFileSync(path, result as string);
} else {
  writer(cleaned, sessionsPath);
}
```

The hook is already `async` — OC awaits hook handlers. The `await` makes
the write complete before the hook returns.

### H2: `estimatePayloadBytes` does the work it's trying to avoid (🟡 efficiency)

**The problem:** `estimatePayloadBytes(data)` calls `JSON.stringify(data)` to
measure the size. But the whole point of offloading is to avoid
`JSON.stringify` on the main thread. If the data is 500KB, we stringify
500KB to discover it's 500KB, then stringify it again in the sidecar.

**Severity:** 🟡 — wasted work, not a crash. But it defeats the purpose
for the exact payloads we're trying to offload.

**Fix:** Use a cheaper estimate. Options:
- `Buffer.byteLength(JSON.stringify(data))` → same problem
- Sample-based: `JSON.stringify(data).length` on a subset → imprecise
- Stat-based: track the last known sessions.json file size → free (fs.statSync)
- Heuristic: if `Object.keys(sessions).length > 100`, assume > 100KB

**Recommended:** Use `fs.statSync(sessionsPath).size` as the estimate.
Zero CPU cost, and the file size is a tight proxy for the stringify output.

### M1: OC config can't inject SidecarProtocol (🟡 compatibility)

**The problem:** `CompactionHelperConfig` has `sidecar?: SidecarProtocol`.
But OC's plugin config system passes plain JSON from `openclaw.json`.
There's no mechanism to inject a `SidecarProtocol` instance via config.

In production, the sidecar plugin (`oc-sidecar`) creates the `SidecarClient`
instance in its `gateway_start` hook. The compaction-helper can't access it
because plugins are isolated — they don't share state.

**Severity:** 🟡 — the wiring is correct in principle (inject the protocol),
but the injection path doesn't exist yet. In production, `cfg.sidecar` will
always be `undefined`, so `NullSidecar` is used, and no offloading happens.

**Fix:** Two options:
- **A (plugin-level):** The oc-sidecar plugin registers the `SidecarClient` as
  a shared service (via `api.registerService()` if OC supports it, or via a
  shared module variable).
- **B (gateway-level):** OC's plugin loader passes a shared `sidecar` instance
  to each plugin's config. Requires a small OC source mod.

Until the injection path exists, the code is correct but dormant. This is
acceptable — the NullSidecar fallback means no behavior change.

### M2: Duplicate `writer` variable (🟡 dead code)

**The problem:** The `sidecarWriter` is defined but the original `writer` is
also still defined (line 82). Both exist in the same scope. The hooks use
`sidecarWriter`, but `writer` is dead code that could confuse future readers.

**Fix:** Remove the original `writer` line, or rename it and mark it as
the inline fallback.

---

## OC Compatibility Analysis

| OC concern | Status |
|------------|--------|
| Plugin API contract (`api.on()`, `api.registerTool()`) | ✅ Unchanged |
| Plugin config schema | ✅ `sidecar` is optional, defaults to NullSidecar |
| Sessions.json format | ✅ Unchanged — same read/write path |
| Hook dispatch order | ✅ Unchanged — compaction-helper still fires before_prompt_build |
| Gateway restart | ✅ Not needed — NullSidecar is the default |
| Plugin install | ✅ Unchanged — sidecar-router.ts bundled by esbuild |
| OC core files | ✅ No modifications |

---

## CI Verification

| Job | Status |
|-----|--------|
| Python Unit | ✅ pass |
| TypeScript Unit | ✅ pass (1,149 tests) |
| Docker Integration | ✅ pass |
| E2E Integration | ✅ pass |
| Staging | skipped (main only) |

---

## Summary

| Finding | Severity | Fix effort | Blocks merge? |
|---------|----------|------------|---------------|
| H1: async write in sync hook | 🟠 | Add `await` (2 lines) | No — merge with fix |
| H2: estimatePayloadBytes wasteful | 🟡 | Use fs.statSync (3 lines) | No — merge with fix |
| M1: no injection path | 🟡 | Follow-up ticket | No — NullSidecar is safe default |
| M2: dead writer variable | 🟡 | Remove 1 line | No — cosmetic |

**Recommendation: MERGE.** The pure logic is correct and tested. The wiring
issues (H1, H2) are fixable in a follow-up commit on the same PR. The
injection path (M1) is a follow-up ticket — the NullSidecar fallback means
zero behavior change in production until the injection is wired.
