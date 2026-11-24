Feature: Incentive-Based Energy Budgeting & OWA Cognitive Economics
  As an OpenClaw topic lane supervisor
  I want positive economic rebates for delegation, batching incentives for pipelines, and non-blocking OWA tool execution
  So that agents avoid lane timeouts without negative gating, prompt nagging, or aborted work

  Scenario: Zero turn energy does not block tool execution (Strict OWA Non-Gating)
    Given an oc-lane-supervisor engine with initialSessionTier "constrained"
    And a session that has exhausted its energy pool to 0 units
    When the agent issues an "exec" tool call
    Then before_tool_call does not block the tool call
    And the tool call executes cleanly

  Scenario: Delegation grants immediate energy rebate and clears low-energy advisory
    Given a session with remaining energy at 80 units in the advisory zone
    When the agent delegates work via "sessions_spawn"
    Then remaining energy increases by 250 units to 330 units
    And the advisory flag is reset
    And the agent earns delegation habit points

  Scenario: Pipeline execution drains flat baseline energy and awards habit bonus
    Given a session with standard turn energy
    When the agent calls "exec_pipeline" with 10 batched steps
    Then the action incurs only flat baseline energy drain without serial friction penalties
    And the session earns a habit bonus for pipeline batching

  Scenario: High action density injects throttled actionable bridge without nagging
    Given a session with 12 tool actions performed in a single turn
    When tool results are persisted
    Then a constructive bridge suggesting sessions_spawn or exec_pipeline is emitted
    And the bridge is throttled to at most once every 5 actions
    And zero stop-sign nagging warnings are appended
