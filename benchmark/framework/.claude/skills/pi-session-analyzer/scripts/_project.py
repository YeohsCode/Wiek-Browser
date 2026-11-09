"""Load the harness-owned session/parser contracts from the skill scripts.

The project checkout is the source tree for this skill. Resolving it from this
file keeps invocations independent of the caller's current working directory and
avoids hard-coded checkout paths or silent parser fallbacks.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any


def harness_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "wiek_bench" / "session_parser.py").is_file():
            return parent
    raise RuntimeError(f"cannot locate wiek-benchmark-harness from {here}")


HARNESS_ROOT = harness_root()
if str(HARNESS_ROOT) not in sys.path:
    sys.path.insert(0, str(HARNESS_ROOT))

try:
    from wiek_bench.results import latest_by_task_id, read_task_attempt_records
    from wiek_bench.session_parser import (
        SessionStats,
        extract_stop_reason_error,
        safe_parse,
        shell_output_is_error,
    )
except ModuleNotFoundError as exc:
    expected = HARNESS_ROOT / ".venv" / "bin" / "python"
    raise RuntimeError(
        f"project dependencies unavailable; run these scripts with {expected}"
    ) from exc


def parse_stats(
    path: str | Path,
    *,
    pricing_snapshot: dict[str, Any] | None = None,
) -> SessionStats:
    return safe_parse(path, pricing_snapshot=pricing_snapshot)


__all__ = [
    "HARNESS_ROOT",
    "SessionStats",
    "extract_stop_reason_error",
    "latest_by_task_id",
    "parse_stats",
    "read_task_attempt_records",
    "shell_output_is_error",
]
