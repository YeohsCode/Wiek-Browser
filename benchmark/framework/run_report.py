#!/usr/bin/env python
"""Stage C — render single-run reports and/or export per-task session HTML.

Self-contained: reads only run-dir products + pi session JSONL (report) or drives pi
RPC export_html (session HTML). Never calls the judge.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from loguru import logger

from wiek_bench.report.compare import render_single_report
from wiek_bench.report.i18n import DEFAULT_REPORT_LOCALE
from wiek_bench.report.screenshots_html import export_run_screenshots_html
from wiek_bench.report.session_html import export_run_sessions
from wiek_bench.results import resolve_run_dir


def _expand_specs(specs: list[str]) -> list[str]:
    out: list[str] = []
    for s in specs:
        out += [part for part in s.split(",") if part.strip()]
    return out


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Stage C: single-run report + session HTML export."
    )
    p.add_argument("--single", nargs="+", default=[], help="one or more runs → single pool report")
    p.add_argument("--out")
    p.add_argument("--label", help="single-run mode pool label")
    p.add_argument("--dataset", help="task reference JSON; default infers data/<benchmark>.json")
    p.add_argument("--exclude", action="append", default=[])
    p.add_argument("--exclude-keyword", action="append", default=[])
    p.add_argument("--keep-error", action="store_true")
    p.add_argument(
        "--locale",
        choices=("zh", "en"),
        default=DEFAULT_REPORT_LOCALE,
        help="single-run report language (default: en)",
    )
    p.add_argument("--export-sessions", help="run id/dir; export session HTML and exit")
    p.add_argument("--output-dir", default="runs")
    return p


def main() -> int:
    args = build_parser().parse_args()

    if args.export_sessions:
        run_dir = resolve_run_dir(args.export_sessions, args.output_dir)
        paths = export_run_sessions(run_dir)
        logger.info("exported {} session HTML files", len(paths))
        # Export trajectory galleries with local I/O; an absent screenshots directory is valid.
        export_run_screenshots_html(run_dir)
        return 0

    if not args.single:
        logger.error("need --single (or --export-sessions)")
        return 2

    exclude_ids = set(_expand_specs(args.exclude))
    run_dirs = [resolve_run_dir(s, args.output_dir) for s in _expand_specs(args.single)]
    label = args.label or run_dirs[0].name
    if args.out:
        out_path = Path(args.out)
        if out_path.is_dir():
            out_path = out_path / "report.html"
    else:
        out_path = run_dirs[0] / f"report_{label}.html"
    result = render_single_report(
        run_dirs,
        out_path=out_path,
        locale=args.locale,
        label=args.label,
        exclude_ids=exclude_ids,
        drop_error=not args.keep_error,
        keywords=args.exclude_keyword,
        dataset_path=args.dataset,
    )
    logger.info("single-run report → {}", result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
