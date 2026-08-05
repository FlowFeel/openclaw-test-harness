# Plugin Gaps: The Application Layer

> The plugin team's concurrency infrastructure (tickets #18–#42) is the
> foundation. These three gaps are the application layer on top — outbound
> media batching, per-call timeout configuration, and subagent progress
> visibility. Each maps to the DFT pattern: pure logic in `shared/`, Protocol
> interface, mock doubles, BDD tests. No OC core files modified (except Gap 2
> which is deferred — an OC source mod, not plugin work).

---

## How the gaps map to the foundation

The team's roadmap already covers the concurrency infrastructure:

| Concurrency issue | Plugin / ticket | Status |
|-------------------|-----------------|--------|
| Subagent completion storms | `oc-subagent-orchestrator` (#18 work queue, #34 auto-dispatch) | Planned |
| Gateway bus contention | `oc-event-loop-monitor` (#29 real `perf_hooks` wiring) | Planned |
| Session scheduling fairness | `oc-topic-worker-pool` (#24 per-topic isolation) | Planned |
| Single-thread contention | `oc-sidecar` (#33 worker pool restoration) | Planned |
| Context window pressure | `oc-compaction-helper` (#30, bloat stripping) | Planned |

What's **not** in the roadmap yet — the three gaps below — sit on top of that
foundation. They're the outbound and observability layers the foundation
doesn't cover.

---

## Gap 1: Outbound `sendMediaGroup` (media batching)

**Status: Pure logic implemented + tested.** Wiring (the `before_tool_call`
hook) is the plugin team's next step.

### The problem

None of the 11 plugins touch the message tool's outbound path. The
`oc-topic-worker-pool` manages *inbound* topic admission, but there's no
*outbound* batch-send plugin. When the agent sends 10 documents in a single
turn, that's 10 separate `sendDocument` gateway round-trips — 10 chances to
hit the 30s timeout under load. This is the wrapper-completeness issue: OC
wraps Telegram's API but doesn't expose `sendMediaGroup` for outbound document
albums.

### The solution

Telegram's Bot API supports `sendMediaGroup`: 2–10 media items to the same
chat in a single API call. A `before_tool_call` hook detects multiple media
paths in the same turn and batches them into a single `sendMediaGroup` call
instead of N separate `sendDocument` calls.

### The pure logic

**Module:** `ts/src/plugins/shared/media-batcher.ts`
**Tests:** `ts/tests/spec/media-batcher.spec.ts` (29 tests)

```ts
import { batchMediaSends, shouldBatch } from "./shared/media-batcher.js";

// In the before_tool_call hook:
if (shouldBatch(pendingSends)) {
  const result = batchMediaSends(pendingSends);
  // Dispatch result.groups as sendMediaGroup calls
  // Dispatch result.singleSends as individual sendDocument calls
  // Send result.droppedCaptions as follow-up text if needed
  console.log(result.rationale); // "90% API call reduction (10 → 1)"
}
```

### What the logic guarantees (DFT axioms)

- **A1 (pure-io-separation):** no imports, no I/O.
- **A2 (determinism):** insertion order preserved, no randomness.
- **A6 (check-result):** `batchMediaSends` returns a `BatchResult` with
  `reductionPercent` — the report IS the proof.
- Groups never exceed 10 items (Telegram hard limit).
- Groups never mix chats (Telegram requires same chat).
- Single items (1 per chat) are never batched (`sendMediaGroup` needs ≥2).
- Only the first item's caption is kept per group (Telegram limitation); dropped captions are reported.

### The Sunday scenario, batched

10 documents to one chat: 10 `sendDocument` round-trips → 1 `sendMediaGroup`
round-trip. **90% API call reduction.** The single round-trip is far less
likely to hit the 30s timeout, and if it does, the `document-send-policy`
gives it 165s (not 30s).

---

## Gap 2: Configurable `timeoutMs` on the message tool

**Status: Pure logic implemented + tested.** The OC source mod to actually
apply the per-call timeout is **deferred** (not plugin work — it's a Phase C
patch like Patch 0001).

### The problem

The gateway client's default request timeout
(`DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS = 30_000`) is calibrated for text
messages. The message tool passed no `timeoutMs` override, so every send —
text or document — got 30s. The gateway client already supports a per-request
override (`protocol-client.ts:226`:

```ts
const timeoutMs =
  options?.timeoutMs === null ? undefined : (options?.timeoutMs ?? this.opts.requestTimeoutMs);
```

), but the message tool never passed one.

### The solution (pure logic — done)

**Module:** `ts/src/plugins/shared/document-send-policy.ts`
**Tests:** `ts/tests/spec/document-send-policy.spec.ts` (26 tests)

The policy computes the right `timeoutMs` for each send:

```ts
import { planDocumentSend } from "./shared/document-send-policy.js";

const plan = planDocumentSend({
  forceDocument: true,
  payloadBytes: 232_000,
  concurrentLoad: 5,  // from SubagentTracker.getActiveCount()
});
// plan.timeoutMs → 165_000 (90s base + 5 × 15s load headroom)
// plan.retryScheduleMs → [30_000, 60_000, 120_000] (exponential backoff)
// plan.chunkFallback → { shouldChunk: false, ... } (first attempt)
```

### What's deferred (OC source mod)

The plugin can *compute* the right timeout (done), but can't *apply* it — the
gateway's tool-call dispatcher doesn't read a `timeoutMs` from the tool call
payload. Applying it requires a small, upstreamable patch to OC's internal
dispatch path (same pattern as Patch 0001: hook debug instrumentation),
verified at Level 1 (direct import) and Level 2 (real running gateway). This
is Phase C work, not plugin work.

### What the plugin team can do now

Wire the policy into the `oc-event-loop-monitor` (#29) so the computed
`timeoutMs` is available as a tool-call hint. When the OC source mod lands,
the dispatcher reads the hint and applies it. Until then, the policy is the
contract — the plugin computes, the dispatcher will apply.

---

## Gap 3: Subagent progress events

**Status: Pure logic implemented + tested.** Wiring (extending the
`SubagentSupervisor` Protocol with a heartbeat signal) is the plugin team's
next step.

### The problem

The `oc-subagent-watchdog` (#35) detects subagents that have crashed or timed
out. But it only fires on terminal events (`subagent_ended`). A subagent
running for 2 minutes could be on track (50% done, heartbeating every 60s) or
stuck (hung on a bad web search, no heartbeat). Without intermediate progress,
the orchestrator can't tell until the run timeout fires — wasting the timeout
window.

### The solution

Extend the `SubagentSupervisor` Protocol (#15) with a heartbeat signal: the
supervised child emits a lightweight `{status: "progress", pct: 0.5}` message
every 60s via the MessagePort. The `oc-subagent-watchdog` listens and exposes
it via a `subagent_progress` tool. The orchestrator can then make adaptive
decisions: wait, retry, reassign, or kill.

### The pure logic

**Module:** `ts/src/plugins/shared/subagent-progress-tracker.ts`
**Tests:** `ts/tests/spec/subagent-progress-tracker.spec.ts` (21 tests)

```ts
import { trackProgressStart, recordProgress, detectStuck } from "./shared/subagent-progress-tracker.js";

// On subagent spawn:
let map = trackProgressStart(map, "task:1", nowMs, 120_000 /* expectedDuration */);

// On each heartbeat (from the MessagePort):
map = recordProgress(map, "task:1", 0.5, nowMs);

// Periodic check:
const result = detectStuck(map, 60_000 /* maxHeartbeatAge */, nowMs);
// result.stuckTaskIds → tasks needing intervention
// result.onTrackTaskIds → tasks progressing normally
// result.staleHeartbeatTaskIds → tasks whose heartbeat went stale
// result.noHeartbeatTaskIds → tasks that never heartbeated (may be within grace)
```

### What the logic guarantees (DFT axioms)

- **A1 (pure-io-separation):** no imports, no I/O.
- **A2 (determinism):** all timestamps injected, no `Date.now()`.
- **A6 (check-result):** `detectStuck` returns a `StuckDetectionResult` — the
  categorization IS the report.
- State is immutable (each operation returns a new `Map`).
- Progress pct is clamped to [0, 1].
- History is capped (default 20) for trend analysis without unbounded growth.
- `computeProgressRate` detects stalled tasks (heartbeating but not advancing).

### The three categories

`detectStuck` distinguishes three states, each with a different response:

| Category | Meaning | Response |
|----------|---------|----------|
| `onTrack` | Recent heartbeat, progress advancing | Wait |
| `staleHeartbeat` | Had a heartbeat but it's old | Investigate — may be hung |
| `noHeartbeat` (past grace) | Never heartbeated, past grace period | Likely crashed — retry/kill |

The grace period (=`maxHeartbeatAgeMs`) gives new subagents time to send their
first heartbeat before being flagged. A subagent that started 10s ago with no
heartbeat is `noHeartbeat` but NOT `stuck` (within grace). A subagent that
started 100s ago with no heartbeat is `stuck` (past grace).

### Bonus: `computeProgressRate`

A subagent that's heartbeating but stuck at the same pct (e.g., 0.5 for 3
heartbeats) has a progress rate of 0. `computeProgressRate` detects this —
distinguishing "slow but progressing" from "stalled in a retry loop." The
watchdog can flag zero-rate subagents even before the heartbeat goes stale.

---

## Summary: the application layer

| Gap | Pure logic | Tests | Wiring (plugin team) | OC source mod? |
|-----|-----------|-------|----------------------|----------------|
| 1. `sendMediaGroup` outbound | `media-batcher.ts` ✅ | 29 ✅ | `before_tool_call` hook in new plugin or `oc-topic-worker-pool` extension | No |
| 2. Configurable `timeoutMs` | `document-send-policy.ts` ✅ | 26 ✅ | `oc-event-loop-monitor` exposes the hint | Yes (deferred) |
| 3. Subagent progress | `subagent-progress-tracker.ts` ✅ | 21 ✅ | `SubagentSupervisor` Protocol heartbeat + `oc-subagent-watchdog` listener | No |

**Total: 76 new tests across 3 pure-logic modules.** All DFT-compliant (A1
pure, A2 deterministic, A6 report). No OC core files modified. The pure logic
is the contract; the wiring is the plugin team's implementation against it.

### Test state after this work

- **1,091 CI tests** (was 1,041), 76 new across 3 modules
- **Typecheck:** clean
- All three modules pass the DFT axioms by construction (pure, deterministic,
  report-returning)
