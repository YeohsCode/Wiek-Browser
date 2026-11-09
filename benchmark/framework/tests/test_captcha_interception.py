"""CAPTCHA interception: sentinel detection, prompt injection, and judge exclusion."""

from __future__ import annotations

from pathlib import Path

import pytest

from wiek_bench import captcha
from wiek_bench.datasets.base import BenchmarkTask
from wiek_bench.prompts import render_task_prompt

import run_judge


def _task(benchmark: str) -> BenchmarkTask:
    return BenchmarkTask(task_id="t-1", benchmark=benchmark, instruction="Find the result.")


# --- sentinel detection -------------------------------------------------------


@pytest.mark.parametrize(
    "final_output",
    [
        "[CAPTCHA_BLOCKED] redfin.com Cloudflare Turnstile",
        # The whole point of the line-scoped match: coexists with the FINAL ANSWER opener
        # the same template requires.
        "FINAL ANSWER: could not finish.\n[CAPTCHA_BLOCKED] redfin.com Cloudflare Turnstile",
        "**[CAPTCHA_BLOCKED]** redfin.com Cloudflare Turnstile",
        "- [captcha_blocked] redfin.com Cloudflare Turnstile",
        "Findings below.\n\n  [CAPTCHA_BLOCKED] redfin.com Cloudflare Turnstile\n\nDone.",
    ],
)
def test_sentinel_line_is_detected(final_output: str) -> None:
    detail = captcha.detail_from_final_output(final_output)

    assert detail == "redfin.com Cloudflare Turnstile"


@pytest.mark.parametrize(
    "final_output",
    [
        "",
        "FINAL ANSWER: no CAPTCHA appeared; the listing is $1.2M",
        "FINAL ANSWER: I passed the CAPTCHA and found 3 listings",
        # The failure mode that killed the "appears anywhere" variant: the agent
        # discussing the marker rather than reporting a block.
        "FINAL ANSWER: no need to emit [CAPTCHA_BLOCKED] this time; the page loaded",
        "FINAL ANSWER: the instructions mention [CAPTCHA_BLOCKED] but I was not blocked",
    ],
)
def test_narration_about_the_marker_is_not_interception(final_output: str) -> None:
    assert captcha.detail_from_final_output(final_output) is None


def test_sentinel_without_detail_still_intercepts() -> None:
    assert captcha.detail_from_final_output("[CAPTCHA_BLOCKED]") is not None


def test_is_blocked_reads_the_record_field_not_the_error() -> None:
    assert captcha.is_blocked({"blocked_by_captcha": True})
    assert not captcha.is_blocked({"blocked_by_captcha": False})
    assert not captcha.is_blocked({})
    # An error row is a broken measurement, never an interception.
    assert not captcha.is_blocked({"error": "task timeout after 900s"})


# --- benchmark scope ----------------------------------------------------------


def test_benchmarks_scored_on_captchas_are_excluded() -> None:
    assert captcha.intercepts("real-world-bench")
    assert captcha.intercepts("odysseys")
    assert not captcha.intercepts("stealth-bench")
    assert not captcha.intercepts("bu-bench")


@pytest.mark.parametrize("benchmark", ["real-world-bench", "odysseys"])
def test_prompt_carries_the_sentinel_for_intercepted_benchmarks(benchmark: str) -> None:
    rendered = render_task_prompt(_task(benchmark), browser_tool="wiek-browser")

    assert captcha.SENTINEL in rendered


@pytest.mark.parametrize("benchmark", sorted(captcha.EXCLUDED_BENCHMARKS))
def test_prompt_omits_the_sentinel_for_excluded_benchmarks(benchmark: str) -> None:
    """An excluded benchmark must never be asked for a marker Stage A ignores."""
    rendered = render_task_prompt(_task(benchmark), browser_tool="wiek-browser")

    assert captcha.SENTINEL not in rendered


# --- Stage B exclusion --------------------------------------------------------


def _records() -> list[dict[str, object]]:
    return [
        {"task_id": "ok", "error": None},
        {"task_id": "broken", "error": "task timeout after 900s"},
        {"task_id": "walled", "error": None, "blocked_by_captcha": True,
         "captcha_detail": "redfin.com Cloudflare Turnstile"},
    ]


