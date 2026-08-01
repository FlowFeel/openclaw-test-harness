Feature: Subagent Spawning Performance
  In order to verify the "flexible spine, tight entropy" policy
  As a platform engineer
  I need to verify that multiple subagents can be spawned concurrently
  and that tight timeouts prevent lingering

  Background:
    Given the OC runtime is patched with:
      | patch                    | status |
      | child-admission          | active |
      | worker-pool              | active |
      | sqlite-registry           | active |
    And the config is:
      | maxConcurrent            | 6    |
      | maxChildrenPerAgent      | 4    |
      | maxSpawnDepth            | 1    |
      | runTimeoutSeconds        | 120  |
      | archiveAfterMinutes      | 5    |

  @acceptance @spine
  Scenario: Multiple subagents spawned concurrently
    Given 0 active subagents are running
    When 4 subagents are spawned in parallel
    Then all 4 spawns should be admitted
    And the worker pool should have available threads

  @acceptance @spine
  Scenario: Spawn rejected at concurrent limit
    Given 6 active subagents are running
    When a 7th subagent is requested
    Then the spawn should be rejected
    And the governing cap should be "subagents.maxConcurrent"

  @acceptance @entropy
  Scenario: Tight timeout kills lingering subagent
    Given a subagent has been running for 120 seconds
    When the timeout sweep runs
    Then the subagent should transition to timed_out
    And the subagent should be eligible for archival

  @acceptance @entropy
  Scenario: Fast cleanup after completion
    Given a subagent completed 5 minutes ago
    When the archive sweep runs
    Then the subagent should transition to archived
    And no further transitions should be possible

  @acceptance @worker-pool
  Scenario: Worker pool offloads JSON.stringify
    Given the worker pool has 3 threads
    When a large JSON object is serialized
    Then the serialization should run in a worker thread
    And the main event loop should not be blocked

  @acceptance @registry
  Scenario: SQLite registry returns counts fast
    Given the SQLite registry is synced
    When session counts are queried
    Then the query should complete in under 500ms
    And the counts should match the JSON registry

  @acceptance @policy
  Scenario: Flexible spine allows parallel work
    Given maxConcurrent is 6
    When 6 subagents are spawned in parallel
    Then all 6 should be admitted
    And each subagent has a 2-minute timeout
    And completed subagents are archived within 5 minutes
