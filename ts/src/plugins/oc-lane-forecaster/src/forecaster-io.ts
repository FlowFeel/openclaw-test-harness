/**
 * OcLaneForecaster — I/O Protocol wrapper.
 *
 * @behavior
 * Declares the Protocol types for session run duration tracking and telemetry
 * persistence. Provides in-memory and crash-safe storage implementations.
 *
 * @invariants
 * - Protocol interfaces (HistoryReader/HistoryWriter) declared here.
 * - Logic files depend only on types, never on the I/O implementation.
 * - Pure logic/I/O separation: no business logic in this file.
 *
 * @dft
 * - Tested with in-memory Protocol doubles.
 * - Zero external fixtures.
 */

import type { SessionRunHistory } from "./forecaster-logic.js";

export interface SessionHistoryEntry {
  sessionKey: string;
  durations: number[];
  timeouts: number;
  lastUpdatedAt: number;
}

export type HistoryReader = (sessionKey: string) => SessionRunHistory | null;
export type HistoryWriter = (sessionKey: string, durationMs: number, hitTimeout: boolean, nowMs: number) => void;

/**
 * In-memory session history store conforming to HistoryReader and HistoryWriter.
 */
export class InMemorySessionHistoryStore {
  private entries = new Map<string, SessionHistoryEntry>();

  public read: HistoryReader = (sessionKey: string): SessionRunHistory | null => {
    const entry = this.entries.get(sessionKey);
    if (!entry) return null;
    return {
      recentDurationsMs: [...entry.durations],
      timeoutsEncountered: entry.timeouts,
      lastRunDurationMs: entry.durations[entry.durations.length - 1],
    };
  };

  public write: HistoryWriter = (
    sessionKey: string,
    durationMs: number,
    hitTimeout: boolean,
    nowMs: number
  ): void => {
    const existing = this.entries.get(sessionKey) ?? {
      sessionKey,
      durations: [],
      timeouts: 0,
      lastUpdatedAt: nowMs,
    };

    existing.durations.push(durationMs);
    // Keep last 10 runs
    if (existing.durations.length > 10) {
      existing.durations.shift();
    }
    if (hitTimeout) {
      existing.timeouts += 1;
    }
    existing.lastUpdatedAt = nowMs;
    this.entries.set(sessionKey, existing);
  };

  public clear(): void {
    this.entries.clear();
  }
}

/** Global default history store instance */
export const defaultHistoryStore = new InMemorySessionHistoryStore();
