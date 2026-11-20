"""Pure drift evaluation, alert deduplication, and formatting rules.

@invariants
- Pure logic: zero filesystem or network I/O; timestamps injected explicitly (A1, A2).
- Deterministic: identical inputs produce identical deltas and alert strings.

@dft
- Tested via Python pytest suite (tests/test_drift_checker.py) with inline inputs.
"""

from __future__ import annotations

import hashlib
import io
import tarfile
from collections.abc import Callable
from typing import Any

from phosphene.drift_models import (
    AlertDelta,
    DriftClassification,
    PluginDriftResult,
)


def extract_bundle_sha256(tgz_bytes: bytes) -> str:
    """Extract inner dist/index.js from an in-memory .tgz and compute its SHA256."""
    with tarfile.open(fileobj=io.BytesIO(tgz_bytes), mode="r:gz") as tar:
        target_member = None
        for member in tar.getmembers():
            normalized = member.name.lstrip("./")
            is_dist_index = normalized in (
                "package/dist/index.js",
                "dist/index.js",
            ) or normalized.endswith("/dist/index.js")
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


def resolve_expected_bundle_sha256(
    plugin_entry: dict[str, Any],
    get_archive_bytes_fn: Callable[[str], bytes] | None = None,
) -> str | None:
    """Resolve expected dist/index.js SHA256 for a manifest entry."""
    cached_sha = plugin_entry.get("distIndexSha256")
    if cached_sha and isinstance(cached_sha, str):
        return cached_sha

    filename = plugin_entry.get("filename")
    if filename and get_archive_bytes_fn:
        tgz_bytes = get_archive_bytes_fn(filename)
        return extract_bundle_sha256(tgz_bytes)

    return None


def compute_alert_delta(
    results: list[PluginDriftResult],
    prior_signatures: dict[str, Any],
    now_iso: str,
) -> tuple[AlertDelta, dict[str, Any]]:
    """Pure transition computing new, suppressed, and resolved drift alerts."""
    active_signatures: dict[str, Any] = {
        k: dict(v) for k, v in prior_signatures.items()
    }
    delta = AlertDelta()
    current_drift_plugins: set[str] = set()

    for r in results:
        exp_short = r.expected_sha[:12] if r.expected_sha else "none"
        act_short = r.actual_sha[:12] if r.actual_sha else "none"

        if r.status != DriftClassification.MATCH:
            current_drift_plugins.add(r.plugin_id)
            sig = f"{r.plugin_id}:{exp_short}:{act_short}:{r.status.value}"

            if sig in active_signatures:
                active_signatures[sig]["last_seen_at"] = now_iso
                delta.suppressed_alerts.append(r)
            else:
                active_signatures[sig] = {
                    "plugin": r.plugin_id,
                    "expected_sha": exp_short,
                    "actual_sha": act_short,
                    "status": r.status.value,
                    "first_alerted_at": now_iso,
                    "last_seen_at": now_iso,
                }
                delta.new_alerts.append(r)

    resolved_sigs: list[str] = []
    for sig, sig_data in active_signatures.items():
        plugin_id = sig_data.get("plugin")
        if plugin_id and plugin_id not in current_drift_plugins:
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

    return delta, active_signatures


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
