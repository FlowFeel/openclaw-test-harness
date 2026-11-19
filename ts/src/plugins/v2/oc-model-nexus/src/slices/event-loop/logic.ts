/**
 * Event Loop Pure Transition Algebra — appends telemetry readings and aggregates health.
 *
 * @invariants
 * - Pure logic: zero perf_hooks/v8/process imports, returns immutable snapshots (A1, A2, A6).
 *
 * @dft
 * - Tested via slices/event-loop/tests/logic.spec.ts.
 */

import {
  aggregateSystemHealth,
  type ProcessTelemetry,
  type SystemHealth,
} from "../../../../../shared/telemetry-logic.js";
import type { EventLoopSliceState } from "./state.js";

export function recordTelemetryReading(
  state: EventLoopSliceState,
  reading: ProcessTelemetry,
): { nextState: EventLoopSliceState; trimmed: boolean } {
  const combined = [...state.readings, reading];
  const trimmed = combined.length > state.maxReadings;
  const readings = trimmed ? combined.slice(combined.length - state.maxReadings) : combined;
  return {
    trimmed,
    nextState: { ...state, readings },
  };
}

export function evaluateEventLoopHealth(state: EventLoopSliceState, windowSize = 10): SystemHealth {
  return aggregateSystemHealth([...state.readings.slice(-windowSize)], 0, 0);
}
