"""Task registry and periodic job definitions for OpenClaw harness.

Provides:
- Task registration contract for heartbeat and periodic maintenance tasks.
- Plugin drift check task wired to cron '0 */6 * * *'.
- CLI runner for task dispatch and standalone verification.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .drift_checker import (
    DriftClassification,
    check_plugin_drift,
    format_drift_alert,
    format_provenance_alert,
    format_resolution_alert,
    manage_alert_state,
    verify_commit_provenance,
)


@dataclass
class TaskDefinition:
    """Registered periodic or background task."""

    name: str
    cron: str
    handler: Callable[..., Any]
    timeout_seconds: int = 60
    description: str = ""


_TASK_REGISTRY: dict[str, TaskDefinition] = {}


def register_task(
    name: str,
    cron: str,
    handler: Callable[..., Any],
    *,
    timeout_seconds: int = 60,
    description: str = "",
) -> TaskDefinition:
    """Register a scheduled task in the harness task plane."""
    task = TaskDefinition(
        name=name,
        cron=cron,
        handler=handler,
        timeout_seconds=timeout_seconds,
        description=description,
    )
    _TASK_REGISTRY[name] = task
    return task


def get_task(name: str) -> TaskDefinition | None:
    """Retrieve registered task definition by name."""
    return _TASK_REGISTRY.get(name)


def list_tasks() -> list[TaskDefinition]:
    """Return all registered tasks in registration order."""
    return list(_TASK_REGISTRY.values())


def clear_registry() -> None:
    """Clear all registered tasks (used primarily in test teardown)."""
    _TASK_REGISTRY.clear()


def run_plugin_drift_check(
    *,
    extensions_dir: Path | str | None = None,
    manifest_path: Path | str | None = None,
    state_file: Path | str | None = None,
    release_tag: str = "",
    commit_sha: str = "",
    repo: str = "FlowFeel/openclaw-test-harness",
    github_token: str | None = None,
    archive_lookup_dir: Path | str | None = None,
) -> list[str]:
    """Execute plugin drift verification, check provenance, and manage alert state.

    Returns doctor assertion strings suitable for logging or CLI output.
    """
    doctor_lines: list[str] = []

    # 1. Provenance Gate (if commit SHA provided or inferred)
    if commit_sha:
        token = github_token or os.environ.get("GITHUB_TOKEN")
        provenance = verify_commit_provenance(repo, commit_sha, token=token)
        if not provenance.ok:
            error_msg = provenance.error or "Commit has no merged PR"
            doctor_lines.append(format_provenance_alert(commit_sha, error_msg))
            return doctor_lines

    # 2. Resolve Paths
    ext_env = os.environ.get("OPENCLAW_EXTENSIONS_DIR", "~/.openclaw/extensions")
    ext_dir = (
        Path(extensions_dir).expanduser()
        if extensions_dir
        else Path(ext_env).expanduser()
    )

    state_env = os.environ.get(
        "OPENCLAW_STATE_DIR",
        "~/.openclaw/state/drift-check-state.json",
    )
    st_file = (
        Path(state_file).expanduser()
        if state_file
        else Path(state_env).expanduser()
    )

    # 3. Load Manifest
    if manifest_path:
        m_path = Path(manifest_path).expanduser()
    else:
        # Check standard harness location
        ts_dir = Path(__file__).resolve().parent.parent.parent / "ts"
        default_manifest = ts_dir / "dist-plugins" / "plugins-manifest.json"
        m_path = default_manifest

    if not m_path.is_file():
        doctor_lines.append(
            f"[doctor:plugin-drift] [WARN ] Manifest not found at {m_path}"
        )
        return doctor_lines

    try:
        with m_path.open("r", encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        doctor_lines.append(
            f"[doctor:plugin-drift] [ERROR] Failed to load manifest: {exc}"
        )
        return doctor_lines

    # Archive bytes resolver fallback
    archive_dir = Path(archive_lookup_dir) if archive_lookup_dir else m_path.parent

    def get_archive_bytes(filename: str) -> bytes:
        tgz_file = archive_dir / filename
        if not tgz_file.is_file():
            msg = f"Archive {filename} not found in {archive_dir}"
            raise FileNotFoundError(msg)
        return tgz_file.read_bytes()

    # 4. Check Drift
    results = check_plugin_drift(
        ext_dir,
        manifest,
        get_archive_bytes_fn=get_archive_bytes,
    )

    # 5. Manage Alert State (Deduplication)
    delta, _ = manage_alert_state(results, st_file, release_tag=release_tag)

    # 6. Format Doctor Output
    for alert in delta.new_alerts:
        doctor_lines.append(format_drift_alert(alert, release_tag=release_tag))

    for plugin_id, resolved_sha in delta.resolved_alerts:
        doctor_lines.append(format_resolution_alert(plugin_id, resolved_sha))

    if not delta.new_alerts and not delta.resolved_alerts:
        match_count = sum(1 for r in results if r.status == DriftClassification.MATCH)
        total_count = len(results)
        doctor_lines.append(
            f"[doctor:plugin-drift] [OK   ] All {match_count}/{total_count} "
            "plugins verified against release baseline."
        )

    return doctor_lines


# Register default periodic heartbeat task
register_task(
    name="plugin_drift_check",
    cron="0 */6 * * *",
    handler=run_plugin_drift_check,
    timeout_seconds=60,
    description="Periodic verification of installed plugins against blessed release.",
)


def main() -> None:
    """CLI entrypoint for running registry tasks directly."""
    args = sys.argv[1:]
    if "--list" in args:
        print("Registered Tasks:")
        for task in list_tasks():
            pad_name = task.name.ljust(24)
            print(f"  - {pad_name} [{task.cron}] (timeout: {task.timeout_seconds}s)")
        return

    # Default to running drift check
    lines = run_plugin_drift_check()
    for line in lines:
        print(line)


if __name__ == "__main__":
    main()
