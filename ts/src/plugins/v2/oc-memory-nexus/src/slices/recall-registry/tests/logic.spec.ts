/**
 * Tier 1 Unit Spec: oc-memory-nexus / recall-registry slice.
 *
 * @dft Pure unit tests — zero I/O, zero clocks, zero mocks.
 */

import { describe, it, expect } from "vitest";
import { createRecallRegistryState } from "../state.js";
import {
  indexRawNoteFiles,
  applyM4ReplyLint,
  recordExternalTelemetryEvents,
  projectRecallStatus,
  projectRecallVerification,
  projectRecallCatalogue,
} from "../logic.js";

const SAMPLE_NOTE =
  "---\n" +
  "kind: user_preference\n" +
  "use_when: formatting replies\n" +
  "does_not_apply_when: raw json requested\n" +
  "provenance: user interview\n" +
  "source: memory/user-prefs.md\n" +
  "---\n" +
  "Prefers concise replies.";

describe("oc-memory-nexus / slices/recall-registry (Tier 1 Unit)", () => {
  it("indexes frontmatter notes, verifies schemas, and projects filtered catalogue", () => {
    let state = createRecallRegistryState();
    const res = indexRawNoteFiles(state, [
      { id: "prefs", filePath: "memory/user-prefs.md", rawContent: SAMPLE_NOTE },
      { id: "plain", filePath: "memory/readme.md", rawContent: "# Just a readme" },
    ]);
    state = res.nextState;

    expect(res.scanned).toBe(2);
    expect(res.candidates).toBe(1);
    expect(res.indexed).toBe(1);

    const status = projectRecallStatus(state);
    expect(status.detail.totalNotes).toBe(1);
    expect(status.detail.validCount).toBe(1);

    const verification = projectRecallVerification(state);
    expect(verification.invalidCount).toBe(0);
    expect(verification.validCount).toBe(1);

    const cat = projectRecallCatalogue(state, { kind: "user_preference" });
    expect(cat.totalListed).toBe(1);

    const tel = recordExternalTelemetryEvents(state, [{ kind: "user_preference", arm: "M1" }]);
    expect(tel.count).toBe(1);
    expect(tel.nextState.telemetry.totalFired).toBe(1);

    const lint = applyM4ReplyLint(state, "All clean.");
    expect(lint.flaggedCount).toBe(0);
  });
});
