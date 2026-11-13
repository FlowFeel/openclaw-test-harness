/**
 * Stream Relay Decision Logic — pure routing and fallback decisions for model stream relay.
 *
 * @behavior
 * Evaluates whether model responses should be relayed via the sidecar process,
 * and determines fallback conditions based on sidecar availability and retry thresholds.
 *
 * @invariants
 * - Pure logic: no direct network I/O, no timers.
 * - Deterministic: all state and counts passed explicitly as arguments.
 *
 * @dft
 * - Tested with isolated unit fixtures in oc-model-nexus.spec.ts.
 */

export interface StreamRelayConfig {
  sidecarPort?: number;
  fallbackEnabled?: boolean;
  fallbackTimeoutMs?: number;
  maxRetries?: number;
  healthCheckIntervalMs?: number;
}

export interface RelayState {
  started: boolean;
  startedAt: number | null;
  sidecarPort: number;
  fallbackMode: boolean;
  fallbackCount: number;
  totalRelayed: number;
  totalFailed: number;
  lastLatencyMs: number | null;
  avgLatencyMs: number | null;
}

export function shouldRelay(
  modelId: string,
  sidecarAvailable: boolean,
  fallbackEnabled: boolean,
): boolean {
  if (!modelId) return false;
  if (sidecarAvailable) return true;
  return fallbackEnabled;
}

export function shouldRelayFallback(
  sidecarAvailable: boolean,
  fallbackEnabled: boolean,
  consecutiveFailures: number,
  maxRetries: number,
): boolean {
  if (!fallbackEnabled) return false;
  if (!sidecarAvailable) return true;
  if (consecutiveFailures >= maxRetries) return true;
  return false;
}

