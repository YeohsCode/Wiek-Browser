from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, cast

import pytest

import run_judge
from wiek_bench.config import HarnessConfig
from wiek_bench.judges.base import JudgeInput, JudgeResult
from wiek_bench.judges.odysseys_judge import OdysseysJudge
from wiek_bench.metrics import aggregate_summary
from wiek_bench.report.compare import build_payload, load_group, render_html
from wiek_bench.results import TaskRecord


def _write_task(run_dir: Path, task_id: str, *, benchmark: str) -> None:
    record = TaskRecord(
        task_id=task_id,
        benchmark=benchmark,
        provider="pi",
        browser_tool="wiek-browser",
        skill_name="wiek-browser",
        verdict=True,
        score=1.0,
    )
    path = run_dir / "tasks.jsonl"
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record.to_dict()) + "\n")


def _write_judge(
    run_dir: Path, task_id: str, *, duration_s: float, rubrics: list[str]
) -> None:
    judges_dir = run_dir / "judges"
    judges_dir.mkdir(exist_ok=True)
    payload = {
        "task_id": task_id,
        "verdict": True,
        "score": 1.0,
        "judge_duration_s": duration_s,
        "judge_input_tokens": 10,
        "judge_output_tokens": 5,
        "judge_cost_usd": 0.1,
        "judge_sessions": [
            {"rubric_id": rubric_id, "duration_s": duration_s / len(rubrics)}
            for rubric_id in rubrics
        ],
        "metadata": {
            "rubric_results": [
                {"rubric_id": rubric_id, "satisfied": True} for rubric_id in rubrics
            ]
        },
    }
    (judges_dir / f"{task_id}_judge.json").write_text(
        json.dumps(payload), encoding="utf-8"
    )


def test_summary_and_report_put_judge_timing_in_metadata_section(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    meta = {
        "run_id": "run",
        "benchmark": "real-world-bench",
        "provider": "pi",
        "model": "gpt-test",
        "browser_tool": "wiek-browser",
        "judge_model": "openai/judge",
        "wall_clock_total_s": 42.0,
    }
    (run_dir / "run_metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    _write_task(run_dir, "task-1", benchmark="real-world-bench")
    _write_task(run_dir, "task-2", benchmark="real-world-bench")
    _write_judge(run_dir, "task-1", duration_s=30.0, rubrics=["R1", "R2"])
    _write_judge(run_dir, "task-2", duration_s=15.0, rubrics=["R1"])
    (run_dir / "judges" / "_job.json").write_text(
        json.dumps({"finished": True, "duration_s": 20.0}), encoding="utf-8"
    )

    summary = aggregate_summary(run_dir, meta)
    payload = build_payload(load_group([run_dir], "timed"), drop_error=False)
    totals = payload["totals"]["base"]

    assert summary["judge_total_duration_s"] == 45.0
    assert summary["judge_rubric_count"] == 3
    assert summary["judge_avg_duration_per_rubric_s"] == 15.0
    assert summary["judge_wall_clock_s"] == 20.0
    assert totals["judge_total_duration_s"] == 45.0
    assert totals["judge_rubric_count"] == 3
    assert totals["judge_avg_duration_per_rubric_s"] == 15.0
    assert payload["meta"]["base_judge_wall_s"] == 20.0
    html = render_html(payload)
    meta_block = html.split("const metaPairs = [", 1)[1].split("];", 1)[0]
    stats_block = html.split("const stats = T.count ? [", 1)[1].split("] : [];", 1)[0]
    assert "avg judge / rubric" in meta_block
    assert "judge wall time" in meta_block
    assert "avg judge / rubric" not in stats_block
    assert "judge wall time" not in stats_block
    assert '"base_judge_wall_s": 20.0' in html


def test_spliced_rubric_usage_preserves_cached_timing() -> None:
    judge = OdysseysJudge(cast(Any, object()))

    usage = judge._usage_from_sessions(
        [
            {
                "rubric_id": "R1",
                "input_tokens": 10,
                "output_tokens": 5,
                "cost_usd": 0.1,
                "duration_s": 12.5,
                "turns": 3,
            },
            {
                "rubric_id": "R2",
                "input_tokens": 20,
                "output_tokens": 8,
                "cost_usd": 0.2,
                "duration_s": 7.5,
                "turns": 2,
            },
        ]
    )

    assert usage.duration_s == 20.0
    assert usage.num_turns == 5
    assert usage.input_tokens == 30
    assert usage.output_tokens == 13


def test_judge_run_records_completed_job_wall_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_dir = tmp_path / "adhoc-run"
    run_dir.mkdir()
    meta = {
        "run_id": "adhoc-run",
        "benchmark": "adhoc",
        "browser_tool": "wiek-browser",
        "judge_model": "openai/judge",
        "adhoc": {
            "tasks": [
                {
                    "task_id": "adhoc",
                    "confirmed_task": "Check the page",
                    "rubrics": {
                        "R1": {
                            "requirement": "Check the page",
                            "verification": "Verify the page state",
                        }
                    },
                }
            ]
        },
    }
    (run_dir / "run_metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    _write_task(run_dir, "adhoc", benchmark="adhoc")

    class FakeJudge:
        name = "fake"
        supports_agent_mode = True

        async def evaluate(self, judge_input: JudgeInput) -> JudgeResult:
            del judge_input
            return JudgeResult(
                verdict=True,
                score=1.0,
                reasoning="ok",
                judge_model="openai/judge",
                metadata={
                    "judge_mode": "single",
                    "judge_duration_s": 9.0,
                    "judge_turns": 1,
                    "judge_sessions": [
                        {"rubric_id": "R1", "duration_s": 9.0, "turns": 1}
                    ],
                    "num_rubrics": 1,
                },
            )

    monkeypatch.setattr(
        run_judge,
        "make_judge_for_benchmark",
        lambda _benchmark, *, ctx: FakeJudge(),
    )
    cfg = HarnessConfig()
    cfg.run.show_progress = False
    cfg.run.auto_export_sessions = False

    result = asyncio.run(run_judge.judge_run(run_dir, cfg))

    assert result == 0
    job = json.loads((run_dir / "judges" / "_job.json").read_text(encoding="utf-8"))
    assert job["finished"] is True
    assert job["finished_at"]
    assert isinstance(job["duration_s"], float)
    assert job["duration_s"] >= 0.0
