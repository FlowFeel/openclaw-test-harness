/**
 * Sidecar Router — pure logic for deciding when to offload CPU work.
 *
 * @dft
 * - A1 (pure-io-separation): no imports, no I/O. Pure functions only.
 * - A2 (determinism): no Date.now(), no Math.random(). All inputs injected.
 * - A6 (check-result): returns SidecarDecision with rationale.
 *
 * @invariants
 * - Never throws — returns { offload: false, reason: "..." } on any issue
 * - Threshold-based: only offloads when the work is worth the IPC cost
 * - Fallback-safe: caller can always do inline work when offload=false
 */

/** Size thresholds for offloading decisions. */
export const OFFLOAD_THRESHOLDS = {
  /** Minimum JSON payload size (bytes) to justify IPC overhead. */
  minJsonBytes: 50_000,       // 50KB — smaller than this, inline is faster
  /** Minimum session size for serialization offload. */
  minSessionBytes: 100_000,   // 100KB
  /** Minimum transcript size for compaction offload. */
  minTranscriptBytes: 500_000, // 500KB
} as const;

export interface SidecarDecision {
  /** True = route to sidecar. False = do inline. */
  offload: boolean;
  /** The operation name if offloading. */
  operation?: string;
  /** Human-readable rationale for the decision. */
  rationale: string;
}

export interface OffloadParams {
  /** The operation being considered: json.stringify, json.parse, serialize.session, compact.context */
  operation: string;
  /** Size of the payload in bytes (estimated). */
  payloadBytes: number;
  /** Is the sidecar process running and healthy? */
  sidecarAvailable: boolean;
  /** Is the worker pool currently busy (active >= poolSize)? */
  poolFull: boolean;
}

/**
 * Decide whether to offload a CPU-heavy operation to the sidecar.
 *
 * Decision logic:
 * 1. Sidecar must be available
 * 2. Pool must not be full
 * 3. Payload must exceed the threshold for the operation type
 *
 * @returns SidecarDecision — the caller does inline work when offload=false
 */
export function shouldOffload(params: OffloadParams): SidecarDecision {
  const { operation, payloadBytes, sidecarAvailable, poolFull } = params;

  if (!sidecarAvailable) {
    return { offload: false, rationale: "sidecar not available" };
  }

  if (poolFull) {
    return { offload: false, rationale: "worker pool full, do inline" };
  }

  const threshold = getThreshold(operation);
  if (threshold === null) {
    return { offload: false, rationale: `unknown operation: ${operation}` };
  }

  if (payloadBytes < threshold) {
    return {
      offload: false,
      rationale: `payload ${payloadBytes}B < threshold ${threshold}B for ${operation}, inline is faster`,
    };
  }

  return {
    offload: true,
    operation,
    rationale: `offloading ${operation}: ${payloadBytes}B >= threshold ${threshold}B, sidecar available, pool has capacity`,
  };
}

/**
 * Get the size threshold for an operation type.
 */
export function getThreshold(operation: string): number | null {
  switch (operation) {
    case "json.stringify":
    case "json.parse":
      return OFFLOAD_THRESHOLDS.minJsonBytes;
    case "serialize.session":
      return OFFLOAD_THRESHOLDS.minSessionBytes;
    case "compact.context":
      return OFFLOAD_THRESHOLDS.minTranscriptBytes;
    default:
      return null;
  }
}

/**
 * Build the sidecar request payload for an operation.
 */
export function buildOffloadRequest(
  operation: string,
  data: unknown,
): { operation: string; data: unknown } {
  return { operation, data };
}

/**
 * Estimate the byte size of a value for offload decisions.
 * Uses JSON.stringify length — the same work that would be offloaded.
 * This is a quick estimate (the actual stringify happens in the sidecar).
 */
export function estimatePayloadBytes(data: unknown): number {
  try {
    const str = JSON.stringify(data);
    return str ? Buffer.byteLength(str) : 0;
  } catch {
    return 0;
  }
}
