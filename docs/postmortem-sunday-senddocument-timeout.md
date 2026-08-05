# Postmortem: Sunday Gateway WebSocket Timeout on sendDocument

> **Status:** Policy implemented and tested (`document-send-policy.ts`). Wiring
> pending — this document is the handoff to the plugin team that owns the
> message tool.

---

## The Incident

On Sunday, a synthesis file (232KB) was being sent to the Telegram chat via the
message tool's `sendDocument` path. Five subagents had just completed or were
completing, and the gateway was processing their completion events. The
`sendDocument` call hit the gateway's default 30-second websocket request
timeout. The first attempt timed out. The retry — fired immediately into the
same contention — failed with a network error.

The synthesis file never reached the chat.

## The Diagnosis

**The issue is gateway websocket contention under concurrent load, not file
size.**

When subagents are active and the gateway is processing multiple event streams,
the 30-second timeout on the message tool's gateway round-trip can be exceeded
even for moderate-sized payloads. Two factors compound:

1. **Base64 inflation.** File content is base64-encoded for the websocket
   payload, inflating it ~33% (232KB → ~309KB on the wire). This increases the
   serialization and transfer cost, but is not the primary cause.

2. **Concurrent event processing.** Five completing subagents generate
   completion events that the gateway must process on the same websocket. The
   `sendDocument` request queues behind these events. Under this contention,
   the gateway cannot complete the round-trip to the Telegram Bot API within
   30s — even though the Telegram API itself would respond in 2-5s.

The retry failed because it hit the **same contention** immediately, with no
backoff. The gateway was still draining the completion-event backlog when the
retry arrived.

### Why the 30s timeout is wrong for documents

The gateway client's default request timeout
(`DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS = 30_000` in
`packages/gateway-client/src/timeouts.ts`) is calibrated for text messages —
small payloads, no file I/O, no base64 inflation. The message tool passed no
`timeoutMs` override, so every send — text or document — got 30s.

The gateway client already supports a per-request override
(`protocol-client.ts:226`):

```ts
const timeoutMs =
  options?.timeoutMs === null ? undefined : (options?.timeoutMs ?? this.opts.requestTimeoutMs);
```

The fix is not to change the default. The fix is for the message tool to pass
the right `timeoutMs` for document sends.

## The Fix: Document Send Policy

A pure-logic policy module computes the timeout, retry schedule, and chunk
fallback for each send. The message tool wiring applies the plan.

**Module:** `ts/src/plugins/shared/document-send-policy.ts`
**Tests:** `ts/tests/spec/document-send-policy.spec.ts` (26 tests, all passing)

### Priority 1: Configurable, load-aware timeout

```ts
const timeoutMs = resolveDocumentSendTimeout({
  forceDocument: true,        // document, not text
  payloadBytes: 232_000,      // the file size
  concurrentLoad: 5,          // completing subagents / active gateway ops
});
// → 165,000ms (165s): 90s base + 5 × 15s load headroom
```

- **Text sends:** 30s (unchanged — the current default is correct for text).
- **Document sends:** 90s default (in the recommended 60-120s range).
- **Load-aware:** +15s per concurrent gateway operation, capped at 180s.

This alone would have prevented Sunday's failure. The 30s timeout becomes 165s
under 5-subagent load — well above the ~5s the Telegram API actually needs.

### Priority 2: Retry with exponential backoff

```ts
const schedule = resolveRetrySchedule();
// → [30_000, 60_000, 120_000]  (30s → 60s → 120s, 3 attempts)
```

The Sunday retry failed because it retried immediately into the same contention.
Exponential backoff gives the gateway time to drain the completion-event backlog
before each retry arrives. The schedule is capped at 120s per delay.

### Priority 3 (optional): Chunk large files as fallback

```ts
const plan = computeChunkPlan({
  payloadBytes: 232_000,
  timedOutOnce: true,         // only after a first timeout
});
// → { shouldChunk: true, chunkCount: 3, chunkSize: 100_000, lastChunkSize: 32_000 }
```

If the first send times out even with the load-aware timeout, fall back to
splitting the file into ~100KB parts and sending each as its own document. This
handles the case where the timeout is genuinely about payload size, not just
load. Triggered only after a prior timeout — not on every send.

### The complete plan

```ts
const plan = planDocumentSend({
  forceDocument: true,
  payloadBytes: 232_000,
  concurrentLoad: 5,
  chunk: { timedOutOnce: false },  // first attempt
});
// → {
//     timeoutMs: 165_000,
//     retryScheduleMs: [30_000, 60_000, 120_000],
//     chunkFallback: { shouldChunk: false, ... },
//     wireBytes: 309_334,
//     rationale: "document send: 165000ms timeout (232000B payload, 309334B wire);
//                 load-aware: 5 concurrent ops; retry: 3 attempts (30000→60000→120000ms)"
//   }
```

The `rationale` field is logged on every send, so postmortem analysis can
reconstruct the policy's reasoning.

## Wiring Instructions (for the plugin team)

The message tool's send path should apply the plan:

1. **Before sending:** Call `planDocumentSend(...)` with `forceDocument`,
   `payloadBytes`, and `concurrentLoad` (from the active subagent count or
   gateway queue depth).

2. **Pass `plan.timeoutMs`** as the gateway request's `options.timeoutMs`. This
   overrides the 30s default for document sends.

3. **On timeout:** Wait `plan.retryScheduleMs[i]` ms, then retry. Repeat up to
   `plan.retryScheduleMs.length` times.

4. **If all retries fail AND `plan.chunkFallback` was not triggered:** Re-plan
   with `chunk: { timedOutOnce: true }`. If `shouldChunk` is true, split the
   file and send each chunk as its own `sendDocument` call (each with its own
   load-aware timeout).

5. **Log `plan.rationale`** on every send attempt for observability.

### The `concurrentLoad` source

The `concurrentLoad` parameter is the number of gateway operations in flight.
The most direct source is the active subagent count (from
`SubagentTracker.getActiveCount()`) or the gateway client's pending-request
count. Either is a reasonable proxy for "how loaded is the gateway right now."

## What CI Proves

The policy module is pure logic (DFT axioms A1, A2, A6):

| Axiom | How it's satisfied |
|-------|--------------------|
| A1 (pure-io-separation) | No imports, no I/O. Pure functions only. |
| A2 (determinism) | No `Date.now()`, no `Math.random()`. Load and time are injected parameters. |
| A6 (check-result) | `planDocumentSend` returns a `DocumentSendPlan` with a `rationale` — never `void`. |

The 26 tests encode:
- The Sunday scenario (232KB, 5 subagents → 165s timeout, 3 retries, no chunk on first attempt)
- The Sunday scenario after first timeout (chunk fallback → 3 chunks)
- Text vs document timeout selection
- Load headroom scaling and capping
- Exponential vs linear backoff
- Chunk plan edge cases (exact multiples, custom sizes, no-timeout)
- The current broken behavior (30s, no retries) for comparison

## What Production Proves

CI proves the policy *computes the right plan*. Production proves the plan
*prevents the failure*. After the plugin team wires the policy:

1. Deploy with the message tool passing `plan.timeoutMs`.
2. Observe document sends under concurrent subagent load.
3. Confirm no 30s timeouts on `sendDocument` calls.
4. Confirm retries fire with backoff (not immediately) when contention spikes.
5. Confirm chunk fallback triggers only after a genuine timeout, not on every send.
