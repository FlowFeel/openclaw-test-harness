/**
 * Stream Relay State Slice — owns relay availability, fallback mode, and latency counters.
 *
 * @invariants
 * - Isolated state slice; zero coupling to sibling slices.
 *
 * @dft
 * - Tested directly via slices/stream-relay/tests/logic.spec.ts.
 */

export interface StreamRelayConfig {
  sidecarPort: number;
  fallbackEnabled: boolean;
  maxRetries: number;
}

export interface RelayState {
  started: boolean;
  startedAt: number | null;
  sidecarPort: number;
  fallbackMode: boolean;
  fallbackCount: number;
  consecutiveFailures: number;
  totalRelayed: number;
  totalFailed: number;
  lastLatencyMs: number | null;
  avgLatencyMs: number | null;
}

export function createRelayState(sidecarPort: number, startedAtMs: number): RelayState {
  return {
    started: true,
    startedAt: startedAtMs,
    sidecarPort,
    fallbackMode: false,
    fallbackCount: 0,
    consecutiveFailures: 0,
    totalRelayed: 0,
    totalFailed: 0,
    lastLatencyMs: null,
    avgLatencyMs: null,
  };
}
