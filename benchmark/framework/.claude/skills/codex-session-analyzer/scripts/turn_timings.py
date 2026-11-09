#!/usr/bin/env python3
"""Show per-turn wall/LLM/env timing for a Codex rollout."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _codex_session_lib import (  # noqa: E402
    iter_entries_with_lines,
    iter_tool_pairs,
    iter_turns,
    parse_iso,
    to_jsonl,
)
from _project import ensure_codex_rollout, parse_stats  # noqa: E402


def _task_start(path: Path) -> tuple[int | None, Any]:
    fallback_line = None
    fallback_ts = None
    for line_number, entry in iter_entries_with_lines(path):
        timestamp = parse_iso(entry.get("timestamp"))
        if fallback_ts is None and timestamp is not None:
            fallback_line, fallback_ts = line_number, timestamp
        payload = entry.get("payload")
        if (
            entry.get("type") == "event_msg"
            and isinstance(payload, dict)
            and payload.get("type") == "task_started"
        ):
            return line_number, timestamp
    return fallback_line, fallback_ts


def collect_turn_timings(path: Path) -> list[dict[str, Any]]:
    ensure_codex_rollout(path)
    start_line, previous_ts = _task_start(path)
    pairs_by_turn: dict[int, list[dict[str, Any]]] = {}
    for pair in iter_tool_pairs(path):
        turn = pair.get("call_turn_index")
        if isinstance(turn, int):
            pairs_by_turn.setdefault(turn, []).append(pair)
    rows: list[dict[str, Any]] = []
    previous_line = start_line
    for turn in iter_turns(path):
        if not turn["complete"] or turn["ts"] is None:
            continue
        wall = (
            max(0.0, (turn["ts"] - previous_ts).total_seconds())
            if previous_ts is not None
            else None
        )
        pairs = pairs_by_turn.get(int(turn["turn_index"]), [])
        env = sum(float(pair["latency_s"] or 0.0) for pair in pairs)
        llm = max(0.0, float(wall or 0.0) - env)
        last_usage = turn.get("last_token_usage")
        usage = last_usage if isinstance(last_usage, dict) else {}
        rows.append(
            {
                "turn_index": turn["turn_index"],
                "start_line": previous_line,
                "token_count_line": turn["source_line"],
                "start_ts": previous_ts,
                "end_ts": turn["ts"],
                "turn_wall_s": wall,
                "think_s": None,
                "llm_s": llm,
                "env_s": env,
                "tool_calls": len(pairs),
                "tool_failures": sum(pair["is_error"] is True for pair in pairs),
                "embedded_output_errors": sum(
                    pair["embedded_error"] is True for pair in pairs
                ),
                "missing_tool_outputs": sum(pair["is_error"] is None for pair in pairs),
                "duration_sources": sorted(
                    {str(pair["duration_source"]) for pair in pairs if pair["duration_source"]}
                ),
                "input_tokens": int(usage.get("input_tokens", 0) or 0),
                "output_tokens": int(usage.get("output_tokens", 0) or 0),
                "reasoning_tokens": int(usage.get("reasoning_output_tokens", 0) or 0),
            }
        )
        previous_ts = turn["ts"]
        previous_line = turn["source_line"]
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument("--jsonl", action="store_true")
    parser.add_argument("--top", type=int)
    args = parser.parse_args(argv)
    if not args.session.is_file():
        print(f"error: file not found: {args.session}", file=sys.stderr)
        return 2
    try:
        rows = collect_turn_timings(args.session)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if not rows:
        print("(no complete turns)")
        return 0
    if args.jsonl:
        for row in rows:
            print(to_jsonl(row))
        return 0
    header = (
        f"{'turn':>4} {'line':>5} {'wall_s':>8} {'llm_s':>8} {'env_s':>8} "
        f"{'calls':>5} {'fail':>4} {'embed':>5} {'reason':>7} source"
    )
    print(header)
    print("-" * len(header))
    for row in rows:
        wall = row["turn_wall_s"]
        print(
            f"{row['turn_index']:>4} {row['token_count_line']:>5} "
            f"{(f'{wall:.2f}' if wall is not None else '-'):>8} "
            f"{row['llm_s']:>8.2f} {row['env_s']:>8.2f} "
            f"{row['tool_calls']:>5} {row['tool_failures']:>4} "
            f"{row['embedded_output_errors']:>5} "
            f"{row['reasoning_tokens']:>7} {','.join(row['duration_sources']) or '-'}"
        )
    stats = parse_stats(args.session)
    print()
    print(
        "session parser totals: "
        f"duration={stats.duration_s} think={stats.think_time_s} "
        f"llm={stats.llm_time_s} env={stats.env_time_s} "
        f"ttft={stats.time_to_first_token_s}"
    )
    if args.top:
        print(f"\n=== top {args.top} turns by wall_s ===")
        ranked = sorted(rows, key=lambda row: -float(row["turn_wall_s"] or 0.0))[: args.top]
        for row in ranked:
            print(
                f"  turn {row['turn_index']:<4} line={row['token_count_line']:<5} "
                f"wall={row['turn_wall_s']:.2f}s llm={row['llm_s']:.2f}s "
                f"env={row['env_s']:.2f}s calls={row['tool_calls']}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
