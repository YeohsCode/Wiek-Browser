#!/usr/bin/env python3
"""Extract and filter Codex tool call/output pairs."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _codex_session_lib import call_fingerprint, iter_tool_pairs, to_jsonl  # noqa: E402
from _project import ensure_codex_rollout  # noqa: E402


def shorten(value: str, limit: int) -> str:
    flat = value.replace("\n", " | ")
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def args_preview(arguments: dict[str, Any], limit: int) -> str:
    return shorten(json.dumps(arguments, ensure_ascii=False, default=str), limit)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument("--table", action="store_true")
    parser.add_argument("--name", action="append")
    parser.add_argument("--errors-only", action="store_true")
    parser.add_argument("--success-only", action="store_true")
    parser.add_argument("--missing-only", action="store_true")
    parser.add_argument("--turn-from", type=int)
    parser.add_argument("--turn-to", type=int)
    parser.add_argument("--max-args", type=int, default=200)
    parser.add_argument("--max-result", type=int, default=400)
    parser.add_argument("--full", action="store_true")
    args = parser.parse_args(argv)
    if not args.session.is_file():
        print(f"error: file not found: {args.session}", file=sys.stderr)
        return 2
    if sum((args.errors_only, args.success_only, args.missing_only)) > 1:
        print("error: result-status filters conflict", file=sys.stderr)
        return 2
    try:
        ensure_codex_rollout(args.session)
        pairs = list(iter_tool_pairs(args.session))
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    rows: list[dict[str, Any]] = []
    for pair in pairs:
        if args.name and pair["tool_name"] not in args.name:
            continue
        if (
            args.errors_only
            and pair["is_error"] is not True
            and not pair["embedded_error"]
        ):
            continue
        if args.success_only and (
            pair["is_error"] is not False or pair["embedded_error"]
        ):
            continue
        if args.missing_only and pair["is_error"] is not None:
            continue
        turn = pair["call_turn_index"]
        if args.turn_from is not None and (turn is None or turn < args.turn_from):
            continue
        if args.turn_to is not None and (turn is None or turn > args.turn_to):
            continue
        rows.append(pair)
    if args.table:
        if not rows:
            print("(no calls)")
            return 0
        header = (
            f"{'line':>5} {'out':>5} {'turn':>4} {'tool':<14} {'dur_s':>7} "
            f"{'source':<14} {'status':>7} {'fingerprint':<12}  args"
        )
        print(header)
        print("-" * len(header))
        for row in rows:
            status = (
                "missing"
                if row["is_error"] is None
                else (
                    "error"
                    if row["is_error"]
                    else ("embedded" if row["embedded_error"] else "ok")
                )
            )
            latency = row["latency_s"]
            print(
                f"{row['call_line'] or 0:>5} {row['result_line'] or 0:>5} "
                f"{row['call_turn_index'] or 0:>4} {row['tool_name'][:14]:<14} "
                f"{(f'{latency:.2f}' if latency is not None else '-'):>7} "
                f"{str(row['duration_source'] or '-')[:14]:<14} {status:>7} "
                f"{call_fingerprint(row['tool_name'], row['arguments']):<12}  "
                f"{args_preview(row['arguments'], 80)}"
            )
        return 0
    for row in rows:
        output = {
            "call_id": row["call_id"],
            "call_type": row["call_type"],
            "result_type": row["result_type"],
            "call_line": row["call_line"],
            "result_line": row["result_line"],
            "call_turn_index": row["call_turn_index"],
            "tool_name": row["tool_name"],
            "fingerprint": call_fingerprint(row["tool_name"], row["arguments"]),
            "status": (
                "missing"
                if row["is_error"] is None
                else (
                    "error"
                    if row["is_error"]
                    else ("embedded" if row["embedded_error"] else "ok")
                )
            ),
            "is_error": row["is_error"],
            "embedded_error": row["embedded_error"],
            "error_bucket": row["error_bucket"],
            "call_ts": row["call_ts"],
            "result_ts": row["result_ts"],
            "latency_s": row["latency_s"],
            "duration_source": row["duration_source"],
        }
        if args.full:
            output["arguments"] = row["arguments"]
            output["result_text"] = row["result_text"]
        else:
            output["args_preview"] = args_preview(row["arguments"], args.max_args)
            output["result_preview"] = shorten(row["result_text"], args.max_result)
        print(to_jsonl(output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
