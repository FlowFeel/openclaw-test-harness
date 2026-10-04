"""Plugin drift checker and release provenance assertion module.

Verifies that:
1. Blessed releases originated from a valid, merged GitHub Pull Request.
2. The runtime bundles installed in ~/.openclaw/extensions/*/dist/index.js
   match the verified inner bundle content of the blessed release (solving the
   archive .tgz vs unpacked bundle referent mismatch).
3. Drift alerts are deduplicated across periodic ticks, emitting only on state
   change (new drift or resolution).
"""

from __future__ import annotations

import hashlib
import io
import json
import tarfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any

import requests


class DriftClassification(StrEnum):
    """Classification of plugin drift state against blessed release."""

    MATCH = "MATCH"
    STALE = "STALE"
    UNRECOGNIZED_BUILD = "UNRECOGNIZED_BUILD"
    MISSING = "MISSING"


@dataclass
class ProvenanceStatus:
    """Result of verifying release commit provenance."""

    ok: bool
    pr_number: int | None = None
    merged_at: str | None = None
    error: str | None = None


@dataclass
class PluginDriftResult:
    """Drift check result for an individual plugin."""

    plugin_id: str
    status: DriftClassification
    expected_sha: str | None = None
    actual_sha: str | None = None
    runtime_path: Path | None = None
    filename: str | None = None
    details: str = ""


@dataclass
class AlertDelta:
    """State transition delta for drift alerts on a given tick."""

    new_alerts: list[PluginDriftResult] = field(default_factory=list)
    suppressed_alerts: list[PluginDriftResult] = field(default_factory=list)
    resolved_alerts: list[tuple[str, str]] = field(default_factory=list)


def extract_bundle_sha256(tgz_bytes: bytes) -> str:
    """Extract inner dist/index.js from an in-memory .tgz and compute its SHA256.

    Resolves the referent mismatch where plugins-manifest.json has .tgz hashes
    while the OpenClaw gateway runtime runs the unpacked dist/index.js bundle.
    """
    with tarfile.open(fileobj=io.BytesIO(tgz_bytes), mode="r:gz") as tar:
        # Standard npm pack structure places files inside a 'package/' top directory
        target_member = None
        for member in tar.getmembers():
            normalized = member.name.lstrip("./")
            is_dist_index = (
                normalized in ("package/dist/index.js", "dist/index.js")
                or normalized.endswith("/dist/index.js")
            )
            if is_dist_index:
                target_member = member
                break

        if target_member is None:
            msg = "dist/index.js not found in tarball archive"
            raise FileNotFoundError(msg)

        extracted = tar.extractfile(target_member)
        if extracted is None:
            msg = f"Failed to extract member {target_member.name} from tarball"
            raise ValueError(msg)

        return hashlib.sha256(extracted.read()).hexdigest()


def verify_commit_provenance(
    repo: str,
    commit_sha: str,
    *,
    token: str | None = None,
    session: requests.Session | None = None,
) -> ProvenanceStatus:
    """Assert that a release commit originated from a merged GitHub Pull Request.

    Enforces that release tags trace back to a reviewed and merged PR, closing
    the audit hole for untracked shadow merges or ad-hoc local tag pushes.
    """
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
            ok=False,
            error=f"Network error querying commit PRs: {exc}",
        )

    if resp.status_code != 200:
        return ProvenanceStatus(
            ok=False,
            error=f"GitHub API error {resp.status_code}: {resp.text}",
        )

    pulls = resp.json()
    if not isinstance(pulls, list) or len(pulls) == 0:
        return ProvenanceStatus(
            ok=False,
            error=f"Commit {commit_sha} has no associated pull requests.",
        )

    # Find at least one PR that was merged
    for pr in pulls:
        merged_at = pr.get("merged_at")
        if merged_at is not None:
            return ProvenanceStatus(
                ok=True,
                pr_number=pr.get("number"),
                merged_at=merged_at,
            )

    return ProvenanceStatus(
        ok=False,
        error=f"Commit {commit_sha} is associated with PR(s) but none are merged.",
    )


