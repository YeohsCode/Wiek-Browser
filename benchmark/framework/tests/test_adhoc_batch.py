from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, cast

import pytest
from pydantic import ValidationError

import run_eval
import run_judge
from wiek_bench.adhoc import build_adhoc_tasks, normalize_adhoc_node, text_tasks_to_entries
from wiek_bench.config import HarnessConfig, load_config
from wiek_bench.judges.bu_bench_judge import make_judge_for_benchmark
from wiek_bench.judges.odysseys_judge import OdysseysJudge
from wiek_bench.webui.runner import RunManager, _metadata_to_overrides


def _rubric(requirement: str = "Complete the task") -> dict[str, str]:
    return {
        "requirement": requirement,
        "verification": "Verify the result in the final answer and browser state",
    }


def _json_task(task_id: str, *, rubrics: bool) -> dict[str, Any]:
    return {
        "task_id": task_id,
        "confirmed_task": f"Run {task_id}",
        "level": "easy",
        "website": "https://example.com",
        "rubrics": {"R1": _rubric()} if rubrics else {},
    }


def test_text_batch_normalises_once_and_reuses_existing_concurrency() -> None:
    entries = text_tasks_to_entries(["one", "two", "three"])
    cfg = HarnessConfig(adhoc={"tasks": entries})
    cfg.run.concurrency = 3

    tasks, benchmark, snapshot = run_eval._build_tasks(cfg)
    expanded = run_eval._expand_iterations(tasks, cfg.run.iterations)

    assert cfg.run.auto_judge is False
    assert cfg.run.concurrency == 3
    assert benchmark == "adhoc"
    assert [task.task_id for task in expanded] == ["adhoc-1", "adhoc-2", "adhoc-3"]
    assert snapshot == {"tasks": entries}


def test_all_rubric_json_can_enable_odysseys_judge() -> None:
    entries = [_json_task("first", rubrics=True), _json_task("second", rubrics=True)]
    cfg = HarnessConfig(run={"auto_judge": True}, adhoc={"tasks": entries})

    tasks, snapshot, rubric_mode = build_adhoc_tasks(cfg.adhoc.model_dump())

    assert cfg.run.auto_judge is True
    assert rubric_mode == "all"
    assert snapshot == {"tasks": entries}
    assert tasks[0].benchmark == "adhoc"
    assert tasks[0].start_url == "https://example.com"
    assert tasks[0].metadata["rubrics"]["R1"]["requirement"] == "Complete the task"
    assert isinstance(make_judge_for_benchmark("adhoc", ctx=cast(Any, object())), OdysseysJudge)


def test_mixed_rubric_batch_is_rejected_at_config_boundary() -> None:
    entries = [_json_task("with", rubrics=True), _json_task("without", rubrics=False)]

    with pytest.raises(ValueError, match="cannot mix"):
        normalize_adhoc_node({"tasks": entries})
    with pytest.raises(ValidationError, match="cannot mix"):
        HarnessConfig(adhoc={"tasks": entries})


@pytest.mark.parametrize("task_id", ["duplicate", "../escape", "dir/task", "dir\\task"])
def test_duplicate_or_unsafe_task_ids_are_rejected(task_id: str) -> None:
    entries = [_json_task(task_id, rubrics=False)]
    if task_id == "duplicate":
        entries.append(_json_task(task_id, rubrics=False))
        expected = "unique"
    else:
        expected = "path-safe"

    with pytest.raises(ValueError, match=expected):
        normalize_adhoc_node({"tasks": entries})


def test_cli_repeated_tasks_default_judge_off() -> None:
    args = run_eval.build_parser().parse_args(
        ["--task", "one", "--task", "two", "--task", "three", "--concurrency", "3"]
    )

    cfg = run_eval._apply_cli_overrides(HarnessConfig(), args)

    assert cfg.run.auto_judge is False
    assert cfg.run.concurrency == 3
    assert [entry["confirmed_task"] for entry in cfg.adhoc.tasks or []] == [
        "one",
        "two",
        "three",
    ]


def test_cli_text_batch_cannot_enable_judge() -> None:
    args = run_eval.build_parser().parse_args(["--task", "one", "--auto-judge"])

    with pytest.raises(SystemExit, match="requires every task"):
        run_eval._apply_cli_overrides(HarnessConfig(), args)


def test_cli_json_batch_can_enable_judge(tmp_path: Path) -> None:
    source = tmp_path / "tasks.json"
    source.write_text(
        json.dumps([_json_task("one", rubrics=True), _json_task("two", rubrics=True)]),
        encoding="utf-8",
    )
    args = run_eval.build_parser().parse_args(
        ["--tasks-json", str(source), "--auto-judge", "--concurrency", "2"]
    )

    cfg = run_eval._apply_cli_overrides(HarnessConfig(), args)

    assert cfg.run.auto_judge is True
    assert cfg.run.concurrency == 2
    assert [entry["task_id"] for entry in cfg.adhoc.tasks or []] == ["one", "two"]


