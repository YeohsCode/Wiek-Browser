#!/usr/bin/env python3
"""Extract Codex tool failures and rollout terminal errors with source lines."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _codex_session_lib import (  # noqa: E402
    classify_error,
    iter_tool_pairs,
    terminal_events,
    to_jsonl,
)
from _project import ensure_codex_rollout  # noqa: E402


def shorten(value: str, limit: int) -> str:
    flat = value.replace("\n", " | ")
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def args_preview(arguments: dict[str, Any], limit: int) -> str:
    return shorten(json.dumps(arguments, ensure_ascii=False, default=str), limit)


def collect_errors(session: Path) -> list[dict[str, Any]]:
    ensure_codex_rollout(session)
    rows: list[dict[str, Any]] = []
    for pair in iter_tool_pairs(session):
        if not pair["is_error"] and not pair["embedded_error"]:
            continue
        rows.append(
            {
                "error_type": (
                    str(pair["result_type"] or "tool_call_output")
                    if pair["is_error"]
                    else "embedded_output_error"
                ),
                "source_line": pair["result_line"],
                "call_line": pair["call_line"],
                "call_turn_index": pair["call_turn_index"],
                "tool_name": pair["tool_name"],
                "error_bucket": pair["error_bucket"],
                "call_ts": pair["call_ts"],
                "result_ts": pair["result_ts"],
                "latency_s": pair["latency_s"],
                "duration_source": pair["duration_source"],
                "arguments": pair["arguments"],
                "error_text": pair["result_text"],
            }
        )
    for event in terminal_events(session):
        if event["type"] not in {"error", "turn_aborted"}:
            continue
        message = str(event.get("message") or event["type"])
        rows.append(
            {
                "error_type": f"event_msg.{event['type']}",
                "source_line": event["source_line"],
                "call_line": None,
                "call_turn_index": None,
                "tool_name": "codex",
                "error_bucket": classify_error(message),
                "call_ts": None,
                "result_ts": event["timestamp"],
                "latency_s": None,
                "duration_source": None,
                "arguments": {},
                "error_text": message,
            }
        )
    return sorted(rows, key=lambda row: int(row["source_line"] or 0))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument("--table", action="store_true")
    parser.add_argument("--bucket", action="append")
    parser.add_argument("--max-args", type=int, default=200)
    parser.add_argument("--max-err", type=int, default=400)
    args = parser.parse_args(argv)
    if not args.session.is_file():
        print(f"error: file not found: {args.session}", file=sys.stderr)
        return 2
    try:
        rows = [
            row
            for row in collect_errors(args.session)
            if not args.bucket or row["error_bucket"] in args.bucket
        ]
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.table:
        if not rows:
            print("(no errors)")
            return 0
        header = (
            f"{'line':>5} {'turn':>4} {'type':<22} {'tool':<14} "
            f"{'bucket':<18} {'dur_s':>7} {'source':<14}  err"
        )
        print(header)
        print("-" * len(header))
        for row in rows:
            latency = row["latency_s"]
            print(
                f"{row['source_line'] or 0:>5} {row['call_turn_index'] or 0:>4} "
                f"{row['error_type'][:22]:<22} {row['tool_name'][:14]:<14} "
                f"{str(row['error_bucket'] or '?')[:18]:<18} "
                f"{(f'{latency:.2f}' if latency is not None else '-'):>7} "
                f"{str(row['duration_source'] or '-')[:14]:<14}  "
                f"{shorten(str(row['error_text']), args.max_err)}"
            )
        return 0
    for row in rows:
        print(
            to_jsonl(
                {
                    **{key: value for key, value in row.items() if key != "arguments"},
                    "args_preview": args_preview(row["arguments"], args.max_args),
                    "error_text": shorten(str(row["error_text"]), args.max_err),
                }
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
