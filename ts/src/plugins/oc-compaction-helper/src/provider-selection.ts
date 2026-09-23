/**
 * provider-selection — compaction provider selection consistency report.
 *
 * @behavior
 * OC 2026.6.8 silently runs the built-in LLM summarizer when a compaction
 * provider is registered but not selected (unset config) — the "dead
 * provider" failure class (topic 70660 wedged twice; issue #35). This
 * report makes the selection state explicit at registration time and in
 * compact_check so drift cannot hide.
 *
 * @invariants
 * - Pure: (selectedId, registeredIds) -> report. No I/O.
 * - Deterministic: same inputs -> same report.
 * - Registered-but-unselected and selected-but-unregistered are BOTH loud.
 *
 * @dft
 * - provider-selection.spec.ts: all four selection states, deterministic
 *   output, consequence text naming the fallback behavior.
 */

import {
  evaluateProviderConsistency,
  formatDoctorAssertionLine,
  type ProviderConsistencyAssertion,
  type DoctorAssertionSeverity,
} from "../../shared/provider-consistency.js";

export interface ProviderSelectionReport {
  /** The id OC will select for compaction (null = unset config). */
  selected: string | null;
  /** Provider ids registered on this gateway. */
  registered: string[];
  /** True when the selected id (if any) is in the registered set. */
  selectedRegistered: boolean;
  /** True when nothing is selected although providers are registered. */
  unsetDespiteRegistered: boolean;
  /** Non-empty when drift or danger exists; log it at boot. */
  warning?: string;
  /** What actually runs compaction. */
  consequence: string;
  /** Full standardized doctor assertion (Issue #38). */
  assertion: ProviderConsistencyAssertion;
  /** Formatted doctor CLI/summary line. */
  doctorLine: string;
}

/**
 * Build the selection-consistency report delegating to generic doctor assertion logic.
 *
 * @param selectedId Value of agents.defaults.compaction.provider (null if unset).
 * @param registeredIds Ids registered by plugins on this gateway.
 */
export function providerSelectionReport(
  selectedId: string | null | undefined,
  registeredIds: string[]
): ProviderSelectionReport {
  const assertion = evaluateProviderConsistency({
    capability: "compaction",
    configPath: "agents.defaults.compaction.provider",
    selectedId,
    registeredIds,
    fallbackDescription: "built-in LLM summarizer",
    hazardNote: "wedges transcripts above ~5.2 MB (issue #35, topic 70660)",
  });

  const selected = assertion.selectedId;
  const registered = assertion.registeredIds;
  const selectedRegistered = selected !== null && registered.includes(selected);
  const unsetDespiteRegistered = selected === null && registered.length > 0;

  return {
    selected,
    registered,
    selectedRegistered,
    unsetDespiteRegistered,
    warning: assertion.verdict !== "ok" ? assertion.message : undefined,
    consequence: assertion.consequence,
    assertion,
    doctorLine: formatDoctorAssertionLine(assertion),
  };
}
