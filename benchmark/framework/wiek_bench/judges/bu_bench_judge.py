"""BU Bench judge.

LLM-as-judge with ground-truth priority; degrades to instruction matching when there
is no answer. Faithful re-implementation of the upstream criteria.
Also hosts make_judge_for_benchmark routing.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel

from wiek_bench.judges.base import Judge, JudgeInput, JudgeResult
from wiek_bench.judges.context import (
    PiJudgeContext,
    clip_result,
    clip_task,
    format_trajectory,
)
from wiek_bench.prompts import render_judge_prompt


class _JudgementResultSchema(BaseModel):
    reasoning: str | None = None
    verdict: bool = False
    failure_reason: str | None = None
    impossible_task: bool = False
    reached_captcha: bool = False


class BUBenchJudge:
    name = "bu-bench"
    supports_agent_mode = True

    def __init__(self, ctx: PiJudgeContext) -> None:
        self.ctx = ctx

    def _message(self, ji: JudgeInput, mode: str, scoped: list[Path]) -> str:
        final = ji.final_output.strip() or "(Agent did not return a result)"
        return render_judge_prompt(
            "bu_bench",
            task=clip_task(ji.task.instruction),
            answer=ji.task.answer,
            final_result=clip_result(final),
            trajectory=format_trajectory(ji.bash_actions),
            provider_error=ji.error,
            **self.ctx.scope_kwargs(scoped, ji.selected_screenshots),
            mode=mode,
            session_file=ji.session_file,
            screenshots_dir=ji.screenshots_dir,
            manifest_path=ji.manifest_path,
            trees_dir=ji.trees_dir,
            probe_script=self.ctx.probe_script,
        )

    async def evaluate(self, ji: JudgeInput) -> JudgeResult:
        images = self.ctx.cap_screenshots(ji.selected_screenshots)
        result, mode = await self.ctx.run_json(
            make_message=lambda m: self._message(ji, m, images),
            schema=_JudgementResultSchema,
            images=images,
            supports_agent=self.supports_agent_mode,
        )
        if result.value is None:
            return JudgeResult(
                verdict=None,  # A judge error is undetermined, not a task failure.
                score=0,
                reasoning="",
                error=result.error,
                judge_model=self.ctx.model,
                metadata={"image_count": len(images), "judge_mode": mode, **result.usage.as_meta()},
            )
        v: _JudgementResultSchema = result.value
        return JudgeResult(
            verdict=v.verdict,
            score=1 if v.verdict else 0,
            reasoning=v.reasoning or "",
            failure_reason=v.failure_reason,
            impossible_task=v.impossible_task,
            reached_captcha=v.reached_captcha,
            judge_model=self.ctx.model,
            metadata={"image_count": len(images), "judge_mode": mode, **result.usage.as_meta()},
        )


def make_judge_for_benchmark(benchmark: str, *, ctx: PiJudgeContext) -> Judge:
    from wiek_bench.datasets import get_adapter
    from wiek_bench.judges.odysseys_judge import OdysseysJudge
    from wiek_bench.judges.online_mind2web_judge import OnlineMind2WebJudge
    from wiek_bench.judges.stealth_judge import StealthBenchJudge

    # Ad-hoc has no registered adapter, but its accepted judged form is an
    # Odysseys-shaped all-rubric batch. Bypass only adapter lookup, not judge semantics.
    if benchmark == "adhoc":
        return OdysseysJudge(ctx)

    judge_name = get_adapter(benchmark).judge_name
    if judge_name == "stealth-bench":
        return StealthBenchJudge(ctx)
    if judge_name == "online-mind2web":
        return OnlineMind2WebJudge(ctx)
    if judge_name == "odysseys":
        return OdysseysJudge(ctx)
    return BUBenchJudge(ctx)
