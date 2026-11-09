#!/usr/bin/env python3
"""Human-readable Codex rollout overview backed by the project parser."""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _codex_session_lib import json_default, read_first_user_prompt  # noqa: E402
from _project import load_run_metadata, parse_stats, resolve_run  # noqa: E402
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


def scan(
    path: Path,
    *,
    pricing_snapshot: dict[str, Any] | None,
    errors_per_bucket: int,
    final_chars: int,
) -> dict[str, Any]:
    out = summarize(path, pricing_snapshot=pricing_snapshot)
    stats = parse_stats(path, pricing_snapshot=pricing_snapshot)
    line_count, bad_count = _line_health(path)
    samples: dict[str, list[dict[str, Any]]] = {}
    for error in collect_errors(path):
        bucket = str(error["error_bucket"])
        rows = samples.setdefault(bucket, [])
        if len(rows) < errors_per_bucket:
            rows.append(
                {
                    "line": error["source_line"],
                    "type": error["error_type"],
                    "tool": error["tool_name"],
                    "snippet": str(error["error_text"])[:300].replace("\n", " | "),
                }
            )
    prompt = read_first_user_prompt(path)
    out.update(
        {
            "lines_read": line_count,
            "bad_lines": bad_count,
            "error_samples": samples,
            "user_prompt_line": prompt["source_line"],
            "user_first_prompt": str(prompt["text"])[:600],
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
        f"{indent}{key.ljust(width)}  {count}" for key, count in counter.most_common(limit)
    )


def render(out: dict[str, Any]) -> str:
    lines = [
        f"file:        {out['path']}",
        f"session_id:  {out['session_id']}",
        f"cwd:         {out['cwd']}",
        f"model:       {out['model']}",
        f"cli_version: {out['cli_version']}",
        f"duration_s:  {out['duration_s']}",
        f"timing_s:    think={out['think_time_s']} llm={out['llm_time_s']} env={out['env_time_s']} ttft={out['time_to_first_token_s']}",
        f"lines:       {out['lines_read']} (bad: {out['bad_lines']})",
        f"turns:       {out['num_turns']}",
        (
            f"tool_calls:  {out['tool_calls']} "
            f"(failures: {out['tool_failures']}, "
            f"embedded: {out['embedded_output_errors']}, "
            f"missing: {out['missing_tool_outputs']})"
        ),
        f"tokens:      in={out['input_tokens']} out={out['output_tokens']} reasoning={out['reasoning_tokens']} cacheR={out['cache_read_tokens']}",
        f"cost_usd:    {out['cost_usd']} estimate={out['cost_is_estimate']}",
        f"stop_error:  {out['stop_reason_error'] or '(none)'}",
        f"parse_error: {out['parse_error'] or '(none)'}",
        f"warnings:    {out['warnings'] or '(none)'}",
        "",
        "=== tool_call_dist ===",
        _fmt_mapping(out["tool_call_dist"]),
        "",
        "=== command head dist ===",
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
        f"=== first user prompt (line {out['user_prompt_line']}) ===",
        out["user_first_prompt"] or "(none)",
        "",
        "=== last assistant text (tail) ===",
        out["final_text"] or "(none)",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument("--run", help="Codex run dir/id, used for pricing snapshot")
    parser.add_argument("--errors", type=int, default=3)
    parser.add_argument("--final-chars", type=int, default=1200)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if not args.session.is_file():
        print(f"error: file not found: {args.session}", file=sys.stderr)
        return 2
    pricing = None
    if args.run:
        try:
            pricing = load_run_metadata(resolve_run(args.run)).get("codex_pricing")
        except FileNotFoundError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
    try:
        result = scan(
            args.session,
            pricing_snapshot=pricing,
            errors_per_bucket=args.errors,
            final_chars=args.final_chars,
        )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(
        json.dumps(result, ensure_ascii=False, indent=2, default=json_default)
        if args.json
        else render(result)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
