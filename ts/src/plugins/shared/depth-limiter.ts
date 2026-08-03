/**
 * Depth Limiter — pure logic for nested subagent chain management.
 *
 * @behavior
 * Controls how deep subagent chains can go (main → research → analysis).
 * Each depth level has stricter timeouts and faster cleanup to prevent
 * the bloat cascade that caused 2,575 dead subagents at depth 3+.
 *
 * @invariants
 * - All functions are pure (input → output, no mutation)
 * - No Date.now() — uses injected timestamp
 * - No I/O — no sessions.json, no network
 * - Depth 3+ is always blocked (the original bloat cascade came from unbounded nesting)
 *
 * @dft
 * - All functions testable with inline data
 * - Deterministic: no random, no clock
 * - Immutable: returns new values, never mutates
 */

// ── Types ─────────────────────────────────────────────────────

export type SpawnDepth = 0 | 1 | 2;

export interface DepthConfig {
  maxSpawnDepth: number;
  baseTimeoutSeconds: number;
  baseArchiveAfterMinutes: number;
  /** Timeout reduction per depth level (depth 1 = base, depth 2 = base - reduction) */
  timeoutReductionPerDepth: number;
  /** Archive reduction per depth level */
  archiveReductionPerDepth: number;
}

export interface DepthDecision {
  allowed: boolean;
  reason?: string;
  effectiveDepth: number;
  timeoutSeconds: number;
  archiveAfterMinutes: number;
}

// ── Default config (matches OC's openclaw.json) ──────────────

export const DEFAULT_DEPTH_CONFIG: DepthConfig = {
  maxSpawnDepth: 2,
  baseTimeoutSeconds: 300,
  baseArchiveAfterMinutes: 10,
  timeoutReductionPerDepth: 120,   // depth 2 gets 300-120=180s
  archiveReductionPerDepth: 5,      // depth 2 gets 10-5=5min
};

// ── Pure logic ────────────────────────────────────────────────

/**
 * Check if spawning at a given depth is allowed.
 * Depth 0 = main, depth 1 = first subagent, depth 2 = nested subagent.
 */
export function canSpawnAtDepth(
  currentDepth: number,
  config: DepthConfig
): boolean {
  const effectiveDepth = currentDepth + 1;
  return effectiveDepth <= config.maxSpawnDepth;
}

/**
 * Get the spawn decision for a given depth, including
 * the effective timeout and archive-after values.
 */
export function getDepthDecision(
  currentDepth: number,
  config: DepthConfig = DEFAULT_DEPTH_CONFIG
): DepthDecision {
  const effectiveDepth = currentDepth + 1;

  if (effectiveDepth > config.maxSpawnDepth) {
    return {
      allowed: false,
      reason: `depth ${effectiveDepth} exceeds maxSpawnDepth ${config.maxSpawnDepth}`,
      effectiveDepth,
      timeoutSeconds: 0,
      archiveAfterMinutes: 0,
    };
  }

  // Depth 1 = base, depth 2 = base - reduction
  const reductionLevels = effectiveDepth - 1;
  const timeoutSeconds = Math.max(
    60, // floor: never less than 60s
    config.baseTimeoutSeconds - (reductionLevels * config.timeoutReductionPerDepth)
  );
  const archiveAfterMinutes = Math.max(
    1, // floor: never less than 1 min
    config.baseArchiveAfterMinutes - (reductionLevels * config.archiveReductionPerDepth)
  );

  return {
    allowed: true,
    effectiveDepth,
    timeoutSeconds,
    archiveAfterMinutes,
  };
}

/**
 * Get the timeout for a specific depth level.
 */
export function getTimeoutForDepth(
  depth: number,
  config: DepthConfig = DEFAULT_DEPTH_CONFIG
): number {
  const reductionLevels = depth - 1;
  return Math.max(
    60,
    config.baseTimeoutSeconds - (reductionLevels * config.timeoutReductionPerDepth)
  );
}

/**
 * Get the archive-after-minutes for a specific depth level.
 */
export function getArchiveAfterForDepth(
  depth: number,
  config: DepthConfig = DEFAULT_DEPTH_CONFIG
): number {
  const reductionLevels = depth - 1;
  return Math.max(
    1,
    config.baseArchiveAfterMinutes - (reductionLevels * config.archiveReductionPerDepth)
  );
}

/**
 * Check if a subagent at a given depth can spawn its own children.
 * At maxSpawnDepth=2: depth 1 can spawn (→ depth 2), depth 2 cannot (→ depth 3 blocked).
 */
export function canNestFurther(
  currentDepth: number,
  config: DepthConfig
): boolean {
  return canSpawnAtDepth(currentDepth, config);
}

/**
 * Compute the depth-aware cleanup policy for stale subagent purging.
 * Deeper subagents should be purged more aggressively.
 */
export interface DepthAwareCleanupPolicy {
  maxAgeHoursByDepth: Map<number, number>;
  bloatFieldAggression: "normal" | "aggressive";
}

export function getCleanupPolicyForDepth(
  depth: number,
  baseMaxAgeHours: number = 15
): { maxAgeHours: number; aggressive: boolean } {
  // Depth 2 subagents: purge after 1/3 the normal time (5h vs 15h)
  // Depth 1 subagents: normal purge time (15h)
  if (depth >= 2) {
    return {
      maxAgeHours: Math.max(1, Math.floor(baseMaxAgeHours / 3)),
      aggressive: true,
    };
  }
  return {
    maxAgeHours: baseMaxAgeHours,
    aggressive: false,
  };
}

/**
 * Validate a depth config for sanity.
 */
export function validateDepthConfig(config: DepthConfig): string[] {
  const errors: string[] = [];

  if (config.maxSpawnDepth < 1) {
    errors.push("maxSpawnDepth must be >= 1");
  }
  if (config.maxSpawnDepth > 2) {
    errors.push("maxSpawnDepth must be <= 2 (depth 3+ caused the original bloat cascade)");
  }
  if (config.baseTimeoutSeconds < 60) {
    errors.push("baseTimeoutSeconds must be >= 60");
  }
  if (config.timeoutReductionPerDepth < 0) {
    errors.push("timeoutReductionPerDepth must be >= 0");
  }
  if (config.archiveReductionPerDepth < 0) {
    errors.push("archiveReductionPerDepth must be >= 0");
  }

  // Verify depth 2 raw timeout doesn't rely on the 60s floor
  const depth2RawTimeout = config.baseTimeoutSeconds - config.timeoutReductionPerDepth;
  if (depth2RawTimeout < 60) {
    errors.push(
      `depth 2 raw timeout ${depth2RawTimeout}s relies on 60s floor (base ${config.baseTimeoutSeconds}s - reduction ${config.timeoutReductionPerDepth}s)`
    );
  }

  return errors;
}
