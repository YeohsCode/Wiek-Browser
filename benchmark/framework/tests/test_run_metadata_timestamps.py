from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, cast

import run_eval
from wiek_bench.config import HarnessConfig


ORIGINAL_START = "2026-07-06T09:00:00+00:00"


def _context(tmp_path: Path, *, started_at: str = ORIGINAL_START) -> run_eval.RunContext:
    """Build the smallest RunContext that _write_run_metadata can serialize."""
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    return run_eval.RunContext(
        cfg=HarnessConfig(),
        run_id="run-1",
        run_dir=run_dir,
        started_at=started_at,
        benchmark="real-world-bench",
        adhoc=None,
        browser_tool_name="wiek-browser",
        skill_path=str(tmp_path / "SKILL.md"),
        skill_hash=None,
        wiek_browser_release=None,
        pi_bin="pi",
        pi_agent_dir=tmp_path / "agent-home" / ".pi" / "agent",
        codex_bin=None,
        codex_home=None,
        codex_pricing=None,
        provider_name="pi",
        model="test-model",
        model_provider="test-provider",
        reasoning_level="off",
        agent_workdir=tmp_path / "work",
        provider_env={},
        max_turns=None,
        capture_stderr=False,
        harness_root=str(tmp_path),
        python_exe=sys.executable,
        progress=cast(Any, None),
        provider=cast(Any, None),
        rerun_task_ids=set(),
    )


def _metadata(ctx: run_eval.RunContext) -> dict[str, Any]:
    return json.loads((ctx.run_dir / "run_metadata.json").read_text(encoding="utf-8"))


def test_started_at_survives_the_teardown_metadata_write(tmp_path: Path) -> None:
    """The finish write must not restamp started_at, or every run looks instantaneous."""
    ctx = _context(tmp_path)

    run_eval._write_run_metadata(ctx, [], {})
    at_start = _metadata(ctx)["started_at"]
    run_eval._write_run_metadata(ctx, [], {"completed_at": "2026-07-06T09:30:00+00:00"})
    final = _metadata(ctx)

    assert at_start == ORIGINAL_START
    assert final["started_at"] == ORIGINAL_START
    assert final["started_at"] != final["completed_at"]


def test_rerun_and_resume_still_restore_the_original_run_start(tmp_path: Path) -> None:
    """A continued run reports when the run began, not when the continuation began."""
    ctx = _context(tmp_path, started_at="2026-07-06T15:00:00+00:00")

    run_eval._write_run_metadata(ctx, [], {"started_at": ORIGINAL_START})

    assert _metadata(ctx)["started_at"] == ORIGINAL_START
