Feature: Topic-Aware Durable Memory Architecture (Pillar 1 & Pillar 2)
  As an OpenClaw agent operating in Telegram forum topics or platform lanes
  I want memory flushes dynamically routed to topic-scoped and domain-scoped Markdown living documents
  And long-running memory distillation offloaded non-blockingly to durable sidecar workers
  So that monolithic linear daily logs are replaced with high-relevance topic memory without burning conversational lane energy

  Scenario: Topic-scoped resolution for Telegram forum topic sessions
    Given an oc-memory-nexus plugin registered with InMemoryPluginApi
    When flushPlanResolver is invoked for Telegram topic 102248 "Cybernetics"
    Then the resolved targetPath is "meta/memory/topics/102248-cybernetics/MEMORY.md"
    And the promptObjective specifies topic-specific decisions and research progress
    And the sessionType is "topic"

  Scenario: Monorepo platform lane and user persona resolution
    Given an oc-memory-nexus plugin registered with InMemoryPluginApi
    When flushPlanResolver is invoked for a platform lane session
    Then the resolved targetPath is "meta/team/SPEC_LOG.md"
    And the sessionType is "platform"
    When flushPlanResolver is invoked for direct user "edphos"
    Then the resolved targetPath is "meta/memory/edphos/MEMORY.md"
    And the sessionType is "user"

  Scenario: Fallback unscoped resolution preserves daily note safety
    Given an oc-memory-nexus plugin registered with InMemoryPluginApi
    When flushPlanResolver is invoked with an unscoped context at date "2026-11-26"
    Then the resolved targetPath is "memory/2026-11-26.md"
    And the sessionType is "fallback"

  Scenario: Off-loop durable distillation dispatch in before_compaction
    Given an oc-memory-nexus plugin registered with a stateful durable spawner
    And an active Telegram topic session with recent transcript history
    When before_compaction hook is dispatched
    Then an off-loop durable task "memory_distill" is dispatched with target_dir "meta/memory/topics/102248-cybernetics"
    And zero in-lane file writes or token burns block the conversational turn
