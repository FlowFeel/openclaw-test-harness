/**
 * Resume Delta Logic (M8) — pure decision logic.
 *
 * @behavior
 * Pure decision logic for tracking file and state modifications between compaction
 * checkpoints and session resume / prompt build turns:
 * - Creates deterministic compaction snapshots of file timestamps.
 * - Computes deltas (modified, added, removed, unchanged) across checkpoints.
 * - Formats factual machine notices without negative prompt guardrails.
 * - Computes delta hashes to avoid spamming identical notices across turns.
 *
 * @invariants
 * - Pure: same inputs -> same outputs, zero side-effects.
 * - Zero I/O builtins (no node:fs, node:path, fetch).
 * - Zero non-deterministic calls (no Date.now(), Math.random(), new Date()).
 * - Zero auxiliary model calls: all decisions are deterministic host compute.
 *
 * @dft
 * - Tested with inline mock data and zero filesystem fixtures.
 */

export interface CompactionSnapshot {
  checkpointId: string;
  timestampMs: number;
  files: Record<string, number>;
}

export interface FileDeltaReport {
  checkpointId: string;
  compactionTimestampMs: number;
  nowMs: number;
  elapsedMs: number;
  modified: string[];
  added: string[];
  removed: string[];
  unchangedCount: number;
  hasChanges: boolean;
}

/**
 * Creates an immutable compaction snapshot from a map of file paths to mtimes.
 */
export function createCompactionSnapshot(
  checkpointId: string,
  timestampMs: number,
  files: Record<string, number>
): CompactionSnapshot {
  return {
    checkpointId: checkpointId.trim() || `ckpt-${timestampMs}`,
    timestampMs,
    files: { ...files },
  };
}

/**
 * Computes deterministic file deltas between a compaction snapshot and current file stats.
 */
export function computeFileDeltas(
  snapshot: CompactionSnapshot,
  currentFiles: Record<string, number>,
  nowMs: number
): FileDeltaReport {
  const modified: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  let unchangedCount = 0;

  const currentPaths = Object.keys(currentFiles).sort();
  const snapshotPaths = new Set(Object.keys(snapshot.files));

  for (const path of currentPaths) {
    const currentMtime = currentFiles[path];
    if (snapshotPaths.has(path)) {
      const snapshotMtime = snapshot.files[path];
      if (currentMtime > snapshotMtime) {
        modified.push(path);
      } else {
        unchangedCount++;
      }
    } else {
      added.push(path);
    }
  }

  for (const path of snapshotPaths) {
    if (!(path in currentFiles)) {
      removed.push(path);
    }
  }

  removed.sort();

  const hasChanges = modified.length > 0 || added.length > 0 || removed.length > 0;
  const elapsedMs = Math.max(0, nowMs - snapshot.timestampMs);

  return {
    checkpointId: snapshot.checkpointId,
    compactionTimestampMs: snapshot.timestampMs,
    nowMs,
    elapsedMs,
    modified,
    added,
    removed,
    unchangedCount,
    hasChanges,
  };
}

/**
 * Computes a deterministic token representing the current delta state.
 */
export function computeDeltaHash(report: FileDeltaReport): string {
  if (!report.hasChanges) return "clean";
  return `m:[${report.modified.join(",")}]|a:[${report.added.join(",")}]|r:[${report.removed.join(",")}]`;
}

/**
 * Decides whether to emit a resume delta notice on the current turn.
 */
export function shouldEmitDeltaNotice(
  lastEmittedHash: string | undefined,
  currentHash: string,
  hasChanges: boolean
): boolean {
  if (!hasChanges) return false;
  return lastEmittedHash !== currentHash;
}

/**
 * Formats an objective, machine-generated resume state delta notice.
 * Zero negative guardrail preaching — only factual deltas.
 */
export function formatResumeDeltaNotice(report: FileDeltaReport): string {
  if (!report.hasChanges) return "";

  const totalChanges = report.modified.length + report.added.length + report.removed.length;
  const lines: string[] = [
    `# [RESUME STATE DELTA] ${totalChanges} file(s) modified since last compaction checkpoint (${report.checkpointId}):`,
  ];

  if (report.modified.length > 0) {
    lines.push(`- Modified (${report.modified.length}):`);
    for (const p of report.modified) {
      lines.push(`  • ${p}`);
    }
  }

  if (report.added.length > 0) {
    lines.push(`- Added (${report.added.length}):`);
    for (const p of report.added) {
      lines.push(`  • ${p}`);
    }
  }

  if (report.removed.length > 0) {
    lines.push(`- Removed (${report.removed.length}):`);
    for (const p of report.removed) {
      lines.push(`  • ${p}`);
    }
  }

  return lines.join("\n");
}
