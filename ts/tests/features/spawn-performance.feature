Feature: Subagent spawning performance — the "flexible spine, tight entropy" policy
  Admission control admits parallel subagent work up to explicit caps;
  timeouts and archival keep entropy bounded. Every scenario below is
  executed by tests/integration/bdd.spec.ts and the efficiency specs.

  Background:
    Given the OC runtime is patched with:
      | patch                    | status |
      | child-admission          | active |
      | worker-pool              | active |
      | sqlite-registry          | active |
    And the config is:
      | maxConcurrent            | 6    |
      | maxChildrenPerAgent      | 4    |
      | maxSpawnDepth            | 1    |
      | runTimeoutSeconds        | 120  |
      | archiveAfterMinutes      | 5    |

  Rule: Parallel work is admitted up to the concurrent cap

    Scenario: Spawn admitted when under concurrent limit
      Given 0 active subagents are running
      When a subagent spawn is requested
      Then the spawn is admitted

    Scenario: Spawn rejected when at concurrent limit
      Given the concurrent limit is already reached
      When another subagent spawn is requested
      Then the spawn is rejected

  Rule: Tight entropy — timeouts and archival bound lingering work

    Scenario: Subagent transitions to timed_out
      Given a subagent has been running longer than its timeout
      When the transition is evaluated
      Then the subagent transitions to timed_out

    Scenario: Timed-out subagent transitions to archived
      Given a subagent is in the timed_out state
      When the archival transition runs
      Then the subagent transitions to archived
      And archived is final — no transitions out

  Rule: Heavy serialization never stalls the main loop

    Scenario: async I/O does not cause significant event loop blocking
      Given a large file read is issued asynchronously
      When the event-loop delay probe samples during the read
      Then the probe gap stays small compared to the sync variant

  Rule: The registry answers count queries from real storage

    Scenario: SQLite registry counts active sessions accurately
      Given the SQLite registry contains known session records
      When active session counts are queried
      Then the counts match the inserted records
