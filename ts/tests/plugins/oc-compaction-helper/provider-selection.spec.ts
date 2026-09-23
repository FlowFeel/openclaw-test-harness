/**
 * oc-compaction-helper — provider-selection consistency specs (issue #35).
 *
 * @behavior
 * Verifies the selection report across all four selection states and the
 * core lesson of the dead-provider war story: registered-but-unselected
 * must be loud, not silent.
 *
 * @dft
 * - Pure function calls only; no clock, no I/O.
 * - Deterministic: repeated calls return identical reports.
 */

import { describe, it, expect } from "vitest";
import { providerSelectionReport } from "../../../src/plugins/oc-compaction-helper/src/provider-selection.js";

describe("providerSelectionReport (issue #35: the dead-provider class)", () => {
  const warn = (r: ReturnType<typeof providerSelectionReport>) => r.warning ?? "";

  it("registered-but-unselected is loud and names the wedge consequence", () => {
    const r = providerSelectionReport(null, ["literate", "streaming"]);
    expect(r.unsetDespiteRegistered).toBe(true);
    expect(r.warning).toBeTruthy();
    expect(warn(r)).toContain("UNSET");
    expect(warn(r)).toContain("#35");
    expect(r.consequence).toContain("built-in LLM summarizer");
    expect(r.consequence).toContain("dead code");
    expect(r.assertion.verdict).toBe("warn");
    expect(r.doctorLine).toContain("[doctor:provider-consistency] [WARN ] compaction:");
  });

  it("selected-but-unregistered is loud — OC falls back silently otherwise", () => {
    const r = providerSelectionReport("literate-typo", ["literate", "streaming"]);
    expect(r.selected).toBe("literate-typo");
    expect(r.selectedRegistered).toBe(false);
    expect(r.warning).toBeTruthy();
    expect(warn(r)).toContain("literate-typo");
    expect(warn(r)).toContain("NOT registered");
    expect(r.consequence).toContain("fallback");
    expect(r.assertion.verdict).toBe("error");
    expect(r.doctorLine).toContain("[doctor:provider-consistency] [ERROR] compaction:");
  });

  it("clean selection: selected and registered — no warning, positive consequence", () => {
    const r = providerSelectionReport("streaming", ["literate", "streaming"]);
    expect(r.selectedRegistered).toBe(true);
    expect(r.unsetDespiteRegistered).toBe(false);
    expect(r.warning).toBeUndefined();
    expect(r.consequence).toContain('plugin provider "streaming"');
    expect(r.assertion.verdict).toBe("ok");
    expect(r.doctorLine).toContain("[doctor:provider-consistency] [OK   ] compaction:");
  });

  it("unset with nothing registered is consistent — informational, not a warning", () => {
    const r = providerSelectionReport(null, []);
    expect(r.warning).toBeUndefined();
    expect(r.consequence).toContain("consistent");
    expect(r.assertion.verdict).toBe("ok");
    expect(r.doctorLine).toContain("[doctor:provider-consistency] [OK   ] compaction:");
  });

  it("empty-string and whitespace ids are treated as unset", () => {
    const r = providerSelectionReport("   ", ["literate"]);
    expect(r.selected).toBeNull();
    expect(r.unsetDespiteRegistered).toBe(true);
  });

  it("deterministic: repeated calls return identical reports", () => {
    const a = providerSelectionReport(null, ["literate", "streaming"]);
    const b = providerSelectionReport(null, ["literate", "streaming"]);
    expect(a).toEqual(b);
    expect(a.registered).toEqual(["literate", "streaming"]);
  });
});
