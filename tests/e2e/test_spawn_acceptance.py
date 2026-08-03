"""Acceptance tests for spawn and config policy.

Updated for plugin strategy: worker pool bundle patches are no longer applied.
The sidecar plugin handles worker offloading via HTTP proxy to a standalone process.
"""

from pathlib import Path


class TestConfigPolicy:
    """Config values match the 'flexible spine, comfortable entropy' policy."""

    def test_max_concurrent_is_flexible(self, subagent_config: dict[str, int]) -> None:
        assert subagent_config["maxConcurrent"] >= 4, (
            "maxConcurrent should allow parallel work"
        )

    def test_entropy_is_comfortable(self, subagent_config: dict[str, int]) -> None:
        """runTimeoutSeconds should be <= 360 (comfortable — room to finish)."""
        assert subagent_config["runTimeoutSeconds"] <= 360, (
            f"runTimeoutSeconds={subagent_config['runTimeoutSeconds']} — "
            "entropy should be comfortable (<= 360s)"
        )

    def test_cleanup_is_fast(self, subagent_config: dict[str, int]) -> None:
        """archiveAfterMinutes should be <= 10 (fast cleanup)."""
        assert subagent_config["archiveAfterMinutes"] <= 10

    def test_spawn_depth_is_shallow(self, subagent_config: dict[str, int]) -> None:
        """maxSpawnDepth should be 2 (no nesting)."""
        assert subagent_config["maxSpawnDepth"] == 2


class TestSidecarPlugin:
    """The sidecar plugin replaces bundle patches — no core OC files modified."""

    def test_plugin_manifest_exists(self) -> None:
        """The oc-sidecar plugin manifest exists at the expected path."""
        manifest = Path("ts/src/plugins/oc-sidecar/openclaw.plugin.json")
        assert manifest.exists(), f"Plugin manifest not found at {manifest}"

    def test_plugin_package_exists(self) -> None:
        """The oc-sidecar plugin package.json exists."""
        pkg = Path("ts/src/plugins/oc-sidecar/package.json")
        assert pkg.exists(), f"Plugin package.json not found at {pkg}"

    def test_plugin_entry_exists(self) -> None:
        """The plugin entry point exists."""
        entry = Path("ts/src/plugins/oc-sidecar/src/index.ts")
        assert entry.exists(), f"Plugin entry not found at {entry}"

    def test_sidecar_server_exists(self) -> None:
        """The sidecar server script exists."""
        server = Path("ts/src/plugins/oc-sidecar/src/sidecar-server.ts")
        assert server.exists(), f"Sidecar server not found at {server}"

    def test_worker_entry_exists(self) -> None:
        """The worker entry script exists."""
        worker = Path("ts/src/plugins/oc-sidecar/src/worker-entry.ts")
        assert worker.exists(), f"Worker entry not found at {worker}"

    def test_sidecar_client_exists(self) -> None:
        """The sidecar HTTP client exists."""
        client = Path("ts/src/plugins/oc-sidecar/src/sidecar-client.ts")
        assert client.exists(), f"Sidecar client not found at {client}"

    def test_sidecar_manager_exists(self) -> None:
        """The sidecar process manager exists."""
        manager = Path("ts/src/plugins/oc-sidecar/src/sidecar-manager.ts")
        assert manager.exists(), f"Sidecar manager not found at {manager}"


class TestWorkerPoolAcceptance:
    """Worker pool is now a sidecar plugin, not a bundle patch.

    These tests verify the plugin infrastructure exists and is structurally sound,
    replacing the old bundle-patch acceptance tests.
    """

    def test_plugin_manifest_declares_tools(self) -> None:
        """The plugin manifest declares sidecar_health and sidecar_exec tools."""
        import json

        manifest = json.loads(
            Path("ts/src/plugins/oc-sidecar/openclaw.plugin.json").read_text()
        )
        tools = manifest.get("contracts", {}).get("tools", [])
        assert "sidecar_health" in tools
        assert "sidecar_exec" in tools

    def test_plugin_activates_on_startup(self) -> None:
        """The plugin activates on gateway startup."""
        import json

        manifest = json.loads(
            Path("ts/src/plugins/oc-sidecar/openclaw.plugin.json").read_text()
        )
        assert manifest.get("activation", {}).get("onStartup") is True
