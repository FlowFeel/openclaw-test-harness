Feature: Plugin crash insurance — the runtime defends itself against hostile tool input and hook latency
  Our plugins must not be able to crash the OC gateway, and the gateway's
  tool boundary must answer every input with a protocol-shaped response.
  Every rule here is proven against the REAL runtime: a real gateway process
  (`openclaw gateway run`), the real RPC surface (`tools.invoke` over the
  gateway websocket protocol), and the real `createHookRunner` from OC source.
  No mocks of the system under test.

  Background:
    Given the test container image with OC 2026.7.1 baked in
    And the oc-topic-manager plugin built and enabled
    And the gateway booted with OPENCLAW_GATEWAY_TOKEN auth

  Rule: Tool boundary — every input gets a protocol-shaped response
    The gateway's `tools.invoke` RPC is the boundary between hostile callers
    and plugin `execute` functions. Whatever we throw at it — missing names,
    unknown tools, wrong types, oversized payloads — the gateway must respond
    (never hang, never crash) and stay serving afterwards.

    Scenario: missing tool name is rejected with an error shape
      Given the gateway is listening
      When a tools.invoke RPC arrives with no name field
      Then the gateway responds ok=true with payload ok=false and an error message
      And the gateway is still alive after the call

    Scenario: unknown tool name is rejected without crashing
      Given the gateway is healthy
      When a tools.invoke RPC names a tool that no plugin registered
      Then the gateway responds with payload ok=false and an error mentioning the tool is not available
      And the gateway is still alive after the call

    Scenario: null and wrong-typed params are rejected, not fatal
      Given the gateway is healthy
      When tools.invoke arrives with params set to null
      Then the gateway responds with a protocol-shaped failure
      And a follow-up valid RPC still succeeds
      And the gateway is still alive

    Scenario: oversized string payload does not kill the gateway
      Given the gateway is healthy
      When tools.invoke carries a 1 MiB string payload
      Then the gateway responds with a protocol-shaped response
      And the gateway is still alive after the call

    Scenario: valid tool call succeeds through the same boundary
      Given the session registry fixture exists in the container
      When tools.invoke calls topic_audit with a valid params object
      Then the gateway responds ok=true with payload ok=true
      And the payload carries the audit report fields
      And the gateway is still alive after the call

  Rule: Hook dispatch does not stall the event loop beyond budget
    Hook dispatch overhead with no handlers must be negligible, and our
    handlers under representative payloads must keep event-loop stalls under
    an explicit budget. Proven with the real `createHookRunner` (OC source,
    patch-built) and a monotonic event-loop delay probe — never a mock runner.

    Scenario: dispatch with zero handlers is negligible
      Given the real createHookRunner built from patched OC source
      When 100 dispatches run against a registry with no handlers
      Then each dispatch takes less than 0.1 milliseconds on average
      And the event-loop stall stays under 1 millisecond

    Scenario: dispatch with ten handlers stays under budget
      Given the real createHookRunner
      When 100 dispatches run against ten registered void handlers
      Then each dispatch takes less than 10 milliseconds on average
      And the event-loop stall stays under 10 milliseconds

    Scenario: a hostile handler that throws is swallowed with a trace, loop keeps breathing
      Given the real createHookRunner with catchErrors enabled
      When a handler throws synchronously during dispatch
      Then the dispatch resolves without rejecting
      And the failure is recorded in the hook trace
      And the event-loop stall stays under the budget

  Rule: Registry writes are crash-safe
    The topic registry is OC's live sessions.json. A crash mid-write must
    never leave it truncated or half-written: every write is atomic
    (tmp + rename) and preserves a backup of the previous content.

    Scenario: a successful write replaces the file atomically
      Given a fixture sessions.json on disk
      When writeSessions persists new content
      Then the file content equals the new registry
      And no temporary files remain next to it

    Scenario: a failed write leaves the previous file intact
      Given a fixture sessions.json on disk
      When the JSON payload cannot be serialized (circular reference)
      Then the write throws
      And the file content is unchanged

    Scenario: each write backs up the previous content
      Given a fixture sessions.json containing a known entry
      When writeSessions persists different content
      Then the backup file contains the previous registry content
