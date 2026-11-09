#!/usr/bin/env python3
"""Extract the full user prompt and final assistant output from a Pi session.

Sessions normally contain one user message. The output is the last assistant turn
that contains text. Plain-text output uses two sections:
  ===== INPUT =====
  <full user prompt>

  ===== OUTPUT =====
  <full final assistant text>

Usage:
  extract_io.py <session.jsonl> [--jsonl]
                                [--input-only|--output-only]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pi_session_lib import (  # noqa: E402
    iter_assistant_turns,
    read_first_user_prompt,
    read_session_header,
    to_jsonl,
)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("session", type=Path)
    ap.add_argument("--jsonl", action="store_true", help="Output one line of JSON")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--input-only", action="store_true")
    g.add_argument("--output-only", action="store_true")
    args = ap.parse_args(argv)

    if not args.session.is_file():
        print(f"error: file not found: {args.session}", file=sys.stderr)
        return 2

    user_prompt = read_first_user_prompt(args.session)
    final_text = ""
    final_turn = None
    final_line = None
    for t in iter_assistant_turns(args.session):
        if t["text"].strip():
            final_text = t["text"]
            final_turn = t["turn_index"]
            final_line = t["source_line"]

    if args.jsonl:
        header = read_session_header(args.session)
        row = {
            "session_id": header.get("session_id"),
            "cwd": header.get("cwd"),
        }
        if not args.output_only:
            row["input"] = user_prompt
        if not args.input_only:
            row["output"] = final_text
            row["output_turn_index"] = final_turn
            row["output_source_line"] = final_line
        print(to_jsonl(row))
        return 0

    if not args.output_only:
        print("===== INPUT =====")
        print(user_prompt or "(no user prompt)")
        print()
    if not args.input_only:
        print(f"===== OUTPUT (turn {final_turn}, line {final_line}) =====")
        print(final_text or "(no final text)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
