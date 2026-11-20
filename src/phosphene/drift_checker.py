"""Plugin drift checker and release provenance I/O orchestrator.

@invariants
- I/O boundary: isolates HTTP (GitHub API) and filesystem scans from pure rules
  in drift_rules.py (A1).
- Preserves all public exports from drift_models.py and drift_rules.py for
  backward compatibility.

@dft
- Accepts injectable requests.Session and get_archive_bytes_fn for
  deterministic testing (A5).
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import requests

from phosphene.drift_models import (
    AlertDelta,
    DriftClassification,
    PluginDriftResult,
    ProvenanceStatus,
)
from phosphene.drift_rules import (
    compute_alert_delta,
    extract_bundle_sha256,
    format_drift_alert,
    format_provenance_alert,
    format_resolution_alert,
    resolve_expected_bundle_sha256,
)

__all__ = [
    "AlertDelta",
    "DriftClassification",
    "PluginDriftResult",
    "ProvenanceStatus",
    "check_plugin_drift",
    "compute_alert_delta",
    "extract_bundle_sha256",
    "format_drift_alert",
    "format_provenance_alert",
    "format_resolution_alert",
    "manage_alert_state",
    "resolve_expected_bundle_sha256",
    "verify_commit_provenance",
]


def verify_commit_provenance(
    repo: str,
    commit_sha: str,
    *,
    token: str | None = None,
    session: requests.Session | None = None,
) -> ProvenanceStatus:
    """Assert that a release commit originated from a merged GitHub Pull Request."""
    url = f"https://api.github.com/repos/{repo}/commits/{commit_sha}/pulls"
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    client = session or requests.Session()
    try:
        resp = client.get(url, headers=headers, timeout=15)
    except requests.RequestException as exc:
        return ProvenanceStatus(
            ok=False, error=f"Network error querying commit PRs: {exc}"
        )

    if resp.status_code != 200:
        return ProvenanceStatus(
            ok=False, error=f"GitHub API error {resp.status_code}: {resp.text}"
        )

    pulls = resp.json()
    if not isinstance(pulls, list) or len(pulls) == 0:
        return ProvenanceStatus(
            ok=False,
            error=f"Commit {commit_sha} has no associated pull requests.",
        )

    for pr in pulls:
        merged_at = pr.get("merged_at")
        if merged_at is not None:
            return ProvenanceStatus(
                ok=True, pr_number=pr.get("number"), merged_at=merged_at
            )

    return ProvenanceStatus(
        ok=False,
        error=f"Commit {commit_sha} is associated with PR(s) but none are merged.",
    )


def check_plugin_drift(
    extensions_dir: Path | str,
    manifest: dict[str, Any],
    *,
    get_archive_bytes_fn: Callable[[str], bytes] | None = None,
) -> list[PluginDriftResult]:
    """Scan runtime extension directory and classify each plugin against manifest."""
    base_dir = Path(extensions_dir).expanduser()
    results: list[PluginDriftResult] = []

    for plugin in manifest.get("plugins", []):
        plugin_id = plugin.get("id") or plugin.get("name", "unknown")
        filename = plugin.get("filename")
        expected_sha = resolve_expected_bundle_sha256(plugin, get_archive_bytes_fn)

        plugin_dir = base_dir / plugin_id
        target_file = plugin_dir / "dist" / "index.js"
        if not target_file.is_file():
            alt_target = plugin_dir / "index.js"
            if alt_target.is_file():
                target_file = alt_target

        if not target_file.is_file():
            results.append(
                PluginDriftResult(
                    plugin_id=plugin_id,
                    status=DriftClassification.MISSING,
                    expected_sha=expected_sha,
                    actual_sha=None,
                    runtime_path=target_file if plugin_dir.exists() else None,
                    filename=filename,
                    details=f"Runtime bundle not found at {target_file}",
                )
            )
            continue

        try:
            actual_sha = hashlib.sha256(target_file.read_bytes()).hexdigest()
        except OSError as exc:
            results.append(
                PluginDriftResult(
                    plugin_id=plugin_id,
                    status=DriftClassification.UNRECOGNIZED_BUILD,
                    expected_sha=expected_sha,
                    actual_sha=None,
                    runtime_path=target_file,
                    filename=filename,
                    details=f"Error reading installed bundle: {exc}",
                )
            )
            continue

        if expected_sha is None:
            status = DriftClassification.UNRECOGNIZED_BUILD
            details = "Unable to resolve expected bundle hash from release"
        elif actual_sha == expected_sha:
            status = DriftClassification.MATCH
            details = "Runtime bundle matches release checksum exactly"
        else:
            status = DriftClassification.STALE
            details = "Runtime bundle hash differs from blessed release"

        results.append(
            PluginDriftResult(
                plugin_id=plugin_id,
                status=status,
                expected_sha=expected_sha,
                actual_sha=actual_sha,
                runtime_path=target_file,
                filename=filename,
                details=details,
            )
        )

    return results


def manage_alert_state(
    results: list[PluginDriftResult],
    state_file: Path | str,
    *,
    release_tag: str = "",
    manifest_etag: str = "",
) -> tuple[AlertDelta, dict[str, Any]]:
    """Deduplicate alerts using persistent state file with atomic writes."""
    state_path = Path(state_file).expanduser()
    state_path.parent.mkdir(parents=True, exist_ok=True)

    prior_signatures: dict[str, Any] = {}
    saved_tag = release_tag
    saved_etag = manifest_etag

    if state_path.is_file():
        try:
            with state_path.open("r", encoding="utf-8") as f:
                loaded = json.load(f)
                if isinstance(loaded, dict):
                    prior_signatures = loaded.get("active_signatures", {})
                    if not saved_tag:
                        saved_tag = loaded.get("last_checked_tag", "")
                    if not saved_etag:
                        saved_etag = loaded.get("manifest_etag", "")
        except (OSError, json.JSONDecodeError):
            prior_signatures = {}

    now_iso = datetime.now(UTC).isoformat()
    delta, active_signatures = compute_alert_delta(results, prior_signatures, now_iso)

    state: dict[str, Any] = {
        "last_checked_tag": saved_tag,
        "manifest_etag": saved_etag,
        "last_check_timestamp": now_iso,
        "active_signatures": active_signatures,
    }

    tmp_path = state_path.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    tmp_path.replace(state_path)

    return delta, state
