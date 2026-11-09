#!/usr/bin/env python3
"""Analyze one Codex run: aggregate metrics, focus tasks, attempts, errors, retries."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _codex_session_lib import json_default  # noqa: E402
from _project import (  # noqa: E402
    latest_by_task_id,
    read_task_attempt_records,
    require_codex_run,
    resolve_run,
)
from extract_errors import collect_errors  # noqa: E402
from retry_clusters import find_retry_clusters  # noqa: E402
from session_summary import summarize  # noqa: E402


def _task_summary(record: dict[str, Any], pricing: dict[str, Any] | None) -> dict[str, Any]:
    session_file = record.get("session_file")
    if not isinstance(session_file, str) or not session_file:
        return {"path": session_file, "duration_s": None, "parse_error": "no session_file"}
    path = Path(session_file)
    if not path.is_file():
        return {"path": session_file, "duration_s": None, "parse_error": "session file does not exist"}
    try:
        return summarize(path, pricing_snapshot=pricing)
    except ValueError as exc:
        return {"path": session_file, "duration_s": None, "parse_error": str(exc)}


def _focus_key(item: dict[str, Any]) -> tuple[int, int, int, int, float]:
    record = item["record"]
    summary = item["summary"]
    return (
        int(bool(record.get("error"))),
        int(record.get("verdict") is False),
        int(int(record.get("attempt_count") or 1) > 1),
        int(summary.get("tool_failures") or 0)
        + int(summary.get("embedded_output_errors") or 0),
        float(summary.get("duration_s") or 0.0),
    )


def _attempt_payload(
    attempt: dict[str, Any], pricing: dict[str, Any] | None
) -> dict[str, Any]:
    session_file = attempt.get("session_file")
    path = Path(session_file) if isinstance(session_file, str) else None
    summary = _task_summary({"session_file": session_file}, pricing)
    errors = collect_errors(path) if path and path.is_file() else []
    return {
        **attempt,
        "session": summary,
        "errors": [
            {
                "error_type": row["error_type"],
                "source_line": row["source_line"],
                "error_bucket": row["error_bucket"],
                "error_text": str(row["error_text"])[:500],
            }
            for row in errors
        ],
    }


def build_run_analysis(
    run_dir: Path,
    *,
    task_ids: list[str] | None = None,
    top: int = 5,
) -> dict[str, Any]:
    metadata = require_codex_run(run_dir)
    pricing = metadata.get("codex_pricing")
    records = latest_by_task_id(run_dir)
    items = [
        {"task_id": task_id, "record": record, "summary": _task_summary(record, pricing)}
        for task_id, record in records.items()
    ]
    if task_ids:
        missing = [task_id for task_id in task_ids if task_id not in records]
        if missing:
            raise ValueError(f"task_id not found in run: {', '.join(missing)}")
        wanted = set(task_ids)
        selected = [item for item in items if item["task_id"] in wanted]
    else:
        selected = sorted(items, key=_focus_key, reverse=True)[:top]
    warnings: list[str] = []
    details: list[dict[str, Any]] = []
    for item in selected:
        task_id = item["task_id"]
        record = item["record"]
        session_file = record.get("session_file")
        path = Path(session_file) if isinstance(session_file, str) else None
        attempts = read_task_attempt_records(run_dir, task_id)
        attempt_count = int(record.get("attempt_count") or 1)
        if attempt_count > 1 and not attempts:
            warnings.append(
                f"{task_id}: attempt_count={attempt_count}, but no attempts artifact "
                "(legacy run; earlier sessions cannot be linked reliably)"
            )
        if attempts and len(attempts) != attempt_count:
            warnings.append(
                f"{task_id}: attempts artifact has {len(attempts)} rows, "
                f"tasks.jsonl attempt_count={attempt_count}"
            )
        errors = collect_errors(path) if path and path.is_file() else []
        clusters = find_retry_clusters(path) if path and path.is_file() else []
        details.append(
            {
                "task_id": task_id,
                "base_task_id": record.get("base_task_id"),
                "iteration_index": record.get("iteration_index"),
                "attempt_count": attempt_count,
                "runtime_error": record.get("error"),
                "verdict": record.get("verdict"),
                "score": record.get("score"),
                "judge_reasoning": record.get("judge_reasoning"),
                "session": item["summary"],
                "attempts": [_attempt_payload(attempt, pricing) for attempt in attempts],
                "errors": [
                    {
                        "error_type": row["error_type"],
                        "source_line": row["source_line"],
                        "call_line": row["call_line"],
                        "turn": row["call_turn_index"],
                        "tool_name": row["tool_name"],
                        "error_bucket": row["error_bucket"],
                        "duration_s": row["latency_s"],
                        "duration_source": row["duration_source"],
                        "error_text": str(row["error_text"])[:500],
                    }
                    for row in errors
                ],
                "retry_clusters": clusters,
            }
        )
    parsed = [item["summary"] for item in items if item["summary"].get("duration_s") is not None]
    costs = [float(row["cost_usd"]) for row in parsed if row.get("cost_usd") is not None]
    return {
        "run_dir": str(run_dir),
        "run_id": metadata.get("run_id") or run_dir.name,
        "provider": "codex",
        "model": metadata.get("model"),
        "task_count": len(items),
        "aggregate": {
            "duration_total_s": round(sum(float(row["duration_s"]) for row in parsed), 3),
            "duration_avg_s": (
                round(sum(float(row["duration_s"]) for row in parsed) / len(parsed), 3)
                if parsed
                else None
            ),
            "llm_time_total_s": round(sum(float(row.get("llm_time_s") or 0.0) for row in parsed), 3),
            "env_time_total_s": round(sum(float(row.get("env_time_s") or 0.0) for row in parsed), 3),
            "turns": sum(int(row.get("num_turns") or 0) for row in parsed),
            "tool_calls": sum(int(row.get("tool_calls") or 0) for row in parsed),
            "tool_failures": sum(int(row.get("tool_failures") or 0) for row in parsed),
            "embedded_output_errors": sum(
                int(row.get("embedded_output_errors") or 0) for row in parsed
            ),
            "input_tokens": sum(int(row.get("input_tokens") or 0) for row in parsed),
            "output_tokens": sum(int(row.get("output_tokens") or 0) for row in parsed),
            "reasoning_tokens": sum(int(row.get("reasoning_tokens") or 0) for row in parsed),
            "cost_usd": round(sum(costs), 6) if costs else None,
            "runtime_errors": sum(bool(item["record"].get("error")) for item in items),
            "verdict_failures": sum(item["record"].get("verdict") is False for item in items),
            "retried_tasks": sum(int(item["record"].get("attempt_count") or 1) > 1 for item in items),
        },
        "selected": details,
        "warnings": warnings,
    }


def render(analysis: dict[str, Any]) -> str:
    aggregate = analysis["aggregate"]
    lines = [
        f"run: {analysis['run_id']}",
        (
            f"provider=codex model={analysis['model']} tasks={analysis['task_count']} "
            f"duration={aggregate['duration_total_s']}s turns={aggregate['turns']} "
            f"tools={aggregate['tool_calls']} failures={aggregate['tool_failures']} "
            f"embedded={aggregate['embedded_output_errors']} "
            f"cost={aggregate['cost_usd']}"
        ),
        "",
        "selected tasks:",
    ]
    for task in analysis["selected"]:
        session = task["session"]
        lines.append(
            f"  {task['task_id']} duration={session.get('duration_s')} "
            f"llm={session.get('llm_time_s')} env={session.get('env_time_s')} "
            f"turns={session.get('num_turns')} tools={session.get('tool_calls')} "
            f"failures={session.get('tool_failures')} "
            f"embedded={session.get('embedded_output_errors')} "
            f"attempts={task['attempt_count']} "
            f"verdict={task['verdict']}"
        )
        for error in task["errors"]:
            lines.append(
                f"    error line={error['source_line']} type={error['error_type']} "
                f"bucket={error['error_bucket']}: {error['error_text']}"
            )
        for cluster in task["retry_clusters"]:
            evidence = ", ".join(
                f"line {call['call_line']} fp={call['fingerprint']}"
                for call in cluster["calls"]
            )
            lines.append(
                f"    retry cluster {cluster['cluster']} {cluster['tool_name']} "
                f"x{cluster['count']}: {evidence}"
            )
        for attempt in task["attempts"]:
            lines.append(
                f"    attempt {attempt.get('attempt_index')} "
                f"failure={attempt.get('failure_reason')} "
                f"duration={attempt['session'].get('duration_s')} "
                f"session={attempt.get('session_file')}"
            )
    if analysis["warnings"]:
        lines += ["", "warnings:"] + [f"  - {warning}" for warning in analysis["warnings"]]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run")
    parser.add_argument("--task-id", action="append")
    parser.add_argument("--top", type=int, default=5)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if args.top < 1:
        print("error: --top must be >= 1", file=sys.stderr)
        return 2
    try:
        analysis = build_run_analysis(
            resolve_run(args.run), task_ids=args.task_id, top=args.top
        )
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(
        json.dumps(analysis, ensure_ascii=False, indent=2, default=json_default)
        if args.json
        else render(analysis)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
