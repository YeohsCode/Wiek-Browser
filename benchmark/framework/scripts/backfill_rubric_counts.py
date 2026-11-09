#!/usr/bin/env python3
"""Backfill per-rubric judge counts into top-level tasks.jsonl records.

Older Odysseys judge artifacts already contain ``num_rubrics`` and
``rubric_scores`` under ``judges/<task_id>_judge.json`` metadata, but runs created
before the merge logic was added do not expose ``num_rubrics`` and
``num_rubrics_passed`` on their task records. This script restores those fields
without re-judging.

The calculation matches ``results.py``: ``rubric_scores`` values are zero or one,
so their sum is the number passed. Binary judges lack these metadata keys and keep
both fields as None.

Usage
-----
    python scripts/backfill_rubric_counts.py
    python scripts/backfill_rubric_counts.py --apply
    python scripts/backfill_rubric_counts.py runs/<run_dir>
    python scripts/backfill_rubric_counts.py --runs-root runs --apply
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


def _judge_meta(run_dir: Path, task_id: str) -> dict[str, Any] | None:
    """Read judge metadata, returning None for a missing or invalid artifact."""
    fp = run_dir / "judges" / f"{task_id}_judge.json"
    if not fp.exists():
        return None
    try:
        data = json.loads(fp.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    meta = data.get("metadata")
    return meta if isinstance(meta, dict) else None


def _counts_from_meta(meta: dict[str, Any]) -> tuple[int | None, int | None]:
    """Calculate rubric totals from metadata using the results.py convention."""
    rubric_scores = meta.get("rubric_scores")
    num_rubrics = meta.get("num_rubrics")
    num_rubrics_passed = (
        sum(rubric_scores.values()) if isinstance(rubric_scores, dict) else None
    )
    return num_rubrics, num_rubrics_passed


def _write_lines(path: Path, lines: list[str]) -> None:
    """Atomically replace JSONL while preserving already-serialized lines."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        for line in lines:
            fh.write(line + "\n")
    os.replace(tmp, path)


def backfill_run(run_dir: Path, *, apply: bool) -> dict[str, int]:
    """Backfill one run's tasks.jsonl and return counters without writing in dry-run.

    Invalid rows are preserved verbatim; only parsed rows are modified.
    """
    tasks_path = run_dir / "tasks.jsonl"
    stats = {"rows": 0, "patched": 0, "already": 0, "no_judge": 0, "no_meta": 0, "corrupt": 0}
    if not tasks_path.exists():
        return stats

    # Pair each original line with its parsed value; preserve invalid lines verbatim.
    parsed: list[tuple[str, dict[str, Any] | None]] = []
    for line in tasks_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            parsed.append((line, json.loads(line)))
        except json.JSONDecodeError:
            parsed.append((line, None))
            stats["corrupt"] += 1
            print(f"  ! {run_dir.name}: 损坏行原样保留: {line[:80]}", file=sys.stderr)

    changed = False
    for _, row in parsed:
        if row is None:
            continue
        stats["rows"] += 1
        task_id = str(row.get("task_id") or "")
        meta = _judge_meta(run_dir, task_id)
        if meta is None:
            stats["no_judge"] += 1
            continue
        num_rubrics, num_rubrics_passed = _counts_from_meta(meta)
        if num_rubrics is None:
            stats["no_meta"] += 1  # Binary or older judges have no rubric counts.
            continue
        if row.get("num_rubrics") == num_rubrics and row.get("num_rubrics_passed") == num_rubrics_passed:
            stats["already"] += 1
            continue
        row["num_rubrics"] = num_rubrics
        row["num_rubrics_passed"] = num_rubrics_passed
        stats["patched"] += 1
        changed = True

    if apply and changed:
        lines = [
            json.dumps(row, ensure_ascii=False) if row is not None else raw
            for raw, row in parsed
        ]
        _write_lines(tasks_path, lines)
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dirs", nargs="*", help="指定 run 目录（留空则扫描 --runs-root 下全部）")
    parser.add_argument("--runs-root", default="runs", help="runs 根目录（默认 runs）")
    parser.add_argument("--apply", action="store_true", help="实际写回（默认 dry-run，只报告）")
    args = parser.parse_args()

    if args.run_dirs:
        targets = [Path(p) for p in args.run_dirs]
    else:
        root = Path(args.runs_root)
        targets = sorted(d for d in root.iterdir() if d.is_dir() and (d / "tasks.jsonl").exists())

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"[{mode}] 待处理 run: {len(targets)} 个\n")

    total_patched = 0
    total_corrupt = 0
    for run_dir in targets:
        st = backfill_run(run_dir, apply=args.apply)
        total_patched += st["patched"]
        total_corrupt += st["corrupt"]
        if st["patched"] or st["already"] or st["corrupt"]:
            flag = "✓" if st["patched"] else ("!" if st["corrupt"] else "·")
            extra = f" 损坏={st['corrupt']:2d}" if st["corrupt"] else ""
            print(
                f"{flag} {run_dir.name:58s} "
                f"补={st['patched']:3d} 已有={st['already']:3d} "
                f"无rubric={st['no_meta']:3d} 无judge={st['no_judge']:3d}{extra} /{st['rows']}"
            )

    verb = "已回填" if args.apply else "可回填（dry-run，未写盘；加 --apply 生效）"
    print(f"\n合计 {verb}: {total_patched} 条 task 记录")
    if total_corrupt:
        print(f"⚠ 含 {total_corrupt} 行无法解析，已原样保留未丢弃")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
