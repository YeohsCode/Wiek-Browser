#!/usr/bin/env python3
"""Emit per-assistant-turn timing aligned with the single-run report.

Timing reads only top-level session entry timestamps. ``think_s`` comes from the
preceding ``wiek-bench-think`` custom entry, ``llm_s`` spans to the assistant entry
minus measured thinking, ``env_s`` sums tool-result intervals, and ``turn_s`` is
their non-duplicated total.

Usage:
  turn_timings.py <session.jsonl> [--jsonl] [--top N]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pi_session_lib import iter_entries_with_lines, parse_iso, to_jsonl  # noqa: E402
from _project import parse_stats  # noqa: E402


def collect_turn_timings(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    by_turn: dict[int, dict[str, Any]] = {}
    call_turn: dict[str, int] = {}
    assistant_turn = 0
    prev_ts = None
    pending_think_s = 0.0
    pending_think_seen = False

    for line_number, entry in iter_entries_with_lines(path):
        entry_type = entry.get("type")
        ts = parse_iso(entry.get("timestamp"))
        if entry_type == "custom":
            if entry.get("customType") == "wiek-bench-think":
                think_ms = (entry.get("data") or {}).get("think_ms")
                if isinstance(think_ms, (int, float)) and think_ms >= 0:
                    pending_think_s += float(think_ms) / 1000.0
                    pending_think_seen = True
            continue

        span_s = (
            max(0.0, (ts - prev_ts).total_seconds())
            if ts is not None and prev_ts is not None
            else None
        )
        if ts is not None:
            prev_ts = ts
        if entry_type != "message":
            continue
        message = entry.get("message")
        if not isinstance(message, dict):
            continue
        role = message.get("role")

        if role == "assistant":
            assistant_turn += 1
            content = message.get("content") or []
            tool_calls = [
                block
                for block in content
                if isinstance(block, dict) and block.get("type") == "toolCall"
            ]
            for block in tool_calls:
                call_id = block.get("id")
                if isinstance(call_id, str):
                    call_turn[call_id] = assistant_turn
            think_s = pending_think_s if pending_think_seen else None
            request_s = span_s or 0.0
            llm_s = max(0.0, request_s - (think_s or 0.0))
            row = {
                "turn_index": assistant_turn,
                "source_line": line_number,
                "ts": ts,
                "model": message.get("model"),
                "stop_reason": message.get("stopReason"),
                "think_s": think_s,
                "llm_s": llm_s,
                "env_s": 0.0,
                "turn_s": request_s,
                "thinking_chars": sum(
                    len(str(block.get("thinking") or ""))
                    for block in content
                    if isinstance(block, dict) and block.get("type") == "thinking"
                ),
                "text_chars": sum(
                    len(str(block.get("text") or ""))
                    for block in content
                    if isinstance(block, dict) and block.get("type") == "text"
                ),
                "tool_calls": len(tool_calls),
                "tool_failures": 0,
                "tool_result_lines": [],
            }
            rows.append(row)
            by_turn[assistant_turn] = row
            pending_think_s = 0.0
            pending_think_seen = False
            continue

        if role != "toolResult":
            continue
        call_id = message.get("toolCallId")
        turn_index = call_turn.get(call_id) if isinstance(call_id, str) else None
        if turn_index is None or turn_index not in by_turn:
            continue
        row = by_turn[turn_index]
        env_s = span_s or 0.0
        row["env_s"] += env_s
        row["turn_s"] += env_s
        row["tool_result_lines"].append(line_number)
        if message.get("isError") is True:
            row["tool_failures"] += 1

    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument("--jsonl", action="store_true")
    parser.add_argument("--top", type=int, default=None, help="Also print the N turns with the slowest turn_s")
    args = parser.parse_args(argv)

    if not args.session.is_file():
        print(f"error: file not found: {args.session}", file=sys.stderr)
        return 2
    rows = collect_turn_timings(args.session)
    if not rows:
        print("(no assistant turns)")
        return 0
    if args.jsonl:
        for row in rows:
            print(to_jsonl(row))
        return 0

    header = (
        f"{'turn':>4} {'line':>5} {'think_s':>8} {'llm_s':>8} {'env_s':>8} "
        f"{'turn_s':>8} {'calls':>5} {'fail':>4} stop"
    )
    print(header)
    print("-" * len(header))
    for row in rows:
        think = "-" if row["think_s"] is None else f"{row['think_s']:.1f}"
        print(
            f"{row['turn_index']:>4} {row['source_line']:>5} {think:>8} "
            f"{row['llm_s']:>8.1f} {row['env_s']:>8.1f} {row['turn_s']:>8.1f} "
            f"{row['tool_calls']:>5} {row['tool_failures']:>4} "
            f"{row['stop_reason'] or '-'}"
        )

    stats = parse_stats(args.session)
    print()
    print(
        "session totals: "
        f"duration={stats.duration_s} think={stats.think_time_s} "
        f"llm={stats.llm_time_s} env={stats.env_time_s}"
    )
    if args.top:
        print(f"\n=== top {args.top} turns by turn_s ===")
        for row in sorted(rows, key=lambda item: -float(item["turn_s"]))[: args.top]:
            print(
                f"  turn {row['turn_index']:<4} line={row['source_line']:<5} "
                f"turn={row['turn_s']:.1f}s think={row['think_s']} "
                f"llm={row['llm_s']:.1f}s env={row['env_s']:.1f}s"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
