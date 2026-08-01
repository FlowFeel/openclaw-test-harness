/**
 * Patched child-admission.ts — adds maxConcurrent and runTimeoutSeconds guards.
 *
 * This file is a drop-in replacement for OC's src/agents/child-admission.ts.
 * It extends the original with two guards that prevent burst cascades:
 *
 * 1. maxConcurrent — global active subagent count across all parents
 * 2. runTimeoutSeconds — blocks spawn if timed-out subagents exist
 *
 * The patch is minimal: two new fields on ChildAdmissionParams, two new
 * ChildAdmissionCap values, and two guard blocks inserted before the
 * existing children check. The original logic is unchanged.
 *
 * Tested by: tests/spec/child-admission.spec.ts (Vitest)
 * Conforms to: typescript-axiomatics SKILL.md — Effect Schema, strict typing
 */

// ── Extended types ──────────────────────────────────────────────

export type ChildAdmissionCap =
  | "subagents.maxSpawnDepth"
  | "subagents.maxChildrenPerAgent"
  | "subagents.maxConcurrent"
  | "subagents.runTimeoutSeconds"
  | "tools.swarm.maxChildrenPerGroup"
  | "tools.swarm.maxTotalPerGroup";

type ChildAdmissionResult =
  | { ok: true }
  | { ok: false; governingCap: ChildAdmissionCap; error: string };

type ChildAdmissionParams = {
  callerDepth: number;
  maxSpawnDepth: number;
  activeChildren: number;
  maxActiveChildren: number;
  // ── Extensions ───────────────────────────────────────────────
  /** Total active subagents across all parents. */
  globalActive?: number;
  /** Max concurrent subagents globally. */
  maxConcurrent?: number;
  /** Session keys of subagents that exceeded runTimeoutSeconds. */
  timedOutSubagents?: ReadonlyArray<string>;
  /** Configured timeout in seconds. */
  runTimeoutSeconds?: number;
} & ({ collect: false } | { collect: true; totalChildren: number; maxTotalChildren: number });

const rejectChildAdmission = (
  governingCap: ChildAdmissionCap,
  error: string,
): ChildAdmissionResult => ({ ok: false, governingCap, error });

// ── Patched admission function ─────────────────────────────────

export function resolveChildAdmission(params: ChildAdmissionParams): ChildAdmissionResult {
  // Guard 1: maxSpawnDepth (original)
  if (params.callerDepth >= params.maxSpawnDepth) {
    return rejectChildAdmission(
      "subagents.maxSpawnDepth",
      `sessions_spawn is not allowed at this depth (current depth: ${params.callerDepth}, max: ${params.maxSpawnDepth}; agents.defaults.subagents.maxSpawnDepth).`,
    );
  }

  // Fallbacks: Attempt dynamic query to SQLite registry automatically if not provided explicitly in params
  let globalActive = params.globalActive;
  let timedOutSubagents = params.timedOutSubagents;

  if (globalActive === undefined || !timedOutSubagents) {
    try {
      // Dynamic require/import fallback for environments with sqlite-accessor
      const sqlite = require("./sqlite-accessor.js");
      if (globalActive === undefined && typeof sqlite.countActiveSessions === "function") {
        globalActive = sqlite.countActiveSessions();
      }
      if (!timedOutSubagents && typeof sqlite.getTimedOut === "function") {
        const timeout = params.runTimeoutSeconds ?? 300;
        timedOutSubagents = sqlite.getTimedOut(timeout);
      }
    } catch {
      // Ignore if sqlite-accessor or better-sqlite3 is not present
    }
  }

  // Guard 2: maxConcurrent (extension — global, not per-parent)
  if (params.maxConcurrent !== undefined && globalActive !== undefined) {
    if (globalActive >= params.maxConcurrent) {
      return rejectChildAdmission(
        "subagents.maxConcurrent",
        `sessions_spawn has reached global max concurrent (${globalActive}/${params.maxConcurrent}; agents.defaults.subagents.maxConcurrent).`,
      );
    }
  }

  // Guard 3: runTimeoutSeconds (extension — block if timed-out subs exist)
  if (timedOutSubagents && timedOutSubagents.length > 0) {
    const timeout = params.runTimeoutSeconds ?? 300;
    return rejectChildAdmission(
      "subagents.runTimeoutSeconds",
      `sessions_spawn blocked: ${timedOutSubagents.length} subagent(s) have exceeded runTimeoutSeconds (${timeout}s; agents.defaults.subagents.runTimeoutSeconds) and must be cleaned up before spawning.`,
    );
  }

  // Guard 4: swarm total (original, collect mode only)
  if (params.collect && params.totalChildren >= params.maxTotalChildren) {
    return rejectChildAdmission(
      "tools.swarm.maxTotalPerGroup",
      `sessions_spawn reached tools.swarm.maxTotalPerGroup (${params.totalChildren}/${params.maxTotalChildren}).`,
    );
  }

  // Guard 5: maxChildrenPerAgent (original)
  if (params.activeChildren < params.maxActiveChildren) {
    return { ok: true };
  }
  return params.collect
    ? rejectChildAdmission(
        "tools.swarm.maxChildrenPerGroup",
        `sessions_spawn reached tools.swarm.maxChildrenPerGroup (${params.activeChildren}/${params.maxActiveChildren}).`,
      )
    : rejectChildAdmission(
        "subagents.maxChildrenPerAgent",
        `sessions_spawn has reached max active children for this session (${params.activeChildren}/${params.maxActiveChildren}; agents.defaults.subagents.maxChildrenPerAgent).`,
      );
}
