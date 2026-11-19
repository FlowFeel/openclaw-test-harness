Feature: Plugins v2 Lane Supervisor — Turn Energy, Poll Hygiene, Admission & Topic Recovery
  As an OpenClaw lane supervisor
  I want modular turn-energy budgeting, zero-delta poll collapsing, subagent semaphore tracking, and topic orphan recovery
  So that runaway poll loops enter soft landing cleanly and topic registries stay healthy

  Scenario: Zero-delta poll loop exhausts constrained turn energy and triggers soft landing
    Given an oc-lane-supervisor engine with initialSessionTier "constrained"
    When a session starts a turn and emits 6 zero-delta poll tool results
    Then before_tool_call blocks further tool calls with "Turn energy budget exhausted"

  Scenario: Idle whitespace prompt is suppressed before model invocation
    Given an oc-lane-supervisor engine with suppressIdleHeartbeats enabled
    When before_agent_run receives an empty whitespace prompt
    Then before_agent_run blocks the turn immediately

  Scenario: Topic audit and recovery plan detect unregistered topics deterministically
    Given an oc-lane-supervisor engine
    When topic_audit compares known topics against registrations
    And topic_recover builds a dry-run recovery plan for topic 99999
    Then topic_audit reports zero orphans for matching registrations
    And topic_recover returns a sessionKey containing "topic:99999"

