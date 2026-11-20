"""OpenClaw Test Harness — abstractions, patches, and test pyramid.

Provides:
- **Abstractions**: Protocol interfaces for OC session lifecycle, spawn admission,
  and registry — testable without OC running.
- **Patches**: Versioned patches against OC source (child-admission, session store).
- **Containers**: Docker test containers that spin up patched OC for integration tests.
- **Test Pyramid**: Unit → Integration → E2E, all conformant to phosphene axiomatics.

@invariants
- Package root exposes version and public subpackages with zero import-time
  side effects (A1).

@dft
- Verified by Python pytest suite under tests/.
"""

from __future__ import annotations

from . import drift_checker, registry

__all__ = ["drift_checker", "registry"]
