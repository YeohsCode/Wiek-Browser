#!/usr/bin/env python3
"""Pair two Codex runs and compare parser-derived task metrics."""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _project import latest_by_task_id, require_codex_run, resolve_run  # noqa: E402
from session_summary import summarize  # noqa: E402


def _load(run_dir: Path) -> tuple[dict[str, Any], dict[tuple[str, int], dict[str, Any]]]:
    metadata = require_codex_run(run_dir)
    pricing = metadata.get("codex_pricing")
    rows: dict[tuple[str, int], dict[str, Any]] = {}
    for task_id, record in latest_by_task_id(run_dir).items():
        session_file = record.get("session_file")
        stats = None
        if isinstance(session_file, str) and Path(session_file).is_file():
            stats = summarize(Path(session_file), pricing_snapshot=pricing)
        key = (
            str(record.get("base_task_id") or task_id),
            int(record.get("iteration_index") or 1),
        )
        rows[key] = {
            "task_id": task_id,
            "record": record,
            "stats": stats,
        }
    return metadata, rows


def _metric(row: dict[str, Any], name: str) -> float | int | None:
    stats = row.get("stats")
    return stats.get(name) if isinstance(stats, dict) else None


def build_diff(baseline: Path, test: Path) -> dict[str, Any]:
    base_meta, base = _load(baseline)
    test_meta, target = _load(test)
    common = sorted(set(base) & set(target))
    pairs: list[dict[str, Any]] = []
    for key in common:
        left = base[key]
        right = target[key]
        left_duration = _metric(left, "duration_s")
        right_duration = _metric(right, "duration_s")
        duration_delta = (
            float(right_duration) - float(left_duration)
            if left_duration is not None and right_duration is not None
            else None
        )
        pairs.append(
            {
                "base_task_id": key[0],
                "iteration_index": key[1],
                "baseline_task_id": left["task_id"],
                "test_task_id": right["task_id"],
                "duration_baseline": left_duration,
                "duration_test": right_duration,
                "duration_delta": duration_delta,
                "turns_baseline": _metric(left, "num_turns"),
                "turns_test": _metric(right, "num_turns"),
                "tools_baseline": _metric(left, "tool_calls"),
                "tools_test": _metric(right, "tool_calls"),
                "failures_baseline": _metric(left, "tool_failures"),
                "failures_test": _metric(right, "tool_failures"),
                "tokens_baseline": (
                    int(_metric(left, "input_tokens") or 0)
                    + int(_metric(left, "output_tokens") or 0)
                ),
                "tokens_test": (
                    int(_metric(right, "input_tokens") or 0)
                    + int(_metric(right, "output_tokens") or 0)
                ),
                "cost_baseline": _metric(left, "cost_usd"),
                "cost_test": _metric(right, "cost_usd"),
                "verdict_baseline": left["record"].get("verdict"),
                "verdict_test": right["record"].get("verdict"),
            }
        )

    def aggregate(rows: dict[tuple[str, int], dict[str, Any]]) -> dict[str, Any]:
        stats = [row["stats"] for row in rows.values() if isinstance(row.get("stats"), dict)]
        tool_dist: Counter[str] = Counter()
        for item in stats:
            tool_dist.update(item.get("tool_call_dist") or {})
        costs = [float(item["cost_usd"]) for item in stats if item.get("cost_usd") is not None]
        return {
            "tasks": len(rows),
            "duration_s": round(sum(float(item.get("duration_s") or 0.0) for item in stats), 3),
            "turns": sum(int(item.get("num_turns") or 0) for item in stats),
            "tools": sum(int(item.get("tool_calls") or 0) for item in stats),
            "tool_failures": sum(int(item.get("tool_failures") or 0) for item in stats),
            "tokens": sum(
                int(item.get("input_tokens") or 0) + int(item.get("output_tokens") or 0)
                for item in stats
            ),
            "cost_usd": round(sum(costs), 6) if costs else None,
            "tool_call_dist": dict(tool_dist),
        }

    return {
        "baseline": str(baseline),
        "test": str(test),
        "baseline_run_id": base_meta.get("run_id") or baseline.name,
        "test_run_id": test_meta.get("run_id") or test.name,
        "paired": len(common),
        "only_baseline": [list(key) for key in sorted(set(base) - set(target))],
        "only_test": [list(key) for key in sorted(set(target) - set(base))],
        "aggregate_baseline": aggregate(base),
        "aggregate_test": aggregate(target),
        "pairs": pairs,
    }


def render(payload: dict[str, Any], top: int) -> str:
    lines = [
        f"baseline: {payload['baseline_run_id']}",
        f"test:     {payload['test_run_id']}",
        (
            f"paired={payload['paired']} only_baseline={len(payload['only_baseline'])} "
            f"only_test={len(payload['only_test'])}"
        ),
        "",
        f"{'task':<42} {'iter':>4} {'dur_b':>8} {'dur_t':>8} {'delta':>8} "
        f"{'turn_b':>7} {'turn_t':>7} {'tool_b':>7} {'tool_t':>7}",
    ]
    ranked = sorted(
        payload["pairs"],
        key=lambda row: -abs(float(row["duration_delta"] or 0.0)),
    )
    for row in ranked[:top]:
        lines.append(
            f"{row['base_task_id']:<42} {row['iteration_index']:>4} "
            f"{float(row['duration_baseline'] or 0.0):>8.1f} "
            f"{float(row['duration_test'] or 0.0):>8.1f} "
            f"{float(row['duration_delta'] or 0.0):>+8.1f} "
            f"{int(row['turns_baseline'] or 0):>7} {int(row['turns_test'] or 0):>7} "
            f"{int(row['tools_baseline'] or 0):>7} {int(row['tools_test'] or 0):>7}"
        )
    lines += ["", "aggregate:"]
    for label in ("aggregate_baseline", "aggregate_test"):
        item = payload[label]
        lines.append(
            f"  {label.removeprefix('aggregate_')}: duration={item['duration_s']}s "
            f"turns={item['turns']} tools={item['tools']} failures={item['tool_failures']} "
            f"tokens={item['tokens']} cost={item['cost_usd']}"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline")
    parser.add_argument("test")
    parser.add_argument("--top", type=int, default=10)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        payload = build_diff(resolve_run(args.baseline), resolve_run(args.test))
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(payload, ensure_ascii=False, indent=2) if args.json else render(payload, args.top))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
