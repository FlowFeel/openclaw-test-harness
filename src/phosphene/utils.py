"""Utility functions and message constants for phosphene."""

from __future__ import annotations

import sys
from typing import TextIO

MESSAGES: dict[str, str] = {
    "REGISTERED_TASKS_HEADER": "Registered Tasks:",
}


def format_task_line(name: str, cron: str, timeout_seconds: int) -> str:
    """Format a registered task line for CLI display."""
    pad_name = name.ljust(24)
    return f"  - {pad_name} [{cron}] (timeout: {timeout_seconds}s)"


def safe_print(
    *args: object,
    sep: str = " ",
    end: str = "\n",
    file: TextIO | None = None,
    flush: bool = False,
) -> None:
    """Centralized print utility routing stdout/stderr safely."""
    target = file if file is not None else sys.stdout
    print(*args, sep=sep, end=end, file=target, flush=flush)
