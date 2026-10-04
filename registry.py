"""Task plane registry entrypoint for OpenClaw test harness.

Dispatches periodic heartbeat tasks including plugin drift check ('0 */6 * * *').
"""

from __future__ import annotations

import sys

# Ensure src/ is on sys.path for direct python registry.py execution
from pathlib import Path

src_dir = Path(__file__).resolve().parent / "src"
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from phosphene.registry import (  # noqa: E402
    TaskDefinition,
    clear_registry,
    get_task,
    list_tasks,
    main,
    register_task,
    run_plugin_drift_check,
)

__all__ = [
    "TaskDefinition",
    "clear_registry",
    "get_task",
    "list_tasks",
    "main",
    "register_task",
    "run_plugin_drift_check",
]

if __name__ == "__main__":
    main()
