Feature: Subagent Spawn Admission
  In order to prevent burst cascades that saturate the V8 event loop
  As a platform engineer
  I need to verify that OC's spawn admission enforces concurrent limits
  and timeout guards before allowing new subagent sessions

  Background:
    Given the OC test container is running with patches applied

  @admission @maxConcurrent
  Scenario: Spawn admitted when under concurrent limit
    Given 0 active subagents are running
    And the maxConcurrent is configured to 2
    When a session requests to spawn a subagent
    Then the spawn should be admitted
    And the subagent should start running

  @admission @maxConcurrent
  Scenario: Spawn rejected when at concurrent limit
    Given 2 active subagents are running
    And the maxConcurrent is configured to 2
    When a session requests to spawn a subagent
    Then the spawn should be rejected
    And the governing cap should be "subagents.maxConcurrent"
    And the error should contain "global max concurrent"

  @admission @runTimeout
  Scenario: Spawn rejected when timed-out subagents exist
    Given 1 subagent has exceeded runTimeoutSeconds
    And the runTimeoutSeconds is configured to 300
    When a session requests to spawn a subagent
    Then the spawn should be rejected
    And the governing cap should be "subagents.runTimeoutSeconds"
    And the error should contain "must be cleaned up"

  @admission @runTimeout
  Scenario: Spawn admitted after timed-out subagent is cleaned up
    Given 0 subagents have exceeded runTimeoutSeconds
    When a session requests to spawn a subagent
    Then the spawn should be admitted

  @admission @depth
  Scenario: Spawn rejected at max spawn depth
    Given the caller depth is 1
    And the maxSpawnDepth is configured to 1
    When a session requests to spawn a subagent
    Then the spawn should be rejected
    And the governing cap should be "subagents.maxSpawnDepth"

  @admission @children
  Scenario: Spawn rejected at max children per agent
    Given the parent has 2 active children
    And the maxChildrenPerAgent is configured to 2
    When a session requests to spawn a subagent
    Then the spawn should be rejected
    And the governing cap should be "subagents.maxChildrenPerAgent"

  @lifecycle @timeout
  Scenario: Subagent transitions to timed_out after exceeding timeout
    Given a subagent is in running state
    And the runTimeoutSeconds is configured to 1
    When 1.5 seconds have elapsed
    Then the subagent should transition to timed_out
    And the subagent should be eligible for archival

  @lifecycle @archive
  Scenario: Timed-out subagent transitions to archived
    Given a subagent is in timed_out state
    And the archiveAfterMinutes is configured to 0
    When the archive sweep runs
    Then the subagent should transition to archived
    And no further transitions should be possible
