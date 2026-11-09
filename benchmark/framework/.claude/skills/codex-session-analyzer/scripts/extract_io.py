#!/usr/bin/env python3
"""Extract the canonical user prompt and final assistant output from a Codex rollout."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _codex_session_lib import (  # noqa: E402
    iter_turns,
    read_first_user_prompt,
    read_session_header,
    to_jsonl,
)
from _project import ensure_codex_rollout  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument("--jsonl", action="store_true")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--input-only", action="store_true")
    group.add_argument("--output-only", action="store_true")
    args = parser.parse_args(argv)
    if not args.session.is_file():
        print(f"error: file not found: {args.session}", file=sys.stderr)
        return 2
    try:
        ensure_codex_rollout(args.session)
        prompt = read_first_user_prompt(args.session)
        turns = list(iter_turns(args.session))
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    final = next((turn for turn in reversed(turns) if str(turn["text"]).strip()), None)
    final_text = str(final["text"]) if final else ""
    final_line = final["text_lines"][-1] if final and final["text_lines"] else None
    final_turn = final["turn_index"] if final else None
    if args.jsonl:
        header = read_session_header(args.session)
        row = {"session_id": header.get("session_id"), "cwd": header.get("cwd")}
        if not args.output_only:
            row.update({"input": prompt["text"], "input_source_line": prompt["source_line"]})
        if not args.input_only:
            row.update(
                {
                    "output": final_text,
                    "output_turn_index": final_turn,
                    "output_source_line": final_line,
                }
            )
        print(to_jsonl(row))
        return 0
    if not args.output_only:
        print(f"===== INPUT (line {prompt['source_line']}) =====")
        print(prompt["text"] or "(no user prompt)")
        print()
    if not args.input_only:
        print(f"===== OUTPUT (turn {final_turn}, line {final_line}) =====")
        print(final_text or "(no final text)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
