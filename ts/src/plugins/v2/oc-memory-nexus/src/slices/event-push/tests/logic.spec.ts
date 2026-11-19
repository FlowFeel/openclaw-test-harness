/**
 * Tier 1 Unit Spec: oc-memory-nexus / event-push slice.
 *
 * @dft Pure unit tests — zero I/O, zero clocks, zero mocks.
 */

import { describe, it, expect } from "vitest";
import { createEventPushSliceState } from "../state.js";
import { stepEventPush } from "../logic.js";
import { createRegistry, parseNoteFrontmatter } from "../../../memory-recall-logic.js";

const EVENT_NOTE =
  "---\n" +
  "kind: code_rule\n" +
  "event: deploy_staging\n" +
  "use_when: deploying staging builds\n" +
  "does_not_apply_when: local unit tests\n" +
  "provenance: incident log\n" +
  "source: memory/deploy.md\n" +
  "---\n" +
  "Verify revision SHA after staging deploy.";

describe("oc-memory-nexus / slices/event-push (Tier 1 Unit)", () => {
  it("pushes matching note once per session under hold-once policy", () => {
    const parsed = parseNoteFrontmatter(EVENT_NOTE, "memory/deploy.md");
    expect(parsed).not.toBeNull();
    const registry = createRegistry([parsed!]);

    let state = createEventPushSliceState(60_000);
    const first = stepEventPush(
      state,
      registry,
      { toolName: "exec", params: { cmd: "deploy_staging" }, sessionKey: "s1" },
      10_000,
    );
    state = first.nextState;
    expect(first.notesToPush).toHaveLength(1);
    expect(first.telemetryEvents).toEqual([{ kind: "code_rule", arm: "M1" }]);

    // Second identical event inside hold window is suppressed
    const second = stepEventPush(
      state,
      registry,
      { toolName: "exec", params: { cmd: "deploy_staging" }, sessionKey: "s1" },
      20_000,
    );
    expect(second.notesToPush).toHaveLength(0);
  });
});

