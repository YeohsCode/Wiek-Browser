from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import run_eval
from wiek_bench.config import HarnessConfig
from wiek_bench.datasets import BenchmarkTask
from wiek_bench.judges.base import JudgeResult
from wiek_bench.metrics import aggregate_sessions, aggregate_summary, judge_payload_timing
from wiek_bench.results import (
    TaskAttemptRecord,
    TaskRecord,
    append_task_record,
    merge_judge_into_record,
    read_records,
    read_task_attempt_records,
    task_already_done,
    write_task_attempt_records,
)
from wiek_bench.session_parser import SessionStats


def _record(task_id: str, *, error: str | None = None) -> TaskRecord:
    return TaskRecord(
        task_id=task_id,
        benchmark="test",
        provider="pi",
        browser_tool="wiek-browser",
        skill_name="wiek-browser",
        error=error,
    )


def test_append_replaces_failed_row_without_duplicating_task(tmp_path: Path) -> None:
    append_task_record(tmp_path, _record("task-1", error="temporary"))
    append_task_record(tmp_path, _record("task-1"))

    rows = read_records(tmp_path)

    assert len(rows) == 1
    assert rows[0]["task_id"] == "task-1"
    assert rows[0]["error"] is None


def test_append_keeps_existing_success_without_force_overwrite(tmp_path: Path) -> None:
    append_task_record(tmp_path, _record("task-1"))
    append_task_record(tmp_path, _record("task-1", error="later"))

    assert [row["error"] for row in read_records(tmp_path)] == [None, "later"]
    assert task_already_done(tmp_path, "task-1") is True


def test_force_overwrite_replaces_all_prior_rows_for_task(tmp_path: Path) -> None:
    append_task_record(tmp_path, _record("task-1"))
    append_task_record(tmp_path, _record("task-1", error="later"))
    append_task_record(tmp_path, _record("task-2"))

    append_task_record(tmp_path, _record("task-1", error="replacement"), force_overwrite=True)

    rows = read_records(tmp_path)
    assert [(row["task_id"], row["error"]) for row in rows] == [
        ("task-2", None),
        ("task-1", "replacement"),
    ]


def test_attempt_records_round_trip_and_replace_old_sequence(tmp_path: Path) -> None:
    write_task_attempt_records(
        tmp_path,
        "task-1",
        [TaskAttemptRecord(task_id="task-1", attempt_index=1, provider_error="first")],
    )
    write_task_attempt_records(
        tmp_path,
        "task-1",
        [TaskAttemptRecord(task_id="task-1", attempt_index=1, session_id="final")],
    )

    assert read_task_attempt_records(tmp_path, "task-1") == [
        {
            "attempt_index": 1,
            "ended_at": None,
            "failure_reason": None,
            "provider_error": None,
            "session_file": None,
            "session_id": "final",
            "started_at": None,
            "step_limit_hit": False,
            "task_id": "task-1",
        }
    ]


def test_attempt_records_reject_unknown_schema(tmp_path: Path) -> None:
    path = tmp_path / "attempts" / "task-1.json"
    path.parent.mkdir()
    path.write_text('{"schema_version": 2, "attempts": []}', encoding="utf-8")

    with pytest.raises(ValueError, match="unsupported attempt provenance schema"):
        read_task_attempt_records(tmp_path, "task-1")


def test_merge_judge_persists_complete_rubric_counts(tmp_path: Path) -> None:
    append_task_record(tmp_path, _record("task-1"))
    result = JudgeResult(
        verdict=True,
        score=2 / 3,
        reasoning="Two rubrics passed.",
        judge_model="judge-model",
        metadata={"num_rubrics": 3, "rubric_scores": {"r1": 1, "r2": 0, "r3": 1}},
    )

    merge_judge_into_record(tmp_path, "task-1", result)
    row = read_records(tmp_path)[0]

    assert row["score"] == pytest.approx(2 / 3)
    assert row["num_rubrics"] == 3
    assert row["num_rubrics_passed"] == 2
    assert row["judge_error"] is None
    assert row["judged_at"]


def test_merge_judge_error_drops_partial_score_and_rubric_counts(tmp_path: Path) -> None:
    append_task_record(tmp_path, _record("task-1"))
    result = JudgeResult(
        verdict=None,
        score=0,
        reasoning="Interrupted.",
        error="transport failure",
        metadata={"num_rubrics": 3, "rubric_scores": {"r1": 1}},
    )

    merge_judge_into_record(tmp_path, "task-1", result)
    row = read_records(tmp_path)[0]

    assert row["score"] is None
    assert row["num_rubrics"] is None
    assert row["num_rubrics_passed"] is None
    assert row["judge_error"] == "transport failure"


