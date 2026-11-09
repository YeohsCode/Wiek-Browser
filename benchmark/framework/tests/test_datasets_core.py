from __future__ import annotations

import json
from pathlib import Path

import pytest

from wiek_bench.datasets.base import BenchmarkTask, JsonFileAdapter, extract_first_url, sample_tasks
from wiek_bench.datasets.bu_bench import BUBenchAdapter
from wiek_bench.datasets.stealth_bench import StealthBenchAdapter


def _task(task_id: str, category: str | None) -> BenchmarkTask:
    return BenchmarkTask(
        task_id=task_id,
        benchmark="test",
        instruction=f"Task {task_id}",
        category=category,
    )


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Open https://example.com/path.", "https://example.com/path"),
        ("Use (https://example.com/a?b=1).", "https://example.com/a?b=1"),
        ("No URL here", None),
    ],
)
def test_extract_first_url_strips_sentence_punctuation(text: str, expected: str | None) -> None:
    assert extract_first_url(text) == expected


def test_sample_tasks_preserves_requested_order_and_deduplicates_ids() -> None:
    tasks = [_task("a", "one"), _task("b", "two"), _task("c", "one")]

    selected = sample_tasks(tasks, task_ids=["c", "a", "c"])

    assert [task.task_id for task in selected] == ["c", "a"]


def test_sample_tasks_fails_loudly_for_unknown_id() -> None:
    with pytest.raises(KeyError, match="missing"):
        sample_tasks([_task("known", None)], task_ids=["missing"])


@pytest.mark.parametrize("task_ids", [None, []])
def test_sample_tasks_without_ids_returns_the_whole_dataset_in_order(
    task_ids: list[str] | None,
) -> None:
    tasks = [_task("a1", "a"), _task("a2", "a"), _task("b1", "b")]

    selected = sample_tasks(tasks, task_ids=task_ids)

    assert [task.task_id for task in selected] == ["a1", "a2", "b1"]


def test_json_adapter_rejects_non_array_source(tmp_path: Path) -> None:
    class Adapter(JsonFileAdapter):
        name = "test"
        judge_name = "test"
        _source_file = "tasks.json"

        def parse_entry(self, entry: dict[str, object]) -> BenchmarkTask:
            return _task(str(entry["task_id"]), None)

    (tmp_path / "tasks.json").write_text(json.dumps({"task_id": "one"}), encoding="utf-8")

    with pytest.raises(ValueError, match="must be a JSON array"):
        Adapter(tmp_path).load()


def test_bu_bench_adapter_extracts_website_line() -> None:
    task = BUBenchAdapter().parse_entry(
        {
            "task_id": "bu-1",
            "confirmed_task": "Find the result.\nwebsite: https://example.com/path).",
            "category": "research",
        }
    )

    assert task.start_url == "https://example.com/path"
    assert task.metadata["source_file"] == "BU_Bench_V1.json"


def test_stealth_adapter_normalizes_bare_website() -> None:
    task = StealthBenchAdapter().parse_entry(
        {
            "task_id": "stealth-1",
            "confirmed_task": "Open the target",
            "website": "example.com",
            "category": "waf",
        }
    )

    assert task.start_url == "https://example.com"
