"""Stealth Bench judge: reached the target site without being blocked."""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel

from wiek_bench.judges.base import JudgeInput, JudgeResult
from wiek_bench.judges.context import PiJudgeContext, clip_result, clip_task, format_trajectory
from wiek_bench.prompts import render_judge_prompt


class _StealthVerdictSchema(BaseModel):
    reasoning: str | None = None
    verdict: bool = False
    failure_reason: str | None = None
    blocked_by_captcha: bool = False
    blocked_by_antibot: bool = False
    page_load_failure: bool = False
    reached_target_site: bool = False


class StealthBenchJudge:
    name = "stealth-bench"
    supports_agent_mode = True

    def __init__(self, ctx: PiJudgeContext) -> None:
        self.ctx = ctx

    def _message(self, ji: JudgeInput, mode: str, scoped: list[Path]) -> str:
        return render_judge_prompt(
            "stealth",
            task=clip_task(ji.task.instruction),
            final_result=clip_result(ji.final_output.strip() or "(none)"),
            trajectory=format_trajectory(ji.bash_actions),
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
            schema=_StealthVerdictSchema,
            images=images,
            supports_agent=self.supports_agent_mode,
        )
        if result.value is None:
            return JudgeResult(
                verdict=None, score=0, reasoning="", error=result.error,  # Undetermined judge error.
                judge_model=self.ctx.model,
                metadata={"image_count": len(images), "judge_mode": mode, **result.usage.as_meta()},
            )
        v: _StealthVerdictSchema = result.value
        return JudgeResult(
            verdict=v.verdict,
            score=1 if v.verdict else 0,
            reasoning=v.reasoning or "",
            failure_reason=v.failure_reason,
            reached_captcha=v.blocked_by_captcha,
            judge_model=self.ctx.model,
            metadata={
                "image_count": len(images),
                "judge_mode": mode,
                "blocked_by_captcha": v.blocked_by_captcha,
                "blocked_by_antibot": v.blocked_by_antibot,
                "page_load_failure": v.page_load_failure,
                "reached_target_site": v.reached_target_site,
                **result.usage.as_meta(),
            },
        )
