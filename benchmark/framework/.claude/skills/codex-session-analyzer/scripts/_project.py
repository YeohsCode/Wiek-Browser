"""Load harness-owned Codex session contracts from the skill scripts."""
from __future__ import annotations

import json
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
        CODEX_TOOL_CALL_TYPES,
        CODEX_TOOL_OUTPUT_TYPES,
        SessionStats,
        _codex_arguments,
        _codex_item_duration_s,
        _codex_output_is_error,
        _codex_shell_command,
        safe_parse,
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


def ensure_codex_rollout(path: str | Path) -> None:
    session = Path(path)
    with session.open("r", encoding="utf-8") as handle:
        for raw in handle:
            if not raw.strip():
                continue
            try:
                first = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid first JSONL entry: {session}: {exc}") from exc
            if not isinstance(first, dict) or first.get("type") != "session_meta":
                raise ValueError(f"not a Codex rollout (expected session_meta): {session}")
            return
    raise ValueError(f"empty rollout: {session}")


def load_run_metadata(run_dir: Path) -> dict[str, Any]:
    path = run_dir / "run_metadata.json"
    if not path.is_file():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else {}


def resolve_run(spec: str) -> Path:
    literal = Path(spec)
    if literal.is_dir():
        return literal.resolve()
    candidate = HARNESS_ROOT / "runs" / spec
    if candidate.is_dir():
        return candidate.resolve()
    raise FileNotFoundError(f"run directory not found: {spec}")


def require_codex_run(run_dir: Path) -> dict[str, Any]:
    metadata = load_run_metadata(run_dir)
    provider = metadata.get("provider") or metadata.get("model_provider")
    if provider != "codex":
        raise ValueError(f"run provider is {provider!r}, expected 'codex': {run_dir}")
    return metadata


__all__ = [
    "CODEX_TOOL_CALL_TYPES",
    "CODEX_TOOL_OUTPUT_TYPES",
    "HARNESS_ROOT",
    "SessionStats",
    "_codex_arguments",
    "_codex_item_duration_s",
    "_codex_output_is_error",
    "_codex_shell_command",
    "ensure_codex_rollout",
    "latest_by_task_id",
    "load_run_metadata",
    "parse_stats",
    "read_task_attempt_records",
    "require_codex_run",
    "resolve_run",
]
