/**
 * Document send policy — pure logic for gateway websocket send timeouts.
 *
 * @behavior
 * Computes the timeout, retry schedule, and chunk-fallback plan for sending
 * a message or document through the gateway websocket. The caller (the
 * message tool's wiring layer) passes the plan's `timeoutMs` as the gateway
 * request's `options.timeoutMs`, runs the retries on timeout, and falls back
 * to chunked sends when a first attempt times out.
 *
 * @why
 * On Sunday, a 232KB synthesis file's `sendDocument` call hit the gateway's
 * default 30-second request timeout while 5 subagents were completing and the
 * gateway was processing their completion events. The first attempt timed out;
 * the retry hit the same contention and failed with a network error. The root
 * cause was not file size alone — it was gateway websocket contention under
 * concurrent load, with a timeout calibrated for text messages, not documents.
 *
 * The gateway client already supports a per-request `timeoutMs` override
 * (`protocol-client.ts`: `options?.timeoutMs ?? this.opts.requestTimeoutMs`).
 * The default `requestTimeoutMs` is `DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS`
 * (30,000ms). The message tool passed no override, so every send — text or
 * document — got 30s. This module computes the override the message tool
 * should pass.
 *
 * @invariants
 * - All functions are pure: input → output, no side effects, no I/O.
 * - Deterministic: no `Date.now()`, no `Math.random()`. All inputs are
 *   parameters. Time and load are injected by the caller.
 * - `planDocumentSend` returns a `DocumentSendPlan` (the report, A6) — never
 *   `void`. The plan IS the proof that the policy handles the scenario.
 * - Base64 inflation is accounted for: `wireBytes = ceil(payloadBytes * 4/3)`.
 *   The timeout decision uses wire bytes (what crosses the websocket); the
 *   chunk decision uses payload bytes (the file is split, not the encoding).
 *
 * @dft
 * - A1 (pure-io-separation): no imports, no I/O.
 * - A2 (determinism): no Date.now()/Math.random(); load and time are injected.
 * - A6 (check-result): planDocumentSend returns a plan with a rationale.
 */

// ── Types ─────────────────────────────────────────────────────

/**
 * Inputs to the document send timeout computation.
 *
 * Every field has a default calibrated to the Sunday incident:
 * - `baseTimeoutMs` (30s) — the text-message default, matching
 *   `DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS`.
 * - `documentTimeoutMs` (90s) — the document default, in the recommended
 *   60-120s range.
 * - `loadHeadroomMs` (15s) — extra timeout per concurrent gateway operation.
 *   Five completing subagents add 75s of headroom.
 * - `maxTimeoutMs` (180s) — the hard cap, preventing unbounded scaling.
 */
export interface DocumentSendTimeoutInput {
  /** True when the send is a file/document (forceDocument), false for text. */
  forceDocument: boolean;
  /** The raw payload size in bytes (pre-base64). */
  payloadBytes: number;
  /** Default timeout for text messages. Defaults to 30,000ms. */
  baseTimeoutMs?: number;
  /** Default timeout for document sends. Defaults to 90,000ms (60-120s range). */
  documentTimeoutMs?: number;
  /** Number of concurrent gateway operations (e.g. completing subagents). */
  concurrentLoad?: number;
  /** Extra timeout per unit of concurrent load. Defaults to 15,000ms. */
  loadHeadroomMs?: number;
  /** Hard cap on the computed timeout. Defaults to 180,000ms. */
  maxTimeoutMs?: number;
}

/**
 * Inputs to the retry schedule computation.
 *
 * The Sunday retry failed because it hit the same contention immediately.
 * Exponential backoff gives the gateway time to drain the completion events
 * before the retry arrives.
 */
export interface RetryScheduleInput {
  /** Number of retry attempts. Defaults to 3. */
  attempts?: number;
  /** Base delay (first retry). Defaults to 30,000ms. */
  baseDelayMs?: number;
  /** Strategy: "exponential" (2^i) or "linear" (1×i). Defaults to "exponential". */
  strategy?: "exponential" | "linear";
  /** Hard cap on any single delay. Defaults to 120,000ms. */
  maxDelayMs?: number;
}

