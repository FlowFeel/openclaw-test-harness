/**
 * Exec Pipeline Logic (T-583) — pure planning/validation seam for
 * multi-command pipelines run through the TaskPlane.
 *
 * @behavior
 * Validates an exec_pipeline tool spec (ordered steps, sequential or piped
 * mode, per-step conditionals), decides whether each step should run given
 * the previous step's outcome, and summarizes a completed run into a report.
 *
 * @invariants
 * - Pure logic: no I/O, no timers, no Date.now()/Math.random().
 * - Same input → same output for every function.
 * - Conditionals are orthogonal to stopOnFailure: stopOnFailure aborts the
 *   remaining pipeline after a failed step; conditionals gate individual
 *   steps on the previous step's exit code (&& / || shell semantics).
 * - All functions return data or reports (CheckResult pattern) — no void.
 *
 * @dft
 * - Tested in exec-pipeline-logic.spec.ts with inline data, zero fixtures.
 * - Fully deterministic: no clock, no randomness.
 */

export type PipelineStepCondition = "always" | "on_success" | "on_failure";
export type PipelineMode = "sequential" | "piped";

export const PIPELINE_MODES: readonly PipelineMode[] = ["sequential", "piped"];
export const PIPELINE_CONDITIONS: readonly PipelineStepCondition[] = [
  "always",
  "on_success",
  "on_failure",
];

export const DEFAULT_PIPELINE_MODE: PipelineMode = "sequential";
export const DEFAULT_STOP_ON_FAILURE = true;

/** A single pipeline step as supplied by the caller (unvalidated). */
export interface PipelineStepSpec {
  command: string;
  condition?: PipelineStepCondition;
}

/** A validated, fully-normalized pipeline spec. */
export interface NormalizedPipelineSpec {
  steps: Array<{ command: string; condition: PipelineStepCondition }>;
  mode: PipelineMode;
  stopOnFailure: boolean;
}

/** The observable outcome of one executed step (wiring fills this in). */
export interface StepOutcome {
  exitCode: number | null;
  timedOut?: boolean;
  error?: string;
}

/** A per-step record in a completed pipeline run. */
export interface PipelineStepResult {
  index: number;
  command: string;
  executed: boolean;
  skipped?: boolean;
  skipReason?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  error?: string;
}

/** Report for a completed pipeline run (CheckResult pattern). */
export interface PipelineRunReport {
  ok: boolean;
  mode: PipelineMode;
  totalSteps: number;
  executedCount: number;
  skippedCount: number;
  failedStepIndex: number | null;
  finalExitCode: number | null;
  steps: Array<{
    index: number;
    command: string;
    executed: boolean;
    skipped: boolean;
    exitCode?: number | null;
    skipReason?: string;
  }>;
}

export type PipelineValidation =
  | { ok: true; spec: NormalizedPipelineSpec }
  | { ok: false; error: string };

/**
 * Validates and normalizes a raw pipeline spec (as received from tool params).
 * Returns a discriminated result: never throws.
 */
export function validatePipelineSpec(raw: unknown): PipelineValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "pipeline spec must be an object with a 'steps' array" };
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    return { ok: false, error: "pipeline spec requires a non-empty 'steps' array" };
  }

  const mode = obj.mode === undefined ? DEFAULT_PIPELINE_MODE : obj.mode;
  if (typeof mode !== "string" || !PIPELINE_MODES.includes(mode as PipelineMode)) {
    return {
      ok: false,
      error: `invalid mode '${String(mode)}' — expected one of: ${PIPELINE_MODES.join(", ")}`,
    };
  }

  const stopOnFailure =
    obj.stopOnFailure === undefined ? DEFAULT_STOP_ON_FAILURE : obj.stopOnFailure;
  if (typeof stopOnFailure !== "boolean") {
    return { ok: false, error: "stopOnFailure must be a boolean" };
  }

  const steps: Array<{ command: string; condition: PipelineStepCondition }> = [];
  for (let i = 0; i < obj.steps.length; i++) {
    const rawStep = obj.steps[i];
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
      return { ok: false, error: `step ${i} must be an object` };
    }
    const stepObj = rawStep as Record<string, unknown>;
    if (typeof stepObj.command !== "string" || stepObj.command.trim().length === 0) {
      return { ok: false, error: `step ${i} requires a non-empty 'command' string` };
    }
    const condition =
      stepObj.condition === undefined ? "always" : stepObj.condition;
    if (
      typeof condition !== "string" ||
      !PIPELINE_CONDITIONS.includes(condition as PipelineStepCondition)
    ) {
      return {
        ok: false,
        error: `step ${i} has invalid condition '${String(condition)}' — expected one of: ${PIPELINE_CONDITIONS.join(", ")}`,
      };
    }
    steps.push({ command: stepObj.command, condition: condition as PipelineStepCondition });
  }

  return { ok: true, spec: { steps, mode: mode as PipelineMode, stopOnFailure } };
}

/**
 * Decides whether a step should run given the previous step's outcome.
 * Pure conditional gate (&& / || shell semantics):
 * - "always": run unconditionally.
 * - "on_success": run only if the previous step exited 0 (first step runs).
 * - "on_failure": run only if the previous step failed (first step runs).
 */
export function decideStepExecution(
  condition: PipelineStepCondition,
  previous: StepOutcome | null,
): { run: boolean; reason: string } {
  if (condition === "always") {
    return { run: true, reason: "condition=always" };
  }
  if (previous === null) {
    return { run: true, reason: `condition=${condition} on first step runs unconditionally` };
  }
  const prevFailed = previous.error !== undefined || (previous.exitCode ?? 1) !== 0;
  if (condition === "on_success") {
    return prevFailed
      ? { run: false, reason: "skipped: previous step failed (on_success)" }
      : { run: true, reason: "previous step succeeded (on_success)" };
  }
  // condition === "on_failure"
  return prevFailed
    ? { run: true, reason: "previous step failed (on_failure)" }
    : { run: false, reason: "skipped: previous step succeeded (on_failure)" };
}

/**
 * Summarizes a completed pipeline run into a report.
 * - ok: true when every executed step exited 0 with no error/timeout.
 * - failedStepIndex: index of the first failed executed step, else null.
 * - finalExitCode: exit code of the last executed step, else null.
 */
export function summarizePipelineRun(
  spec: NormalizedPipelineSpec,
  results: PipelineStepResult[],
): PipelineRunReport {
  let executedCount = 0;
  let skippedCount = 0;
  let failedStepIndex: number | null = null;
  let finalExitCode: number | null = null;

  for (const r of results) {
    if (!r.executed || r.skipped) {
      skippedCount++;
      continue;
    }
    executedCount++;
    finalExitCode = r.exitCode ?? null;
    const failed = r.error !== undefined || r.timedOut === true || (r.exitCode ?? 1) !== 0;
    if (failed && failedStepIndex === null) {
      failedStepIndex = r.index;
    }
  }

  const steps = results.map((r) => ({
    index: r.index,
    command: r.command,
    executed: r.executed && !r.skipped,
    skipped: r.skipped === true,
    exitCode: r.executed && !r.skipped ? r.exitCode : undefined,
    skipReason: r.skipReason,
  }));

  return {
    ok: failedStepIndex === null,
    mode: spec.mode,
    totalSteps: spec.steps.length,
    executedCount,
    skippedCount,
    failedStepIndex,
    finalExitCode,
    steps,
  };
}
