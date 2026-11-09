"""The report row payload is the only bridge between a judged record and the badges
the single-run template renders — a flag missing here is a badge that never fires."""

from __future__ import annotations

from typing import Any

from wiek_bench.report.compare import _row_side, _sample_from_record
from wiek_bench.report.template_single import TEMPLATE


def _side(rec: dict[str, Any]) -> dict[str, Any]:
    return _row_side(_sample_from_record(rec, "run-x", None), "run-x")


def test_bu_bench_judge_flags_reach_the_sample_badges() -> None:
    """Only the bu-bench and stealth-bench judges set these, and the template reads
    them by these exact names — assert both ends so a rename on either side trips."""
    side = _side({"task_id": "t-1", "reached_captcha": True, "impossible_task": True})

    assert side["reached_captcha"] is True
    assert side["impossible_task"] is True
    assert "b.reached_captcha" in TEMPLATE
    assert "b.impossible_task" in TEMPLATE


def test_other_judges_leave_the_flags_unset() -> None:
    """No key on the record → None in the payload → falsy in the template → no badge."""
    side = _side({"task_id": "t-1", "verdict": True})

    assert side["reached_captcha"] is None
    assert side["impossible_task"] is None
