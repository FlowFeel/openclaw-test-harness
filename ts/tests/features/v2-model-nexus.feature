Feature: Plugins v2 Model Nexus — Active Routing, Stream Relay & Passive Cache Telemetry
  As an OpenClaw gateway operator
  I want model failover routing, stream relay fallback tracking, and passive provider cache stats
  So that degraded models trigger fast failover without interfering with upstream provider caching

  Scenario: Degraded model triggers fallback recommendation to fastest healthy model
    Given a fresh oc-model-nexus engine with minSamples 2 and p99ThresholdMs 500
    When model "slow/model-a" records 2 calls with latency 900ms and 1 timeout error
    And model "fast/model-b" records 2 successful calls with latency 100ms
    Then model_health reports "slow/model-a" as "critical"
    And model_health recommends "fast/model-b" as fallback

  Scenario: Stream relay enters fallback mode after consecutive failures
    Given a fresh oc-model-nexus engine with maxRetries 2
    When 2 consecutive model calls fail
    Then stream_relay_health reports fallbackMode true and fallbackCount 1

  Scenario: Context cache stats passively observes provider cache tokens without mutating cache store
    Given a fresh oc-model-nexus engine
    When a model call ends with provider usage cacheReadTokens 1024
    Then context_cache_stats reports cacheSize 0
    And context_cache_stats reports providerCacheReadTokens 1024
