Feature: Plugins v2 Efficiency Scoring, Energy Budgeting and Soft Landing
  In order to eliminate unhandled supervisor timeouts, zero-delta polling cascades, and transcript bloat
  As a Systems Architect
  I need the plugin suite to enforce dynamic turn energy budgeting, award habit points, and gracefully gate runaway tools

  Background:
    Given an OpenClaw session with active session tier and energy budget enabled

  @efficiency @energy @budget
  Scenario: Turn energy pool initial allocation by session tier
    Given a session with tier "sovereign"
    When a new turn begins
    Then the initial energy pool should be 1200 units
    And the session should be in an ungated state

  @efficiency @energy @drain
  Scenario: Parsimonious tool execution incurs minimal temporal and baseline drain
    Given a session with tier "standard" and 1000 initial energy
    When a tool "read" executes for 2000 milliseconds
    Then the remaining energy should be reduced by 17 units
    And the action count should be incremented to 1

  @efficiency @habits @rebate
  Scenario: Asynchronous task delegation rewards energy rebate and habit points
    Given a session with tier "standard"
    When an asynchronous task is dispatched via "task_dispatch"
    Then the energy pool should receive a rebate of 200 units
    And the session should be awarded 150 habit points
    And the delegation counter should be incremented to 1

  @efficiency @penalty @polling
  Scenario: Zero-delta poll triggers instant drain penalty
    Given a session with tier "standard" and 1000 initial energy
    When a poll tool "process" returns zero new output
    Then the energy pool should suffer an instant drain penalty of 100 units
    And the session should accumulate 120 penalty points

  @efficiency @advisory
  Scenario: Energy advisory notice injected into tool response before critical ceiling
    Given a session with tier "constrained" and 600 initial energy
    When a heavy synchronous tool burns energy below the 200 unit threshold
    Then an energy advisory notice should be appended to the tool result envelope
    And tool execution should remain allowed

  @efficiency @soft_landing @gating
  Scenario: Exhausted energy budget enforces soft landing and gates subsequent tools cleanly
    Given a session with an exhausted turn energy pool of 0 units
    When the agent attempts to execute another tool call
    Then the tool call should be blocked before execution
    And the block reason should instruct the agent to synthesize its findings immediately

  @efficiency @reputation @tiers
  Scenario: Turn efficiency score updates rolling reputation and promotes session tier
    Given a session with rolling efficiency score of 78
    When a turn completes with a Turn Efficiency Score of 100
    Then the rolling efficiency score should update to 84
    And the session tier should be promoted to "sovereign"
    And the subagent concurrency allowance should expand to 6 slots
