"""Odysseys per-rubric judge for real-world-bench and odysseys.

Each rubric item gets its own pi judge call (single rubric + full trajectory +
all screenshots + final answer); binary per-rubric verdicts aggregate into a
partial-credit task score: score = mean(rubric scores), verdict = all pass.
Rubrics run sequentially within a task; cross-task concurrency stays with
``judge.concurrency`` (no subprocess explosion).

For targeted re-judging, ``evaluate`` accepts ``only_rubrics`` and ``prior``
to re-run a subset of rubrics and splice them over the prior payload, re-aggregating
over the full set. The per-rubric loop (``_run_rubrics``) and the aggregation
(``_finalize``) are factored out so the full-run and subset-splice paths share one
algorithm — no second copy of the score math to drift.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from loguru import logger
from pydantic import BaseModel, Field

from wiek_bench.judges.base import JudgeInput, JudgeResult
from wiek_bench.judges.context import (
    PiJudgeContext,
    clip_result,
    clip_task,
    format_trajectory,
    format_trajectory_steps,
)
from wiek_bench.judges.pi_judge import JudgeUsage
from wiek_bench.prompts import render_judge_prompt
from wiek_bench.session_parser import safe_parse, trajectory_steps_from_session


class _RubricVerdictSchema(BaseModel):
    reasoning: str | None = None
    satisfied: bool = False
    # Judge certainty for this rubric verdict (integer 0-10). It is audit-only
    # and never enters the strictly binary rubric score. Missing values use the
    # pydantic default 0 (= lowest certainty, the safe direction for escalation).
    confidence: int = Field(default=0, ge=0, le=10)


@dataclass
class _RubricRun:
    """Raw per-rubric outcome of one ``_run_rubrics`` pass (subset or full).

    Holds the structured per-rubric data BEFORE task aggregation so the same
    ``_finalize`` can aggregate a full run or a spliced (prior + rerun) set.
    """

    rubric_results: list[dict] = field(default_factory=list)
    rubric_scores: dict[str, int] = field(default_factory=dict)
    rubric_sessions: list[dict] = field(default_factory=list)
    usage: JudgeUsage = field(default_factory=JudgeUsage)
    mode: str = "single"
    error: str | None = None


class OdysseysJudge:
    name = "odysseys"
    supports_agent_mode = True
    # Gates the --rejudge-rubrics path: only a per-rubric judge can
    # re-run a rubric subset. Binary judges (bu-bench / stealth / online-mind2web) lack it.
    supports_rubric_subset = True

    def __init__(self, ctx: PiJudgeContext) -> None:
        self.ctx = ctx

    def _rubric_message(
        self,
        ji: JudgeInput,
        rubric_id: str,
        rubric: dict,
        mode: str,
        scoped: list[Path],
        trajectory: str,
    ) -> str:
        # Agent and single modes use separate templates. Agent mode uses an
        # investigation-oriented context with one role declaration. Single
        # mode reproduces the paper prompt with its system text, trajectory,
        # and screenshots, while omitting the agent's final answer. Both
        # templates receive the same context superset. ``evaluate`` computes
        # the paper-style per-turn trajectory once for all rubrics.
        template = "odysseys_rubric_agent" if mode == "agent" else "odysseys_rubric"
        return render_judge_prompt(
            template,
            task=clip_task(ji.task.instruction),
            rubric_id=rubric_id,
            requirement=str(rubric.get("requirement") or ""),
            verification=str(rubric.get("verification") or ""),
            trajectory=trajectory,
            final_result=clip_result(ji.final_output.strip() or "(Agent did not return a result)"),
            provider_error=ji.error,
            **self.ctx.scope_kwargs(scoped, ji.selected_screenshots),
            mode=mode,
            session_file=ji.session_file,
            screenshots_dir=ji.screenshots_dir,
            manifest_path=ji.manifest_path,
            trees_dir=ji.trees_dir,
            probe_script=self.ctx.probe_script,
        )

    @staticmethod
    def _rubric_system(mode: str) -> str | None:
        """Return the paper system prompt for single mode.

        ``odysseys_rubric_system.j2`` matches the upstream
        FULL_TRAJ_JUDGMENT_SYSTEM. Agent mode returns ``None`` to retain the
        default scaffolding required by its readonly+bash tools and judge
        skill; ``odysseys_rubric_agent.j2`` remains its user message.
        """
        if mode != "single":
            return None
        return render_judge_prompt("odysseys_rubric_system")

    @staticmethod
    def _trajectory(ji: JudgeInput) -> str:
        """Build the paper-style per-turn action history from the session.

        Each turn with an action becomes
        ``N. Response: ... / Action: a -> b``. Response uses visible text and
        falls back to thinking; Action joins that turn's bash commands. Turns
        without actions, including the final answer, are omitted. If the
        session has no parseable steps, fall back to the legacy flat command
        list so single mode always has a trajectory. Agent mode reads the
        session directly and ignores this string.
        """
        steps = trajectory_steps_from_session(ji.session_file) if ji.session_file else []
        if steps:
            return format_trajectory_steps(steps)
        return format_trajectory(ji.bash_actions)

    @staticmethod
    def _write_rubric_progress(ji: JudgeInput, rubric_id: str, done: int, total: int) -> None:
        """Atomically write live rubric progress before evaluating each rubric.

        This is display-only state for the WebUI. Write failures are logged at
        debug level and never affect judging.
        """
        if not ji.progress_path:
            return
        try:
            path = Path(ji.progress_path)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(
                json.dumps(
                    {
                        "task_id": ji.task.task_id,
                        "rubric_id": rubric_id,
                        "done": done,
                        "total": total,
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            tmp.replace(path)
        except Exception as exc:  # noqa: BLE001
            logger.debug("rubric progress sidecar write failed for {}: {}", ji.task.task_id, exc)

    async def _run_rubrics(
        self, ji: JudgeInput, images: list[Path], trajectory: str, rubric_ids: list[str]
    ) -> _RubricRun:
        """Run pi judge once per rubric in ``rubric_ids`` (sorted), collecting raw
        per-rubric verdicts + sessions + usage. On the first undetermined rubric it
        records ``error`` and stops while retaining partial results for audit."""
        rubrics = ji.task.metadata.get("rubrics") or {}
        run = _RubricRun()
        ordered = sorted(rubric_ids)
        # Run one judge subprocess at a time within a task; cross-task
        # parallelism comes from judge.concurrency. Agent mode still uses one
        # independent subprocess per rubric.
        for idx, rubric_id in enumerate(ordered):
            rubric = rubrics.get(rubric_id) or {}
            self._write_rubric_progress(ji, rubric_id, done=idx, total=len(ordered))

            def _make_msg(
                m: str, rid: str = rubric_id, rb: dict = rubric, tj: str = trajectory
            ) -> str:
                return self._rubric_message(ji, rid, rb, m, images, tj)

            result, run.mode = await self.ctx.run_json(
                make_message=_make_msg,
                make_system=self._rubric_system,
                schema=_RubricVerdictSchema,
                images=images,
                supports_agent=self.supports_agent_mode,
            )
            run.usage.add(result.usage)
            # Record this rubric's session even on failure (value is None): the
            # session file may still exist and is useful for auditing. Cache this rubric's
            # own tokens/cost on the entry so a subset rerun sums kept and rerun entries
            # the entries themselves — no re-reading session JSONL, so _judge.json stays a
            # and _judge.json remains self-contained after judge-session cleanup.
            run.rubric_sessions.append(
                {
                    "rubric_id": rubric_id,
                    "session_id": result.usage.session_id,
                    "session_file": result.usage.session_file,
                    "input_tokens": result.usage.input_tokens,
                    "output_tokens": result.usage.output_tokens,
                    "cost_usd": result.usage.cost_usd,
                    "duration_s": result.usage.duration_s,
                    "turns": result.usage.num_turns,
                }
            )
            if result.value is None:
                # One missing rubric skews the mean; surface a judge error while
                # retaining partial results for audit.
                run.error = f"rubric {rubric_id}: {result.error}"
                break
            v: _RubricVerdictSchema = result.value
            run.rubric_scores[rubric_id] = 1 if v.satisfied else 0
            run.rubric_results.append(
                {
                    "rubric_id": rubric_id,
                    "requirement": rubric.get("requirement"),
                    "verification": rubric.get("verification"),
                    "satisfied": v.satisfied,
                    "confidence": v.confidence,
                    "reasoning": v.reasoning or "",
                    # Per-rubric model provenance. It is the same across a full
                    # run and differs only after a subset
                    # rerun with --judge-model.
                    "judge_model": self.ctx.model,
                }
            )
        return run

    def _finalize(
        self, run: _RubricRun, *, num_rubrics: int, image_count: int, usage_meta: dict
    ) -> JudgeResult:
        """Aggregate a (possibly spliced) rubric set into a task JudgeResult — the one
        copy of the score math shared by full-run and subset-splice paths."""
        meta = {
            "image_count": image_count,
            "judge_mode": run.mode,
            "num_rubrics": num_rubrics,
            "rubric_scores": run.rubric_scores,
            "rubric_results": run.rubric_results,
            "judge_sessions": run.rubric_sessions,
            **usage_meta,
        }
        if run.error is not None:
            return JudgeResult(
                verdict=None,  # Undetermined judge error; partial rubrics remain in metadata.
                score=0.0,
                reasoning="",
                error=run.error,
                judge_model=self.ctx.model,
                metadata=meta,
            )
        score = round(sum(run.rubric_scores.values()) / len(run.rubric_scores), 4)
        verdict = all(s == 1 for s in run.rubric_scores.values())
        failed = [r for r in run.rubric_results if not r["satisfied"]]
        # Keep each reasoning string intact. The report renders structured
        # rubric_results first, while failure_reason serves other consumers.
        failure_reason = (
            "; ".join(
                f"{r['rubric_id']}: {r['reasoning'] or 'not satisfied'}" for r in failed
            )
            or None
        )
        reasoning = "\n".join(
            f"[{r['rubric_id']}={'pass' if r['satisfied'] else 'fail'}] {r['reasoning']}"
            for r in run.rubric_results
        )
        return JudgeResult(
            verdict=verdict,
            score=score,
            reasoning=reasoning,
            failure_reason=None if verdict else failure_reason,
            judge_model=self.ctx.model,
            metadata=meta,
        )

    def _usage_from_sessions(self, sessions: list[dict]) -> JudgeUsage:
        """Sum per-rubric judge usage over a (spliced) session set so the overwritten
        _judge.json's token/cost == kept + reran, not just the reran subset. Each entry
        caches its own tokens/cost (recorded in _run_rubrics), so the kept rubrics' usage
        survives even if their session JSONL was cleaned. _judge.json, not the
        sessions, is the source of truth. Legacy prior entries
        cached) lack the fields → fall back to re-parsing that one session file best-effort
        (missing → 0, slight under-count)."""
        usage = JudgeUsage()
        for s in sessions:
            one = JudgeUsage(session_id=s.get("session_id"), session_file=s.get("session_file"))
            stats = None
            if any(k in s for k in ("input_tokens", "output_tokens", "cost_usd")):
                one.input_tokens = int(s.get("input_tokens") or 0)
                one.output_tokens = int(s.get("output_tokens") or 0)
                one.cost_usd = float(s.get("cost_usd") or 0.0)
            elif s.get("session_file"):
                stats = safe_parse(s["session_file"])
                one.input_tokens = stats.input_tokens
                one.output_tokens = stats.output_tokens
                one.cost_usd = float(stats.cost_usd or 0.0)
            if "duration_s" in s or "turns" in s:
                one.duration_s = float(s.get("duration_s") or 0.0)
                one.num_turns = int(s.get("turns") or 0)
            elif s.get("session_file"):
                stats = stats or safe_parse(s["session_file"])
                one.duration_s = stats.duration_s or 0.0
                one.num_turns = stats.num_turns
            usage.add(one)
        return usage

    async def evaluate(
        self,
        ji: JudgeInput,
        *,
        only_rubrics: set[str] | None = None,
        prior: dict | None = None,
    ) -> JudgeResult:
        """Judge the task per rubric. With ``only_rubrics``, re-run only those
        rubrics and splice them over ``prior`` (the prior _judge.json ``metadata``),
        re-aggregating over the full rubric set; otherwise run every rubric."""
        rubrics = ji.task.metadata.get("rubrics")
        if not isinstance(rubrics, dict) or not rubrics:
            # A missing rubric set violates the dataset boundary. Fail loudly
            # instead of degrading to whole-task judging.
            return JudgeResult(
                verdict=None,  # Undetermined judge error.
                score=0.0,
                reasoning="",
                error=f"task {ji.task.task_id} has no rubrics; odysseys judge requires them",
                judge_model=self.ctx.model,
            )

        images = self.ctx.cap_screenshots(ji.selected_screenshots)
        # Compute the paper-style per-turn history once per task and share it
        # across rubrics. Single mode sends it; agent mode reads the session.
        trajectory = self._trajectory(ji)
        num_rubrics = len(rubrics)

        if only_rubrics is None:
            run = await self._run_rubrics(ji, images, trajectory, list(rubrics))
            return self._finalize(
                run, num_rubrics=num_rubrics, image_count=len(images), usage_meta=run.usage.as_meta()
            )

        # Rerun ``only_rubrics`` and splice the results over ``prior``.
        all_ids = {str(r) for r in rubrics}
        want = {str(r) for r in only_rubrics}
        unknown = want - all_ids
        if unknown:
            return JudgeResult(
                verdict=None,
                score=0.0,
                reasoning="",
                error=f"rubric ids not in task {ji.task.task_id}: {sorted(unknown)}",
                judge_model=self.ctx.model,
            )
        prior = prior or {}
        prior_results = {str(r.get("rubric_id")): r for r in (prior.get("rubric_results") or [])}
        prior_scores = {str(k): v for k, v in (prior.get("rubric_scores") or {}).items()}
        prior_sessions = {str(s.get("rubric_id")): s for s in (prior.get("judge_sessions") or [])}
        # completeness: prior (kept) ∪ rerun must cover EVERY dataset rubric — else the
        # mean is over a partial set. An incomplete prior (judge_error broke mid-loop) →
        # fail loudly and tell the caller to rerun the whole task.
        covered = set(prior_results) | want
        if covered != all_ids:
            missing = sorted(all_ids - covered)
            return JudgeResult(
                verdict=None,
                score=0.0,
                reasoning="",
                error=(
                    f"prior judge incomplete for task {ji.task.task_id}; re-run the whole "
                    f"task instead (missing rubrics: {missing})"
                ),
                judge_model=self.ctx.model,
            )

        sub = await self._run_rubrics(ji, images, trajectory, sorted(want))
        if sub.error is not None:
            # the rerun itself failed transiently — return the error WITHOUT splicing so
            # run_judge keeps the prior payload intact.
            return self._finalize(
                sub, num_rubrics=num_rubrics, image_count=len(images), usage_meta=sub.usage.as_meta()
            )

        # splice: reran results replace prior by id, keep the rest; order by rubric id so
        # reasoning / failure_reason are stable regardless of which subset reran.
        new_results = {r["rubric_id"]: r for r in sub.rubric_results}
        new_sessions = {s["rubric_id"]: s for s in sub.rubric_sessions}
        merged_results_map = {**prior_results, **new_results}
        merged_scores = {**prior_scores, **sub.rubric_scores}
        merged_sessions_map = {**prior_sessions, **new_sessions}
        ordered = sorted(all_ids)
        merged_sessions = [merged_sessions_map[r] for r in ordered if r in merged_sessions_map]
        merged = _RubricRun(
            rubric_results=[merged_results_map[r] for r in ordered if r in merged_results_map],
            rubric_scores={r: merged_scores[r] for r in ordered if r in merged_scores},
            rubric_sessions=merged_sessions,
            usage=self._usage_from_sessions(merged_sessions),
            mode=sub.mode,
            error=None,
        )
        return self._finalize(
            merged, num_rubrics=num_rubrics, image_count=len(images), usage_meta=merged.usage.as_meta()
        )
