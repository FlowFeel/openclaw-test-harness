# The Fork Pivot — Two-Track Distribution

> **Amendment (2026-08-08).** This doc amends the OC source mod test bed
> (`docs/oc-source-mod-testbed.md`) and the plugin build & distribution model
> (`README.md` § Plugin Build & Distribution) in response to a pivot: we will
> run our own OC, and solve the major threading and bloat problems directly in
> OC source rather than at the plugin layer.
>
> `responds-to` the foundry-side amendment:
> [`agent-platform-foundry/specs/oc-platform-harness-fork-pivot.md`](https://github.com/FlowFeel/agent-platform-foundry/blob/main/specs/oc-platform-harness-fork-pivot.md)

## The Pivot

The "OC Core Issues — What Plugins Can't Fix" section of the README lists six
problems the plugin layer **cannot** solve because they are OC core behavior:

| # | OC Core Issue | Why Plugins Can't Fix It |
|---|---------------|--------------------------|
| 1 | Bloat field re-injection | OC re-adds `systemPromptReport`/`skillsSnapshot`/`compactionCheckpoints` every turn after the plugin strips them — ~15,000 tokens/turn |
| 2 | Per-call `timeoutMs` not applied | The dispatcher doesn't read `timeoutMs` from the payload |
| 3 | Synchronous compaction | Compaction runs on the main thread (200–500ms block); hooks fire before/after but can't make it async |
| 4 | JSON serialization overhead | `JSON.stringify`/`parse` vs `v8.serialize`/`MessagePort` |
| 5 | Single-thread contention | All serialization, parsing, skill resolution, channel polling compete on one thread; needs `worker_threads` + `SharedArrayBuffer` + `Atomics` |
| 6 | No graceful drain on restart | SIGUSR1 hot-reload kills all WebSockets; active subagents destroyed mid-task |

The plugins were always a workaround for these. Now that we run our own OC,
the source fix is available. **We will solve these directly in OC source.**

This does **not** retire the plugin suite. It establishes a two-track
distribution model.

---

## Two-Track Distribution

There are two kinds of consumer for what this repo produces. Both ship.

### Track A — Modified OC Fork

| Aspect | Value |
|--------|-------|
| Consumer | Anyone who controls their OC image and can run modified OC (the foundry, internal deployments) |
| Artifact | `FlowFeel/openclaw` fork with core mods committed directly |
| What it provides | The six core issues solved at the source — full fidelity, no workaround |
| Supersedes | The plugin workaround layer for the six core issues (Track A consumers don't need those plugins) |
| Residual plugins | `oc-event-loop-monitor` (telemetry — genuinely plugin-shaped, not a core behavior) |
| Proxy | Lives in the foundry (`oc-model-router` → Go OR proxy), not here |

Track A is the **ceiling** — the full-performance runtime with the core issues
solved natively.

### Track B — Plugin Suite

| Aspect | Value |
|--------|-------|
| Consumer | Groups who need plugins — upstream/stock OC consumers, environments that can't run a fork, external users |
| Artifact | The 11-plugin suite, self-contained `dist/index.js` bundles (existing ship capacity, unchanged) |
| What it provides | Best-effort mitigation for the six core issues where plugins can reach, plus the genuinely plugin-shaped capabilities (telemetry, tools) |
| Status | **Preserved as a live ship track.** Not deprecated, not archived. |
| Build | `scripts/build-plugins.mjs` (esbuild, unchanged) |

Track B is the **floor** — the workaround layer that runs on stock OC without
source mods. It is the distribution track for every consumer who cannot or will
not run the fork.

### Why both tracks

The six core issues are *partially* mitigable via plugins (Track B) and *fully*
solvable via core mods (Track A). The plugin suite is the right answer for a
consumer on stock OC; the fork is the right answer for a consumer who controls
their image. Shipping both means the work isn't hostage to a single deployment
model — and the plugin suite remains the upstreamable, portable expression of
the same runtime discipline.

---

## Fork Graduation

`FlowFeel/openclaw` graduates from a clean upstream mirror to **the OC Track A
consumers run.**

| Aspect | Before | After |
|--------|--------|-------|
| `FlowFeel/openclaw` | Clean mirror, pinned at upstream `1aedd8f3` | Fork we run; core mods committed directly |
| `oc-source/upstream` submodule | Tracks upstream mirror commits | Tracks fork commits |
| `oc-source/patches/` | All source mods, patch-on-clean submodule | **Upstreamable patches only** |
| Non-upstreamable core mods | (none) | Committed to the fork |

### Why the patch model doesn't scale to Track A

The patch-on-clean-submodule model (`oc-source/patches/*.patch` over a pristine
`FlowFeel/openclaw`) is sized for **upstreamable** small fixes — e.g. patch
0001 (hook trace instrumentation, 510 lines, one PR). It does **not** scale to
a threading rewrite: `worker_threads` runtime, async compaction, serialization
replacement, bloat-field removal. Those are thousands of lines across multiple
OC subsystems with real branch/merge history needs. A `.patch` file on a pinned
commit is the wrong tool.

The discipline splits cleanly by intent:

| Kind of change | Where it lives | Model | Track |
|----------------|----------------|-------|-------|
| Upstreamable small fixes (hook trace, `timeoutMs` dispatch) | `oc-source/patches/*.patch` | Unchanged — patch-on-clean, PR'd to `openclaw/openclaw` | Both (lands in fork + upstream) |
| Non-upstreamable core mods (threading, bloat, async compaction) | Committed to `FlowFeel/openclaw` fork | Real git history, never PR'd upstream (or PR'd only if generalizable) | A only |
| Plugin workaround layer | `ts/src/plugins/` | Self-contained `dist/index.js` bundles, unchanged | B only |

The two-level verification (Level 1 direct import, Level 2 E2E gateway) still
applies. For Track A it verifies fork HEAD (with core mods). For Track B it
verifies the plugin suite against stock OC (unchanged).

---

## Supersession Table (Track A perspective)

For Track A consumers, each superseded plugin maps to a fork core mod that
replaces it. For Track B consumers, the plugin is still the shipped solution.

| Superseded Plugin | Replaced By (Core Mod, Track A) | OC Core Issue |
|-------------------|---------------------------------|---------------|
| `oc-subagent-orchestrator` + `oc-topic-worker-pool` | Native multithreaded runtime (`worker_threads`, per-topic isolation, real parallelism) | #5 single-thread contention |
| `oc-compaction-helper` | Native async compaction off the main thread | #3 synchronous compaction |
| `oc-session-guard` | Native bloat stripping — no re-injection of `systemPromptReport`/`skillsSnapshot`/`compactionCheckpoints` | #1 bloat re-injection |
| `oc-context-cache` | Native system-prompt + context caching in core | (first product) |
| `oc-stream-relay` | Native stream relay in core | (first product) |
| `oc-subagent-watchdog` | Native subagent lifecycle + stale detection in core | (first product) |
| `oc-sidecar` | Native worker pool / CPU offloading in core | (first product) |
| `oc-model-router` | **Not superseded** — stays as the foundry's Go OR proxy (Track A only) | (first product) |
| `oc-event-loop-monitor` | **Not superseded** — kept as the residual plugin on both tracks (optional telemetry) | — |

Core mods without a plugin predecessor (Track A only):

| OC Core Issue | Core Mod |
|---------------|----------|
| #2 per-call `timeoutMs` | Dispatcher reads `timeoutMs` from the tool-call payload |
| #4 JSON serialization | `v8.serialize`/`MessagePort` for session state |
| #6 no graceful drain | SIGUSR1 drains active subagents before shutdown |

---

## What Changes Where

### This repo (`openclaw-test-harness`)

- `FlowFeel/openclaw` graduates mirror → fork. Track A core mods committed directly.
- `oc-source/patches/` retains only upstreamable patches.
- **Plugin suite preserved as Track B** — not deprecated, not archived. The
  11-plugin suite, the esbuild bundler, the 34-test smoke test, and the install
  instructions are all unchanged and remain a live ship track.
- Two-level verification now covers both tracks:
  - Track A: verify native runtime behavior (multithreading, no bloat re-injection, async compaction) against fork HEAD.
  - Track B: verify plugin behavior against stock OC (unchanged — the existing 1,133 tests).
- `oc-source/README.md` updated to describe the two-track model + fork graduation.

### `agent-platform-foundry` (Track A consumer)

- `docker/openclaw/Dockerfile` builds from `FlowFeel/openclaw@<pinned fork commit>` instead of `npm install openclaw@latest`.
- `plugins.json` shrinks to the residual set (`oc-event-loop-monitor` only) for Track A.
- Kitchen simulacrum fidelity criteria shift: `plugins.feature` → `core-runtime.feature`.
- The foundry is a Track A consumer. It does not consume Track B. See the foundry-side amendment for its changes.

---

## Costs, Named Honestly

1. **Upstream merge burden.** A fork with deep runtime mods must still merge
   upstream fixes. `worker_threads` changes touch the same hot files upstream
   changes touch — expect real merge-conflict cost. This is the price of Track A;
   it is worth it, but not free. Track B is unaffected (it runs on stock OC).
2. **Two verification surfaces, not one.** Track A core mods need their own
   proof (native runtime behavior). Track B plugin coverage (1,133 tests, 89%)
   is preserved for the plugin suite. The two-level model serves both, but a
   different surface is proven for each track. Coverage does not transfer
   between tracks.
3. **Dual maintenance for superseded capabilities.** While a capability exists
   as both a plugin (Track B) and a core mod (Track A), both must be maintained.
   The plugin is the workaround; the core mod is the fix. When/if a core mod
   becomes upstreamable, the plugin can be retired — but until then, both ship.
4. **Provenance discipline.** The superseded plugins are not deleted — they
   document *why* the core mods look the way they do. A Track A developer
   reading the fork's bloat-removal code benefits from the plugin's history of
   discovering the re-injection behavior. Provenance is preserved across tracks.

---

## Relationship to Existing Docs

| Doc | What This Amendment Changes |
|-----|------------------------------|
| `docs/oc-source-mod-testbed.md` | The patch-on-clean model is retained for upstreamable patches only; Track A core mods now live on the fork. This doc remains authoritative for the patch testbed. |
| `README.md` § OC Core Issues | These are now solvable via Track A (fork core mods). Track B (plugins) remains the best-effort mitigation. |
| `README.md` § Plugin Build & Distribution | This is Track B. Preserved as a live ship track, not deprecated. |
| `oc-source/README.md` | Updated to describe the two-track model + fork graduation. |
| Foundry `specs/oc-platform-harness-fork-pivot.md` | The foundry is a Track A consumer. Its amendment describes the consumer side; this doc is the author side. The two are a pair. |
