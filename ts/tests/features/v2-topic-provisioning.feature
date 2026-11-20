Feature: Plugins v2 Topic Provisioning — Automated Workspace Scaffolding & Care Package Drop
  As an OpenClaw topic lane supervisor
  I want automatic directory scaffolding and orientation care package generation on first topic agent turn
  So that new forum topic agents wake up grounded with zero cold-start blindness and direct access to tools/CATALOG.md

  Scenario: New forum topic agent run automatically provisions workspace and drops orientation care package
    Given an oc-lane-supervisor engine with automated topic provisioning enabled
    When an agent turn begins for forum topic 83272 named "Plugins Team"
    Then the workspace directories "docs", "scripts", "tests", and "state" are created under the topic home
    And an orientation care package is dropped at "archive/sessions/telegram/-1003842172831:topic:83272/topics/83272/care-package.md"
    And the agent's initial prompt context receives the orientation brief

  Scenario: Subsequent agent turns in provisioned topic are idempotent
    Given an oc-lane-supervisor engine with automated topic provisioning enabled
    And topic 83272 has already been provisioned
    When another agent turn begins for forum topic 83272
    Then zero additional filesystem writes occur
