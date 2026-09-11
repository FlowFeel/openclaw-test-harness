# Topic registration recovery

Background: Research Stable is a Telegram forum group (-1003842172831) where
every topic must stay registered in OC's session registry. Registration loss
orphans topics silently (war story: topics 82385, 73239).

Every scenario below is executed by tests/plugins/oc-topic-manager/*.spec.ts.

## Rule: Detect orphaned topics

  Scenario: flags topics without a registration as orphaned

    **Given** the forum has topics 1, 82385, and 73336
    **And** the session registry contains registrations for topic 1 only
    **When** a topic audit runs
    **Then** topic 82385 and 73336 are reported as orphaned
    **And** no healthy topics are flagged

  Scenario: flags registrations whose topic vanished as unregisteredSessions

    **Given** the session registry contains a registration for topic 99999
    **And** the forum has no topic 99999
    **When** a topic audit runs
    **Then** the registration is reported as unregistered

## Rule: Archival policy

  Scenario: archives an idle topic

    **Given** a topic idle for more than 14 days
    **When** the archival policy evaluates it
    **Then** the decision is archive with an idle reason

  Scenario: compacts an oversized topic

    **Given** a topic with more than 2000 messages that is active
    **When** the archival policy evaluates it
    **Then** the decision is compact

  Scenario: does NOT archive on unknown last activity — rule is unevaluated, not passed

    **Given** a topic whose last activity is unknown
    **When** the archival policy evaluates it
    **Then** the decision is keep with an unknown-activity reason

  Scenario: still compacts an oversized topic when last activity is unknown

    **Given** an oversized topic whose last activity is unknown
    **When** the archival policy evaluates it
    **Then** the decision is compact

## Rule: Registry source injection

  Scenario: topic_audit reads registrations from the registry when omitted

    **Given** a session registry fixture on disk containing topic 1
    **And** a forum payload with topics 1 and 82385
    **When** topic_audit runs without an explicit registrations argument
    **Then** the audit reads the registry from disk
    **And** topic 82385 is reported as orphaned while topic 1 is not

## Rule: Recovery plan

  Scenario: produces a canonical OC session key

    **Given** agent "main", chat "-1003842172831", topic 82385
    **When** the canonical key is built
    **Then** the key is agent:main:telegram:group:-1003842172831:topic:82385

  Scenario: topic_recover returns a registration plan

    **Given** an orphaned topic 82385
    **When** topic_recover runs without apply
    **Then** the plan carries the canonical session key
    **And** the registry is not written

## Rule: Safety

  Scenario: rejects a missing agent id

    **Given** a recovery input without an agent id
    **When** the key is built
    **Then** the result is an error, not a malformed key

  Scenario: topic_recover rejects a bad topicId

    **Given** a recovery input whose topicId is not a number
    **When** topic_recover runs
    **Then** the tool answers with an invalid-input report

## Rule: Apply recovery

  Scenario: topic_recover apply=true registers the orphan; audit then sees it healthy

    **Given** an orphaned topic 82385 and a real temp registry file
    **When** topic_recover runs with apply=true
    **Then** the registry contains the canonical entry
    **And** a follow-up audit reports no orphans

  Scenario: topic_recover apply=true is idempotent — existing entries are preserved

    **Given** a registry that already contains the registration
    **When** topic_recover runs with apply=true again
    **Then** the existing entry is refused, never overwritten
    **And** the report explains the refusal
