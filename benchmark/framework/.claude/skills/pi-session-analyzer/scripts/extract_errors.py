#!/usr/bin/env python3
"""Extract Pi tool errors and assistant ``stopReason=error`` entries.

Output JSONL by default or a table with ``--table``. Records include turn and
tool identity, error bucket, timestamps, latency, and argument/error previews.

Usage:
  extract_errors.py <session.jsonl> [--table] [--bucket NAME]
                                    [--max-args N] [--max-err N]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pi_session_lib import (  # noqa: E402
    classify_error,
    iter_entries_with_lines,
    iter_tool_pairs,
    to_jsonl,
)
from _project import extract_stop_reason_error  # noqa: E402


def shorten(s: str, n: int) -> str:
    s = s.replace("\n", " | ")
    return s if len(s) <= n else s[: n - 1] + "…"


def args_preview(args: dict[str, Any], n: int) -> str:
    try:
        s = json.dumps(args, ensure_ascii=False, default=str)
    except Exception:
        s = str(args)
    return shorten(s, n)


def collect_errors(session: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for pair in iter_tool_pairs(session):
        if not pair["is_error"]:
            continue
        rows.append(
            {
                "error_type": "tool_result",
                "source_line": pair["result_line"],
                "call_line": pair["call_line"],
                "call_turn_index": pair["call_turn_index"],
                "tool_name": pair["tool_name"],
                "error_bucket": pair["error_bucket"],
                "call_ts": pair["call_ts"],
                "result_ts": pair["result_ts"],
                "latency_s": pair["latency_s"],
                "arguments": pair["arguments"],
                "error_text": pair["result_text"],
            }
        )

    assistant_turn = 0
    for line_number, entry in iter_entries_with_lines(session):
        if entry.get("type") != "message":
            continue
        message = entry.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        assistant_turn += 1
        error_text = extract_stop_reason_error(message)
        if not error_text:
            continue
        rows.append(
            {
                "error_type": "assistant_stop",
                "source_line": line_number,
                "call_line": None,
                "call_turn_index": assistant_turn,
                "tool_name": "assistant",
                "error_bucket": classify_error(error_text),
                "call_ts": None,
                "result_ts": entry.get("timestamp"),
                "latency_s": None,
                "arguments": {},
                "error_text": error_text,
            }
        )
    return sorted(rows, key=lambda row: int(row["source_line"] or 0))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("session", type=Path)
    ap.add_argument("--table", action="store_true", help="Output an aligned table instead of JSONL")
    ap.add_argument("--bucket", help="Keep only the specified bucket (repeatable)", action="append")
    ap.add_argument("--max-args", type=int, default=200)
    ap.add_argument("--max-err", type=int, default=400)
    args = ap.parse_args(argv)

    if not args.session.is_file():
        print(f"error: file not found: {args.session}", file=sys.stderr)
        return 2

    rows = [
        row
        for row in collect_errors(args.session)
        if not args.bucket or row["error_bucket"] in args.bucket
    ]

    if args.table:
        if not rows:
            print("(no errors)")
            return 0
        header = (
            f"{'line':>5} {'turn':>4} {'type':<14} {'tool':<12} "
            f"{'bucket':<18} {'lat_s':>7}  err"
        )
        print(header)
        print("-" * len(header))
        for r in rows:
            lat = r["latency_s"]
            print(f"{r['source_line'] or 0:>5} {r['call_turn_index'] or 0:>4} "
                  f"{r['error_type'][:14]:<14} {r['tool_name'][:12]:<12} "
                  f"{(r['error_bucket'] or '?')[:18]:<18} "
                  f"{(f'{lat:.1f}' if lat is not None else '-'):>7}  "
                  f"{shorten(r['error_text'], args.max_err)}")
    else:
        for r in rows:
            print(to_jsonl({
                "error_type": r["error_type"],
                "source_line": r["source_line"],
                "call_line": r["call_line"],
                "call_turn_index": r["call_turn_index"],
                "tool_name": r["tool_name"],
                "error_bucket": r["error_bucket"],
                "call_ts": r["call_ts"],
                "result_ts": r["result_ts"],
                "latency_s": r["latency_s"],
                "args_preview": args_preview(r["arguments"], args.max_args),
                "error_text": shorten(r["error_text"], args.max_err),
            }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
