Feature: Plugins v2 Memory Nexus — Compaction, Sanitization, Recall & Off-Loop Sidecar
  As an OpenClaw agent
  I want real transcript compaction checks, M8 file deltas, in-situ sanitization, and memory recall delivery
  So that long-running sessions never saturate context ceilings or drop critical workflow cues

  Scenario: Compact check triggers when session exceeds threshold and enforces cooldown
    Given an oc-memory-nexus engine with autoCompactionThresholdMb 0.001
    When compact_check is invoked against an oversized session store
    Then compact_check recommends "compact"
    And an immediate second compact_check reports cooldown remaining

  Scenario: M8 compact_delta reports files modified or added after before_compaction
    Given an oc-memory-nexus engine with a recorded pre-compaction checkpoint
    When a watched file is modified and a new file is added
    Then compact_delta reports deltaCount 2 with modified and added paths

  Scenario: M1 event push enqueues matching memory cue into next turn
    Given an oc-memory-nexus engine with an indexed event-triggered code_rule note
    When after_tool_call fires with matching event parameters
    Then one memory cue injection is enqueued on the workflow API

