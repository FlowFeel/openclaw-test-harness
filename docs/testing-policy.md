# Testing Policy — GHA-only execution for agents

> **Rule: agents do not run the OC runtime locally. All test execution for
> agent-driven changes happens in GitHub Actions.**

## Why

The harness drives a real OC gateway — a long-lived runtime that binds ports,
spawns processes and sidecars, writes to `$HOME/.openclaw`, and executes
plugin code in-process. A hostile or buggy change under test is exactly the
kind of thing that must not run against an operator's machine. The container
(`docker/Dockerfile`) is the containment boundary; GHA runners give every run
a fresh, disposable container with nothing valuable inside.

Local execution is reserved for humans who understand the blast radius.

## What this means in practice

### For agents
1. **Never execute tests, gate scripts, or the OC runtime on the host.** No
   `npm test`, no `vitest run` with e2e configs, no `docker compose up` from
   agent sessions.
2. **Static checks locally are fine** (they cannot execute project code):
   reading files, `tsc --noEmit`, `eslint`, foundry validation are pure
   analysis. When in doubt, run it in GHA instead.
3. **The PR is the test runner.** Open a PR (even a draft) and let CI run:
   - `typescript-tests` — unit layer (tsc + foundry + build + vitest ci config)
   - `docker-integration` — the container gate
   - `e2e-integration` — testcontainers + boot gate + oc-source contract specs
   - `python-tests` — Python layer
   Read the run logs (`gh run view --log-failed`) as the feedback loop, fix,
   push. Repeat.
4. **Branch protection is the enforcement.** Merging requires the GHA checks
   green; a local green run does not exist as a concept.

### For workflow authors
Any CI job that runs harness tests must either (a) replicate the full
environment of the job that proved the claim (submodule deps, docker, built
artifacts), or (b) run a vitest config scoped to what that environment can
prove. Never a hybrid — that is how the Ship Patches verify step failed
(see PR #25).

### Environment map
| Layer | Needs | Runs in |
|---|---|---|
| unit (`vitest.config.ci.ts`) | ts deps only | any GHA job |
| oc-source (`tests/oc-source/`) | submodule + `pnpm install --ignore-scripts` | e2e job |
| e2e / boot gate | docker + testcontainers + built plugin dists | e2e job |
| container parity (`docker/`) | docker | docker-integration job |

## Enforcement status

- CI runs on every PR and on main (`on: push/pull_request`).
- Ship Patches triggers only after CI succeeds on main
  (`workflow_run` gate) and re-verifies in the CI-identical environment.
- Recommended: mark `python-tests`, `typescript-tests`, `docker-integration`,
  `e2e-integration` as required status checks for `main` (repo settings →
  branch protection).
