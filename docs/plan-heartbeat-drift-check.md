# Implementation Plan: Heartbeat Drift-Check & Provenance Assertion

**Ticket:** (b) Heartbeat drift-check vs `plugins-manifest.json`  
**Status:** 📋 Planning / Review  
**Target Cadence:** `0 */6 * * *` (Scheduled Heartbeat / Registry Task)  
**Primary Seams:** `src/phosphene/drift_checker.py`, `registry.py`, and `ts/scripts/pack-plugins.mjs`  

---

## 1. Overview & Objectives

The goal of this task is to prevent silent plugin drift across gateway restarts and multi-agent ship boundaries by providing an automated, periodic verification loop that asserts:
1. **Provenance:** Every deployed/blessed release originated from a valid, merged GitHub Pull Request (closing the audit hole identified in commit `85ac1f2`).
2. **Integrity (The Referent Problem):** The runtime code currently installed in `~/.openclaw/extensions/*/dist/index.js` matches the verified inner bundle content of the blessed release, solving the mismatch where `plugins-manifest.json` tracks `.tgz` archive hashes rather than unpacked files.
3. **Alert Hygiene:** State-change-only alerting that notifies on new drift and reports resolution, avoiding periodic cron alert spam.

---

## 2. Architecture & Data Flow

```
                              [ GitHub Releases ]
                                       │
            ┌──────────────────────────┴──────────────────────────┐
            ▼                                                     ▼
┌─────────────────────────┐                             ┌───────────────────┐
│  plugins-manifest.json  │                             │  Release .tgz     │
│  (Tagged v0.1.14...)    │                             │  Archives         │
└───────────┬─────────────┘                             └─────────┬─────────┘
            │                                                     │
            │ ETag Cached                                         │ In-memory tarfile stream
            ▼                                                     ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                      Plugin Drift Checker (registry.py)                   │
│                                                                           │
│  1. Provenance Gate: GET /commits/<sha>/pulls != []                       │
│  2. Referent Resolver: Extracts inner dist/index.js SHA256 from archive   │
│  3. Runtime Examiner: Reads ~/.openclaw/extensions/*/dist/index.js        │
│  4. Diff & Classifier: MATCH | STALE | UNRECOGNIZED_BUILD | MISSING       │
│  5. Deduped State Manager: Emits on state delta, suppresses on tick       │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │
                                      ▼
                        [ Doctor / Heartbeat Alert ]
```

---

## 3. Key Design Decisions

### 3.1 Resolving the Referent Mismatch
* **Problem:** `plugins-manifest.json` contains the SHA256 digest of each `.tgz` archive. The gateway runtime only contains the unpacked `dist/index.js` bundles. Directly hashing installed files against the release manifest produces a 100% false-positive failure rate.
* **Phase 1 Strategy (In-memory Extraction):**
  - Download or stream the release `.tgz` into an in-memory `io.BytesIO`.
  - Use Python's standard `tarfile.open(fileobj=..., mode="r:gz")` to locate `package/dist/index.js`.
  - Compute the SHA256 of `package/dist/index.js` and compare against the runtime bundle.
  - Requires **zero changes** to existing released assets or the CI workflow.
* **Phase 2 Strategy (Packaging Forward-Compatibility):**
  - Update `ts/scripts/pack-plugins.mjs` so subsequent releases emit a `distIndexSha256` field in `plugins-manifest.json`.
  - When `distIndexSha256` is present in the manifest, the checker bypasses `.tgz` downloading and performs an $O(1)$ JSON lookup.

### 3.2 Provenance Assertion Gate
* **Problem:** Release tags can theoretically be pushed from an unreviewed local branch or shadow merge without entering CI or PR review.
* **Assertion:**
  - Before trusting a release tag, extract the commit SHA backing the tag.
  - Query GitHub REST API: `GET /repos/FlowFeel/openclaw-test-harness/commits/<sha>/pulls`.
  - **Invariant:** The list of associated PRs must be non-empty and have at least one PR with `merged_at != null`.
  - If violated, the check immediately flags a `[doctor:provenance-violation]` alert and refuses to accept the tag as the blessed baseline.

