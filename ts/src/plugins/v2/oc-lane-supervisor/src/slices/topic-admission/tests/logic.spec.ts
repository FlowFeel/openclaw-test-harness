/**
 * Tier 1 Unit Spec: oc-lane-supervisor / topic-admission slice.
 *
 * @dft Pure unit tests — verifies real subagent semaphore acquire/release and topic key parsing.
 */

import { describe, it, expect } from "vitest";
import { createTopicAdmissionState } from "../state.js";
import {
  onSubagentSpawnTransition,
  onSubagentEndTransition,
  classifyTopicSession,
} from "../logic.js";

describe("oc-lane-supervisor / slices/topic-admission (Tier 1 Unit)", () => {
  it("enforces subagent semaphore capacity on spawn/end transitions", () => {
    let state = createTopicAdmissionState({ mainPoolMax: 2, subPoolMax: 1 });
    const s1 = onSubagentSpawnTransition(state, "sub-1");
    state = s1.nextState;
    expect(s1.admitted).toBe(true);
    expect(s1.activeCount).toBe(1);

    const s2 = onSubagentSpawnTransition(state, "sub-2");
    state = s2.nextState;
    expect(s2.admitted).toBe(false);

    const end1 = onSubagentEndTransition(state, "sub-1");
    state = end1.nextState;
    expect(end1.released).toBe(true);
    expect(end1.activeCount).toBe(0);
  });

  it("parses Telegram topic session keys cleanly", () => {
    const parsed = classifyTopicSession("agent:main:telegram:group:-100123:topic:83272");
    expect(parsed?.topicId).toBe("83272");
    expect(classifyTopicSession("dm:user:1")).toBeNull();
  });
});

