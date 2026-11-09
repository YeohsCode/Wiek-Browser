#!/usr/bin/env python3
"""Quick-scan one Pi session using project metrics and line-based error evidence."""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pi_session_lib import read_first_user_prompt  # noqa: E402
from _project import parse_stats  # noqa: E402
from extract_errors import collect_errors  # noqa: E402
from session_summary import summarize  # noqa: E402


def _line_health(path: Path) -> tuple[int, int]:
    lines = 0
    bad = 0
    with path.open("r", encoding="utf-8") as handle:
        for raw in handle:
            if not raw.strip():
                continue
            lines += 1
            try:
                entry = json.loads(raw)
            except json.JSONDecodeError:
                bad += 1
                continue
            if not isinstance(entry, dict):
                bad += 1
    return lines, bad


def scan(path: Path, errors_per_bucket: int, final_chars: int) -> dict[str, Any]:
    out = summarize(path)
    stats = parse_stats(path)
    lines, bad = _line_health(path)
    errors = collect_errors(path)
    samples: dict[str, list[dict[str, Any]]] = {}
    for error in errors:
        bucket = str(error["error_bucket"])
        bucket_samples = samples.setdefault(bucket, [])
        if len(bucket_samples) >= errors_per_bucket:
            continue
        bucket_samples.append(
            {
                "line": error["source_line"],
                "type": error["error_type"],
                "tool": error["tool_name"],
                "snippet": str(error["error_text"])[:300].replace("\n", " | "),
            }
        )
    out.update(
        {
            "lines_read": lines,
            "bad_lines": bad,
            "error_samples": samples,
            "user_first_prompt": read_first_user_prompt(path)[:600],
            "final_text": stats.final_output[-final_chars:],
        }
    )
    return out


def _fmt_mapping(values: dict[str, int], indent: str = "  ", limit: int = 20) -> str:
    if not values:
        return f"{indent}(none)"
    counter = Counter(values)
    width = max(len(key) for key in counter)
    return "\n".join(
        f"{indent}{key.ljust(width)}  {count}"
        for key, count in counter.most_common(limit)
    )


def render(out: dict[str, Any]) -> str:
    lines = [
        f"file:        {out['path']}",
        f"session_id:  {out['session_id']}",
        f"cwd:         {out['cwd']}",
        f"model:       {out['model']}",
        f"duration_s:  {out['duration_s']}",
        f"timing_s:    think={out['think_time_s']} llm={out['llm_time_s']} env={out['env_time_s']}",
        f"lines:       {out['lines_read']} (bad: {out['bad_lines']})",
        f"turns:       {out['num_turns']}",
        f"tool_calls:  {out['tool_calls']}  (failures: {out['tool_failures']})",
        (
            "tokens:      "
            f"in={out['input_tokens']} out={out['output_tokens']} "
            f"reasoning={out['reasoning_tokens']} cacheR={out['cache_read_tokens']}"
        ),
        f"cost_usd:    {out['cost_usd']}",
        f"stop_error:  {out['stop_reason_error'] or '(none)'}",
        f"parse_error: {out['parse_error'] or '(none)'}",
        f"warnings:    {out['warnings'] or '(none)'}",
        "",
        "=== tool_call_dist ===",
        _fmt_mapping(out["tool_call_dist"]),
        "",
        "=== bash head-cmd_dist ===",
        _fmt_mapping(out["bash_cmd_dist"]),
        "",
        "=== error buckets ===",
        _fmt_mapping(out["error_buckets"]),
    ]
    if out["error_samples"]:
        lines += ["", "=== error samples ==="]
        for bucket, samples in out["error_samples"].items():
            lines.append(f"  [{bucket}]")
            for sample in samples:
                lines.append(
                    f"    line={sample['line']} type={sample['type']} tool={sample['tool']}"
                )
                lines.append(f"    err={sample['snippet']}")
    lines += [
        "",
        "=== first user prompt ===",
        out["user_first_prompt"] or "(none)",
        "",
        "=== last assistant text (tail) ===",
        out["final_text"] or "(none)",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument("--errors", type=int, default=3, help="Number of samples per error type")
    parser.add_argument("--final-chars", type=int, default=1200)
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args(argv)
    if not args.session.is_file():
        print(f"error: file not found: {args.session}", file=sys.stderr)
        return 2
    data = scan(args.session, args.errors, args.final_chars)
    print(json.dumps(data, ensure_ascii=False, indent=2) if args.json else render(data))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
