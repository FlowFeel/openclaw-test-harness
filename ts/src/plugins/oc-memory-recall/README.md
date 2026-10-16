# OcMemoryRecall Plugin (`@flowfeel/oc-memory-recall`)

Memory-recall delivery arms for OpenClaw — implementing Deliverables 0, 1, and 2 from [Issue #53](https://github.com/FlowFeel/openclaw-test-harness/issues/53) and [docs/memory-recall-next-steps.md](../../../docs/memory-recall-next-steps.md).

---

## Overview

The `oc-memory-recall` plugin provides deterministic, host-computed delivery mechanisms for authoritative memory:
1. **Deliverable 0 (Note Registry & Frontmatter Schema):** Parses markdown notes with YAML frontmatter at gateway boot into an in-memory index keyed by target file paths and note kinds.
2. **Deliverable 1 (Fire / Hit / Follow Telemetry):** Tracks atomic counters per kind per delivery arm to distinguish unfired signposts from failed lookups.
3. **Deliverable 2 (M6 Marker-on-File-Read Injection):** Intercepts file-reading tools in `tool_result_persist` and prepends authoritative memory signposts without altering source files.

---

## Zero Auxiliary Model Calls Invariant

Per the standing efficiency constraint:
- **0 extra model calls:** All registry lookups, path normalization, telemetry counters, and marker formatting run as $O(1)$ deterministic TypeScript compute in the plugin host.
- No secondary LLM-as-a-judge passes or classification turns.

---

## Foundation Note Schema

Every authoritative memory note in `memory/` (or configured `notesDir`) carries frontmatter with the 5 required fields:

```markdown
---
kind: house_style
use_when: Writing or modifying plugin logic seams
does_not_apply_when: Writing integration test doubles
provenance: "Research Stable 2026-10-15 / 1d"
source: "docs/coding-style.md"
title: "House Style Guidelines"
paths:
  - "src/plugins/shared/types.ts"
  - "docs/conventions.md"
---

# Authoritative Content
...
```

### Schema Fields
- `kind`: One of 14 standard catalogue kinds (`house_style`, `authority`, `silent_trap`, `code_rule`, `domain_fact`, `external_dep`, `procedure`, `user_preference`, `environment`, `project_status`, `architectural_decision`, `historical_incident`, `workaround`, `glossary`).
- `use_when`: Applicability condition read by the model to self-judge scope.
- `does_not_apply_when`: Scope boundaries preventing misapplication.
- `provenance`: Origin basis and freshness age.
- `source`: Primary authoritative file or live-source pointer.
- `paths` (optional): Additional file paths or patterns that trigger the M6 marker when read.

---

## Delivery Arm M6: Marker on File Read

When an agent reads an on-disk file using any file tool (`view_file`, `read_file`, `readFile`, `cat`), `oc-memory-recall` matches the path against the registry. If an authoritative note tracks that file, the plugin synchronously prepends a signpost in `tool_result_persist`:

```
# [SIGNPOST] May be out of date; the current version is kept in memory: docs/coding-style.md (Writing or modifying plugin logic seams)

[Original file content follows...]
```

This ensures the agent is immediately alerted to in-memory authority without modifying files on disk or consuming extra turns.

---

## Tools

### `recall_status`
Returns registry statistics, kind breakdown, and fire/hit/follow telemetry metrics:
```bash
ok: notes: 14 total (14 valid, 0 invalid), 8 kinds, 22 tracked paths
telemetry: totals (fired: 4, hit: 4, followed: 2)
  • [house_style][M6]: fired=3 hit=3 followed=1
  • [silent_trap][M6]: fired=1 hit=1 followed=1
```

### `recall_verify`
Validates note frontmatter against the foundation schema and resolves watched paths:
- **Parameters:**
  - `reload` (`boolean`, optional): Reload notes from disk before validating (default: `true`).

---

## Configuration

In `openclaw.json`:
```json
{
  "plugins": {
    "entries": {
      "oc-memory-recall": {
        "enabled": true,
        "config": {
          "notesDir": "memory",
          "markerPrefix": "# [SIGNPOST] May be out of date; the current version is kept in memory:",
          "telemetryEnabled": true
        }
      }
    }
  }
}
```