### 3.3 Alert Semantics & Deduplication
* **Problem:** Running on a 6-hour cron (`0 */6 * * *`) must not spam alerts every 6 hours if an operator has already acknowledged the drift and scheduled maintenance.
* **Semantics:**
  - Distinct signature per drift: `sig = f"{plugin_id}:{expected_sha[:12]}:{actual_sha[:12]}:{classification}"`
  - Active signatures are maintained in `~/.openclaw/state/drift-check-state.json`.
  - **New signature:** Emit alert with doctor severity `CRITICAL` or `WARN`.
  - **Unchanged signature:** Suppress alert on subsequent ticks.
  - **Resolved signature:** When `actual_sha == expected_sha`, emit a `[RESOLVED]` notification and prune from state.

### 3.4 Runtime Cadence & Performance
* Drift only changes during install, deployment, or gateway restart events.
* Cadence: `0 */6 * * *` (aligned with heartbeat tasks).
* HTTP overhead: Conditional `If-None-Match` (ETag) caching against GitHub API. A 304 response consumes no rate limit and takes <150ms.

---

## 4. Implementation Phases

### Phase 1: Drift Checker Core Engine (`src/phosphene/drift_checker.py`)

1. **Manifest & Asset Client (`DriftClient`):**
   - Query GitHub API for latest release matching `plugins-v0.1.*`.
   - Implement conditional ETag caching to avoid redundant downloads.
   - Read and parse `plugins-manifest.json`.
2. **Provenance Validator:**
   - Query `/commits/<sha>/pulls` for the release commit.
   - Return validation status: `{ ok: bool, pr_number: int | None, merged_at: str | None }`.
3. **Inner Tarball Extractor:**
   ```python
   def extract_bundle_sha256(tgz_bytes: bytes) -> str:
       with tarfile.open(fileobj=io.BytesIO(tgz_bytes), mode="r:gz") as tar:
           member = tar.getmember("package/dist/index.js")
           f = tar.extractfile(member)
           return hashlib.sha256(f.read()).hexdigest()
   ```
4. **Runtime Scanner & Classifier:**
   - Scan `~/.openclaw/extensions/` (or configured plugin directory).
   - Classify each plugin:
     - `MATCH`: Hashes match exactly.
     - `STALE`: Hash matches an older/different release bundle.
     - `UNRECOGNIZED_BUILD`: Bundle doesn't match any known release.
     - `MISSING`: Plugin in manifest is not installed on disk.
5. **State & Alert Manager:**
   - Persist state to `~/.openclaw/state/drift-check-state.json`.
   - Calculate delta: `new_alerts`, `suppressed_alerts`, `resolved_alerts`.

---

### Phase 2: Registry Task Integration (`registry.py`)

1. **Task Registration:**
   - Register `check_plugin_drift` in the task plane:
     ```python
     register_task(
         name="plugin_drift_check",
         cron="0 */6 * * *",
         handler=run_plugin_drift_check,
         timeout_seconds=60,
     )
     ```
2. **Doctor-Formatted Output:**
   - Format alert strings matching the established Doctor convention:
     ```
     [doctor:plugin-drift] [CRITICAL] Plugin 'oc-model-router' drift detected!
     Expected bundle SHA: d01b24c2c152 (from release plugins-v0.1.14...)
     Actual runtime SHA:   e3b0c44298fc (stale bundle)
     Action required: openclaw plugins install ./dist-plugins/flowfeel-oc-model-router-0.1.0.tgz
     ```
   - Format resolution string:
     ```
     [doctor:plugin-drift] [OK] Plugin 'oc-model-router' checksum restored (matches release d01b24c2c152).
     ```

---

### Phase 3: Packaging Forward-Compatibility (`ts/scripts/pack-plugins.mjs`)

