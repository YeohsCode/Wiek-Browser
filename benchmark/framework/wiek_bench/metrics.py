"""Derived-metric aggregation. Everything is computed here from the session SOT.

``BashAction`` / ``bash_actions_from_session`` are re-exported from session_parser
for backward-compatible imports.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Iterable

from loguru import logger

from wiek_bench.captcha import is_blocked
from wiek_bench.results import latest_by_task_id
from wiek_bench.session_parser import (
    BashAction,
    SessionStats,
    bash_actions_from_session,
    safe_parse,
)

__all__ = [
    "BashAction",
    "bash_actions_from_session",
    "aggregate_sessions",
    "aggregate_summary",
    "judge_job_wall_clock_s",
    "judge_payload_timing",
    "write_summary",
]

Classifier = Callable[[str], str | None]


def aggregate_sessions(
    stats: Iterable[SessionStats], *, classifier: Classifier | None = None
) -> dict[str, Any]:
    """Pure fold over SessionStats (no I/O, no browser_tools)."""
    total_duration = 0.0
    costs: list[float] = []
    cost_is_estimate = False
    cost_sources: set[str] = set()
    in_tok = out_tok = cache_r = cache_w = 0
    tool_calls = tool_failures = 0
    tool_dist: dict[str, int] = {}
    bash_dist: dict[str, int] = {}
    count = 0
    for s in stats:
        count += 1
        total_duration += s.duration_s or 0.0
        if s.cost_usd is not None:
            costs.append(s.cost_usd)
            cost_is_estimate = cost_is_estimate or s.cost_is_estimate
            if s.cost_source:
                cost_sources.add(s.cost_source)
        in_tok += s.input_tokens
        out_tok += s.output_tokens
        cache_r += s.cache_read_tokens
        cache_w += s.cache_creation_tokens
        tool_calls += s.tool_calls
        tool_failures += s.tool_failures
        for k, v in s.tool_call_dist.items():
            tool_dist[k] = tool_dist.get(k, 0) + v
        for k, v in s.bash_cmd_dist.items():
            bash_dist[k] = bash_dist.get(k, 0) + v
    return {
        "session_count": count,
        "total_duration_s": round(total_duration, 3),
        "avg_duration_s": round(total_duration / count, 3) if count else 0.0,
        "total_cost_usd": round(sum(costs), 6) if costs else None,
        "avg_cost_usd": round(sum(costs) / len(costs), 6) if costs else None,
        "cost_sample_count": len(costs),
        "cost_is_estimate": cost_is_estimate,
        "cost_sources": sorted(cost_sources),
        "total_input_tokens": in_tok,
        "total_output_tokens": out_tok,
        "total_cache_read_tokens": cache_r,
        "total_cache_creation_tokens": cache_w,
        "total_tokens": in_tok + out_tok,
        "tool_calls": tool_calls,
        "tool_failures": tool_failures,
        "tool_call_dist": tool_dist,
        "bash_cmd_dist": bash_dist,
    }


def _browser_cmd_dist(
    records: list[dict[str, Any]], classifier: Classifier | None
) -> dict[str, int]:
    """Fold per-session bash commands into a subcommand-key distribution.

    Browser-tool knowledge is injected as ``classifier`` so this
    module never imports ``browser_tools``. ``None`` classifier → empty dist.
    """
    if classifier is None:
        return {}
    dist: dict[str, int] = {}
    for rec in records:
        sf = rec.get("session_file")
        if not sf:
            continue
        for action in bash_actions_from_session(sf):
            key = classifier(action.command)
            if key:
                dist[key] = dist.get(key, 0) + 1
    return dist


def judge_payload_timing(payload: dict[str, Any]) -> tuple[float | None, int]:
    """Return cumulative judge-session duration and its timed rubric count.

    Per-rubric judges persist one ``judge_sessions`` entry per rubric. Binary and
    multi-stage task-level judges have no rubric denominator, so they contribute no
    value to the rubric-average metric even when their task duration is available.
    """
    raw_duration = payload.get("judge_duration_s")
    sessions = payload.get("judge_sessions")
    if raw_duration is None or not isinstance(sessions, list) or not sessions:
        return None, 0
    try:
        return float(raw_duration), len(sessions)
    except (TypeError, ValueError):
        return None, 0


def judge_job_wall_clock_s(run_dir: str | Path) -> float | None:
    """Read the latest completed judge job's elapsed wall time from its manifest."""
    path = Path(run_dir) / "judges" / "_job.json"
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("finished") is not True or payload.get("duration_s") is None:
            return None
        return float(payload["duration_s"])
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return None


