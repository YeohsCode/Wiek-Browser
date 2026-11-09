"""evaluate_session(): judge a single pi session without a run directory."""

from __future__ import annotations

from pathlib import Path

from wiek_bench.datasets.base import BenchmarkTask
from wiek_bench.judges.base import Judge, JudgeResult
from wiek_bench.judges.bu_bench_judge import make_judge_for_benchmark
from wiek_bench.judges.context import PiJudgeContext, manifest_path_of, screenshots_dir_of
from wiek_bench.session_parser import bash_actions_from_session, safe_parse

from .base import JudgeInput


async def evaluate_session(
    *,
    session_file: str | Path,
    task: BenchmarkTask,
    screenshots: list[Path],
    ctx: PiJudgeContext,
    benchmark: str | None = None,
    judge: Judge | None = None,
) -> JudgeResult:
    stats = safe_parse(session_file)
    actions = bash_actions_from_session(session_file)
    screenshots = list(screenshots)
    ji = JudgeInput(
        task=task,
        final_output=stats.final_output or "",
        bash_actions=actions,
        selected_screenshots=screenshots,
        session_file=str(session_file),
        screenshots_dir=screenshots_dir_of(screenshots),
        manifest_path=manifest_path_of(screenshots),
        metadata={"session_parse_error": stats.parse_error},
    )
    j = judge or make_judge_for_benchmark(benchmark or task.benchmark, ctx=ctx)
    return await j.evaluate(ji)
