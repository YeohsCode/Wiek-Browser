"""Export bundles (single-run report / session HTML) → zip → downloads dir.

Both modes copy (never move) into the downloads directory so runs/ originals stay.
These are sync helpers; call them from a worker thread (asyncio.to_thread) so the
internal asyncio.run for session export does not collide with the FastAPI loop.
"""

from __future__ import annotations

import time
import zipfile
from pathlib import Path

from wiek_bench.report.compare import render_single_report
from wiek_bench.report.i18n import DEFAULT_REPORT_LOCALE, ReportLocale
from wiek_bench.report.session_html import export_run_sessions


def resolve_downloads_dir(configured: str | None) -> Path:
    if configured:
        return Path(configured).expanduser()
    return Path.home() / "Downloads"


def _ensure_sessions_html(run_dir: Path) -> Path:
    sessions = run_dir / "sessions_html"
    if not sessions.exists() or not any(sessions.glob("*.html")):
        export_run_sessions(run_dir)
    return sessions


def _stamp() -> str:
    return time.strftime("%Y%m%d_%H%M%S")


def export_sessions_bundle(run_dirs: list[Path], downloads_dir: Path) -> Path:
    downloads_dir.mkdir(parents=True, exist_ok=True)
    zip_path = downloads_dir / f"wiek_sessions_{_stamp()}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for run_dir in run_dirs:
            sessions = _ensure_sessions_html(run_dir)
            for html_file in sessions.glob("*.html"):
                zf.write(html_file, arcname=f"{run_dir.name}/{html_file.name}")
    return zip_path


def build_single_report(
    run_dirs: list[Path],
    *,
    exclude_ids: set[str] | None = None,
    locale: ReportLocale = DEFAULT_REPORT_LOCALE,
) -> Path:
    """Render the single-run report HTML into the first run directory without a zip.

    Just the render half of export_single_bundle: the file lands in runs/<id>/ where
    the Artifacts scan picks it up, without copying anything to the downloads directory.
    """
    report_host = run_dirs[0]
    report_html = report_host / f"report_{report_host.name}.html"
    render_single_report(
        run_dirs,
        out_path=report_html,
        exclude_ids=exclude_ids,
        locale=locale,
    )
    return report_html


def export_single_bundle(
    run_dirs: list[Path],
    downloads_dir: Path,
    *,
    exclude_ids: set[str] | None = None,
    locale: ReportLocale = DEFAULT_REPORT_LOCALE,
) -> Path:
    """Single-run report (one or more runs merged into one pool) + session HTML → zip.

    Uses one pool without baseline/test pairing.
    """
    downloads_dir.mkdir(parents=True, exist_ok=True)
    stamp = _stamp()
    report_host = run_dirs[0]
    report_html = build_single_report(
        run_dirs,
        exclude_ids=exclude_ids,
        locale=locale,
    )
    zip_path = downloads_dir / f"wiek_report_{stamp}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(report_html, arcname=f"{report_host.name}/{report_html.name}")
        for run_dir in dict.fromkeys(run_dirs):
            sessions = _ensure_sessions_html(run_dir)
            for html_file in sessions.glob("*.html"):
                zf.write(html_file, arcname=f"{run_dir.name}/sessions_html/{html_file.name}")
    return zip_path
