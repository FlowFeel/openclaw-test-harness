# Patches

Files applied to the OC installation at Docker image build time.

## Files

### child-admission.patch
**Type:** Unified diff patch against OC's `src/agents/child-admission.ts`
**Purpose:** Adds `maxConcurrent` (global active subagent limit) and `runTimeoutSeconds` (blocks spawn if timed-out subagents exist) guards to prevent burst cascades.
**Status:** Active. Applied at image build via `docker/Dockerfile`.

### child-admission.ts
**Type:** Standalone module (full replacement, not a diff)
**Purpose:** Drop-in replacement for OC's child-admission.ts. Used by e2e tests that import the patched logic directly.
**Status:** Active. Imported by test files via `tsx`.

### sqlite-accessor.ts
**Type:** Standalone module
**Purpose:** SQLite registry accessor with WAL mode and busy timeout. Used by e2e tests that need a real database.
**Status:** Active. Used by container tests.

### worker-pool.js
**Type:** Standalone module
**Purpose:** worker_threads pool for CPU-heavy JSON operations (stringify, parse, compaction). Offloads from main event loop.
**Status:** Active. Used by container tests.

## Patch Lifecycle

1. Patches are applied at Docker image build time (see `docker/Dockerfile`)
2. The `.patch` file uses unified diff format (`patch -p1`)
3. Standalone modules (`.ts`, `.js`) are imported directly by tests
4. To add a new patch: create `.patch` file here, rebuild the Docker image
5. To remove a patch: delete the file, rebuild
6. Compatibility is checked against the pinned `OC_VERSION` build arg