def resolve_expected_bundle_sha256(
    plugin_entry: dict[str, Any],
    get_archive_bytes_fn: Callable[[str], bytes] | None = None,
) -> str | None:
    """Resolve expected dist/index.js SHA256 for a manifest entry.

    Dual-path resolution:
    - Phase 3 (O(1)): If distIndexSha256 is present, return it directly.
    - Phase 1 (Archive unpack): Otherwise stream .tgz and extract the SHA256.
    """
    cached_sha = plugin_entry.get("distIndexSha256")
    if cached_sha and isinstance(cached_sha, str):
        return cached_sha

    filename = plugin_entry.get("filename")
    if filename and get_archive_bytes_fn:
        tgz_bytes = get_archive_bytes_fn(filename)
        return extract_bundle_sha256(tgz_bytes)

    return None


def check_plugin_drift(
    extensions_dir: Path | str,
    manifest: dict[str, Any],
    *,
    get_archive_bytes_fn: Callable[[str], bytes] | None = None,
) -> list[PluginDriftResult]:
    """Scan runtime extension directory and classify each plugin against manifest."""
    base_dir = Path(extensions_dir).expanduser()
    results: list[PluginDriftResult] = []

    plugins = manifest.get("plugins", [])
    for plugin in plugins:
        plugin_id = plugin.get("id") or plugin.get("name", "unknown")
        filename = plugin.get("filename")
        expected_sha = resolve_expected_bundle_sha256(plugin, get_archive_bytes_fn)

        # Look for installed bundle at extensions_dir / plugin_id / dist / index.js
        plugin_dir = base_dir / plugin_id
        target_file = plugin_dir / "dist" / "index.js"

        if not target_file.is_file():
            # Check alternative: direct index.js under plugin directory
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
            content = target_file.read_bytes()
            actual_sha = hashlib.sha256(content).hexdigest()
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
            results.append(
                PluginDriftResult(
                    plugin_id=plugin_id,
                    status=DriftClassification.UNRECOGNIZED_BUILD,
                    expected_sha=None,
                    actual_sha=actual_sha,
                    runtime_path=target_file,
                    filename=filename,
                    details="Unable to resolve expected bundle hash from release",
                )
            )
        elif actual_sha == expected_sha:
            results.append(
                PluginDriftResult(
                    plugin_id=plugin_id,
                    status=DriftClassification.MATCH,
                    expected_sha=expected_sha,
                    actual_sha=actual_sha,
                    runtime_path=target_file,
                    filename=filename,
                    details="Runtime bundle matches release checksum exactly",
                )
            )
        else:
            results.append(
                PluginDriftResult(
                    plugin_id=plugin_id,
                    status=DriftClassification.STALE,
                    expected_sha=expected_sha,
                    actual_sha=actual_sha,
                    runtime_path=target_file,
                    filename=filename,
                    details="Runtime bundle hash differs from blessed release",
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
    """Deduplicate alerts using persistent state file.

    Maintains active signatures keyed on:
      plugin:expected_sha:actual_sha:status
    Emits alerts only when new signatures appear, suppresses repeats on subsequent
    ticks, and emits resolution notices when a drifted plugin returns to MATCH.
    """
    state_path = Path(state_file).expanduser()
    state_path.parent.mkdir(parents=True, exist_ok=True)

    state: dict[str, Any] = {
        "last_checked_tag": release_tag,
        "manifest_etag": manifest_etag,
        "last_check_timestamp": datetime.now(UTC).isoformat(),
        "active_signatures": {},
    }

    if state_path.is_file():
        try:
            with state_path.open("r", encoding="utf-8") as f:
                loaded = json.load(f)
                if isinstance(loaded, dict):
                    state["active_signatures"] = loaded.get("active_signatures", {})
                    if not release_tag:
                        state["last_checked_tag"] = loaded.get("last_checked_tag", "")
                    if not manifest_etag:
                        state["manifest_etag"] = loaded.get("manifest_etag", "")
        except (OSError, json.JSONDecodeError):
            state["active_signatures"] = {}

    active_signatures: dict[str, Any] = state["active_signatures"]
    delta = AlertDelta()
    now_iso = datetime.now(UTC).isoformat()

    current_drift_plugins: set[str] = set()

    for r in results:
        exp_short = r.expected_sha[:12] if r.expected_sha else "none"
        act_short = r.actual_sha[:12] if r.actual_sha else "none"

        if r.status != DriftClassification.MATCH:
            current_drift_plugins.add(r.plugin_id)
            sig = f"{r.plugin_id}:{exp_short}:{act_short}:{r.status.value}"

            if sig in active_signatures:
                # Already alerted on a previous tick -> suppress
                active_signatures[sig]["last_seen_at"] = now_iso
                delta.suppressed_alerts.append(r)
            else:
                # New drift detected -> record and alert
                active_signatures[sig] = {
                    "plugin": r.plugin_id,
                    "expected_sha": exp_short,
                    "actual_sha": act_short,
                    "status": r.status.value,
                    "first_alerted_at": now_iso,
                    "last_seen_at": now_iso,
                }
                delta.new_alerts.append(r)

    # Detect resolutions: any active signature whose plugin is now MATCH
    resolved_sigs: list[str] = []
    for sig, sig_data in active_signatures.items():
        plugin_id = sig_data.get("plugin")
        if plugin_id and plugin_id not in current_drift_plugins:
            # Check if this plugin is now in results with MATCH
            matching_result = next(
                (res for res in results if res.plugin_id == plugin_id),
                None,
            )
            if matching_result and matching_result.status == DriftClassification.MATCH:
                res_sha = (
                    matching_result.actual_sha
                    or matching_result.expected_sha
                    or "unknown"
                )
                delta.resolved_alerts.append((plugin_id, res_sha))
                resolved_sigs.append(sig)

    for sig in resolved_sigs:
        active_signatures.pop(sig, None)

    state["active_signatures"] = active_signatures
    state["last_checked_tag"] = release_tag or state.get("last_checked_tag", "")
    state["manifest_etag"] = manifest_etag or state.get("manifest_etag", "")
    state["last_check_timestamp"] = now_iso

    # Atomic write
    tmp_path = state_path.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    tmp_path.replace(state_path)

    return delta, state


def format_drift_alert(result: PluginDriftResult, release_tag: str = "") -> str:
    """Format doctor assertion line for a detected plugin drift."""
    tag_info = f" (from release {release_tag})" if release_tag else ""
    exp_str = result.expected_sha[:12] if result.expected_sha else "unknown"
    act_str = result.actual_sha[:12] if result.actual_sha else "missing"
    status_label = result.status.value.lower()

    lines = [
        f"[doctor:plugin-drift] [CRITICAL] Plugin '{result.plugin_id}' drift detected!",
        f"Expected bundle SHA: {exp_str}{tag_info}",
        f"Actual runtime SHA:   {act_str} ({status_label})",
    ]
    if result.filename:
        cmd = f"openclaw plugins install ./dist-plugins/{result.filename}"
        lines.append(f"Action required: {cmd}")
    return "\n".join(lines)


def format_resolution_alert(plugin_id: str, resolved_sha: str) -> str:
    """Format doctor assertion line for a restored/resolved plugin."""
    short_sha = resolved_sha[:12] if resolved_sha else "verified"
    return (
        f"[doctor:plugin-drift] [OK   ] Plugin '{plugin_id}' "
        f"checksum restored (matches release {short_sha})."
    )


def format_provenance_alert(commit_sha: str, error_msg: str) -> str:
    """Format doctor assertion line for a release provenance gate violation."""
    short_sha = commit_sha[:12] if commit_sha else "unknown"
    return (
        f"[doctor:provenance-violation] [CRITICAL] Release commit {short_sha} "
        f"failed provenance gate: {error_msg}"
    )