def test_config_file_adhoc_default_is_judge_off(tmp_path: Path) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        json.dumps({"adhoc": {"tasks": [_json_task("one", rubrics=True)]}}),
        encoding="utf-8",
    )

    cfg = load_config(config_path)

    assert cfg.run.auto_judge is False


def test_metadata_reuse_migrates_legacy_task_and_keeps_judge_off() -> None:
    overrides = _metadata_to_overrides(
        {
            "benchmark": "adhoc",
            "auto_judge": True,
            "adhoc": {"task": "legacy instruction"},
        }
    )

    assert overrides["adhoc"] == {
        "tasks": [
            {
                "task_id": "adhoc",
                "confirmed_task": "legacy instruction",
                "rubrics": {},
            }
        ]
    }
    assert overrides["run"]["auto_judge"] is False
    assert "benchmark" not in overrides["run"]


def test_metadata_reuse_preserves_all_rubric_judge_switch() -> None:
    entries = [_json_task("one", rubrics=True)]
    overrides = _metadata_to_overrides(
        {"benchmark": "adhoc", "auto_judge": True, "adhoc": {"tasks": entries}}
    )

    assert overrides["adhoc"]["tasks"] == entries
    assert overrides["run"]["auto_judge"] is True


def test_webui_rerun_keeps_legacy_judge_off_and_all_rubric_switch_on(
    tmp_path: Path,
) -> None:
    manager = RunManager(config_path=str(tmp_path / "missing.yaml"))
    legacy = manager._build_action_config(
        {
            "benchmark": "adhoc",
            "auto_judge": True,
            "adhoc": {"task": "legacy instruction"},
        },
        kind="rerun",
        concurrency=3,
        model=None,
        new_run=False,
    )
    judged = manager._build_action_config(
        {
            "benchmark": "adhoc",
            "auto_judge": True,
            "adhoc": {"tasks": [_json_task("one", rubrics=True)]},
        },
        kind="rerun",
        concurrency=3,
        model=None,
        new_run=False,
    )

    assert legacy["run"]["auto_judge"] is False
    assert judged["run"]["auto_judge"] is True
    assert legacy["run"]["auto_export_sessions"] is True
    assert judged["run"]["concurrency"] == 3

    with pytest.raises(ValueError, match="requires non-empty rubrics"):
        manager._build_action_config(
            {
                "benchmark": "adhoc",
                "auto_judge": False,
                "adhoc": {"task": "legacy instruction"},
            },
            kind="rejudge",
            concurrency=None,
            model=None,
            new_run=False,
        )


def test_rerun_rebuilds_each_task_from_complete_snapshot(tmp_path: Path) -> None:
    entries = [_json_task("first", rubrics=True), _json_task("second", rubrics=True)]
    rows = [
        {"task_id": "first__iter2", "base_task_id": "first", "iteration_index": 2},
        {"task_id": "second__iter2", "base_task_id": "second", "iteration_index": 2},
    ]
    (tmp_path / "tasks.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    previous = {"benchmark": "adhoc", "adhoc": {"tasks": entries}}

    tasks = run_eval._build_rerun_tasks(
        HarnessConfig(),
        tmp_path,
        {"first__iter2", "second__iter2"},
        previous,
    )

    assert [task.instruction for task in tasks] == ["Run first", "Run second"]
    assert all(task.metadata["iteration_index"] == 2 for task in tasks)
    assert all(task.metadata["rubrics"] for task in tasks)


def test_resume_preflight_restores_legacy_snapshot_and_iterations(tmp_path: Path) -> None:
    (tmp_path / "run_metadata.json").write_text(
        json.dumps(
            {
                "benchmark": "adhoc",
                "adhoc": {"task": "legacy instruction"},
                "iterations": 2,
                "auto_judge": True,
                "task_count_planned": 2,
                "planned_task_ids": ["adhoc__iter1", "adhoc__iter2"],
            }
        ),
        encoding="utf-8",
    )
    cfg = HarnessConfig()

    error, tasks = run_eval.resume_preflight(cfg, tmp_path)

    assert error is None
    assert [task.task_id for task in tasks] == ["adhoc__iter1", "adhoc__iter2"]
    assert all(task.instruction == "legacy instruction" for task in tasks)
    assert cfg.adhoc.task is None
    assert cfg.adhoc.tasks is not None
    assert cfg.run.iterations == 2
    assert cfg.run.auto_judge is False


def test_direct_judge_rejects_legacy_rubricless_run_without_artifacts(tmp_path: Path) -> None:
    (tmp_path / "run_metadata.json").write_text(
        json.dumps(
            {
                "run_id": "legacy",
                "benchmark": "adhoc",
                "adhoc": {"task": "legacy instruction"},
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "tasks.jsonl").write_text(
        json.dumps({"task_id": "adhoc", "benchmark": "adhoc"}) + "\n",
        encoding="utf-8",
    )

    result = asyncio.run(run_judge.judge_run(tmp_path, HarnessConfig()))

    assert result == 1
    assert not (tmp_path / "judges").exists()
