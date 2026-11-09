"""Judge contracts: JudgeInput / JudgeResult / Judge Protocol (core, engine-free)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from wiek_bench.datasets.base import BenchmarkTask
from wiek_bench.session_parser import BashAction


@dataclass
class JudgeInput:
    task: BenchmarkTask
    final_output: str
    bash_actions: list[BashAction]
    selected_screenshots: list[Path]
    error: str | None = None
    # Absolute session JSONL and frames directory for agent-mode verification.
    session_file: str | None = None
    screenshots_dir: str | None = None
    # Absolute command-to-screenshot manifest. Agent mode injects the path and
    # schema, then lets the judge inspect only the original frames it needs.
    # Legacy runs without a manifest use ``None``.
    manifest_path: str | None = None
    # Absolute frames/trees directory for complementary AX evidence. The
    # manifest maps commands to trees; legacy runs use ``None``.
    trees_dir: str | None = None
    # Optional per-rubric progress sidecar. Odysseys writes
    # {task_id, rubric_id, done, total} before each rubric for live WebUI
    # progress; run_judge removes it when the task finishes.
    progress_path: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class JudgeResult:
    verdict: bool | None  # None means an undetermined judge error.
    score: float  # Binary judges use 0/1; Odysseys uses partial credit in [0,1].
    reasoning: str
    failure_reason: str | None = None
    reached_captcha: bool = False
    impossible_task: bool = False
    judge_model: str | None = None
    error: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class Judge(Protocol):
    name: str
    # Whether this judge benefits from agent mode (read/bash self-inspection). Judges that
    # must replicate an upstream pipeline byte-for-byte set False and fall back to single
    # even under the global agent default.
    supports_agent_mode: bool

    async def evaluate(self, judge_input: JudgeInput) -> JudgeResult: ...
