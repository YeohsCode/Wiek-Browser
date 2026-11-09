#!/usr/bin/env python
"""Stage B — judge a completed run with pi-as-judge; backfill tasks.jsonl + summary.json.

Decoupled from Stage A: verdict=false never triggers a retry, and judge failures never
touch Stage A products. Reusable via judge_run(run_dir, cfg) and the CLI.
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from loguru import logger

from wiek_bench import captcha
from wiek_bench.adhoc import build_adhoc_tasks
from wiek_bench.browser_tools import make_cmd_classifier
from wiek_bench.config import HarnessConfig, load_config
from wiek_bench.datasets import BenchmarkTask, get_adapter
from wiek_bench.judges import (
    JudgeInput,
    JudgeResult,
    PiJudgeContext,
    make_judge_for_benchmark,
    screenshots_dir_of,
)
from wiek_bench.metrics import bash_actions_from_session, write_summary
from wiek_bench.results import latest_by_task_id, merge_judge_into_record, resolve_run_dir
from wiek_bench.session_parser import safe_parse


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_model_label(model: str) -> str:
    return model.replace("/", "_").replace(":", "_")


def _build_context(run_dir: Path, cfg: HarnessConfig, meta: dict[str, Any], model: str) -> PiJudgeContext:
    pi_agent_dir = meta.get("pi_agent_dir") or str(Path("agent-home/.pi/agent").resolve())
    # Resolve the exact judge skill path used by agent mode.
    skill_path = str(Path(pi_agent_dir) / "skills" / cfg.judge.skill_name)
    return PiJudgeContext(
        pi_bin=meta.get("pi_bin") or "pi",
        pi_agent_dir=pi_agent_dir,
        model=model,
        thinking_level=cfg.judge.thinking_level,
        retry_max=cfg.judge.retry_max,
        timeout_s=cfg.judge.rpc.timeout_s,
        max_screenshots=cfg.judge.max_screenshots,
        image_concurrency=cfg.judge.image_concurrency,
        score_threshold=cfg.judge.score_threshold,
        mode=cfg.judge.mode,
        agent_tools=cfg.judge.resolved_agent_tools(),
        judge_skill_path=skill_path,
        agent_timeout_s=cfg.judge.rpc.agent_timeout_s,
    )


def _judge_filename(judges_dir: Path, task_id: str, alt_model: str | None) -> Path:
    if alt_model:
        return judges_dir / f"{task_id}_judge_{safe_model_label(alt_model)}.json"
    return judges_dir / f"{task_id}_judge.json"


def _select_targets(
    records: list[dict[str, Any]],
    judges_dir: Path,
    *,
    rejudge_all: bool,
    rejudge_failed: bool,
    rejudge_errors: bool,
    rejudge_task_ids: set[str] | None = None,
    alt_model: str | None,
) -> list[dict[str, Any]]:
    targets: list[dict[str, Any]] = []
    for rec in records:
        tid = str(rec.get("task_id"))
        jf = _judge_filename(judges_dir, tid, alt_model)
        # An explicit task-id set is a subset of rejudge-all:
        # rejudge-all — re-judge exactly these ids regardless of prior judge state. Mutually
        # exclusive with the four bulk switches (enforced at the CLI / call site).
        if rejudge_task_ids is not None:
            if tid in rejudge_task_ids:
                targets.append(rec)
            continue
        # A CAPTCHA-intercepted task has no trajectory worth judging — the agent never
        # reached the site. Excluded from every bulk selector so neither the initial pass
        # nor a --rejudge-all spends judge cost on it; naming the id explicitly above
        # still forces it through, for an operator who decides the interception was wrong.
        if captcha.is_blocked(rec):
            continue
        if rejudge_all:
            targets.append(rec)
            continue
        # Judge-error-only mode re-judges only transient judge failures,
        # RPC failures), never verdict=false — those are correctly-judged negatives, and
        # re-running the judge over them would waste cost and could flip a sound verdict.
        if rejudge_errors:
            if rec.get("judge_error"):
                targets.append(rec)
            continue
        if rejudge_failed:
            if not jf.exists() or not rec.get("verdict") or rec.get("judge_error"):
                targets.append(rec)
            continue
        if not jf.exists():
            targets.append(rec)
    return targets


def _task_for_record(adapter_index: dict[str, BenchmarkTask], rec: dict[str, Any]) -> BenchmarkTask:
    base_id = str(rec.get("base_task_id") or rec.get("task_id"))
    composite_id = str(rec.get("task_id"))
    base = adapter_index.get(base_id) or adapter_index.get(composite_id)
    if base is None:
        # fallback: minimal task from record (no instruction available)
        return BenchmarkTask(
            task_id=composite_id,
            benchmark=str(rec.get("benchmark")),
            instruction="(instruction unavailable)",
            category=rec.get("category"),
        )
    return dataclasses.replace(base, task_id=composite_id)


def _write_judge_payload(path: Path, result: JudgeResult, task_id: str) -> None:
    meta = result.metadata or {}
    payload = {
        "task_id": task_id,
        "verdict": result.verdict,
        "score": result.score,
        "reasoning": result.reasoning,
        "failure_reason": result.failure_reason,
        "impossible_task": result.impossible_task,
        "reached_captcha": result.reached_captcha,
        "judge_model": result.judge_model,
        # Record the actual per-payload judge channel so Stage C can reopen the
        # session correctly after mode overrides or fallbacks.
        "judge_mode": meta.get("judge_mode"),
        "judge_tools": meta.get("judge_tools"),
        "judge_skill_path": meta.get("judge_skill_path"),
        "judge_error": result.error,
        "judged_at": _now_iso(),
        "judge_session_id": meta.get("judge_session_id"),
        "judge_session_file": meta.get("judge_session_file"),
        # Odysseys is per-rubric: one judge session per rubric. None for single-call
        # judges (online-mind2web / bu-bench), which expose only judge_session_file.
        "judge_sessions": meta.get("judge_sessions"),
        "judge_input_tokens": meta.get("judge_input_tokens", 0),
        "judge_output_tokens": meta.get("judge_output_tokens", 0),
        "judge_cost_usd": meta.get("judge_cost_usd", 0.0),
        # Include judge-session wall time and turns
        # so the WebUI Judge view shows time/turns like Progress. Pre-field runs omit them
        # (meta lacks the keys) → null, surfaced as "—".
        "judge_duration_s": meta.get("judge_duration_s"),
        "judge_turns": meta.get("judge_turns"),
        "image_count": meta.get("image_count", 0),
        "metadata": {k: v for k, v in meta.items() if not k.startswith("judge_")},
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


async def judge_run(
    run_dir: str | Path,
    cfg: HarnessConfig,
    *,
    rejudge_all: bool = False,
    rejudge_failed: bool = False,
    rejudge_errors: bool = False,
    rejudge_task_ids: list[str] | None = None,
    judge_model: str | None = None,
    rejudge_task: str | None = None,
    rejudge_rubrics: list[str] | None = None,
    rejudge_spec: list[dict[str, Any]] | None = None,
) -> int:
    run_dir = Path(run_dir).resolve()
    meta_path = run_dir / "run_metadata.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    benchmark = meta.get("benchmark") or cfg.run.benchmark

    records = list(latest_by_task_id(run_dir).values())
    if not records:
        # A targeted/directed rejudge of an empty run means the requested tasks can't
        # exist → fail loud (non-zero), NOT the bulk path's benign "nothing to judge" exit 0
        # (else a --rejudge-task/--rejudge-spec on an empty run is swallowed as success).
        if rejudge_task is not None or rejudge_spec is not None:
            logger.error("no task records in {}; cannot re-judge {}", run_dir, rejudge_task or "spec targets")
            return 1
        logger.warning("no task records in {}", run_dir)
        return 0

    is_adhoc = benchmark == "adhoc"
    if is_adhoc:
        try:
            adhoc_tasks, _, rubric_mode = build_adhoc_tasks(meta.get("adhoc"))
        except ValueError as exc:
            logger.error("invalid adhoc task snapshot: {}", exc)
            return 1
        if not adhoc_tasks or rubric_mode != "all":
            logger.error(
                "adhoc Judge requires run_metadata.adhoc.tasks with non-empty rubrics for every task"
            )
            return 1
        adapter_index = {task.task_id: task for task in adhoc_tasks}
    else:
        adapter = get_adapter(benchmark)
        adapter_index = {task.task_id: task for task in adapter.load()}

    judges_dir = run_dir / "judges"
    judges_dir.mkdir(parents=True, exist_ok=True)
    model = judge_model or cfg.judge.model
    alt_model = judge_model if judge_model and judge_model != cfg.judge.model else None
    # Named-id re-judge overwrites the canonical _judge.json and
    # backfills tasks.jsonl, NEVER the alt-model file — even with --judge-model (the override
    # only picks WHO judges). Same as the single-task --rejudge-task (set at line ~211): both
    # "I named these ids" flags force canonical; only the scan selectors (all/failed/errors)
    # honour alt_model for side-by-side model comparison. The WebUI "Re-judge selected" path
    # depends on canonical artifacts and summary refresh.
    if rejudge_task_ids is not None:
        alt_model = None
    ctx = _build_context(run_dir, cfg, meta, model)

    # Directed re-judges include the single-task selector
    # the multi-target spec (--rejudge-spec, the WebUI cart — its batch generalization). Both
    # name their tasks and always overwrite CANONICAL (never the alt-model file), even with
    # --judge-model — the override only picks who judges. `work` unifies every path into
    # (record, rubric-subset-or-None) pairs so one loop serves bulk and directed alike.
    targeted = rejudge_task is not None or rejudge_spec is not None
    work: list[tuple[dict[str, Any], set[str] | None]]
    if rejudge_task is not None:
        alt_model = None
        rubric_set: set[str] | None = None
        if rejudge_rubrics:
            rubric_set = {r.strip() for r in rejudge_rubrics if r.strip()} or None
        by_id = {str(rec.get("task_id")): rec for rec in records}
        rec = by_id.get(str(rejudge_task))
        if rec is None:
            logger.error("task not found in run: {}", rejudge_task)
            return 1
        work = [(rec, rubric_set)]
    elif rejudge_spec is not None:
        # Directed semantics: an unknown task id in the spec is an operator error — fail
        # loud before judging anything, unlike --rejudge-task-ids' warn-and-skip.
        alt_model = None
        by_id = {str(rec.get("task_id")): rec for rec in records}
        work = []
        for entry in rejudge_spec:
            spec_tid = str(entry.get("task_id") or "").strip()
            rec = by_id.get(spec_tid)
            if not spec_tid or rec is None:
                logger.error("spec task not found in run: {!r}", spec_tid)
                return 1
            rub = entry.get("rubric_ids") or []
            rub_set = {str(r).strip() for r in rub if str(r).strip()} or None
            work.append((rec, rub_set))
    else:
        id_set = (
            {t.strip() for t in rejudge_task_ids if t and t.strip()}
            if rejudge_task_ids is not None
            else None
        )
        targets = _select_targets(
            records,
            judges_dir,
            rejudge_all=rejudge_all,
            rejudge_failed=rejudge_failed,
            rejudge_errors=rejudge_errors,
            rejudge_task_ids=id_set,
            alt_model=alt_model,
        )
        if id_set is not None:
            missing = id_set - {str(rec.get("task_id")) for rec in targets}
            if missing:
                logger.warning("re-judge: task ids not in run, skipped: {}", sorted(missing))
        work = [(rec, None) for rec in targets]
    directed_rubrics = sorted({r for _, subset in work if subset for r in subset})
    logger.info(
        "Stage B: {} targets (benchmark={}, judge={}{})",
        len(work),
        benchmark,
        model,
        f", rubrics={directed_rubrics}" if directed_rubrics else "",
    )

    # The on-disk job manifest contains the current target set and completion
    # counter. The WebUI gates it on judge-process liveness to show
    # subset re-judge progress the full-run file count can't express. Single writer: the
    # run-level judge mutex allows at most one judge process per run; auto-judge
    # and CLI runs share this same path. Empty work → no manifest (nothing to report, and
    # the previous job's record shouldn't be clobbered by a 0/0).
    job_path = judges_dir / "_job.json"
    job: dict[str, Any] | None = None
    job_started_monotonic: float | None = None
    if work:
        if rejudge_task is not None:
            action = "task"
        elif rejudge_spec is not None:
            action = "spec"
        elif rejudge_task_ids is not None:
            action = "task-ids"
        elif rejudge_errors:
            action = "errors"
        elif rejudge_failed:
            action = "failed"
        elif rejudge_all:
            action = "all"
        else:
            action = "default"
        job_started_monotonic = time.monotonic()
        job = {
            "started_at": _now_iso(),
            "action": action,
            "total": len(work),
            "done": 0,
            "done_ids": [],
            "finished": False,
            "targets": [
                {"task_id": str(rec.get("task_id")), "rubric_ids": sorted(subset) if subset else None}
                for rec, subset in work
            ],
        }
        _write_json_atomic(job_path, job)

    semaphore = asyncio.Semaphore(cfg.judge.concurrency)
    counts = {"ok": 0, "fail": 0, "err": 0}
    # Completion identity lets the WebUI distinguish "queued in
    # this job" from "already re-done in this job" (both have no in-flight sidecar).
    done_ids: list[str] = []

    async def _judge_one(rec: dict[str, Any], *, only_rubrics: set[str] | None = None) -> None:
        tid = str(rec.get("task_id"))
        task = _task_for_record(adapter_index, rec)
        session_file = rec.get("session_file")
        stats = safe_parse(session_file) if session_file else None
        final_output = stats.final_output if stats else ""
        actions = bash_actions_from_session(session_file) if session_file else []
        screenshots = [Path(p) for p in (rec.get("screenshot_paths") or []) if Path(p).exists()]
        ji = JudgeInput(
            task=task,
            final_output=final_output,
            bash_actions=actions,
            selected_screenshots=screenshots,
            error=rec.get("error"),
            session_file=str(session_file) if session_file else None,
            screenshots_dir=screenshots_dir_of(screenshots),
            # Stage A stores the absolute frames/manifest.jsonl path in tasks.jsonl.
            # Legacy runs omit it, and agent investigation degrades without a manifest.
            manifest_path=rec.get("screenshot_manifest"),
            # Stage A stores the AX-tree directory in tasks.jsonl. Legacy runs omit it.
            trees_dir=rec.get("screenshot_trees_dir"),
            # Per-rubric judges update this sidecar before each rubric. The WebUI
            # renders the live state, and this function removes it in finally.
            progress_path=str(judges_dir / f"{tid}_judge.progress.json"),
            metadata={"session_parse_error": stats.parse_error if stats else "no session"},
        )
        judge_path = _judge_filename(judges_dir, tid, alt_model)
        prior_existed = judge_path.exists()
        try:
            async with semaphore:
                judge = make_judge_for_benchmark(benchmark, ctx=ctx)
                if only_rubrics is not None:
                    # Rubric-subset reruns are Odysseys-only and splice over the prior
                    # canonical _judge.json. Bail loud if the judge can't do it or there's no
                    # prior to splice into — never silently fall back to a whole-task judge.
                    if not getattr(judge, "supports_rubric_subset", False):
                        logger.error(
                            "rubric subset unsupported for benchmark {} (task {})", benchmark, tid
                        )
                        counts["err"] += 1
                        return
                    if not prior_existed:
                        logger.error(
                            "no prior judge for {} to splice rubrics into; run a whole-task rejudge", tid
                        )
                        counts["err"] += 1
                        return
                    try:
                        prior_payload = json.loads(judge_path.read_text(encoding="utf-8")) or {}
                    except Exception as exc:  # noqa: BLE001
                        logger.error("failed reading prior judge for {}: {}", tid, exc)
                        counts["err"] += 1
                        return
                    # rubric_results / rubric_scores live in payload["metadata"]; judge_sessions
                    # is a top-level field because judge_* keys are excluded from metadata.
                    # Flatten BOTH into one prior so the splice keeps the un-rejudged rubrics'
                    # sessions and cached usage; reading only metadata would drop them.
                    prior_nested = prior_payload.get("metadata") or {}
                    prior = {
                        "rubric_results": prior_nested.get("rubric_results"),
                        "rubric_scores": prior_nested.get("rubric_scores"),
                        "judge_sessions": prior_payload.get("judge_sessions"),
                    }
                    result = await judge.evaluate(ji, only_rubrics=only_rubrics, prior=prior)
                else:
                    result = await judge.evaluate(ji)
            # Persist the channel the judge actually used after overrides or
            # fallbacks. Stage C must reopen the session from this payload rather
            # than stale Stage A run metadata.
            actual_mode = result.metadata.get("judge_mode") or "single"
            result.metadata["judge_mode"] = actual_mode
            result.metadata["judge_tools"] = list(ctx.agent_tools) if actual_mode == "agent" else []
            result.metadata["judge_skill_path"] = ctx.judge_skill_path if actual_mode == "agent" else None
            # A transient targeted rejudge error must not
            # overwrite a usable prior judgement — skip the write, keep the prior, report err.
            # A never-judged whole-task rejudge has no prior to protect → fall through and
            # record the error like the bulk path.
            if targeted and result.error and prior_existed:
                logger.error(
                    "re-judge of {} errored ({}); keeping prior judgement", tid, result.error
                )
                counts["err"] += 1
                return
            _write_judge_payload(judge_path, result, tid)
            if alt_model is None:
                merge_judge_into_record(run_dir, tid, result)
            if result.error:
                counts["err"] += 1
            elif result.verdict:
                counts["ok"] += 1
            else:
                counts["fail"] += 1
        finally:
            # Remove the rubric progress sidecar when this task's judging is over,
            # success, failure, or splice alike — so the live readout must go with it.
            Path(ji.progress_path).unlink(missing_ok=True)
            done_ids.append(tid)

    coros = [_judge_one(rec, only_rubrics=subset) for rec, subset in work]
    try:
        from tqdm import tqdm

        bar = tqdm(total=len(coros), unit="task", file=sys.stderr) if cfg.run.show_progress else None
    except Exception:  # noqa: BLE001
        bar = None
    for coro in asyncio.as_completed(coros):
        await coro
        # Refresh manifest completion fields after each task,
        # atomic rewrite. Runs in the main coroutine (single writer, no concurrent updates).
        if job is not None:
            job["done"] = len(done_ids)
            job["done_ids"] = list(done_ids)
            _write_json_atomic(job_path, job)
        if bar is not None:
            bar.set_postfix(counts)
            bar.update(1)
    if bar is not None:
        bar.close()
    # Judging proper is over — mark the manifest finished (kept on disk for audit) so the
    # WebUI's job readout retires even while summary and export continue.
    if job is not None:
        assert job_started_monotonic is not None
        job["finished_at"] = _now_iso()
        job["duration_s"] = round(time.monotonic() - job_started_monotonic, 3)
        job["finished"] = True
        _write_json_atomic(job_path, job)

    # The adapter builds and injects the browser-tool classifier so the
    # analytics layer (metrics) stays tool-agnostic.
    cmd_classifier = make_cmd_classifier(meta.get("browser_tool") or "")
    summary = write_summary(run_dir, meta, cmd_classifier=cmd_classifier)
    logger.info(
        "Stage B done: ok={} fail={} err={} | success_rate={}",
        counts["ok"], counts["fail"], counts["err"], summary.get("success_rate"),
    )

    # Mirror Stage A auto-export by rendering judge pi sessions to
    # judge_sessions_html/ when auto_export_sessions is on. Best-effort — a failure
    # only warns and never touches the canonical _judge.json / summary.json products.
    if cfg.run.auto_export_sessions:
        try:
            from wiek_bench.report.session_html import export_run_judge_sessions_async

            await export_run_judge_sessions_async(run_dir)
        except Exception as exc:  # noqa: BLE001
            logger.warning("auto-export judge sessions failed: {}", exc)
    # Directed rejudges (--rejudge-task / --rejudge-spec) name their targets: surface any
    # failure as a non-zero exit so a bad rubric selector / failed rejudge is NOT swallowed
    # as success (the CLI exits 0 on the bulk paths even with per-task errs across many
    # tasks — there a single err is normal; for a deliberate directed rejudge an err means
    # that operation did not happen.
    if targeted and counts["err"]:
        label = rejudge_task if rejudge_task is not None else "spec targets"
        logger.error("targeted re-judge of {} did not succeed (err={})", label, counts["err"])
        return 1
    return 0


async def main_async(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Stage B: judge a completed run.")
    parser.add_argument("--run-id", required=True, help="run id or run dir path")
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument("--output-dir", default="runs")
    parser.add_argument("--rejudge-all", action="store_true")
    parser.add_argument("--rejudge-failed", action="store_true")
    # judge-error-only: re-judge ONLY tasks with judge_error (transient RPC failures),
    # not verdict=false negatives.
    parser.add_argument("--rejudge-errors", action="store_true")
    parser.add_argument("--judge-model")
    parser.add_argument(
        "--judge-mode",
        choices=["single", "agent"],
        default=None,
        help="Override judge execution mode (defaults to config judge.mode)",
    )
    # A single-task targeted rejudge overwrites canonical _judge.json for one
    # task. --rejudge-rubrics narrows to a rubric subset (odysseys-only).
    parser.add_argument(
        "--rejudge-task",
        help="Re-judge one task id and overwrite its canonical _judge.json",
    )
    parser.add_argument(
        "--rejudge-rubrics",
        help="With --rejudge-task, re-judge comma-separated Odysseys rubric ids only",
    )
    # Batch-by-id re-judge selects exactly these
    # task ids (whole-task, overwrite canonical). Subset variant of --rejudge-all.
    parser.add_argument(
        "--rejudge-task-ids",
        help="Re-judge comma-separated composite task ids and overwrite canonical artifacts",
    )
    # Multi-target directed re-judge accepts a JSON file of
    # [{task_id, rubric_ids?}] entries — whole task when rubric_ids is absent/empty, rubric
    # subset splice otherwise (odysseys-only). Always overwrites canonical.
    parser.add_argument(
        "--rejudge-spec",
        help="JSON path containing [{task_id, rubric_ids?}, ...]; always writes canonical artifacts",
    )
    args = parser.parse_args(argv)
    rejudge_rubrics: list[str] | None = None
    if args.rejudge_rubrics:
        if not args.rejudge_task:
            parser.error("--rejudge-rubrics requires --rejudge-task")
        rejudge_rubrics = [s.strip() for s in args.rejudge_rubrics.split(",") if s.strip()]
    rejudge_task_ids: list[str] | None = None
    if args.rejudge_task_ids:
        rejudge_task_ids = [s.strip() for s in args.rejudge_task_ids.split(",") if s.strip()]
    rejudge_spec: list[dict[str, Any]] | None = None
    if args.rejudge_spec:
        # Parse and validate up front; an unreadable or empty directed spec
        # be read or names no tasks is an operator error, never a silent no-op.
        try:
            raw = json.loads(Path(args.rejudge_spec).read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            parser.error(f"--rejudge-spec unreadable: {exc}")
        if (
            not isinstance(raw, list)
            or not raw
            or not all(
                isinstance(e, dict)
                and str(e.get("task_id") or "").strip()
                and isinstance(e.get("rubric_ids") or [], list)
                for e in raw
            )
        ):
            parser.error("--rejudge-spec must be a non-empty JSON list of {task_id, rubric_ids?}")
        rejudge_spec = raw
    if args.rejudge_task and (args.rejudge_all or args.rejudge_failed or args.rejudge_errors):
        parser.error(
            "--rejudge-task is exclusive with --rejudge-all/--rejudge-failed/--rejudge-errors"
        )
    # --rejudge-task-ids is its own bulk selector — exclusive with every other selector.
    if rejudge_task_ids is not None and (
        args.rejudge_all or args.rejudge_failed or args.rejudge_errors or args.rejudge_task
    ):
        parser.error(
            "--rejudge-task-ids is exclusive with "
            "--rejudge-all/--rejudge-failed/--rejudge-errors/--rejudge-task"
        )
    # --rejudge-spec is exclusive with every other selector.
    if rejudge_spec is not None and (
        args.rejudge_all
        or args.rejudge_failed
        or args.rejudge_errors
        or args.rejudge_task
        or rejudge_task_ids is not None
    ):
        parser.error("--rejudge-spec is exclusive with every other re-judge selector")
    cfg = load_config(args.config)
    if args.judge_mode:
        cfg.judge.mode = args.judge_mode
    run_dir = resolve_run_dir(args.run_id, args.output_dir)
    return await judge_run(
        run_dir,
        cfg,
        rejudge_all=args.rejudge_all,
        rejudge_failed=args.rejudge_failed,
        rejudge_errors=args.rejudge_errors,
        rejudge_task_ids=rejudge_task_ids,
        judge_model=args.judge_model,
        rejudge_task=args.rejudge_task,
        rejudge_rubrics=rejudge_rubrics,
        rejudge_spec=rejudge_spec,
    )


def main() -> int:
    load_dotenv()
    return asyncio.run(main_async())


if __name__ == "__main__":
    raise SystemExit(main())