def test_aggregate_sessions_combines_usage_cost_and_tool_distributions() -> None:
    stats = [
        SessionStats(
            duration_s=1.25,
            cost_usd=0.1,
            cost_is_estimate=True,
            cost_source="pricing",
            input_tokens=10,
            output_tokens=5,
            tool_calls=2,
            tool_failures=1,
            tool_call_dist={"bash": 2},
            bash_cmd_dist={"wiek-browser": 1},
        ),
        SessionStats(
            duration_s=2.0,
            cost_usd=None,
            input_tokens=4,
            output_tokens=6,
            tool_calls=1,
            tool_call_dist={"read": 1},
        ),
    ]

    summary = aggregate_sessions(stats)

    assert summary["session_count"] == 2
    assert summary["total_duration_s"] == 3.25
    assert summary["avg_duration_s"] == 1.625
    assert summary["total_cost_usd"] == 0.1
    assert summary["cost_sample_count"] == 1
    assert summary["cost_is_estimate"] is True
    assert summary["total_tokens"] == 25
    assert summary["tool_call_dist"] == {"bash": 2, "read": 1}
    assert summary["bash_cmd_dist"] == {"wiek-browser": 1}


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"judge_duration_s": 2, "judge_sessions": []},
        {"judge_duration_s": "invalid", "judge_sessions": ["one"]},
    ],
)
def test_judge_payload_timing_rejects_incomplete_or_invalid_payload(
    payload: dict[str, object],
) -> None:
    assert judge_payload_timing(payload) == (None, 0)


def test_aggregate_summary_keeps_error_taxonomy_disjoint(tmp_path: Path) -> None:
    append_task_record(tmp_path, _record("transport", error="provider_transport_failure: timeout"))
    append_task_record(tmp_path, _record("timeout", error="task timeout after 10s"))
    append_task_record(tmp_path, _record("success"))
    judge = JudgeResult(verdict=True, score=1, reasoning="Done")
    merge_judge_into_record(tmp_path, "success", judge)

    summary = aggregate_summary(
        tmp_path,
        {
            "run_id": "run-1",
            "benchmark": "test",
            "provider": "pi",
            "model": "model",
            "browser_tool": "wiek-browser",
        },
    )

    assert summary["total_tasks"] == 3
    assert summary["completed_tasks"] == 1
    assert summary["provider_error_count"] == 2
    assert summary["transport_failure_count"] == 1
    assert summary["timeout_count"] == 1
    assert summary["success_tasks"] == 1
    assert summary["success_rate"] == pytest.approx(1 / 3, abs=0.0001)


def test_judge_accounting_ignores_unrelated_json(tmp_path: Path) -> None:
    append_task_record(tmp_path, _record("task-1"))
    judges = tmp_path / "judges"
    judges.mkdir()
    (judges / "task-1_judge.json").write_text(
        json.dumps(
            {
                "judge_cost_usd": 0.25,
                "judge_input_tokens": 10,
                "judge_output_tokens": 5,
                "judge_duration_s": 6,
                "judge_sessions": ["a", "b"],
            }
        ),
        encoding="utf-8",
    )
    (judges / "notes.json").write_text("not valid json", encoding="utf-8")

    summary = aggregate_summary(tmp_path, {"run_id": "run-1"})

    assert summary["judge_total_cost_usd"] == 0.25
    assert summary["judge_total_tokens"] == 15
    assert summary["judge_total_duration_s"] == 6
    assert summary["judge_avg_duration_per_rubric_s"] == 3


def test_a_crashed_task_still_lands_in_tasks_jsonl(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """An exception escaping _execute_task used to leave a progress event and nothing
    else, so the task dropped out of the run's own record while completed_at was still
    written — shrinking every denominator computed from those rows around the crash."""

    class FakeProgress:
        def start_task(self, task_id: str, slot: int) -> None:
            del task_id, slot

        def finish_task(self, task_id: str, **kwargs: object) -> None:
            del task_id, kwargs

    async def boom(*args: object, **kwargs: object) -> TaskRecord:
        raise RuntimeError("teardown exploded")

    monkeypatch.setattr(run_eval, "_execute_task", boom)
    cfg = HarnessConfig()
    ctx = SimpleNamespace(
        cfg=cfg,
        run_dir=tmp_path,
        progress=FakeProgress(),
        provider_name="pi",
        browser_tool_name="wiek-browser",
        skill_hash="abc123",
        wiek_browser_release=None,
        rerun_task_ids=set(),
    )
    crashed = BenchmarkTask(task_id="crashed", benchmark="test", instruction="explodes")

    # One task already recorded clean, so a lost crash row would show as 1/1 = 100%.
    append_task_record(tmp_path, _record("ok"))
    asyncio.run(run_eval._run_serial(ctx, [crashed]))

    rows = {str(row["task_id"]): row for row in read_records(tmp_path)}
    assert "teardown exploded" in rows["crashed"]["error"]
    # The error text keeps it out of "done", so resume retries it and replaces this row.
    assert not task_already_done(tmp_path, "crashed")

    summary = aggregate_summary(tmp_path, {"run_id": "run-1", "benchmark": "test"})
    assert summary["total_tasks"] == 2
    assert summary["provider_error_count"] == 1
    assert summary["success_rate"] == 0.0
