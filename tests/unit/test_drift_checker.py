"""Unit tests for plugin drift checker, provenance assertion, and task registry.

Tests:
1. Release commit provenance assertions (merged PR vs unmerged/empty).
2. Tarball dist/index.js extraction (resolving archive vs bundle referent problem).
3. Drift classification (MATCH, STALE, MISSING, UNRECOGNIZED_BUILD).
4. Alert state deduplication and resolution transitions.
5. Registry task registration and periodic heartbeat execution.
"""

from __future__ import annotations

import hashlib
import io
import json
import tarfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import requests

from phosphene.drift_checker import (
    DriftClassification,
    PluginDriftResult,
    check_plugin_drift,
    extract_bundle_sha256,
    format_drift_alert,
    format_provenance_alert,
    format_resolution_alert,
    manage_alert_state,
    resolve_expected_bundle_sha256,
    verify_commit_provenance,
)
from phosphene.registry import (
    clear_registry,
    get_task,
    list_tasks,
    register_task,
    run_plugin_drift_check,
)


def _create_synthetic_tgz(files: dict[str, bytes]) -> bytes:
    """Helper to create an in-memory gzipped tarball."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


# ── Provenance Assertion Tests ──────────────────────────────────────────


class TestProvenanceAssertion:
    """Verify commit provenance checks against GitHub API."""

    def test_provenance_valid_merged_pr(self) -> None:
        """Commit with a merged PR passes the provenance gate."""
        session = MagicMock(spec=requests.Session)
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = [
            {"number": 47, "merged_at": "2026-10-01T17:30:00Z"},
        ]
        session.get.return_value = response

        status = verify_commit_provenance(
            "FlowFeel/openclaw-test-harness",
            "85ac1f2",
            session=session,
        )
        assert status.ok
        assert status.pr_number == 47
        assert status.merged_at == "2026-10-01T17:30:00Z"
        assert status.error is None

    def test_provenance_empty_prs(self) -> None:
        """Commit with no associated PRs fails the provenance gate."""
        session = MagicMock(spec=requests.Session)
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = []
        session.get.return_value = response

        status = verify_commit_provenance(
            "FlowFeel/openclaw-test-harness",
            "deadbeef",
            session=session,
        )
        assert not status.ok
        assert status.pr_number is None
        assert "no associated pull requests" in (status.error or "")

    def test_provenance_unmerged_pr(self) -> None:
        """Commit with PR that has not been merged fails provenance gate."""
        session = MagicMock(spec=requests.Session)
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = [
            {"number": 99, "merged_at": None},
        ]
        session.get.return_value = response

        status = verify_commit_provenance(
            "FlowFeel/openclaw-test-harness",
            "shadow123",
            session=session,
        )
        assert not status.ok
        assert "none are merged" in (status.error or "")

    def test_provenance_api_error(self) -> None:
        """GitHub API non-200 responses return failure."""
        session = MagicMock(spec=requests.Session)
        response = MagicMock()
        response.status_code = 404
        response.text = "Not Found"
        session.get.return_value = response

        status = verify_commit_provenance(
            "FlowFeel/openclaw-test-harness",
            "missing",
            session=session,
        )
        assert not status.ok
        assert "GitHub API error 404" in (status.error or "")

    def test_provenance_network_error(self) -> None:
        """Network exception returns ok=False with error message."""
        session = MagicMock(spec=requests.Session)
        session.get.side_effect = requests.ConnectionError("Connection refused")

        status = verify_commit_provenance(
            "FlowFeel/openclaw-test-harness",
            "offline",
            session=session,
        )
        assert not status.ok
        assert "Network error" in (status.error or "")


# ── Referent Resolution & Tarball Extraction Tests ─────────────────────


class TestTarballExtraction:
    """Test extracting inner dist/index.js from release .tgz archives."""

    def test_extract_bundle_sha256_success(self) -> None:
        """Correctly extracts dist/index.js and returns SHA256."""
        bundle_content = b"console.log('openclaw plugin runtime bundle');"
        expected_sha = hashlib.sha256(bundle_content).hexdigest()

        tgz_bytes = _create_synthetic_tgz(
            {
                "package/package.json": b'{"name": "@flowfeel/test-plugin"}',
                "package/dist/index.js": bundle_content,
            }
        )

        extracted_sha = extract_bundle_sha256(tgz_bytes)
        assert extracted_sha == expected_sha

    def test_extract_bundle_sha256_missing_file(self) -> None:
        """Raises FileNotFoundError if archive does not contain dist/index.js."""
        tgz_bytes = _create_synthetic_tgz(
            {
                "package/package.json": b'{"name": "@flowfeel/test-plugin"}',
                "package/src/index.ts": b"export {};",
            }
        )

        with pytest.raises(FileNotFoundError, match=r"dist/index\.js not found"):
            extract_bundle_sha256(tgz_bytes)


# ── Dual-Path Resolution Tests ──────────────────────────────────────────


class TestDualPathResolution:
    """Verify resolve_expected_bundle_sha256 uses O(1) manifest field or tarball."""

    def test_prefers_dist_index_sha_from_manifest(self) -> None:
        """If distIndexSha256 is present, return it directly without reading archive."""
        entry = {
            "id": "oc-test",
            "filename": "oc-test-0.1.0.tgz",
            "distIndexSha256": "fast_cached_sha_12345",
        }
        getter = MagicMock()
        sha = resolve_expected_bundle_sha256(entry, getter)
        assert sha == "fast_cached_sha_12345"
        getter.assert_not_called()

    def test_falls_back_to_tarball_extraction(self) -> None:
        """If distIndexSha256 is absent, invokes getter and unpacks tarball."""
        content = b"inner bundle code"
        expected_sha = hashlib.sha256(content).hexdigest()
        tgz_bytes = _create_synthetic_tgz({"package/dist/index.js": content})

        entry = {
            "id": "oc-test",
            "filename": "oc-test-0.1.0.tgz",
        }
        getter = MagicMock(return_value=tgz_bytes)
        sha = resolve_expected_bundle_sha256(entry, getter)
        assert sha == expected_sha
        getter.assert_called_once_with("oc-test-0.1.0.tgz")


# ── Drift Classification Tests ─────────────────────────────────────────


class TestCheckPluginDrift:
    """Verify runtime directory scanning and drift classification."""

    def test_classification_match_and_stale_and_missing(self, tmp_path: Path) -> None:
        """Simulate MATCH, STALE, and MISSING plugins simultaneously."""
        ext_dir = tmp_path / "extensions"
        ext_dir.mkdir()

        # Plugin 1: MATCH
        p1_dir = ext_dir / "oc-matched" / "dist"
        p1_dir.mkdir(parents=True)
        p1_code = b"matched plugin runtime code"
        (p1_dir / "index.js").write_bytes(p1_code)
        p1_sha = hashlib.sha256(p1_code).hexdigest()

        # Plugin 2: STALE (different code installed)
        p2_dir = ext_dir / "oc-stale" / "dist"
        p2_dir.mkdir(parents=True)
        (p2_dir / "index.js").write_bytes(b"old stale code")

        # Plugin 3: MISSING (directory not created)

        manifest = {
            "plugins": [
                {
                    "id": "oc-matched",
                    "filename": "oc-matched-0.1.0.tgz",
                    "distIndexSha256": p1_sha,
                },
                {
                    "id": "oc-stale",
                    "filename": "oc-stale-0.1.0.tgz",
                    "distIndexSha256": "expected_new_sha_9999",
                },
                {
                    "id": "oc-missing",
                    "filename": "oc-missing-0.1.0.tgz",
                    "distIndexSha256": "some_sha_8888",
                },
            ]
        }

        results = check_plugin_drift(ext_dir, manifest)
        by_id = {r.plugin_id: r for r in results}

        assert by_id["oc-matched"].status == DriftClassification.MATCH
        assert by_id["oc-matched"].actual_sha == p1_sha

        assert by_id["oc-stale"].status == DriftClassification.STALE
        assert by_id["oc-stale"].expected_sha == "expected_new_sha_9999"

        assert by_id["oc-missing"].status == DriftClassification.MISSING
        assert by_id["oc-missing"].actual_sha is None


# ── Alert Deduplication & Resolution Tests ─────────────────────────────


class TestManageAlertState:
    """Verify state-change-only alerting and resolution notifications."""

    def test_alert_lifecycle_new_suppressed_resolved(self, tmp_path: Path) -> None:
        """Tick 1: new drift alert.

        Tick 2: drift unchanged -> alert suppressed.
        Tick 3: drift fixed -> resolution notice emitted.
        """
        state_file = tmp_path / "drift-check-state.json"

        # Tick 1: Plugin is STALE
        stale_res = [
            PluginDriftResult(
                plugin_id="oc-model-router",
                status=DriftClassification.STALE,
                expected_sha="d01b24c2c15240be",
                actual_sha="e3b0c44298fc1c14",
                filename="oc-model-router-0.1.0.tgz",
            ),
        ]
        delta_t1, state_t1 = manage_alert_state(
            stale_res,
            state_file,
            release_tag="plugins-v0.1.14",
        )
        assert len(delta_t1.new_alerts) == 1
        assert delta_t1.new_alerts[0].plugin_id == "oc-model-router"
        assert len(delta_t1.suppressed_alerts) == 0
        assert len(delta_t1.resolved_alerts) == 0
        assert len(state_t1["active_signatures"]) == 1

        # Tick 2: Drift persists without change
        delta_t2, _ = manage_alert_state(
            stale_res,
            state_file,
            release_tag="plugins-v0.1.14",
        )
        assert len(delta_t2.new_alerts) == 0
        assert len(delta_t2.suppressed_alerts) == 1
        assert delta_t2.suppressed_alerts[0].plugin_id == "oc-model-router"
        assert len(delta_t2.resolved_alerts) == 0

        # Tick 3: Operator installs the matching bundle -> MATCH
        matched_res = [
            PluginDriftResult(
                plugin_id="oc-model-router",
                status=DriftClassification.MATCH,
                expected_sha="d01b24c2c15240be",
                actual_sha="d01b24c2c15240be",
                filename="oc-model-router-0.1.0.tgz",
            ),
        ]
        delta_t3, state_t3 = manage_alert_state(
            matched_res,
            state_file,
            release_tag="plugins-v0.1.14",
        )
        assert len(delta_t3.new_alerts) == 0
        assert len(delta_t3.suppressed_alerts) == 0
        assert len(delta_t3.resolved_alerts) == 1
        assert delta_t3.resolved_alerts[0] == ("oc-model-router", "d01b24c2c15240be")
        assert len(state_t3["active_signatures"]) == 0


# ── Doctor Formatting Tests ─────────────────────────────────────────────


class TestDoctorFormatting:
    """Verify output formatting matches doctor convention."""

    def test_format_drift_alert(self) -> None:
        result = PluginDriftResult(
            plugin_id="oc-model-router",
            status=DriftClassification.STALE,
            expected_sha="d01b24c2c15240be",
            actual_sha="e3b0c44298fc1c14",
            filename="flowfeel-oc-model-router-0.1.0.tgz",
        )
        alert = format_drift_alert(result, release_tag="plugins-v0.1.14")
        assert "[doctor:plugin-drift] [CRITICAL]" in alert
        assert "Plugin 'oc-model-router' drift detected!" in alert
        assert "Expected bundle SHA: d01b24c2c152" in alert
        assert "(from release plugins-v0.1.14)" in alert
        assert "Actual runtime SHA:   e3b0c44298fc (stale)" in alert
        filename = "flowfeel-oc-model-router-0.1.0.tgz"
        expected_cmd = (
            f"Action required: openclaw plugins install ./dist-plugins/{filename}"
        )
        assert expected_cmd in alert

    def test_format_resolution_alert(self) -> None:
        res = format_resolution_alert("oc-model-router", "d01b24c2c15240be")
        assert "[doctor:plugin-drift] [OK   ]" in res
        assert "Plugin 'oc-model-router' checksum restored" in res
        assert "matches release d01b24c2c152" in res

    def test_format_provenance_alert(self) -> None:
        alert = format_provenance_alert("85ac1f2", "No merged PR found")
        assert "[doctor:provenance-violation] [CRITICAL]" in alert
        assert "Release commit 85ac1f2 failed provenance gate" in alert
        assert "No merged PR found" in alert


# ── Registry Task Plane Tests ───────────────────────────────────────────


class TestRegistryTaskPlane:
    """Verify registry task registration and periodic drift task runner."""

    def setup_method(self) -> None:
        clear_registry()

    def teardown_method(self) -> None:
        clear_registry()

    def test_register_and_list_tasks(self) -> None:
        task = register_task(
            name="test_task",
            cron="0 */6 * * *",
            handler=lambda: "done",
            timeout_seconds=30,
        )
        assert task.name == "test_task"
        assert get_task("test_task") is task
        assert len(list_tasks()) == 1

    def test_run_plugin_drift_check_provenance_violation(self) -> None:
        """When provenance fails, drift check terminates early with doctor alert."""
        session = MagicMock(spec=requests.Session)
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = []  # No PRs
        session.get.return_value = response

        # Patch verify_commit_provenance through requests session or mock
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(
                "phosphene.registry.verify_commit_provenance",
                lambda *args, **kwargs: verify_commit_provenance(
                    "FlowFeel/openclaw-test-harness",
                    "unreviewed_sha",
                    session=session,
                ),
            )
            lines = run_plugin_drift_check(commit_sha="unreviewed_sha")
            assert len(lines) == 1
            assert "[doctor:provenance-violation] [CRITICAL]" in lines[0]

    def test_run_plugin_drift_check_end_to_end(self, tmp_path: Path) -> None:
        """End-to-end task run verifying plugins against synthetic manifest."""
        ext_dir = tmp_path / "extensions"
        ext_dir.mkdir()

        # Install matching plugin
        p_dir = ext_dir / "oc-demo" / "dist"
        p_dir.mkdir(parents=True)
        code = b"console.log('demo');"
        (p_dir / "index.js").write_bytes(code)
        sha = hashlib.sha256(code).hexdigest()

        manifest_path = tmp_path / "plugins-manifest.json"
        manifest_data = {
            "plugins": [
                {
                    "id": "oc-demo",
                    "filename": "oc-demo-0.1.0.tgz",
                    "distIndexSha256": sha,
                }
            ]
        }
        manifest_path.write_text(json.dumps(manifest_data), encoding="utf-8")
        state_file = tmp_path / "state.json"

        lines = run_plugin_drift_check(
            extensions_dir=ext_dir,
            manifest_path=manifest_path,
            state_file=state_file,
            release_tag="plugins-v0.1.14",
        )
        assert len(lines) == 1
        assert "[doctor:plugin-drift] [OK   ]" in lines[0]
        assert "All 1/1 plugins verified against release baseline." in lines[0]