/**
 * Inputs to the chunk-fallback computation.
 *
 * Chunking is the optional last resort: if the first send times out, split
 * the file into ~100KB parts and send each as its own document. This handles
 * the case where the timeout is genuinely about payload size, not just load.
 */
export interface ChunkPlanInput {
  /** The raw payload size in bytes (pre-base64). */
  payloadBytes: number;
  /** Target chunk size in bytes. Defaults to 100,000 (~100KB). */
  chunkSizeBytes?: number;
  /** Whether a previous send timed out (triggers the chunk fallback). */
  timedOutOnce?: boolean;
}

/** The chunk-fallback plan (A6 report). */
export interface ChunkPlan {
  /** Whether chunking should be applied. */
  shouldChunk: boolean;
  /** Number of chunks (1 if not chunking). */
  chunkCount: number;
  /** Size of each full chunk in bytes. */
  chunkSize: number;
  /** Size of the final (possibly partial) chunk in bytes. */
  lastChunkSize: number;
  /** Total payload bytes (echoed for the report). */
  totalBytes: number;
  /** Why this decision was made (for logging). */
  rationale: string;
}

/**
 * The complete document send plan — the A6 report.
 *
 * The message tool wiring applies this plan:
 * 1. Send with `timeoutMs`.
 * 2. On timeout, wait `retryScheduleMs[i]` and retry (up to `retryScheduleMs.length` retries).
 * 3. If still failing and `chunkFallback.shouldChunk`, switch to chunked sends.
 */
export interface DocumentSendPlan {
  /** The gateway request timeout to pass as `options.timeoutMs`. */
  timeoutMs: number;
  /** Delays (ms) before each retry attempt. Empty array = no retries. */
  retryScheduleMs: number[];
  /** The chunk-fallback plan, or null if chunking is not applicable. */
  chunkFallback: ChunkPlan | null;
  /** Estimated wire bytes (base64-inflated) for logging. */
  wireBytes: number;
  /** Why this plan was chosen (for logging and postmortem analysis). */
  rationale: string;
}

// ── Pure logic ────────────────────────────────────────────────

/**
 * Compute the wire (on-the-wire) byte count for a payload.
 *
 * Base64 encoding inflates binary content by ~4/3 (33%). The gateway
 * websocket carries the base64-encoded payload, so the timeout decision
 * should account for wire bytes, not raw bytes.
 *
 * Pure: ceil(payloadBytes * 4 / 3). No rounding ambiguity.
 */
export function computeWireBytes(payloadBytes: number): number {
  if (payloadBytes <= 0) return 0;
  return Math.ceil((payloadBytes * 4) / 3);
}

/**
 * Resolve the gateway request timeout for a document or text send.
 *
 * Logic:
 * 1. Text sends use `baseTimeoutMs` (30s) — no change from the current default.
 * 2. Document sends use `documentTimeoutMs` (90s) — in the 60-120s range.
 * 3. Under concurrent load, document sends get `loadHeadroomMs` per concurrent
 *    operation, giving the gateway time to drain completion events.
 * 4. The result is capped at `maxTimeoutMs` (180s).
 *
 * The Sunday scenario: forceDocument=true, concurrentLoad=5 →
 * 90,000 + 5 × 15,000 = 165,000ms (165s). Well above the 30s that failed.
 */
export function resolveDocumentSendTimeout(input: DocumentSendTimeoutInput): number {
  const {
    forceDocument,
    baseTimeoutMs = 30_000,
    documentTimeoutMs = 90_000,
    concurrentLoad = 0,
    loadHeadroomMs = 15_000,
    maxTimeoutMs = 180_000,
  } = input;

  // Text sends: no load scaling. The 30s default is calibrated for text.
  if (!forceDocument) {
    return Math.min(baseTimeoutMs, maxTimeoutMs);
  }

  // Document sends: base document timeout + load headroom, capped.
  const loadAdjustment = Math.max(0, concurrentLoad) * loadHeadroomMs;
  const computed = documentTimeoutMs + loadAdjustment;
  return Math.min(computed, maxTimeoutMs);
}

/**
 * Compute the retry delay schedule for sendDocument retries.
 *
 * The Sunday retry failed because it retried immediately into the same
 * contention. Exponential backoff (30s → 60s → 120s) gives the gateway
 * time to drain the completion-event backlog before each retry.
 *
 * Returns an array of delays (ms), one per retry attempt. The caller waits
 * `schedule[i]` ms before the (i+1)th retry.
 */
