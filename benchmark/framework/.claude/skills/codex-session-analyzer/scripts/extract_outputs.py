#!/usr/bin/env python3
"""Extract Codex reasoning summaries, agent messages, assistant text, or final output."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _codex_session_lib import iter_turns, to_jsonl  # noqa: E402
from _project import ensure_codex_rollout  # noqa: E402


def _last_line(turn: dict[str, Any], key: str) -> int | None:
    lines = turn.get(key)
    return int(lines[-1]) if isinstance(lines, list) and lines else None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument(
        "--mode",
        choices=["all", "reasoning", "agent", "text", "final"],
        default="all",
    )
    parser.add_argument("--jsonl", action="store_true")
    parser.add_argument("--turn", type=int)
    args = parser.parse_args(argv)
    if not args.session.is_file():
        print(f"error: file not found: {args.session}", file=sys.stderr)
        return 2
    try:
        ensure_codex_rollout(args.session)
        turns = list(iter_turns(args.session))
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.mode == "final":
        target = next((turn for turn in reversed(turns) if str(turn["text"]).strip()), None)
        if target is None:
            print("(no final text)")
            return 0
        line = _last_line(target, "text_lines")
        row = {
            "turn_index": target["turn_index"],
            "source_line": line,
            "token_count_line": target["source_line"],
            "text": target["text"],
        }
        if args.jsonl:
            print(to_jsonl(row))
        else:
            print(f"# final turn={row['turn_index']} line={line}")
            print(row["text"])
        return 0
    selected = turns if args.turn is None else [turn for turn in turns if turn["turn_index"] == args.turn]
    if args.turn is not None and not selected:
        print(f"(turn {args.turn} not found)")
        return 1
    emitted = 0
    for turn in selected:
        reasoning = turn["reasoning"] if args.mode in {"all", "reasoning"} else ""
        agent = turn["agent_messages"] if args.mode in {"all", "agent"} else ""
        text_value = turn["text"] if args.mode in {"all", "text"} else ""
        if args.mode == "reasoning" and not reasoning:
            continue
        if args.mode == "agent" and not agent:
            continue
        if args.mode == "text" and not text_value:
            continue
        row = {
            "turn_index": turn["turn_index"],
            "token_count_line": turn["source_line"],
            "complete": turn["complete"],
            "reasoning_lines": turn["reasoning_lines"],
            "agent_message_lines": turn["agent_message_lines"],
            "text_lines": turn["text_lines"],
        }
        if args.mode in {"all", "reasoning"}:
            row["reasoning"] = reasoning
        if args.mode in {"all", "agent"}:
            row["agent_message"] = agent
        if args.mode in {"all", "text"}:
            row["text"] = text_value
        if args.jsonl:
            print(to_jsonl(row))
        else:
            print(
                f"\n===== turn {turn['turn_index']} token_line={turn['source_line']} "
                f"complete={turn['complete']} ====="
            )
            if reasoning:
                print(f"--- reasoning lines={turn['reasoning_lines']} ---")
                print(reasoning)
            if agent:
                print(f"--- agent lines={turn['agent_message_lines']} ---")
                print(agent)
            if text_value:
                print(f"--- text lines={turn['text_lines']} ---")
                print(text_value)
        emitted += 1
    if emitted == 0:
        print(f"(no {args.mode} output)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
