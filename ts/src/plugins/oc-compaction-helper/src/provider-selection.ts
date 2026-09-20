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
}

/**
 * Build the selection-consistency report.
 *
 * @param selectedId Value of agents.defaults.compaction.provider (null if unset).
 * @param registeredIds Ids registered by plugins on this gateway.
 */
export function providerSelectionReport(
  selectedId: string | null | undefined,
  registeredIds: string[]
): ProviderSelectionReport {
  const selected = typeof selectedId === "string" && selectedId.trim() ? selectedId.trim() : null;
  const registered = [...registeredIds];
  const selectedRegistered = selected !== null && registered.includes(selected);
  const unsetDespiteRegistered = selected === null && registered.length > 0;

  if (selected !== null && !selectedRegistered) {
    return {
      selected,
      registered,
      selectedRegistered: false,
      unsetDespiteRegistered: false,
      warning:
        `compaction.provider "${selected}" is configured but NOT registered — ` +
        "OC falls back to the built-in LLM summarizer, which wedges transcripts " +
        "above ~5.2 MB (issue #35). Register it or fix the id.",
      consequence: "built-in LLM summarizer (fallback — unbounded single model call)",
    };
  }
  if (unsetDespiteRegistered) {
    return {
      selected: null,
      registered,
      selectedRegistered: false,
      unsetDespiteRegistered: true,
      warning:
        `compaction.provider is UNSET although ${registered.length} provider(s) ` +
        `are registered (${registered.join(", ")}) — the built-in LLM summarizer ` +
        "runs unconditionally and wedges transcripts above ~5.2 MB (issue #35, " +
        "the dead-provider class). Set agents.defaults.compaction.provider.",
      consequence: "built-in LLM summarizer (unselected provider is dead code)",
    };
  }
  return {
    selected,
    registered,
    selectedRegistered: selected !== null ? true : false,
    unsetDespiteRegistered: false,
    consequence:
      selected === null
        ? "built-in LLM summarizer (no providers registered either — consistent)"
        : `plugin provider "${selected}" (registered)`,
  };
}
