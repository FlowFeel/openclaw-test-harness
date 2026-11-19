"""Drift checker value models and classification enums.

@invariants
- Pure value objects with zero I/O or side effects (A1, A6).

@dft
- Imported by drift_rules.py and drift_checker.py; covered by Python pytest suite.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path


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

