/**
 * TeachBack Logic — pure diagnostics and instructive error formatting.
 *
 * @behavior
 * Formats actionable post-kill and timeout diagnostics when tasks breach caps.
 * Replaces cryptic CommandLaneTimeouts with instructive teach-backs that cite
 * the preserved output handle and provide re-dispatch syntax.
 *
 * @invariants
 * - Every function is pure: same input → same output, no side effects.
 * - No imports of I/O modules (node:fs, node:child_process, node:path, etc.).
 * - No Date.now() / Math.random() — all time injected via options.nowMs.
 * - Formatter returns structured report (CheckResult pattern).
 *
 * @dft
 * - Pure logic tested in teachback-logic.spec.ts with inline data.
 * - Zero fixtures, deterministic.
 */

import type { TaskPlaneTask } from "../../shared/types.js";

export type ShippedStatus = "shipped_clean" | "uncommitted_changes" | "pushed_pr" | "unknown";

export interface ShippedState {
  lastCommitSha?: string;
  lastCommitMessage?: string;
  lastPushedBranch?: string;
  lastPrNumber?: number | string;
  repo?: string;
  hasUncommittedChanges?: boolean;
  shippedAt?: number;
  status: ShippedStatus;
}

export interface TeachbackMessage {
  summary: string;
  detail: string;
  outputHandle: string;
  durationMs: number;
  capMs: number;
  shippedState?: ShippedState;
  suggestedAction: string;
  resumeCommandHint?: string;
}

export interface TeachbackReport {
  taskId: string;
  formattedAt: number;
  durationMs: number;
  capMs: number;
  outputHandle: string;
  shippedStateStatus?: ShippedStatus;
}

/**
 * Formats a post-kill teachback for an agent whose task breached a lane or supervisor cap.
 */
export function formatPostKillTeachback(
  task: TaskPlaneTask,
  options: {
    nowMs: number;
    capMs?: number;
    durationMs?: number;
    shippedState?: ShippedState;
  }
): { teachback: TeachbackMessage; report: TeachbackReport } {
  const capMs = options.capMs ?? task.timeoutMs;
  const capSec = Math.round(capMs / 1000);
  const durationMs =
    options.durationMs ??
    (task.timestamps.startedAt
      ? options.nowMs - task.timestamps.startedAt
      : capMs);
  const durationSec = Math.round(durationMs / 1000);
  const handle = task.output_handle;
  const shippedState = options.shippedState;

  const commandStr = typeof task.payload?.command === "string" ? task.payload.command : "";
  const tailSnippet = task.result?.outputTail ? `\n\n--- Output Tail ---\n${task.result.outputTail}` : "";

  let shippedDescription = "";
  if (shippedState?.lastCommitSha) {
    const prPart = shippedState.lastPrNumber ? ` (PR #${shippedState.lastPrNumber})` : "";
    const branchPart = shippedState.lastPushedBranch ? ` on branch '${shippedState.lastPushedBranch}'` : "";
    shippedDescription = `\n\nObservable shipped-state: commit ${shippedState.lastCommitSha.slice(0, 7)}${branchPart}${prPart}. Work survived by policy — resume checkpoint from this commit.`;
    if (shippedState.hasUncommittedChanges) {
      shippedDescription += ` Note: working tree contains uncommitted changes.`;
    }
  } else if (shippedState?.hasUncommittedChanges) {
    shippedDescription = `\n\nObservable shipped-state: working tree contains uncommitted changes. No recent pushed commit observed during this run.`;
  }

  const summary = `Killed at ${capSec}s lane cap (${durationSec}s elapsed). Note: this is a lane timeout, not an LLM provider outage. Partial output preserved at handle ${handle}. Re-dispatch with task_dispatch to resume.`;
  const detail = `Task '${task.id}' exceeded the execution limit (${capSec}s, ran ${durationSec}s). Foreground execution holds the semaphore lane, starving the system.${shippedDescription}${tailSnippet}`;
  const suggestedAction = `Use 'task_dispatch({ command: "${commandStr || "..."}" }, ${capMs * 2})' to run asynchronously, and inspect output via 'task_output("${task.id}")'.`;

  const teachback: TeachbackMessage = {
    summary,
    detail,
    outputHandle: handle,
    durationMs,
    capMs,
    shippedState,
    suggestedAction,
    resumeCommandHint: commandStr
      ? `task_dispatch({ command: "${commandStr}" }, ${capMs * 2})`
      : undefined,
  };

  const report: TeachbackReport = {
    taskId: task.id,
    formattedAt: options.nowMs,
    durationMs,
    capMs,
    outputHandle: handle,
    shippedStateStatus: shippedState?.status,
  };

  return { teachback, report };
}
