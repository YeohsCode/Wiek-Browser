from __future__ import annotations

import re
from pathlib import Path

import pytest

from wiek_bench.datasets.base import BenchmarkTask
from wiek_bench.prompts import render_judge_prompt, render_task_prompt


ROOT = Path(__file__).resolve().parents[1]
HAN_RE = re.compile(r"[\u3400-\u9fff]")
INTERNAL_DOC_RE = re.compile(r"(?i:\bprd\b|docs/prd)|§")
JUDGE_TEMPLATES = tuple(
    path.stem
    for path in sorted((ROOT / "wiek_bench/prompts/judge").glob("*.j2"))
    if not path.stem.startswith("_")
)


def _judge_context(mode: str) -> dict[str, object]:
    return {
        "mode": mode,
        "task": "Inspect the target page.",
        "answer": "Expected result",
        "final_result": "FINAL ANSWER: Expected result",
        "trajectory": "1. Open the target page.",
        "provider_error": None,
        "session_file": "/tmp/session.jsonl",
        "screenshots_dir": "/tmp/frames",
        "probe_script": "/tmp/probe.py",
        "manifest_path": "/tmp/manifest.jsonl",
        "trees_dir": "/tmp/trees",
        "image_count": 1,
        "total_frames": 1,
        "scoped_frames": ["001.webp"],
        "rubric_id": "R1",
        "requirement": "The target page is visible.",
        "verification": "Check the final page state.",
        "key_points": "1. Open the target page.",
        "last_actions": "Opened the target page.",
        "agent_final": "Expected result",
        "screenshot_reasoning": "The target page is visible.",
    }


@pytest.mark.parametrize("mode", ["single", "agent"])
@pytest.mark.parametrize("template", JUDGE_TEMPLATES)
def test_all_judge_prompts_render_in_english(template: str, mode: str) -> None:
    rendered = render_judge_prompt(template, **_judge_context(mode))

    assert rendered.strip()
    assert not HAN_RE.search(rendered)
    assert not INTERNAL_DOC_RE.search(rendered)


def test_task_prompt_adds_missing_start_url_once() -> None:
    task = BenchmarkTask(
        task_id="task-1",
        benchmark="test",
        instruction="Find the result.",
        start_url="https://example.com/start",
    )

    rendered = render_task_prompt(task, browser_tool="wiek-browser")

    assert rendered.count("https://example.com/start") == 1
    assert "`wiek-browser`" in rendered
    assert "Find the result." in rendered


def test_task_prompt_does_not_duplicate_explicit_start_url() -> None:
    task = BenchmarkTask(
        task_id="task-1",
        benchmark="test",
        instruction="Open https://example.com/start and find the result.",
        start_url="https://example.com/start",
    )

    rendered = render_task_prompt(task, browser_tool="wiek-browser")

    assert rendered.count("https://example.com/start") == 1
