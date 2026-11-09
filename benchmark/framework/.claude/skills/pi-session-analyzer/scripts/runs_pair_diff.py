#!/usr/bin/env python3
"""Compare two runs by pairing task executions on base_task_id.

Usage:
    runs_pair_diff.py <baseline_run_dir> <test_run_dir> [--top N]

Output includes pairing coverage, per-task execution metrics, largest duration and
turn differences, and aggregate tool-call distribution differences. Run it from
the project root so ``wiek_bench.session_parser`` is importable.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _project import SessionStats, parse_stats  # noqa: E402


def parse_iso(s: Any) -> datetime | None:
    if not isinstance(s, str) or not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def import_parser() -> Callable[[str | Path], SessionStats]:
    """Return the only supported parser path; import failures are loud in ``_project``."""
    return parse_stats


def load_tasks(run_dir: Path) -> list[dict[str, Any]]:
    p = run_dir / "tasks.jsonl"
    if not p.is_file():
        raise SystemExit(f"missing tasks.jsonl: {p}")
    out = []
    with p.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def task_duration(task: dict[str, Any]) -> float | None:
    a = parse_iso(task.get("started_at"))
    b = parse_iso(task.get("ended_at"))
    if a and b and b >= a:
        return (b - a).total_seconds()
    return None


def enrich(
    tasks: list[dict[str, Any]],
    parse_fn: Callable[[str | Path], SessionStats],
) -> list[dict[str, Any]]:
    out = []
    for t in tasks:
        sf = t.get("session_file")
        stats = parse_fn(sf) if sf else None
        out.append({
            "task_id": t.get("task_id"),
            "base_task_id": t.get("base_task_id"),
            "iteration_index": t.get("iteration_index"),
            "verdict": t.get("verdict"),
            "score": t.get("score"),
            "error": t.get("error"),
            "wall_s": task_duration(t),
            "session_file": sf,
            "stats": stats,
        })
    return out


def fmt_num(value: Any) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.1f}"
    return str(value)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("baseline", type=Path)
    ap.add_argument("test", type=Path)
    ap.add_argument("--top", type=int, default=10)
    args = ap.parse_args(argv)

    parse_fn = import_parser()
    base = enrich(load_tasks(args.baseline), parse_fn)
    test = enrich(load_tasks(args.test), parse_fn)

    by_key_b = {(t["base_task_id"], t["iteration_index"]): t for t in base}
    by_key_t = {(t["base_task_id"], t["iteration_index"]): t for t in test}
    keys_common = sorted(set(by_key_b) & set(by_key_t))
    only_b = sorted(set(by_key_b) - set(by_key_t))
    only_t = sorted(set(by_key_t) - set(by_key_b))

    print(f"baseline: {args.baseline}  ({len(base)} tasks)")
    print(f"test:     {args.test}  ({len(test)} tasks)")
    print(f"paired={len(keys_common)}  only_baseline={len(only_b)}  only_test={len(only_t)}")
    print()

    # per-task table
    header = (
        f"{'task_id':<40} {'iter':>4} {'wall_b':>8} {'wall_t':>8} {'Δwall':>8} "
        f"{'turn_b':>6} {'turn_t':>6} {'tools_b':>7} {'tools_t':>7} "
        f"{'verd_b':>8} {'verd_t':>8}"
    )
    print(header)
    print("-" * len(header))

    pair_rows = []
    for k in keys_common:
        b = by_key_b[k]
        t = by_key_t[k]
        wb = b["wall_s"]
        wt = t["wall_s"]
        dw = (wt - wb) if (wb is not None and wt is not None) else None
        sb = b["stats"]
        st = t["stats"]
        turn_b = getattr(sb, "num_turns", None) if sb else None
        turn_t = getattr(st, "num_turns", None) if st else None
        tools_b = getattr(sb, "tool_calls", None) if sb else None
        tools_t = getattr(st, "tool_calls", None) if st else None
        pair_rows.append({
            "key": k, "wb": wb, "wt": wt, "dw": dw,
            "turn_b": turn_b, "turn_t": turn_t,
            "tools_b": tools_b, "tools_t": tools_t,
            "verdict_b": b["verdict"], "verdict_t": t["verdict"],
            "task_id_b": b["task_id"], "task_id_t": t["task_id"],
        })
        print(f"{k[0]:<40} {k[1]!s:>4} {fmt_num(wb):>8} {fmt_num(wt):>8} {fmt_num(dw):>8} "
              f"{fmt_num(turn_b):>6} {fmt_num(turn_t):>6} {fmt_num(tools_b):>7} {fmt_num(tools_t):>7} "
              f"{str(b['verdict'])[:8]:>8} {str(t['verdict'])[:8]:>8}")

    # top diffs
    print()
    print(f"=== top {args.top} duration diffs (test - baseline, larger = test slower) ===")
    sorted_pairs = sorted(
        [r for r in pair_rows if r["dw"] is not None],
        key=lambda r: -r["dw"],
    )
    for r in sorted_pairs[: args.top]:
        print(f"  +{r['dw']:7.1f}s  base={r['key'][0]}  iter={r['key'][1]}  "
              f"wall {fmt_num(r['wb'])}->{fmt_num(r['wt'])}  "
              f"turns {fmt_num(r['turn_b'])}->{fmt_num(r['turn_t'])}  "
              f"tools {fmt_num(r['tools_b'])}->{fmt_num(r['tools_t'])}")
    print()
    print(f"=== top {args.top} duration regressions (test faster) ===")
    for r in sorted_pairs[-args.top:][::-1]:
        if r["dw"] is None or r["dw"] >= 0:
            continue
        print(f"  {r['dw']:7.1f}s  base={r['key'][0]}  iter={r['key'][1]}")

    # Aggregate tool-call distributions.
    def agg_tools(tasks: list[dict[str, Any]]) -> Counter[str]:
        c: Counter[str] = Counter()
        for t in tasks:
            d = getattr(t["stats"], "tool_call_dist", None) or {}
            for name, n in d.items():
                c[name] += n
        return c

    tb = agg_tools(base)
    tt = agg_tools(test)
    all_names = sorted(set(tb) | set(tt), key=lambda n: -(tb.get(n, 0) + tt.get(n, 0)))
    print()
    print("=== tool_call_dist (aggregate) ===")
    print(f"{'tool':<30} {'baseline':>10} {'test':>10} {'Δ':>10}")
    for n in all_names:
        b = tb.get(n, 0)
        t = tt.get(n, 0)
        print(f"{n:<30} {b:>10} {t:>10} {(t-b):>+10}")

    # Aggregate tokens and cost.
    def agg_tokens(tasks: list[dict[str, Any]]) -> tuple[int, int, int, int, float]:
        ti = to = cr = cw = 0
        cost = 0.0
        for t in tasks:
            s = t["stats"]
            if not s:
                continue
            ti += getattr(s, "input_tokens", 0) or 0
            to += getattr(s, "output_tokens", 0) or 0
            cr += getattr(s, "cache_read_tokens", 0) or 0
            cw += getattr(s, "cache_creation_tokens", 0) or 0
            cost += getattr(s, "cost_usd", 0.0) or 0.0
        return ti, to, cr, cw, cost

    print()
    print("=== tokens / cost (aggregate) ===")
    a_ti, a_to, a_cr, a_cw, a_cost = agg_tokens(base)
    b_ti, b_to, b_cr, b_cw, b_cost = agg_tokens(test)
    print(f"{'metric':<18} {'baseline':>14} {'test':>14} {'Δ':>14}")
    for label, a, b in [
        ("input_tokens", a_ti, b_ti),
        ("output_tokens", a_to, b_to),
        ("cache_read", a_cr, b_cr),
        ("cache_write", a_cw, b_cw),
    ]:
        print(f"{label:<18} {a:>14} {b:>14} {(b-a):>+14}")
    print(f"{'cost_usd':<18} {a_cost:>14.4f} {b_cost:>14.4f} {(b_cost-a_cost):>+14.4f}")

    # Tasks present in only one run.
    if only_b:
        print(f"\nonly in baseline ({len(only_b)}): {only_b[:10]}{'...' if len(only_b)>10 else ''}")
    if only_t:
        print(f"only in test     ({len(only_t)}): {only_t[:10]}{'...' if len(only_t)>10 else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
