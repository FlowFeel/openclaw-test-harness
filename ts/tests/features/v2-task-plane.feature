Feature: Plugins v2 Task Plane — Lock-Free Dispatch, Pipelines, Staging Verify & Durable Proxy
  As an OpenClaw task orchestrator
  I want lock-free async task dispatch, fail-fast pipelines, staging SHA verification, work queueing, and durable sidecar proxying
  So that long-running operations never block conversational lanes and always verify shipped state

  Scenario: Lock-free task dispatch creates a tracked running task and supports cancellation
    Given an oc-task-plane engine with in-memory registry and process spawner
    When task_dispatch is invoked for an exec command
    Then task_status reports the task as "running"
    And task_cancel transitions the task to "killed"

  Scenario: Staging verification distinguishes live deployments from stale images
    Given an oc-task-plane engine with a staging revision fetcher serving SHA "a1b2c3d"
    When staging_verify checks expected SHA "a1b2c3d"
    Then staging_verify reports verified true and status "live"
    When staging_verify checks expected SHA "deadbeef"
    Then staging_verify reports verified false and status "stale_image_running"

  Scenario: Work queue enforces concurrency cap and tracks total queued tasks
    Given an oc-task-plane engine with maxConcurrentSubagents 2
    When queue_work enqueues 3 tasks
    Then queue_work dispatches 2 tasks immediately
    And queue_status reports total 3

  Scenario: Open-world payloads survive dispatch, status query, and lock-free wake delivery untouched
    Given an oc-task-plane engine with in-memory registry, process spawner, and PluginApi workflow wake
    When task_dispatch is invoked with arbitrary nested and non-object OWA payloads
    Then task_status preserves all payload keys and raw non-object payloads verbatim
    And process exit wakes the owning session asynchronously without schema interception