1. **Emit `distIndexSha256`:**
   - Modify `pack-plugins.mjs` to compute the SHA256 of `dist/index.js` prior to running `npm pack`.
   - Add `distIndexSha256` directly into the catalog entry in `plugins-manifest.json`.
2. **Dual-Path Resolution in Checker:**
   - If `entry.get("distIndexSha256")` is present: use it immediately (zero network overhead).
   - If absent: fall back to downloading and extracting the `.tgz` (backwards-compatible with older releases).

---

### Phase 4: Verification & Test Matrix (`tests/test_drift_checker.py`)

1. **Provenance Unit Tests:**
   - `test_provenance_valid_pr`: PR merged -> passes.
   - `test_provenance_empty_pr`: No associated PR -> raises `PROVENANCE_VIOLATION`.
   - `test_provenance_unmerged_pr`: PR open but not merged -> raises `PROVENANCE_VIOLATION`.
2. **Tarball Extraction Tests:**
   - `test_tarball_bundle_hash_extraction`: In-memory synthetic `.tgz` with known content -> asserts expected SHA256.
3. **Drift Classification Tests:**
   - `test_classification_match`: Hash match -> `MATCH`.
   - `test_classification_stale`: Hash mismatch -> `STALE`.
   - `test_classification_missing`: Missing directory -> `MISSING`.
4. **Alert State Deduplication Tests:**
   - `test_alert_deduplication`: Consecutive runs with the same drift emit alert on tick 1, suppress on tick 2.
   - `test_alert_resolution`: Correcting the file on tick 3 clears signature and emits resolution notice.
5. **ETag Caching Tests:**
   - `test_etag_304_handling`: Unmodified manifest reuses local cache without re-downloading.

---

## 5. File & State Schemas

### 5.1 `drift-check-state.json` (`~/.openclaw/state/drift-check-state.json`)
```json
{
  "last_checked_tag": "plugins-v0.1.14.258f7e08b847-oc-2026.7.1",
  "manifest_etag": "\"26260dc1a07d188c41c5e41\"",
  "last_check_timestamp": "2026-10-04T08:15:00Z",
  "active_signatures": {
    "oc-model-router:d01b24c2c152:e3b0c44298fc:STALE": {
      "plugin": "oc-model-router",
      "expected_sha": "d01b24c2c152",
      "actual_sha": "e3b0c44298fc",
      "status": "STALE",
      "first_alerted_at": "2026-10-04T08:15:00Z",
      "last_seen_at": "2026-10-04T14:15:00Z"
    }
  }
}
```

### 5.2 Extended `plugins-manifest.json` Entry (Phase 3 Forward-Compatibility)
```json
{
  "id": "oc-model-router",
  "name": "@flowfeel/oc-model-router",
  "version": "0.1.0",
  "filename": "flowfeel-oc-model-router-0.1.0.tgz",
  "sizeBytes": 10112,
  "sha256": "d01b24c2c15240be12ba7e0b57772d61a5d1798de66f3d677445e0d5a511983e",
  "distIndexSha256": "8a7c2e391b10a24f0c82de92b02444391e6bdf201e5d36e2329e46a782b13c32",
  "description": "Model fallback chain optimization...",
  "contracts": { "tools": ["model_health"] }
}
```

---

## 6. Deliverables & Acceptance Criteria

| # | Item | Target Path | Acceptance Criteria |
|---|---|---|---|
| 1 | Drift & Provenance Module | `src/phosphene/drift_checker.py` | Provenance gate, tarball extraction, ETag caching, classification |
| 2 | Heartbeat / Registry Task | `registry.py` | Runs on `0 */6 * * *`, formats doctor alerts, deduplicates |
| 3 | State File Store | `~/.openclaw/state/drift-check-state.json` | Persists active signatures and ETags |
| 4 | Packaging Script Update | `ts/scripts/pack-plugins.mjs` | Emits `distIndexSha256` for forward-compatibility |
| 5 | Test Suite | `tests/test_drift_checker.py` | 100% pass on provenance, tarball extraction, alert dedup, and classification |
