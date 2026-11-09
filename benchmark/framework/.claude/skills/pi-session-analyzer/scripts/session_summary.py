#!/usr/bin/env python3
"""Emit one JSON summary per session using the project ``session_parser``.

Metrics include timing components, stop errors, parser warnings, turns, tools,
tokens, and cost.

Usage:
  session_summary.py <session.jsonl> [<session.jsonl> ...]
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pi_session_lib import (  # noqa: E402
    classify_error,
    iter_tool_pairs,
    to_jsonl,
)
from _project import parse_stats  # noqa: E402


def summarize(
    path: Path,
    *,
    pricing_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    stats = parse_stats(path, pricing_snapshot=pricing_snapshot)
    err_bucket: Counter[str] = Counter()

    for p in iter_tool_pairs(path):
        if p["is_error"]:
            if p["error_bucket"]:
                err_bucket[p["error_bucket"]] += 1
    if stats.stop_reason_error:
        err_bucket[classify_error(stats.stop_reason_error)] += 1

    return {
        "path": str(path),
        "session_id": stats.session_id,
        "cwd": stats.cwd,
        "model": stats.model,
        "duration_s": stats.duration_s,
        "think_time_s": stats.think_time_s,
        "llm_time_s": stats.llm_time_s,
        "env_time_s": stats.env_time_s,
        "time_to_first_token_s": stats.time_to_first_token_s,
        "num_turns": stats.num_turns,
        "tool_calls": stats.tool_calls,
        "tool_failures": stats.tool_failures,
        "tool_call_dist": dict(stats.tool_call_dist),
        "bash_cmd_dist": dict(stats.bash_cmd_dist),
        "error_buckets": dict(err_bucket),
        "stop_reason_error": stats.stop_reason_error,
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
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("sessions", nargs="+", type=Path)
    args = ap.parse_args(argv)

    rc = 0
    for p in args.sessions:
        if not p.is_file():
            print(f"error: file not found: {p}", file=sys.stderr)
            rc = 2
            continue
        print(to_jsonl(summarize(p)))
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
