#!/usr/bin/env python3
"""Project-parser summary for one or more Codex rollout JSONL files."""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _codex_session_lib import (  # noqa: E402
    classify_error,
    iter_tool_pairs,
    read_session_header,
    terminal_events,
    to_jsonl,
)
from _project import (  # noqa: E402
    ensure_codex_rollout,
    load_run_metadata,
    parse_stats,
    resolve_run,
)


def summarize(
    path: Path,
    *,
    pricing_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    ensure_codex_rollout(path)
    stats = parse_stats(path, pricing_snapshot=pricing_snapshot)
    header = read_session_header(path)
    buckets: Counter[str] = Counter()
    missing_calls = 0
    embedded_errors = 0
    for pair in iter_tool_pairs(path):
        if pair["is_error"] or pair["embedded_error"]:
            buckets[str(pair["error_bucket"] or "other")] += 1
        if pair["embedded_error"]:
            embedded_errors += 1
        if pair["is_error"] is None:
            missing_calls += 1
    terminals = terminal_events(path)
    for event in terminals:
        if event["type"] in {"error", "turn_aborted"}:
            buckets[classify_error(str(event.get("message") or event["type"]))] += 1
    return {
        "path": str(path),
        "format": "codex_rollout",
        "session_id": stats.session_id,
        "cwd": stats.cwd,
        "model": stats.model,
        "cli_version": header.get("cli_version"),
        "originator": header.get("originator"),
        "duration_s": stats.duration_s,
        "think_time_s": stats.think_time_s,
        "llm_time_s": stats.llm_time_s,
        "env_time_s": stats.env_time_s,
        "time_to_first_token_s": stats.time_to_first_token_s,
        "num_turns": stats.num_turns,
        "tool_calls": stats.tool_calls,
        "tool_failures": stats.tool_failures,
        "embedded_output_errors": embedded_errors,
        "missing_tool_outputs": missing_calls,
        "tool_call_dist": dict(stats.tool_call_dist),
        "bash_cmd_dist": dict(stats.bash_cmd_dist),
        "error_buckets": dict(buckets),
        "stop_reason_error": stats.stop_reason_error,
        "terminal_events": terminals,
        "parse_error": stats.parse_error,
        "warnings": list(stats.warnings),
        "final_output_present": bool(stats.final_output.strip()),
        "input_tokens": stats.input_tokens,
        "output_tokens": stats.output_tokens,
        "cache_read_tokens": stats.cache_read_tokens,
        "cache_creation_tokens": stats.cache_creation_tokens,
        "total_tokens": stats.input_tokens + stats.output_tokens,
        "reasoning_tokens": stats.reasoning_tokens,
        "reasoning_tokens_is_estimate": stats.reasoning_tokens_is_estimate,
        "cost_usd": None if stats.cost_usd is None else round(stats.cost_usd, 6),
        "cost_is_estimate": stats.cost_is_estimate,
        "cost_source": stats.cost_source,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sessions", nargs="+", type=Path)
    parser.add_argument("--run", help="Codex run dir/id, used for pricing snapshot")
    args = parser.parse_args(argv)
    pricing = None
    if args.run:
        try:
            pricing = load_run_metadata(resolve_run(args.run)).get("codex_pricing")
        except FileNotFoundError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
    status = 0
    for path in args.sessions:
        if not path.is_file():
            print(f"error: file not found: {path}", file=sys.stderr)
            status = 2
            continue
        try:
            print(to_jsonl(summarize(path, pricing_snapshot=pricing)))
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            status = 2
    return status


if __name__ == "__main__":
    raise SystemExit(main())
