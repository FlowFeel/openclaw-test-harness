# Topic registration recovery

Background: Research Stable is a Telegram forum group (-1003842172831) where
every topic must stay registered in OC's session registry. Registration loss
orphans topics silently (war story: topics 82385, 73239).

## Rule: Detect orphaned topics

**Given** the forum has topics 1, 82385, and 73336
**And** the session registry contains registrations for topic 1 only
**When** a topic audit runs
**Then** topic 82385 and 73336 are reported as orphaned
**And** no healthy topics are flagged

## Rule: Detect stale registrations

**Given** the session registry contains a registration for topic 99999
**And** the forum has no topic 99999
**When** a topic audit runs
**Then** the registration is reported as unregistered

## Rule: Archival policy

**Given** a topic idle for more than 14 days
**When** the archival policy evaluates it
**Then** the decision is archive with an idle reason

**Given** a topic with more than 2000 messages that is active
**When** the archival policy evaluates it
**Then** the decision is compact

**Given** a topic with 10 messages active today
**When** the archival policy evaluates it
**Then** the decision is leave

**Given** a topic whose last activity is unknown (no source supplied it)
**When** the archival policy evaluates it
**Then** the decision is leave with an "unknown" reason
**And** the idle rule is reported as unevaluated, not passed

**Given** a topic with more than 2000 messages whose last activity is unknown
**When** the archival policy evaluates it
**Then** the decision is compact

## Rule: Registry source injection

**Given** topic_audit invoked without injected registrations
**When** the audit runs
**Then** registrations are read from the OC session registry on disk
**And** non-topic session keys are ignored

## Rule: Recovery plan

**Given** orphaned topic 82385 in chat -1003842172831
**When** a recovery plan is built for agent "main"
**Then** the plan registers session key
  "agent:main:telegram:group:-1003842172831:topic:82385"
**And** the plan action is "register"

## Rule: Safety

**Given** a recovery request with an empty agentId
**When** a recovery plan is built
**Then** the operation is rejected

**Given** a recovery request with a non-numeric topicId
**When** topic_recover executes
**Then** the response states the input is invalid
**And** no plan is produced

## Rule: Apply recovery

**Given** an orphaned topic and a healthy session registry
**When** topic_recover executes with apply=true
**Then** the registry contains the canonical session key
**And** the report states applied=true with before=absent

**Given** a topic whose session key is already registered
**When** topic_recover executes with apply=true
**Then** the existing registry entry is preserved unchanged
**And** the report states applied=false with reason "already registered"

**Given** a registry that was just repaired via apply=true
**When** a topic audit runs against the same registry
**Then** no topics are reported as orphaned