#!/usr/bin/env python3
"""Extract all tool calls and paired results from a Pi session.

Output JSONL by default or a table with ``--table``. Filters support tool name,
success status, and turn range.

Usage:
  extract_tool_calls.py <session.jsonl>
      [--table]
      [--name NAME]
      [--errors-only]
      [--success-only]
      [--turn-from N] [--turn-to N]
      [--max-args N]
      [--max-result N]
      [--full]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pi_session_lib import call_fingerprint, iter_tool_pairs, to_jsonl  # noqa: E402


def shorten(s: str, n: int) -> str:
    s = s.replace("\n", " | ")
    return s if len(s) <= n else s[: n - 1] + "…"


def args_preview(args: dict[str, Any], n: int) -> str:
    try:
        s = json.dumps(args, ensure_ascii=False, default=str)
    except Exception:
        s = str(args)
    return shorten(s, n)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("session", type=Path)
    ap.add_argument("--table", action="store_true")
    ap.add_argument("--name", action="append", help="Filter by tool_name (repeatable)")
    ap.add_argument("--errors-only", action="store_true")
    ap.add_argument("--success-only", action="store_true")
    ap.add_argument("--missing-only", action="store_true", help="Keep only calls without a toolResult")
    ap.add_argument("--turn-from", type=int, default=None)
    ap.add_argument("--turn-to", type=int, default=None)
    ap.add_argument("--max-args", type=int, default=200)
    ap.add_argument("--max-result", type=int, default=400)
    ap.add_argument("--full", action="store_true",
                    help="Output complete arguments / result_text in JSONL mode")
    args = ap.parse_args(argv)

    if not args.session.is_file():
        print(f"error: file not found: {args.session}", file=sys.stderr)
        return 2
    if sum((args.errors_only, args.success_only, args.missing_only)) > 1:
        print("error: result-status filters conflict", file=sys.stderr)
        return 2

    rows = []
    for p in iter_tool_pairs(args.session):
        if args.name and p["tool_name"] not in args.name:
            continue
        if args.errors_only and not p["is_error"]:
            continue
        if args.success_only and p["is_error"] is not False:
            continue
        if args.missing_only and p["result_line"] is not None:
            continue
        ti = p["call_turn_index"]
        if args.turn_from is not None and (ti is None or ti < args.turn_from):
            continue
        if args.turn_to is not None and (ti is None or ti > args.turn_to):
            continue
        rows.append(p)

    if args.table:
        if not rows:
            print("(no calls)")
            return 0
        header = (
            f"{'line':>5} {'turn':>4} {'tool':<14} {'lat_s':>7} {'status':>7} "
            f"{'fingerprint':<12}  {'args':<50}  result"
        )
        print(header)
        print("-" * len(header))
        for r in rows:
            lat = r["latency_s"]
            status = "missing" if r["is_error"] is None else ("error" if r["is_error"] else "ok")
            fingerprint = call_fingerprint(r["tool_name"], r["arguments"])
            print(f"{r['call_line'] or 0:>5} {r['call_turn_index'] or 0:>4} "
                  f"{r['tool_name'][:14]:<14} "
                  f"{(f'{lat:.1f}' if lat is not None else '-'):>7} {status:>7} "
                  f"{fingerprint:<12}  {args_preview(r['arguments'], 50):<50}  "
                  f"{shorten(r['result_text'], args.max_result)}")
        return 0

    for r in rows:
        out = {
            "call_id": r["call_id"],
            "call_line": r["call_line"],
            "result_line": r["result_line"],
            "call_turn_index": r["call_turn_index"],
            "tool_name": r["tool_name"],
            "fingerprint": call_fingerprint(r["tool_name"], r["arguments"]),
            "status": "missing" if r["is_error"] is None else ("error" if r["is_error"] else "ok"),
            "is_error": r["is_error"],
            "error_bucket": r["error_bucket"],
            "call_ts": r["call_ts"],
            "result_ts": r["result_ts"],
            "latency_s": r["latency_s"],
        }
        if args.full:
            out["arguments"] = r["arguments"]
            out["result_text"] = r["result_text"]
        else:
            out["args_preview"] = args_preview(r["arguments"], args.max_args)
            out["result_preview"] = shorten(r["result_text"], args.max_result)
        print(to_jsonl(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