export function resolveRetrySchedule(input: RetryScheduleInput = {}): number[] {
  const {
    attempts = 3,
    baseDelayMs = 30_000,
    strategy = "exponential",
    maxDelayMs = 120_000,
  } = input;

  if (attempts <= 0) return [];

  const schedule: number[] = [];
  for (let i = 0; i < attempts; i++) {
    const multiplier = strategy === "exponential" ? Math.pow(2, i) : i + 1;
    const delay = Math.min(baseDelayMs * multiplier, maxDelayMs);
    schedule.push(delay);
  }
  return schedule;
}

/**
 * Compute the chunk-fallback plan.
 *
 * Chunking is triggered only when a previous send timed out
 * (`timedOutOnce === true`) AND the payload exceeds the chunk size.
 * A 232KB file with 100KB chunks → 3 chunks (100KB, 100KB, 32KB).
 *
 * Returns a ChunkPlan (A6 report) with the chunk count and sizes.
 */
export function computeChunkPlan(input: ChunkPlanInput): ChunkPlan {
  const {
    payloadBytes,
    chunkSizeBytes = 100_000,
    timedOutOnce = false,
  } = input;

  // Don't chunk if the payload fits in one chunk or if we haven't timed out yet.
  if (!timedOutOnce || payloadBytes <= chunkSizeBytes) {
    return {
      shouldChunk: false,
      chunkCount: 1,
      chunkSize: payloadBytes,
      lastChunkSize: payloadBytes,
      totalBytes: payloadBytes,
      rationale: timedOutOnce
        ? "payload fits in one chunk; no split needed"
        : "no prior timeout; chunking not yet triggered",
    };
  }

  const chunkCount = Math.ceil(payloadBytes / chunkSizeBytes);
  const lastChunkSize = payloadBytes - chunkSizeBytes * (chunkCount - 1);

  return {
    shouldChunk: true,
    chunkCount,
    chunkSize: chunkSizeBytes,
    lastChunkSize,
    totalBytes: payloadBytes,
    rationale: `prior timeout; splitting ${payloadBytes}B into ${chunkCount} chunks of ≤${chunkSizeBytes}B`,
  };
}

/**
 * Compute the complete document send plan.
 *
 * This is the orchestrator: it calls the three pure functions above and
 * assembles a `DocumentSendPlan` (the A6 report). The message tool wiring
 * applies the plan — this function makes the decisions, the wiring executes
 * them.
 *
 * The plan's `rationale` field captures why each decision was made, so the
 * postmortem log can reconstruct the policy's reasoning.
 */
export function planDocumentSend(
  input: DocumentSendTimeoutInput & {
    retry?: RetryScheduleInput;
    chunk?: Omit<ChunkPlanInput, "payloadBytes">;
  },
): DocumentSendPlan {
  const { forceDocument, payloadBytes, retry, chunk } = input;

  const timeoutMs = resolveDocumentSendTimeout(input);
  const retryScheduleMs = resolveRetrySchedule(retry);
  const chunkFallback = computeChunkPlan({
    payloadBytes,
    chunkSizeBytes: chunk?.chunkSizeBytes,
    timedOutOnce: chunk?.timedOutOnce,
  });
  const wireBytes = computeWireBytes(payloadBytes);

  const reasons: string[] = [];
  reasons.push(
    forceDocument
      ? `document send: ${timeoutMs}ms timeout (${payloadBytes}B payload, ${wireBytes}B wire)`
      : `text send: ${timeoutMs}ms timeout`,
  );
  if (forceDocument && input.concurrentLoad && input.concurrentLoad > 0) {
    reasons.push(`load-aware: ${input.concurrentLoad} concurrent ops`);
  }
  if (retryScheduleMs.length > 0) {
    reasons.push(`retry: ${retryScheduleMs.length} attempts (${retryScheduleMs.join("→")}ms)`);
  }
  if (chunkFallback.shouldChunk) {
    reasons.push(`chunk fallback: ${chunkFallback.chunkCount} chunks`);
  }

  return {
    timeoutMs,
    retryScheduleMs,
    chunkFallback,
    wireBytes,
    rationale: reasons.join("; "),
  };
}
