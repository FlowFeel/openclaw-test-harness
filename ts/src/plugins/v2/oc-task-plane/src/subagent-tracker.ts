/**
 * Subagent tracker — pure logic for tracking subagent lifecycle.
 *
 * @behavior
 * Maintains an in-memory map of active subagents. When a subagent
 * is spawned, it's added. When it ends, it's removed. Stale
 * subagents (exceeded runTimeoutSeconds) are detected.
 *
 * @invariants
 * - All functions are pure (input state → output state)
 * - No Date.now() — uses injected timestamp
 * - No I/O — no file system, no network
 *
 * @dft
 * - All functions testable with inline data
 * - Deterministic: injected timestamps
 */

// ── Types ─────────────────────────────────────────────────────

export interface SubagentRecord {
  sessionKey: string;
  model?: string;
  provider?: string;
  spawnedBy?: string;
  startedAtMs: number;
  endedAtMs?: number;
  status: "active" | "ended" | "stale";
}

export type SubagentMap = Map<string, SubagentRecord>;

export interface StaleDetectionResult {
  staleKeys: string[];
  activeCount: number;
  totalSpawned: number;
  totalEnded: number;
}

// ── Pure logic ────────────────────────────────────────────────

export function trackSpawn(
  map: SubagentMap,
  record: Omit<SubagentRecord, "status" | "endedAtMs">,
  nowMs: number
): SubagentMap {
  const next = new Map(map);
  next.set(record.sessionKey, {
    ...record,
    startedAtMs: record.startedAtMs || nowMs,
    status: "active",
  });
  return next;
}

export function trackEnd(
  map: SubagentMap,
  sessionKey: string,
  nowMs: number
): SubagentMap {
  const next = new Map(map);
  const existing = next.get(sessionKey);
  if (existing) {
    next.set(sessionKey, { ...existing, endedAtMs: nowMs, status: "ended" });
  }
  return next;
}

export function detectStale(
  map: SubagentMap,
  runTimeoutSeconds: number,
  nowMs: number
): { stale: SubagentMap; fresh: SubagentMap; result: StaleDetectionResult } {
  const cutoffMs = nowMs - runTimeoutSeconds * 1000;
  const stale = new Map<string, SubagentRecord>();
  const fresh = new Map<string, SubagentRecord>();
  let totalEnded = 0;

  for (const [key, record] of map) {
    if (record.status === "ended") {
      totalEnded++;
      fresh.set(key, record);
      continue;
    }
    if (record.startedAtMs < cutoffMs) {
      stale.set(key, { ...record, status: "stale" });
    } else {
      fresh.set(key, record);
    }
  }

  return {
    stale,
    fresh,
    result: {
      staleKeys: Array.from(stale.keys()),
      activeCount: fresh.size - totalEnded,
      totalSpawned: map.size,
      totalEnded,
    },
  };
}

export function getActiveCount(map: SubagentMap): number {
  let count = 0;
  for (const record of map.values()) {
    if (record.status === "active") count++;
  }
  return count;
}

export function canSpawn(
  map: SubagentMap,
  maxConcurrent: number
): boolean {
  return getActiveCount(map) < maxConcurrent;
}
