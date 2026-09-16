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

export interface TeachbackMessage {
  summary: string;
  detail: string;
  outputHandle: string;
  suggestedAction: string;
  resumeCommandHint?: string;
}

export interface TeachbackReport {
  taskId: string;
  formattedAt: number;
  capMs: number;
  outputHandle: string;
}

/**
 * Formats a post-kill teachback for an agent whose task breached a lane or supervisor cap.
 */
export function formatPostKillTeachback(
  task: TaskPlaneTask,
  options: { nowMs: number; capMs?: number }
): { teachback: TeachbackMessage; report: TeachbackReport } {
  const capMs = options.capMs ?? task.timeoutMs;
  const capSec = Math.round(capMs / 1000);
  const handle = task.output_handle;

  const commandStr = typeof task.payload?.command === "string" ? task.payload.command : "";
  const tailSnippet = task.result?.outputTail ? `\n\n--- Output Tail ---\n${task.result.outputTail}` : "";

  const summary = `Killed at ${capSec}s lane cap. Partial output preserved at handle ${handle}. Re-dispatch with task_dispatch to resume.`;
  const detail = `Task '${task.id}' exceeded the execution limit (${capSec}s). Foreground execution holds the semaphore lane, starving the system.${tailSnippet}`;
  const suggestedAction = `Use 'task_dispatch({ command: "${commandStr || "..."}" }, ${capMs * 2})' to run asynchronously, and inspect output via 'task_output("${task.id}")'.`;

  const teachback: TeachbackMessage = {
    summary,
    detail,
    outputHandle: handle,
    suggestedAction,
    resumeCommandHint: commandStr
      ? `task_dispatch({ command: "${commandStr}" }, ${capMs * 2})`
      : undefined,
  };

  const report: TeachbackReport = {
    taskId: task.id,
    formattedAt: options.nowMs,
    capMs,
    outputHandle: handle,
  };

  return { teachback, report };
}