@pytest.mark.parametrize(
    "selector",
    ["rejudge_all", "rejudge_failed", "rejudge_errors", None],
)
def test_bulk_judge_selectors_skip_intercepted_tasks(tmp_path: Path, selector: str | None) -> None:
    flags = {"rejudge_all": False, "rejudge_failed": False, "rejudge_errors": False}
    if selector:
        flags[selector] = True

    targets = run_judge._select_targets(
        _records(), tmp_path, alt_model=None, **flags
    )

    assert "walled" not in {str(rec["task_id"]) for rec in targets}


def test_naming_an_intercepted_task_still_judges_it(tmp_path: Path) -> None:
    """An operator who decides an interception was wrong can force the task through."""
    targets = run_judge._select_targets(
        _records(),
        tmp_path,
        rejudge_all=False,
        rejudge_failed=False,
        rejudge_errors=False,
        rejudge_task_ids={"walled"},
        alt_model=None,
    )

    assert [str(rec["task_id"]) for rec in targets] == ["walled"]


# --- downstream accounting ----------------------------------------------------


def test_intercepted_task_is_not_an_error_anywhere_downstream(tmp_path: Path) -> None:
    """The whole point of the dedicated field: resume, error counts, and the report's
    drop_error filter must all see a clean, completed task."""
    import json

    from wiek_bench.metrics import aggregate_summary
    from wiek_bench.report.compare import filter_samples, load_group
    from wiek_bench.results import task_already_done

    run = tmp_path / "run_x"
    run.mkdir()

    def _session(name: str, final_text: str) -> str:
        path = run / f"{name}.jsonl"
        entries = [
            {"type": "session", "version": 3, "id": name, "timestamp": "2026-07-25T00:00:00Z"},
            {"type": "message", "timestamp": "2026-07-25T00:01:00Z",
             "message": {"role": "assistant", "stopReason": "stop",
                         "content": [{"type": "text", "text": final_text}]}},
        ]
        path.write_text("".join(json.dumps(e) + "\n" for e in entries), encoding="utf-8")
        return str(path)

    rows = [
        {"task_id": "ok-1", "benchmark": "real-world-bench", "error": None, "verdict": True,
         "score": 1.0, "started_at": "2026-07-25T00:00:00+00:00",
         "ended_at": "2026-07-25T00:02:00+00:00",
         "session_file": _session("ok-1", "FINAL ANSWER: the listing is $412,000")},
        {"task_id": "walled-1", "benchmark": "real-world-bench", "error": None,
         "blocked_by_captcha": True, "captcha_detail": "redfin.com Cloudflare Turnstile",
         "started_at": "2026-07-25T00:00:00+00:00", "ended_at": "2026-07-25T00:01:00+00:00",
         "session_file": _session(
             "walled-1",
             "FINAL ANSWER: could not retrieve listings.\n"
             "[CAPTCHA_BLOCKED] redfin.com Cloudflare Turnstile",
         )},
    ]
    (run / "tasks.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    meta = {"run_id": "run_x", "benchmark": "real-world-bench"}
    (run / "run_metadata.json").write_text(json.dumps(meta))

    # resume: no error → already done, so it is not silently re-run.
    assert task_already_done(run, "walled-1")

    summary = aggregate_summary(run, meta)
    assert summary["provider_error_count"] == 0
    assert summary["captcha_blocked_count"] == 1
    assert summary["completed_tasks"] == 2
    # Counted in the denominator: a wall means the result was not delivered.
    assert summary["success_rate"] == 0.5

    # report: survives drop_error and reaches the sample list carrying the badge flag.
    group = load_group([run], "base")
    kept, dropped = filter_samples(group.samples, exclude_ids=set(), drop_error=True, keywords=[])
    walled = next(s for s in kept if s.task_id == "walled-1")
    assert walled.blocked_by_captcha
    assert walled.captcha_detail == "redfin.com Cloudflare Turnstile"
    assert not dropped
