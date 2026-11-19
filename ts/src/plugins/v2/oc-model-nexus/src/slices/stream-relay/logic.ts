/**
 * Stream Relay Pure Transition Algebra — routing predicates and relay counter transitions.
 *
 * @invariants
 * - Pure logic: zero I/O, zero Date.now(), returns immutable RelayState snapshots (A1, A2, A6).
 *
 * @dft
 * - Tested in slices/stream-relay/tests/logic.spec.ts.
 */

import type { RelayState, StreamRelayConfig } from "./state.js";

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
  return consecutiveFailures >= maxRetries;
}

export function recordRelayOutcome(
  state: RelayState,
  outcome: { success: boolean; latencyMs: number },
  config: StreamRelayConfig,
): { nextState: RelayState; enteredFallback: boolean } {
  const totalRelayed = state.totalRelayed + 1;
  const totalFailed = outcome.success ? state.totalFailed : state.totalFailed + 1;
  const consecutiveFailures = outcome.success ? 0 : state.consecutiveFailures + 1;

  const fallbackMode = shouldRelayFallback(
    true,
    config.fallbackEnabled,
    consecutiveFailures,
    config.maxRetries,
  );
  const enteredFallback = !state.fallbackMode && fallbackMode;
  const fallbackCount = enteredFallback ? state.fallbackCount + 1 : state.fallbackCount;

  const prevAvg = state.avgLatencyMs ?? outcome.latencyMs;
  const avgLatencyMs =
    outcome.latencyMs > 0
      ? Math.round(((prevAvg * state.totalRelayed + outcome.latencyMs) / totalRelayed) * 100) / 100
      : state.avgLatencyMs;

  return {
    enteredFallback,
    nextState: {
      ...state,
      totalRelayed,
      totalFailed,
      consecutiveFailures,
      fallbackMode,
      fallbackCount,
      lastLatencyMs: outcome.latencyMs > 0 ? outcome.latencyMs : state.lastLatencyMs,
      avgLatencyMs,
    },
  };
}

export function formatRelayHealth(state: RelayState, nowMs: number): Record<string, unknown> {
  return {
    started: state.started,
    uptimeSeconds: state.startedAt ? Math.max(0, Math.round((nowMs - state.startedAt) / 1000)) : 0,
    sidecarPort: state.sidecarPort,
    fallbackMode: state.fallbackMode,
    fallbackCount: state.fallbackCount,
    totalRelayed: state.totalRelayed,
    totalFailed: state.totalFailed,
    lastLatencyMs: state.lastLatencyMs,
    avgLatencyMs: state.avgLatencyMs,
  };
}
