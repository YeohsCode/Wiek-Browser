#!/usr/bin/env python3
"""Extract assistant thinking, intermediate text, or final output from a Pi session.

Modes select thinking blocks, assistant text, the final assistant text, or all
turns. Human-readable output includes turn, time, and model; ``--jsonl`` emits one
object per turn.

Usage:
  extract_outputs.py <session.jsonl> [--mode all|thinking|text|final]
                                     [--jsonl] [--turn N]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pi_session_lib import iter_assistant_turns, to_jsonl  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("session", type=Path)
    ap.add_argument("--mode", choices=["all", "thinking", "text", "final"], default="all")
    ap.add_argument("--jsonl", action="store_true", help="Output one JSON line per turn")
    ap.add_argument("--turn", type=int, default=None, help="Inspect only the specified turn")
    args = ap.parse_args(argv)

    if not args.session.is_file():
        print(f"error: file not found: {args.session}", file=sys.stderr)
        return 2

    turns = list(iter_assistant_turns(args.session))
    if not turns:
        print("(no assistant turns)")
        return 0

    if args.mode == "final":
        # Find the last turn containing text.
        target = None
        for t in reversed(turns):
            if t["text"].strip():
                target = t
                break
        if target is None:
            print("(no final text)")
            return 0
        if args.jsonl:
            print(to_jsonl({"turn_index": target["turn_index"],
                            "source_line": target["source_line"], "ts": target["ts"],
                            "model": target["model"], "text": target["text"]}))
        else:
            print(f"# final turn={target['turn_index']} line={target['source_line']} "
                  f"ts={target['ts']} model={target['model']}")
            print(target["text"])
        return 0

    selected = turns
    if args.turn is not None:
        selected = [t for t in turns if t["turn_index"] == args.turn]
        if not selected:
            print(f"(turn {args.turn} not found)")
            return 1

    for t in selected:
        thinking = t["thinking"] if args.mode in ("all", "thinking") else ""
        text = t["text"] if args.mode in ("all", "text") else ""
        if args.mode == "thinking" and not thinking:
            continue
        if args.mode == "text" and not text:
            continue
        if args.jsonl:
            row = {
                "turn_index": t["turn_index"],
                "source_line": t["source_line"],
                "ts": t["ts"],
                "model": t["model"],
                "stop_reason": t["stop_reason"],
            }
            if args.mode in ("all", "thinking"):
                row["thinking"] = thinking
            if args.mode in ("all", "text"):
                row["text"] = text
            print(to_jsonl(row))
            continue
        print(f"\n===== turn {t['turn_index']}  line={t['source_line']}  "
              f"ts={t['ts']}  model={t['model']}  "
              f"stop={t['stop_reason']} =====")
        if thinking:
            print("--- thinking ---")
            print(thinking)
        if text:
            print("--- text ---")
            print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
