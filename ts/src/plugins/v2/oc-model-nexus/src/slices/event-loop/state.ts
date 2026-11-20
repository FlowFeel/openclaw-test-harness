/**
 * Event Loop Telemetry State Slice — bounded sliding window of ProcessTelemetry samples.
 *
 * @invariants
 * - Pure data structure; bounded to maxReadings.
 *
 * @dft
 * - Tested via slices/event-loop/tests/logic.spec.ts.
 */

import type { ProcessTelemetry } from "../../../../../shared/telemetry-logic.js";

export interface EventLoopSliceState {
  readonly readings: readonly ProcessTelemetry[];
  readonly maxReadings: number;
}

export function createEventLoopState(maxReadings = 60): EventLoopSliceState {
  return { readings: [], maxReadings };
}

