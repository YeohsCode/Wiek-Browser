#!/usr/bin/env python3
"""Analyze one run, including samples, slow tasks, attempts, and error evidence."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _project import HARNESS_ROOT, latest_by_task_id, read_task_attempt_records  # noqa: E402
from extract_errors import collect_errors  # noqa: E402
from retry_clusters import find_retry_clusters  # noqa: E402
from session_summary import summarize  # noqa: E402


def resolve_run(spec: str) -> Path:
    literal = Path(spec)
    if literal.is_dir():
        return literal.resolve()
    candidate = HARNESS_ROOT / "runs" / spec
    if candidate.is_dir():
        return candidate.resolve()
    raise FileNotFoundError(f"run directory not found: {spec}")


def _metadata(run_dir: Path) -> dict[str, Any]:
    path = run_dir / "run_metadata.json"
    if not path.is_file():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, dict) else {}


def _task_summary(record: dict[str, Any], pricing: dict[str, Any] | None) -> dict[str, Any]:
    session_file = record.get("session_file")
    if not isinstance(session_file, str) or not session_file:
        return {
            "path": session_file,
            "duration_s": None,
            "tool_failures": 0,
            "parse_error": "no session_file",
        }
    session_path = Path(session_file)
    if not session_path.is_file():
        return {
            "path": session_file,
            "duration_s": None,
            "tool_failures": 0,
            "parse_error": "session file does not exist",
        }
    return summarize(session_path, pricing_snapshot=pricing)


def _attempt_details(
    attempt: dict[str, Any], pricing: dict[str, Any] | None
) -> dict[str, Any]:
    session = _task_summary({"session_file": attempt.get("session_file")}, pricing)
    session_file = attempt.get("session_file")
    session_path = Path(session_file) if isinstance(session_file, str) else None
    errors = collect_errors(session_path) if session_path and session_path.is_file() else []
    return {
        **attempt,
        "session": session,
        "errors": [
            {
                "error_type": error["error_type"],
                "source_line": error["source_line"],
                "error_bucket": error["error_bucket"],
                "error_text": str(error["error_text"])[:500],
            }
            for error in errors
        ],
    }


def _focus_key(item: dict[str, Any]) -> tuple[int, int, int, int, float]:
    record = item["record"]
    summary = item["summary"]
    return (
        int(bool(record.get("error"))),
        int(record.get("verdict") is False),
        int(int(record.get("attempt_count") or 1) > 1),
        int(summary.get("tool_failures") or 0),
        float(summary.get("duration_s") or 0.0),
    )


def build_run_analysis(
    run_dir: Path,
    *,
    task_ids: list[str] | None = None,
    top: int = 5,
) -> dict[str, Any]:
    metadata = _metadata(run_dir)
    pricing = metadata.get("codex_pricing")
    records = latest_by_task_id(run_dir)
    items: list[dict[str, Any]] = []
    for task_id, record in records.items():
        items.append(
            {
                "task_id": task_id,
                "record": record,
                "summary": _task_summary(record, pricing),
            }
        )

    warnings: list[str] = []
    if task_ids:
        missing = [task_id for task_id in task_ids if task_id not in records]
        if missing:
            raise ValueError(f"task_id not found in run: {', '.join(missing)}")
        selected = [item for item in items if item["task_id"] in set(task_ids)]
    else:
        selected = sorted(items, key=_focus_key, reverse=True)[:top]

    selected_payload: list[dict[str, Any]] = []
    for item in selected:
        task_id = item["task_id"]
        record = item["record"]
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
                f"but tasks.jsonl attempt_count={attempt_count}"
            )
        session_file = record.get("session_file")
        session_path = Path(session_file) if isinstance(session_file, str) else None
        errors = collect_errors(session_path) if session_path and session_path.is_file() else []
        clusters = (
            find_retry_clusters(session_path) if session_path and session_path.is_file() else []
        )
        selected_payload.append(
            {
                "task_id": task_id,
                "base_task_id": record.get("base_task_id"),
                "iteration_index": record.get("iteration_index"),
                "attempt_count": attempt_count,
                "error": record.get("error"),
                "verdict": record.get("verdict"),
                "score": record.get("score"),
                "session": item["summary"],
                "attempts": [_attempt_details(attempt, pricing) for attempt in attempts],
                "errors": [
                    {
                        "error_type": error["error_type"],
                        "source_line": error["source_line"],
                        "call_line": error["call_line"],
                        "call_turn_index": error["call_turn_index"],
                        "tool_name": error["tool_name"],
                        "error_bucket": error["error_bucket"],
                        "latency_s": error["latency_s"],
                        "error_text": str(error["error_text"])[:500],
                    }
                    for error in errors
                ],
                "retry_clusters": clusters,
            }
        )

    durations = [
        float(item["summary"]["duration_s"])
        for item in items
        if item["summary"].get("duration_s") is not None
    ]
    return {
        "run_dir": str(run_dir),
        "run_id": metadata.get("run_id") or run_dir.name,
        "task_count": len(items),
        "aggregate": {
            "duration_total_s": round(sum(durations), 3),
            "duration_avg_s": round(sum(durations) / len(durations), 3) if durations else None,
            "turns": sum(int(item["summary"].get("num_turns") or 0) for item in items),
            "tool_calls": sum(int(item["summary"].get("tool_calls") or 0) for item in items),
            "tool_failures": sum(
                int(item["summary"].get("tool_failures") or 0) for item in items
            ),
            "task_errors": sum(bool(item["record"].get("error")) for item in items),
            "verdict_failures": sum(item["record"].get("verdict") is False for item in items),
            "retried_tasks": sum(
                int(item["record"].get("attempt_count") or 1) > 1 for item in items
            ),
        },
        "selected": selected_payload,
        "warnings": warnings,
    }


def render(analysis: dict[str, Any]) -> str:
    aggregate = analysis["aggregate"]
    lines = [
        f"run: {analysis['run_id']}",
        (
            f"tasks={analysis['task_count']} duration={aggregate['duration_total_s']}s "
            f"turns={aggregate['turns']} tools={aggregate['tool_calls']} "
            f"tool_failures={aggregate['tool_failures']} retries={aggregate['retried_tasks']}"
        ),
        "",
        "selected tasks:",
    ]
    for task in analysis["selected"]:
        session = task["session"]
        lines.append(
            f"  {task['task_id']} duration={session.get('duration_s')} "
            f"turns={session.get('num_turns')} tools={session.get('tool_calls')} "
            f"failures={session.get('tool_failures')} attempts={task['attempt_count']} "
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
        if task["attempts"]:
            for attempt in task["attempts"]:
                attempt_session = attempt["session"]
                lines.append(
                    f"    attempt {attempt.get('attempt_index')} "
                    f"failure={attempt.get('failure_reason')} "
                    f"duration={attempt_session.get('duration_s')} "
                    f"stop={attempt_session.get('stop_reason_error')} "
                    f"session={attempt.get('session_file')}"
                )
                for error in attempt["errors"]:
                    lines.append(
                        f"      error line={error['source_line']} "
                        f"bucket={error['error_bucket']}: {error['error_text']}"
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
            resolve_run(args.run),
            task_ids=args.task_id,
            top=args.top,
        )
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(analysis, ensure_ascii=False, indent=2) if args.json else render(analysis))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
