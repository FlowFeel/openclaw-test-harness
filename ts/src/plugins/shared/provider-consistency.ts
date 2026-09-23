/**
 * Provider Consistency — pure logic for boot-gate and doctor assertions
 * across selection-based plugin contracts (compaction, memory, speech, etc.).
 *
 * @behavior
 * Evaluates configured vs. registered provider IDs at gateway boot and doctor inspection.
 * Detects the "dead-provider" hazard (capability registered but never selected,
 * causing silent fallback to unbounded built-in mechanisms; topic 70660 / issue #35)
 * and the "missing-provider" hazard (configured ID not claimed by any registered plugin).
 *
 * @invariants
 * - Pure: (params) -> ProviderConsistencyAssertion. No I/O.
 * - Deterministic: same inputs -> identical assertion verdict and messages.
 * - Generic: applies equally to compaction, memory, speech, and future contracts.
 * - Three-state verdict: "ok" | "warn" | "error".
 *
 * @dft
 * - Tested via provider-consistency.spec.ts across all four states for multiple capabilities.
 * - Zero external fixtures, deterministic.
 */

export type DoctorAssertionSeverity = "ok" | "warn" | "error";

export interface ProviderConsistencyParams {
  /** Capability name being checked, e.g. "compaction", "memory", "speech" */
  capability: string;
  /** Config property path, e.g. "agents.defaults.compaction.provider" */
  configPath: string;
  /** Currently configured provider ID (null/undefined if unset) */
  selectedId?: string | null;
  /** Provider IDs registered by active plugins */
  registeredIds: readonly string[];
  /** Description of fallback mechanism when custom provider isn't active */
  fallbackDescription?: string;
  /** Contextual note describing wedge/failure risk threshold if applicable */
  hazardNote?: string;
}

export interface ProviderConsistencyAssertion {
  capability: string;
  configPath: string;
  selectedId: string | null;
  registeredIds: string[];
  verdict: DoctorAssertionSeverity;
  message: string;
  consequence: string;
  remediation?: string;
}

/**
 * Evaluates provider consistency across configured and registered states.
 */
export function evaluateProviderConsistency(
  params: ProviderConsistencyParams
): ProviderConsistencyAssertion {
  const {
    capability,
    configPath,
    fallbackDescription = "built-in default",
    hazardNote = "",
  } = params;

  const selected =
    typeof params.selectedId === "string" && params.selectedId.trim()
      ? params.selectedId.trim()
      : null;
  const registered = [...params.registeredIds];
  const isSelectedRegistered = selected !== null && registered.includes(selected);
  const isUnsetDespiteRegistered = selected === null && registered.length > 0;

  // State 1: Configured ID does not match any registered plugin
  if (selected !== null && !isSelectedRegistered) {
    const hazard = hazardNote ? ` ${hazardNote}` : "";
    return {
      capability,
      configPath,
      selectedId: selected,
      registeredIds: registered,
      verdict: "error",
      message:
        `${configPath} "${selected}" is configured but NOT registered — ` +
        `OC falls back silently to ${fallbackDescription}.${hazard} Register the provider plugin or correct the ID.`,
      consequence: `${fallbackDescription} (fallback — unhandled selection)`,
      remediation:
        `Register a plugin claiming "${selected}" or change ${configPath} to ` +
        (registered.length > 0
          ? `one of: ${registered.map((r) => `"${r}"`).join(", ")}`
          : "unset / default"),
    };
  }

  // State 2: Providers registered by active plugins, but config is unset (dead-code hazard)
  if (isUnsetDespiteRegistered) {
    const hazard = hazardNote ? ` (${hazardNote})` : "";
    return {
      capability,
      configPath,
      selectedId: null,
      registeredIds: registered,
      verdict: "warn",
      message:
        `${configPath} is UNSET although ${registered.length} provider(s) are registered ` +
        `(${registered.join(", ")}) — ${fallbackDescription} runs unconditionally and ` +
        `registered provider is dead code.${hazard}`,
      consequence: `${fallbackDescription} (unselected provider is dead code)`,
      remediation: `Set ${configPath} to one of: ${registered.map((r) => `"${r}"`).join(", ")}.`,
    };
  }

  // State 3: Clean selection matching a registered provider
  if (selected !== null && isSelectedRegistered) {
    return {
      capability,
      configPath,
      selectedId: selected,
      registeredIds: registered,
      verdict: "ok",
      message: `${capability} provider "${selected}" is configured and active.`,
      consequence: `plugin provider "${selected}" (registered)`,
    };
  }

  // State 4: Unset with no custom providers registered (clean baseline default)
  return {
    capability,
    configPath,
    selectedId: null,
    registeredIds: registered,
    verdict: "ok",
    message: `${capability} provider unset with no plugin providers registered — clean default.`,
    consequence: `${fallbackDescription} (no custom providers registered — consistent)`,
  };
}

/**
 * Formats a doctor assertion line for CLI/doctor output and gateway boot summaries.
 */
export function formatDoctorAssertionLine(
  assertion: ProviderConsistencyAssertion
): string {
  const tag = assertion.verdict.toUpperCase().padEnd(5);
  return `[doctor:provider-consistency] [${tag}] ${assertion.capability}: ${assertion.message}`;
}
