"""Shared test fixtures for the openclaw-test-harness."""

import json
from pathlib import Path

import pytest


@pytest.fixture
def subagent_config() -> dict[str, int]:
    """Read subagent config from openclaw.json."""
    cfg_path = Path("/home/node/.openclaw/openclaw.json")
    if not cfg_path.exists():
        # Fallback for CI — use default values
        return {
            "maxConcurrent": 6,
            "maxChildrenPerAgent": 4,
            "runTimeoutSeconds": 300,
            "archiveAfterMinutes": 10,
            "maxSpawnDepth": 2,
        }
    cfg = json.loads(cfg_path.read_text())
    return cfg["agents"]["defaults"]["subagents"]