def _judge_accounting(run_dir: Path) -> tuple[float, int, float | None, int]:
    judges_dir = run_dir / "judges"
    cost = 0.0
    tokens = 0
    total_duration = 0.0
    timed_rubrics = 0
    if not judges_dir.exists():
        return cost, tokens, None, timed_rubrics
    for jf in judges_dir.glob("*_judge.json"):
        try:
            data = json.loads(jf.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        cost += float(data.get("judge_cost_usd", 0.0) or 0.0)
        tokens += int(data.get("judge_input_tokens", 0) or 0)
        tokens += int(data.get("judge_output_tokens", 0) or 0)
        duration, rubric_count = judge_payload_timing(data)
        if duration is not None:
            total_duration += duration
            timed_rubrics += rubric_count
    return (
        round(cost, 6),
        tokens,
        round(total_duration, 3) if timed_rubrics else None,
        timed_rubrics,
    )


def aggregate_summary(
    run_dir: str | Path,
    run_metadata: dict[str, Any],
    *,
    cmd_classifier: Classifier | None = None,
) -> dict[str, Any]:
    run_dir = Path(run_dir)
    records = list(latest_by_task_id(run_dir).values())

    stats_list: list[SessionStats] = []
    parse_errors: list[str] = []
    success_by_cat: dict[str, dict[str, int]] = {}
    completed = judged = success = 0
    provider_errors = timeouts = transport_failures = captcha = impossible = judge_errors = 0
    captcha_blocked = 0
    scores: list[float] = []

    for rec in records:
        sf = rec.get("session_file")
        stats = (
            safe_parse(sf, pricing_snapshot=run_metadata.get("codex_pricing"))
            if sf
            else SessionStats()
        )
        if stats.parse_error and sf:
            parse_errors.append(str(rec.get("task_id")))
        stats_list.append(stats)

        err = rec.get("error")
        if not err:
            completed += 1
        else:
            provider_errors += 1
            err_s = str(err)
            # timeout_count / transport_failure_count are disjoint subsets of
            # provider_error_count. Match the structured
            # provider_transport_failure: prefix FIRST — a transport failure whose
            # detail text mentions "timeout" must not leak into timeout_count via the
            # loose substring check (process timeouts are "task timeout after Ns",
            # which carry no such prefix).
            if err_s.startswith("provider_transport_failure:"):
                transport_failures += 1
            elif "timeout" in err_s.lower():
                timeouts += 1
        # Orthogonal to the error counts above, never a subset of them: an intercepted
        # task ran cleanly (so it counts as completed) and simply never reached a verdict.
        if is_blocked(rec):
            captcha_blocked += 1
        if rec.get("verdict") is not None or rec.get("judge_error"):
            judged += 1
        # Success iff verdict is true: with partial credit a score in (0,1)
        # must not count as success — verdict carries the perfect/pass semantics.
        is_success = bool(rec.get("verdict"))
        if is_success:
            success += 1
        # judge_error rows carry score=null (set in merge_judge_into_record), so
        # this naturally excludes undetermined tasks from average_score.
        if rec.get("score") is not None:
            scores.append(float(rec["score"]))
        if rec.get("reached_captcha"):
            captcha += 1
        if rec.get("impossible_task"):
            impossible += 1
        if rec.get("judge_error"):
            judge_errors += 1

        cat = rec.get("category") or "unknown"
        bucket = success_by_cat.setdefault(str(cat), {"total": 0, "success": 0})
        bucket["total"] += 1
        if is_success:
            bucket["success"] += 1

    folded = aggregate_sessions(stats_list)
    schema_warnings, zero_metric_warning = _schema_health(stats_list)
    judge_cost, judge_tokens, judge_duration, judge_rubric_count = _judge_accounting(run_dir)
    judge_avg_duration = (
        round(judge_duration / judge_rubric_count, 3)
        if judge_duration is not None and judge_rubric_count
        else None
    )
    total = len(records)

    summary: dict[str, Any] = {
        "run_id": run_metadata.get("run_id"),
        "benchmark": run_metadata.get("benchmark"),
        "provider": run_metadata.get("provider") or run_metadata.get("pi_provider"),
        "model_provider": run_metadata.get("model_provider") or run_metadata.get("pi_provider"),
        "model": run_metadata.get("model"),
        "browser_tool": run_metadata.get("browser_tool"),
        "skill_name": run_metadata.get("skill_name"),
        "total_tasks": total,
        "completed_tasks": completed,
        "judged_tasks": judged,
        "success_tasks": success,
        "success_rate": round(success / total, 4) if total else 0.0,
        # mean score over tasks that produced one (judge_error excluded — those
        # rows carry score=null): ≈ judged success rate for binary judges,
        # dataset-level average rubric score for Odysseys.
        "average_score": round(sum(scores) / len(scores), 4) if scores else 0.0,
        "success_rate_by_category": {
            k: round(v["success"] / v["total"], 4) if v["total"] else 0.0
            for k, v in sorted(success_by_cat.items())
        },
        "provider_error_count": provider_errors,
        "timeout_count": timeouts,
        "transport_failure_count": transport_failures,
        # Agent self-reported anti-bot walls, intercepted in Stage A and never judged.
        # These tasks DO count in success_rate's denominator (a wall means the result was
        # not delivered), so subtract this to read a wall-free rate. Independent of
        # provider_error_count; distinct from captcha_count, a judge OUTPUT flag on
        # trajectories that were judged.
        "captcha_blocked_count": captcha_blocked,
        "captcha_count": captcha,
        "impossible_count": impossible,
        "judge_error_count": judge_errors,
        "judge_provider": run_metadata.get("judge_provider", "pi"),
        "judge_model": run_metadata.get("judge_model"),
        "judge_total_cost_usd": judge_cost,
        "judge_total_tokens": judge_tokens,
        "judge_total_duration_s": judge_duration,
        "judge_avg_duration_per_rubric_s": judge_avg_duration,
        "judge_rubric_count": judge_rubric_count,
        "judge_wall_clock_s": judge_job_wall_clock_s(run_dir),
        "browser_tool_cmd_dist": _browser_cmd_dist(records, cmd_classifier),
        "session_parse_errors": parse_errors,
        "session_schema_warnings": schema_warnings,
        "zero_metric_warning": zero_metric_warning,
        "concurrency": run_metadata.get("concurrency"),
        "wall_clock_total_s": run_metadata.get("wall_clock_total_s"),
    }
    summary.update(folded)
    return summary


def _schema_health(stats_list: list[SessionStats]) -> tuple[dict[str, int], str | None]:
    """Surface session-schema drift instead of silently
    producing all-zero metrics.

    - Aggregates ``SessionStats.warnings`` (e.g. unexpected session version) so the
      otherwise-unread warnings become auditable in summary.json.
    - Run-level zero-metrics sentinel: if every non-empty session (num_turns>0)
      recorded zero tool calls, a pi field rename most likely broke parsing — emit a
      loud warning rather than letting each session quietly fold to zero.
    """
    schema_warnings: dict[str, int] = {}
    for s in stats_list:
        for w in s.warnings:
            schema_warnings[w] = schema_warnings.get(w, 0) + 1
    if schema_warnings:
        logger.warning("session schema warnings across run: {}", schema_warnings)

    nonempty = [s for s in stats_list if s.num_turns > 0]
    zero_metric_warning: str | None = None
    if nonempty and all(s.tool_calls == 0 for s in nonempty):
        zero_metric_warning = (
            f"all {len(nonempty)} non-empty sessions recorded tool_calls==0 — "
            "likely session schema drift (verify session_parser against provider JSONL)"
        )
        logger.warning("zero-metrics sentinel: {}", zero_metric_warning)
    return schema_warnings, zero_metric_warning


def write_summary(
    run_dir: str | Path,
    run_metadata: dict[str, Any],
    *,
    cmd_classifier: Classifier | None = None,
) -> dict[str, Any]:
    run_dir = Path(run_dir)
    summary = aggregate_summary(run_dir, run_metadata, cmd_classifier=cmd_classifier)
    (run_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return summary
