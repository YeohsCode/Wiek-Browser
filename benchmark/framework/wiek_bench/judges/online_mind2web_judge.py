"""Online-Mind2Web WebJudge: three-stage pipeline.

key points (text) → per-image score 1-5 (vision) → filter + final success/failure.
Each stage is a pi text call; usage accumulates across all sub-calls.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

from wiek_bench.judges.base import JudgeInput, JudgeResult
from wiek_bench.judges.context import PiJudgeContext, clip_task
from wiek_bench.judges.pi_judge import JudgeUsage, pi_judge_text
from wiek_bench.prompts import render_judge_prompt

_SCORE_RE = re.compile(r"score\s*[:=]?\s*([1-5])", re.IGNORECASE)


class OnlineMind2WebJudge:
    name = "online-mind2web"
    # Reproduce the upstream three-stage pipeline exactly. None of the stages
    # benefit from tools, so this judge always falls back to single mode.
    supports_agent_mode = False

    def __init__(self, ctx: PiJudgeContext) -> None:
        self.ctx = ctx

    def _text_call(self, message: str, images: list[Path] | None = None):
        return pi_judge_text(
            model=self.ctx.model,
            thinking_level=self.ctx.thinking_level,
            message=message,
            images=images,
            retry_max=self.ctx.retry_max,
            timeout_s=self.ctx.timeout_s,
            pi_bin=self.ctx.pi_bin,
            pi_agent_dir=self.ctx.pi_agent_dir,
            cwd=self.ctx.workspace,
        )

    async def evaluate(self, ji: JudgeInput) -> JudgeResult:
        self._task_id = ji.task.task_id
        usage = JudgeUsage()
        stage_errors: list[str] = []

        # Stage 1: key points
        kp_msg = render_judge_prompt(
            "online_mind2web_key_points", task=clip_task(ji.task.instruction)
        )
        kp_res = await self._text_call(kp_msg)
        usage.add(kp_res.usage)
        if kp_res.error:
            stage_errors.append(f"key_points: {kp_res.error}")
        key_points = kp_res.text.strip() or ji.task.instruction

        images = self.ctx.cap_screenshots(ji.selected_screenshots)
        per_image: list[tuple[Path, int, str]] = []

        # Stage 2: per-image vision scoring (bounded concurrency)
        if images:
            sem = asyncio.Semaphore(max(1, self.ctx.image_concurrency))

            async def score_one(img: Path) -> tuple[Path, int, str, str | None]:
                async with sem:
                    msg = render_judge_prompt(
                        "online_mind2web_image",
                        task=clip_task(ji.task.instruction),
                        key_points=key_points,
                    )
                    res = await self._text_call(msg, images=[img])
                    usage.add(res.usage)
                    m = _SCORE_RE.search(res.text)
                    score = int(m.group(1)) if m else 1
                    return img, score, res.text.strip(), res.error

            scored = await asyncio.gather(*(score_one(i) for i in images))
            per_image = [(p, s, r) for (p, s, r, _e) in scored]
            for _p, _s, _r, err in scored:
                if err:
                    stage_errors.append(f"image: {err}")

        important = [(p, s, r) for (p, s, r) in per_image if s >= self.ctx.score_threshold]
        per_image_scores = [s for (_, s, _) in per_image]

        # Stage 3: final verdict (text only)
        last_actions = "\n".join(a.command for a in ji.bash_actions[-15:])
        img_reasons = "\n\n".join(
            f"[screenshot score={s}] {r[:600]}" for (_, s, r) in (important or per_image)
        )
        final_msg = render_judge_prompt(
            "online_mind2web_final",
            task=clip_task(ji.task.instruction),
            key_points=key_points,
            last_actions=last_actions,
            agent_final=ji.final_output.strip() or "(none)",
            screenshot_reasoning=img_reasons or "(no screenshots)",
        )
        final_res = await self._text_call(final_msg)
        usage.add(final_res.usage)
        if final_res.error:
            # judge-infrastructure failure: do not pass off a confident verdict
            verdict = None  # A judge error is undetermined.
            error = f"WebJudge final stage failed: {final_res.error}"
        else:
            text = final_res.text.lower()
            # last occurrence wins
            success = text.rfind("success")
            failure = text.rfind("failure")
            if success < 0 and failure < 0:
                verdict = None  # No parseable verdict is an undetermined judge error.
                error = "no success/failure keyword in final verdict"
            else:
                verdict = success > failure
                error = None

        return JudgeResult(
            verdict=verdict,
            score=1 if verdict else 0,
            reasoning=final_res.text.strip(),
            # judge_error (verdict=None) carries no failure_reason — only a real
            # verdict==False does (else it reads as a content failure, not a judge fault).
            failure_reason="WebJudge: not all key points satisfied" if verdict is False else None,
            judge_model=self.ctx.model,
            error=error,
            metadata={
                "image_count": len(images),
                "judge_mode": "single",  # Always single because agent mode is unsupported.
                "key_points": key_points,
                "important_image_count": len(important),
                "per_image_scores": per_image_scores,
                "score_threshold": self.ctx.score_threshold,
                "action_history_count": len(ji.bash_actions),
                "stage_errors": stage_errors,
                **usage.as_meta(),
            },
        )
