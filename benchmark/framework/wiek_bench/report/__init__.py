"""Report layer (Stage C): single-run report + session HTML export."""

from __future__ import annotations

from .compare import render_single_report
from .screenshots_html import export_run_screenshots_html
from .session_html import (
    export_run_judge_sessions,
    export_run_judge_sessions_async,
    export_run_sessions,
    export_run_sessions_async,
)

__all__ = [
    "export_run_judge_sessions",
    "export_run_judge_sessions_async",
    "export_run_screenshots_html",
    "export_run_sessions",
    "export_run_sessions_async",
    "render_single_report",
]
