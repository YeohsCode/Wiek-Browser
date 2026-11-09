#!/usr/bin/env python
"""Stage A — sample tasks, drive the selected provider, capture, tear down, record.

The provider's native session JSONL stays the source of truth; this script writes only
tasks.jsonl + run_metadata.json + screenshots, then optionally triggers Stage B/C.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import shutil
import signal
import sys
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from loguru import logger
from pydantic import ValidationError

from wiek_bench.adhoc import (
    adhoc_is_active,
    build_adhoc_tasks,
    normalize_adhoc_node,
    text_tasks_to_entries,
)
from wiek_bench import captcha, wiek_release
from wiek_bench.browser_tools.wiek_browser import (
    WiekBrowserTool,
    probe_runtime_contract,
    validate_skill_runtime_contract,
)
from wiek_bench.cleanup import maybe_close_after_run
from wiek_bench.codex_pricing import fetch_codex_pricing_snapshot
from wiek_bench.config import HarnessConfig, load_config
from wiek_bench.datasets import BenchmarkTask, get_adapter
from wiek_bench.progress import ProgressReporter
from wiek_bench.prompts import render_task_prompt
from wiek_bench.providers import (
    AgentProvider,
    AgentRunResult,
    CODEX_PROJECT_MARKER,
    CodexAgentSpec,
    CodexProvider,
    PiAgentSpec,
    PiProvider,
    kill_all_pi_processes,
    prepare_codex_home,
    resolve_codex_runtime,
    validate_codex_reasoning_effort,
    verify_codex_context_isolation,
)
from wiek_bench.results import (
    TaskAttemptRecord,
    TaskRecord,
    append_task_record,
    latest_by_task_id,
    task_already_done,
    write_task_attempt_records,
)
from wiek_bench import run_liveness, task_resources
from wiek_bench.runspace import TaskRunspace, make_task_runspace, merge_env
from wiek_bench.screenshotter import compress_frames, load_frames
from wiek_bench.session_parser import safe_parse
from wiek_bench.skills import compute_file_hash, resolve_skill_path, skill_name_from_path


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def resolve_pi_home(cfg: HarnessConfig) -> Path:
    return cfg.providers.pi.resolved_home()


@dataclass
class RunContext:
    cfg: HarnessConfig
    run_id: str
    run_dir: Path
    # Execution start, stamped once here and reused by every metadata write. Deriving it
    # inside the writer instead would make the teardown write report the finish time, since
    # both writes go through the same function (rerun and resume masked that by restoring
    # the previous run's value from prev_meta; a fresh run had nothing to restore).
    started_at: str
    # Label written to run_metadata.benchmark and used in run_id; "adhoc" on the
    # dataset-less bypass, else cfg.run.benchmark.
    benchmark: str
    # {tasks: [...]} when adhoc (provenance + WebUI reuse), else None.
    adhoc: dict[str, Any] | None
    browser_tool_name: str
    skill_path: str
    skill_hash: str | None
    # Freeze the effective wiek-browser release at run start, using the same
    # timestamp boundary as skill_hash. Other browser tools store None.
    wiek_browser_release: dict[str, Any] | None
    pi_bin: str
    pi_agent_dir: Path
    codex_bin: str | None
    codex_home: Path | None
    codex_pricing: dict[str, Any] | None
    provider_name: str
    model: str
    model_provider: str
    reasoning_level: str
    agent_workdir: Path
    provider_env: dict[str, str]
    max_turns: int | None
    capture_stderr: bool
    harness_root: str
    python_exe: str
    progress: ProgressReporter
    provider: AgentProvider
    # Selective force-rerun set; empty for normal runs. Tasks in this set
    # bypass the resume-skip and force-overwrite their prior tasks.jsonl rows.
    rerun_task_ids: set[str]
    runtime_drift_error: str | None = None


def _effective_limits(cfg: HarnessConfig) -> tuple[float, int | None]:
    lim = cfg.limits
    # Step mode combines a wall-clock backstop with event-based turn enforcement.
    # Time mode uses task_timeout_seconds without a turn limit.
    if lim.mode == "steps":
        wall_clock_s = lim.step_mode_backstop_seconds
        max_turns = lim.max_turns
    else:
        wall_clock_s = lim.task_timeout_seconds
        max_turns = None
    return wall_clock_s, max_turns


def historical_runtime_mismatch(previous_metadata: dict[str, Any], current: dict[str, Any]) -> str | None:
    """Return why resume/rerun would not be reusing the runtime the run was recorded
    against, or None when the active one still matches.

    Not a verdict on its own: the caller decides. Stage A refuses by default and proceeds
    under ``--allow-runtime-mismatch``; the WebUI calls this BEFORE spawning so the
    request itself can ask the user to confirm, rather than killing the subprocess
    invisibly. Its ``current`` snapshot is the un-probed one from
    ``wiek_release.run_metadata_entry`` (probing costs a browser launch), so the contract
    comparison runs only when both sides know their contract."""
    if not previous_metadata:
        return None
    previous = previous_metadata.get("wiek_browser_release")
    if not isinstance(previous, dict):
        return "existing wiek-browser run has no wiek_browser_release snapshot"
    previous_sha = previous.get("index_js_sha256")
    current_sha = current.get("index_js_sha256")
    if not previous_sha or previous_sha != current_sha:
        return (
            "wiek-browser runtime sha256 differs from the existing run: "
            f"previous={previous_sha}, current={current_sha}"
        )
    previous_contract = previous.get("runtime_contract")
    current_contract = current.get("runtime_contract")
    if previous_contract and current_contract and previous_contract != current_contract:
        return (
            "wiek-browser runtime contract differs from the existing run: "
            f"previous={previous_contract}, current={current_contract}"
        )
    return None


def _prepare_wiek_browser_runtime(
    cfg: HarnessConfig,
    *,
    skill_path: Path,
    expected_skill_hash: str | None,
    previous_metadata: dict[str, Any],
    allow_runtime_mismatch: bool = False,
) -> tuple[dict[str, Any], str, str | None]:
    """Snapshot, probe, and validate the one runtime contract used by this Stage A.

    Returns the snapshot, the skill hash, and the historical mismatch the caller accepted
    — None unless ``allow_runtime_mismatch`` let a differing runtime through, in which case
    the run must record that this leg no longer shares one runtime with the earlier ones."""
    snapshot = wiek_release.run_metadata_entry(cfg.wiek_browser)
    sdk_path = snapshot.get("index_js_realpath")
    if not sdk_path:
        raise RuntimeError("no active wiek-browser runtime index.js")
    tool = WiekBrowserTool()
    runtime_contract = probe_runtime_contract(bin_path=tool.bin(), sdk_path=sdk_path)
    skill_contract = validate_skill_runtime_contract(
        skill_path=skill_path,
        sdk_path=sdk_path,
        runtime_contract=runtime_contract,
    )
    snapshot["runtime_contract"] = runtime_contract.value
    snapshot["skill_runtime_contract"] = skill_contract.value if skill_contract else None
    # Catch an external rebuild that raced the read-only probe itself.
    wiek_release.assert_runtime_snapshot(cfg.wiek_browser, snapshot)
    current_skill_hash = compute_file_hash(skill_path)
    if expected_skill_hash is not None and current_skill_hash != expected_skill_hash:
        raise RuntimeError(
            "wiek-browser SKILL changed between provider setup and runtime preflight: "
            f"before={expected_skill_hash}, current={current_skill_hash}"
        )
    mismatch = historical_runtime_mismatch(previous_metadata, snapshot)
    if mismatch is not None:
        if not allow_runtime_mismatch:
            raise RuntimeError(mismatch)
        logger.warning("wiek-browser runtime mismatch accepted by the caller: {}", mismatch)
    return snapshot, current_skill_hash, mismatch


def _runtime_is_stable(ctx: RunContext) -> bool:
    """Task-boundary guard; first drift wins and prevents future task starts."""
    if ctx.wiek_browser_release is None:
        return True
    if ctx.runtime_drift_error is not None:
        return False
    try:
        wiek_release.assert_runtime_snapshot(ctx.cfg.wiek_browser, ctx.wiek_browser_release)
    except wiek_release.RuntimeDriftError as exc:
        ctx.runtime_drift_error = str(exc)
        logger.error("{}", ctx.runtime_drift_error)
        return False
    return True


@dataclass
class ProviderSetup:
    provider: AgentProvider
    name: str
    model: str
    model_provider: str
    reasoning_level: str
    workdir: Path
    env: dict[str, str]
    max_turns: int | None
    capture_stderr: bool
    codex_bin: str | None = None
    codex_home: Path | None = None


def _prepare_provider(
    cfg: HarnessConfig,
    *,
    pi_bin: str,
    pi_agent_dir: Path,
    skill_path: Path,
    python_exe: str,
) -> ProviderSetup:
    wall_clock_s, max_turns = _effective_limits(cfg)
    if cfg.run.provider == "pi":
        workdir = pi_agent_dir / "workspace"
        if workdir.exists():
            shutil.rmtree(workdir, ignore_errors=True)
        workdir.mkdir(parents=True, exist_ok=True)
        spec = PiAgentSpec(
            pi_bin=pi_bin,
            provider=cfg.providers.pi.provider,
            model=cfg.providers.pi.model,
            thinking_level=cfg.providers.pi.thinking_level,
            allowed_tools=cfg.providers.pi.resolved_tools(),
            skill_path=str(skill_path),
            task_timeout_s=wall_clock_s,
            max_turns=max_turns,
            capture_stderr=cfg.providers.pi.debug.capture_stderr,
        )
        return ProviderSetup(
            provider=PiProvider(spec),
            name="pi",
            model=spec.model,
            model_provider=spec.provider,
            reasoning_level=spec.thinking_level,
            workdir=workdir,
            env={"PI_CODING_AGENT_DIR": str(pi_agent_dir)},
            max_turns=max_turns,
            capture_stderr=spec.capture_stderr,
        )

    codex_cfg = cfg.providers.codex
    # Codex has no PreToolUse guard equivalent: strict/loose would
    # silently run inject-only while promising command-level enforcement.
    if cfg.run.browser_tool_mode != "off":
        raise ValueError(
            'provider=codex requires browser_tool_mode="off": the browser-tool '
            f"guard is Pi-only, got {cfg.run.browser_tool_mode!r}"
        )
    validate_codex_reasoning_effort(codex_cfg.reasoning_effort)
    bin_override = os.environ.get(codex_cfg.bin_env) or codex_cfg.bin_default
    codex_runtime = resolve_codex_runtime(bin_override)
    codex_home = codex_cfg.resolved_home()
    installed_skill = prepare_codex_home(codex_home, skill_path)
    workdir = codex_home / "workspace"
    if workdir.exists():
        shutil.rmtree(workdir, ignore_errors=True)
    workdir.mkdir(parents=True, exist_ok=True)
    (workdir / CODEX_PROJECT_MARKER).write_text("managed root\n", encoding="utf-8")
    real_home = os.environ.get("HOME") or str(Path.home())
    isolated_home = codex_home / "isolated-home"
    isolated_home.mkdir(parents=True, exist_ok=True)
    selected_skill_name = skill_name_from_path(installed_skill)
    verify_codex_context_isolation(
        codex_bin=codex_runtime.executable,
        codex_home=codex_home,
        workdir=workdir,
        real_home=real_home,
        expected_skill_name=selected_skill_name,
    )
    spec = CodexAgentSpec(
        codex_bin=codex_runtime.sdk_bin,
        codex_home=str(codex_home),
        model=codex_cfg.model,
        reasoning_effort=codex_cfg.reasoning_effort,
        skill_name=selected_skill_name,
        skill_path=str(installed_skill),
        task_timeout_s=wall_clock_s,
        python_exe=python_exe,
        real_home=real_home,
        service_tier=codex_cfg.service_tier,
        max_turns=max_turns,
    )
    return ProviderSetup(
        provider=CodexProvider(spec),
        name="codex",
        model=spec.model,
        model_provider="openai",
        reasoning_level=spec.reasoning_effort,
        workdir=workdir,
        env={"CODEX_HOME": str(codex_home), "HOME": str(isolated_home)},
        max_turns=max_turns,
        capture_stderr=False,
        codex_bin=codex_runtime.executable,
        codex_home=codex_home,
    )


async def _execute_task(
    ctx: RunContext,
    task: BenchmarkTask,
    *,
    concurrency_slot: int,
) -> TaskRecord:
    cfg = ctx.cfg
    runspace = make_task_runspace(
        run_id=ctx.run_id,
        task_id=task.task_id,
        run_dir=ctx.run_dir,
        browser_tool=ctx.browser_tool_name,
        browser_tool_mode=cfg.run.browser_tool_mode,
        harness_root=ctx.harness_root,
        workdir=ctx.agent_workdir,
        python_exe=ctx.python_exe,
        wiek_browser_runtime_contract=(
            str(ctx.wiek_browser_release.get("runtime_contract"))
            if ctx.wiek_browser_release is not None
            else None
        ),
        wiek_browser_sdk_path=(
            str(ctx.wiek_browser_release.get("index_js_realpath"))
            if ctx.wiek_browser_release is not None
            else None
        ),
        provider_env=ctx.provider_env,
        bin_env=cfg.browser_tool_cfg(ctx.browser_tool_name).bin_env,
        attachments=task_resources.resolve_attachments(task),
    )
    # A new task lifecycle owns a fresh attempt sequence. Reset immediately so a
    # resumed prior error cannot leave stale provenance visible if this lifecycle
    # crashes before its first provider result.
    write_task_attempt_records(ctx.run_dir, task.task_id, [])


    prompt = render_task_prompt(
        task,
        browser_tool=ctx.browser_tool_name,
        template=cfg.prompts.task_template,
        attachments=[str(p) for p in runspace.attachment_paths],
    )
    env = merge_env(runspace)

    session_file_box: dict[str, str] = {}

    def _on_session_file(path: str) -> None:
        # Called once the provider secures sessionFile from get_state;
        # re-fires on retry when a fresh session replaces the failed one.
        if session_file_box.get("path") != path:
            session_file_box["path"] = path
            ctx.progress.session_known(task.task_id, path)

    result = None
    attempts = 0
    failure: str | None = None
    attempt_records: list[TaskAttemptRecord] = []
    # In step mode, the turns poller also enforces the step limit by setting
    # stop_event once on-disk num_turns reaches the cap, which the provider races against
    # run_prompt to stop pi cleanly. The poller + stop_event are created PER ATTEMPT, not
    # once per task: a retry spawns a fresh session, and a poller/event shared across
    # attempts can carry a prior attempt's "reached max_turns" set into the next run — the
    # poller's safe_parse await lets a stale read re-set the event right after a clear —
    # falsely tripping step_limit_hit on the retry. Per-attempt lifetime isolates each run;
    # the poller is cancelled before the next attempt (or teardown) so it can never touch a
    # later attempt's event/session.
    for attempt in range(cfg.run.retry_count + 1):
        attempts = attempt + 1
        if attempts > 1:
            # Refresh the live retry count for the WebUI progress page.
            ctx.progress.task_attempt(task.task_id, attempt=attempts)
        # Drop the prior attempt's session pointer before this attempt's poller starts,
        # so the poller only ever observes this attempt's session (the failed session
        # file lingers on disk — _isolate drops frames, not the session JSONL).
        session_file_box.pop("path", None)
        stop_event = asyncio.Event() if ctx.max_turns is not None else None
        # Count complete turn_end events and set stop_event at max_turns so the
        # provider stops before the next LLM call. Disk polling and the wall-clock
        # backstop remain fallbacks for missing events or stalled agents.
        on_event = _step_limit_on_event(ctx.progress.on_event, ctx.max_turns, stop_event)
        poller = (
            asyncio.create_task(
                _poll_turns(
                    ctx,
                    task.task_id,
                    session_file_box,
                    max_turns=ctx.max_turns,
                    stop_event=stop_event,
                )
            )
            if (ctx.progress.emits_events or ctx.max_turns is not None)
            else None
        )
        try:
            result = await ctx.provider.run(
                task_id=task.task_id,
                prompt=prompt,
                cwd=runspace.workdir,
                env=env,
                on_event=on_event,
                on_session_file=_on_session_file,
                stderr_path=runspace.pi_stderr_path,
                stop_event=stop_event,
            )
        finally:
            if poller is not None:
                poller.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await poller
        if result.step_limit_hit:
            # A reached step limit is a clean stop, not a retryable failure;
            # judge the partial session as-is.
            failure = None
            attempt_records.append(
                TaskAttemptRecord(
                    task_id=task.task_id,
                    attempt_index=attempts,
                    session_id=result.session_id,
                    session_file=result.session_file,
                    started_at=result.started_at,
                    ended_at=result.ended_at,
                    provider_error=result.error,
                    failure_reason=None,
                    step_limit_hit=True,
                )
            )
            write_task_attempt_records(ctx.run_dir, task.task_id, attempt_records)
            break
        # Priority: provider error, abnormal session stop, then empty output.
        failure = (
            result.error
            or await asyncio.to_thread(_stop_reason_failure, result)
            or await asyncio.to_thread(_empty_output_failure, result)
        )
        attempt_records.append(
            TaskAttemptRecord(
                task_id=task.task_id,
                attempt_index=attempts,
                session_id=result.session_id,
                session_file=result.session_file,
                started_at=result.started_at,
                ended_at=result.ended_at,
                provider_error=result.error,
                failure_reason=failure,
                step_limit_hit=False,
            )
        )
        # Persist after every completed provider lifecycle so a later harness crash
        # does not orphan an already-finished failed attempt.
        write_task_attempt_records(ctx.run_dir, task.task_id, attempt_records)
        if failure is None:
            break
        if attempt < cfg.run.retry_count:
            logger.warning(
                "task {} attempt {}/{} failed ({}); retrying",
                task.task_id,
                attempts,
                cfg.run.retry_count + 1,
                failure,
            )
            await _isolate_failed_attempt(ctx, runspace, task, failure)

    assert result is not None
    if failure is not None and result.error is None:
        # empty output / session-internal abnormal stop exhausted retries: their
        # result.error is empty, so synthesize it (keeping the provider_transport_failure:
        # prefix) for resume, Stage B, and transport-failure counting.
        result.error = f"{failure} after {attempts} attempt(s)"
    # Read only from a clean run: a contaminated session's final message says nothing
    # reliable about why the task ended. Evaluated outside the retry loop because a wall
    # is a terminal outcome, not a retryable failure — re-running hits the same wall.
    captcha_detail = (
        await asyncio.to_thread(_captcha_detail, result)
        if result.error is None and captcha.intercepts(task.benchmark)
        else None
    )
    closed_by, close_rc = await asyncio.to_thread(
        maybe_close_after_run,
        runspace=runspace,
        browser_tool=ctx.browser_tool_name,
        task_id=task.task_id,
        provider_error=result.error,
        python_exe=ctx.python_exe,
        harness_root=ctx.harness_root,
        timeout_seconds=15.0,
    )

    # Frames were already deduplicated incrementally at capture time. Teardown transcodes
    # the kept PNGs to full-res WebP (q90) — outside the timed loop — then collects the unique
    # frame paths and the command-to-screenshot manifest.
    compress_frames(runspace.frames_dir)
    selection = load_frames(runspace.frames_dir)

    return TaskRecord(
        task_id=task.task_id,
        benchmark=task.benchmark,
        category=task.category,
        provider=ctx.provider_name,
        browser_tool=ctx.browser_tool_name,
        skill_name=cfg.browser_tool_cfg(ctx.browser_tool_name).skill_name,
        skill_file_hash_at_task_start=ctx.skill_hash,
        base_task_id=task.metadata.get("base_task_id", task.task_id),
        iteration_index=task.metadata.get("iteration_index", 1),
        session_id=result.session_id,
        session_file=result.session_file,
        started_at=result.started_at,
        ended_at=result.ended_at,
        attempt_count=attempts,
        concurrency_slot=concurrency_slot,
        close_executed_by=closed_by,
        close_returncode=close_rc,
        screenshot_capture_mode=cfg.screenshots.capture_mode,
        screenshot_dedup_method=cfg.screenshots.dedup_method,
        screenshot_max_judge=cfg.judge.max_screenshots,
        screenshot_paths=[str(p) for p in selection.frame_paths],
        screenshot_manifest=str(selection.manifest_path) if selection.manifest_path else None,
        screenshot_errors=str(selection.errors_path) if selection.errors_path else None,
        # Derive the AX-tree directory from any retained tree; legacy runs may have none.
        screenshot_trees_dir=str(selection.tree_paths[0].parent) if selection.tree_paths else None,
        pi_stderr_path=(str(runspace.pi_stderr_path) if ctx.capture_stderr else None),
        error=result.error,
        blocked_by_captcha=captcha_detail is not None,
        captcha_detail=captcha_detail,
    )


def _session_turns(record: TaskRecord) -> int | None:
    """Return session num_turns for an emitted done/fail progress event."""
    if not record.session_file:
        return None
    stats = safe_parse(record.session_file)
    return None if stats.parse_error else stats.num_turns


def _step_limit_on_event(
    inner: Callable[[dict[str, Any]], None] | None,
    max_turns: int | None,
    stop_event: asyncio.Event | None,
) -> Callable[[dict[str, Any]], None] | None:
    """Wrap progress events with hard, event-driven turn-limit enforcement.

    A ``turn_end`` marks a complete assistant turn including its tool calls and
    results. Setting ``stop_event`` at ``max_turns`` lets the provider abort before
    the next LLM call without interrupting an allowed turn. The count matches
    ``session_parser.num_turns``. Disk polling and the wall-clock backstop cover
    missing events or stalled agents. Non-step mode returns ``inner`` unchanged.
    """
    if max_turns is None or stop_event is None:
        return inner
    turns_done = 0

    def _cb(event: dict[str, Any]) -> None:
        nonlocal turns_done
        if event.get("type") == "turn_end":
            turns_done += 1
            if turns_done >= max_turns:
                stop_event.set()
        if inner is not None:
            inner(event)

    return _cb


async def _poll_turns(
    ctx: RunContext,
    task_id: str,
    session_file_box: dict[str, str],
    interval_s: float = 5.0,
    *,
    max_turns: int | None = None,
    stop_event: asyncio.Event | None = None,
) -> None:
    """Poll the on-disk session for a running task's live turn count.

    This is observer-only for progress; in step mode it also enforces the step limit
    by setting stop_event once num_turns reaches max_turns. Parse failures skip the beat;
    cancellation ends the loop. Turns derive solely from session_parser — never the RPC
    event stream."""
    last: int | None = None
    while True:
        await asyncio.sleep(interval_s)
        path = session_file_box.get("path")
        if not path:
            continue
        try:
            stats = await asyncio.to_thread(safe_parse, path)
        except Exception:  # noqa: BLE001
            continue
        if stats.parse_error:
            continue
        if max_turns is not None and stop_event is not None and stats.num_turns >= max_turns:
            stop_event.set()  # Stop the provider cleanly at the step limit.
        if stats.num_turns == last:
            continue
        last = stats.num_turns
        ctx.progress.task_progress(task_id, turns=stats.num_turns)


def _stop_reason_failure(result: AgentRunResult) -> str | None:
    """Session ended on an assistant message with stopReason=="error" (e.g. a
    provider_transport_failure / WebSocket drop): pi exits cleanly so result.error
    is empty, but the measurement is contaminated and must retry. Judged
    before empty output — transport failures usually blank final_output, and even a
    partial output before the drop must fail. Returns SessionStats.stop_reason_error
    (carries the provider_transport_failure: prefix) or None."""
    if not result.session_file:
        return None
    return safe_parse(result.session_file).stop_reason_error


def _captcha_detail(result: AgentRunResult) -> str | None:
    """Return the reported block detail when the agent's final message carries the
    sentinel line, else None. Only reached on an otherwise-clean run, so the session parses."""
    if not result.session_file:
        return None
    return captcha.detail_from_final_output(safe_parse(result.session_file).final_output)


def _empty_output_failure(result: AgentRunResult) -> str | None:
    """Treat empty final output as a retryable failure. Judged solely
    on final_output being blank — a partial parse that still yields text counts
    as output."""
    if not result.session_file:
        return "empty final output (no session file)"
    stats = safe_parse(result.session_file)
    if stats.final_output.strip():
        return None
    return "empty final output"


async def _isolate_failed_attempt(
    ctx: RunContext,
    runspace: TaskRunspace,
    task: BenchmarkTask,
    failure: str,
) -> None:
    """Best-effort isolation before the next attempt: close leftover browser
    instances and drop the failed attempt's frames and manifest, so only the
    final successful attempt's screenshots survive.
    close_done/<task_id>.json is overwritten by the final post-run close."""
    try:
        await asyncio.to_thread(
            maybe_close_after_run,
            runspace=runspace,
            browser_tool=ctx.browser_tool_name,
            task_id=task.task_id,
            provider_error=failure,
            python_exe=ctx.python_exe,
            harness_root=ctx.harness_root,
            timeout_seconds=15.0,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("between-attempt close failed for {}: {}", task.task_id, exc)
    try:
        for path in runspace.frames_dir.iterdir():
            if path.is_file():
                path.unlink()
    except OSError as exc:
        logger.warning("frame cleanup failed for {}: {}", task.task_id, exc)


def _crash_record(
    ctx: RunContext, task: BenchmarkTask, exc: BaseException, *, started_at: str
) -> TaskRecord:
    """Turn a harness crash into an ordinary failed row.

    ``_execute_task`` handles provider errors itself, so an exception escaping it comes
    from runspace setup or artifact teardown. Recording only a progress event would drop
    the task out of tasks.jsonl entirely while the run still writes ``completed_at``,
    which silently shrinks every denominator derived from those rows — success_rate above
    all — and makes a crashed run look better than a clean one. The row carries no
    session, so its resources fold in as zero; the error text keeps it out of
    ``task_already_done``, so resume still retries it and the retry replaces this row."""
    return TaskRecord(
        task_id=task.task_id,
        benchmark=task.benchmark,
        category=task.category,
        provider=ctx.provider_name,
        browser_tool=ctx.browser_tool_name,
        skill_name=ctx.cfg.browser_tool_cfg(ctx.browser_tool_name).skill_name,
        skill_file_hash_at_task_start=ctx.skill_hash,
        base_task_id=task.metadata.get("base_task_id", task.task_id),
        iteration_index=task.metadata.get("iteration_index", 1),
        started_at=started_at,
        ended_at=_now_iso(),
        error=f"harness crash: {exc}",
    )


async def _run_serial(ctx: RunContext, tasks: list[BenchmarkTask]) -> None:
    slot = 1
    for task in tasks:
        if (
            ctx.cfg.run.resume
            and task.task_id not in ctx.rerun_task_ids
            and task_already_done(ctx.run_dir, task.task_id)
        ):
            ctx.progress.finish_task(task.task_id, skipped=True)
            continue
        if not _runtime_is_stable(ctx):
            break
        ctx.progress.start_task(task.task_id, slot)
        task_started_at = _now_iso()
        try:
            record = await _execute_task(ctx, task, concurrency_slot=slot)
            append_task_record(
                ctx.run_dir, record, force_overwrite=task.task_id in ctx.rerun_task_ids
            )
            turns = await asyncio.to_thread(_session_turns, record)
            ctx.progress.finish_task(task.task_id, error=record.error, turns=turns)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("task {} crashed", task.task_id)
            append_task_record(
                ctx.run_dir,
                _crash_record(ctx, task, exc, started_at=task_started_at),
                force_overwrite=task.task_id in ctx.rerun_task_ids,
            )
            ctx.progress.finish_task(task.task_id, error=f"harness crash: {exc}")
        if not _runtime_is_stable(ctx):
            break
        slot += 1


async def _run_concurrent(ctx: RunContext, tasks: list[BenchmarkTask]) -> None:
    semaphore = asyncio.Semaphore(ctx.cfg.run.concurrency)
    writer_lock = asyncio.Lock()
    groups: dict[str, list[BenchmarkTask]] = {}
    for t in tasks:
        groups.setdefault(t.metadata.get("base_task_id", t.task_id), []).append(t)
    for g in groups.values():
        g.sort(key=lambda x: x.metadata.get("iteration_index", 1))

    slot_counter = {"n": 0}

    async def _group_worker(group: list[BenchmarkTask]) -> None:
        for task in group:
            if ctx.runtime_drift_error is not None:
                return
            if (
                ctx.cfg.run.resume
                and task.task_id not in ctx.rerun_task_ids
                and task_already_done(ctx.run_dir, task.task_id)
            ):
                ctx.progress.finish_task(task.task_id, skipped=True)
                continue
            async with semaphore:
                if not _runtime_is_stable(ctx):
                    return
                slot_counter["n"] += 1
                slot = slot_counter["n"]
                ctx.progress.start_task(task.task_id, slot)
                task_started_at = _now_iso()
                try:
                    record = await _execute_task(ctx, task, concurrency_slot=slot)
                    async with writer_lock:
                        append_task_record(
                            ctx.run_dir,
                            record,
                            force_overwrite=task.task_id in ctx.rerun_task_ids,
                        )
                    turns = await asyncio.to_thread(_session_turns, record)
                    ctx.progress.finish_task(task.task_id, error=record.error, turns=turns)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    logger.exception("task {} crashed", task.task_id)
                    async with writer_lock:
                        append_task_record(
                            ctx.run_dir,
                            _crash_record(ctx, task, exc, started_at=task_started_at),
                            force_overwrite=task.task_id in ctx.rerun_task_ids,
                        )
                    ctx.progress.finish_task(task.task_id, error=f"harness crash: {exc}")
                if not _runtime_is_stable(ctx):
                    return

    await asyncio.gather(*(_group_worker(g) for g in groups.values()))


def _build_tasks(cfg: HarnessConfig) -> tuple[list[BenchmarkTask], str, dict[str, Any] | None]:
    """Resolve the task source from dataset sampling or the ad-hoc bypass.

    Returns ``(tasks, benchmark_label, adhoc_node)``. A canonical or legacy ad-hoc
    node bypasses ``get_adapter`` / ``sample`` and produces the complete base-task
    snapshot written to run_metadata. Dataset runs keep the existing sampling path.
    """
    adhoc_tasks, adhoc_node, _ = build_adhoc_tasks(cfg.adhoc.model_dump())
    if adhoc_tasks:
        return adhoc_tasks, "adhoc", adhoc_node
    adapter = get_adapter(cfg.run.benchmark)
    tasks = adapter.sample(task_ids=cfg.sampling.task_ids)
    return tasks, cfg.run.benchmark, None


def _expand_iterations(tasks: list[BenchmarkTask], iterations: int) -> list[BenchmarkTask]:
    if iterations <= 1:
        return [
            replace(t, metadata={**t.metadata, "base_task_id": t.task_id, "iteration_index": 1})
            for t in tasks
        ]
    expanded: list[BenchmarkTask] = []
    for i in range(1, iterations + 1):
        for t in tasks:
            expanded.append(
                replace(
                    t,
                    task_id=f"{t.task_id}__iter{i}",
                    metadata={**t.metadata, "base_task_id": t.task_id, "iteration_index": i},
                )
            )
    return expanded


def _write_run_metadata(ctx: RunContext, tasks: list[BenchmarkTask], extra: dict[str, Any]) -> None:
    cfg = ctx.cfg
    pi_ext = ctx.pi_agent_dir / "extensions" / "wiek-bench.ts"
    metadata: dict[str, Any] = {
        "run_id": ctx.run_id,
        "benchmark": ctx.benchmark,
        "provider": ctx.provider_name,
        "browser_tool": ctx.browser_tool_name,
        "browser_tool_mode": cfg.run.browser_tool_mode,
        "skill_name": cfg.browser_tool_cfg(ctx.browser_tool_name).skill_name,
        "skill_source_path": ctx.skill_path,
        "skill_file_hash": ctx.skill_hash,
        "pi_extension_file_hash": compute_file_hash(pi_ext) if pi_ext.exists() else None,
        "pi_bin": ctx.pi_bin,
        "pi_provider": cfg.providers.pi.provider if ctx.provider_name == "pi" else None,
        "model_provider": ctx.model_provider,
        "model": ctx.model,
        "thinking_level": ctx.reasoning_level,
        "providers": {
            "pi": {
                "tool_profile": cfg.providers.pi.tool_profile,
                "allowed_tools": cfg.providers.pi.resolved_tools(),
            },
            "codex": {
                "codex_home": str(ctx.codex_home) if ctx.codex_home else None,
                "reasoning_effort": cfg.providers.codex.reasoning_effort,
                "service_tier": cfg.providers.codex.service_tier,
            },
        },
        "pi_agent_dir": str(ctx.pi_agent_dir),
        "agent_home": str(ctx.pi_agent_dir.parent.parent),
        "codex_bin": ctx.codex_bin,
        "codex_home": str(ctx.codex_home) if ctx.codex_home else None,
        "codex_pricing": ctx.codex_pricing,
        "judge_provider": cfg.judge.provider,
        "judge_model": cfg.judge.model,
        # global-default channel (fallback for payloads missing per-payload fields). Mirror
        # the per-payload rule: single mode carries no tools/skill (run_judge._judge_one).
        "judge_mode": cfg.judge.mode,
        "judge_tools": cfg.judge.resolved_agent_tools() if cfg.judge.mode == "agent" else [],
        "judge_skill_path": (
            str(ctx.pi_agent_dir / "skills" / cfg.judge.skill_name)
            if cfg.judge.mode == "agent"
            else None
        ),
        "concurrency": cfg.run.concurrency,
        "iterations": cfg.run.iterations,
        "auto_judge": cfg.run.auto_judge,
        # WebUI hero pill needs to know a run HAS an export stage to label the post-Stage-A
        # window as "exporting" or "judging": export_run_sessions runs only when this
        # is on, so progress() gates the exporting pill on it (missing → defaults true).
        "auto_export_sessions": cfg.run.auto_export_sessions,
        # Freeze limits so WebUI reuse and selective reruns do not silently fall
        # back to default step or time settings.
        "limits": cfg.limits.model_dump(),
        "task_count_planned": len(tasks),
        # The complete planned task-id list is the run's authoritative boundary.
        # Exact set comparison after resume sampling catches same-count identity
        # drift that count-only checks miss. Composite ids include iteration suffixes.
        # During rerun, `tasks` is only a subset, so restore this field from prior
        # metadata rather than deriving a narrower boundary.
        "planned_task_ids": None if ctx.rerun_task_ids else [t.task_id for t in tasks],
        # Freeze the selection so adapter.sample rebuilds the same set on resume.
        "task_ids": cfg.sampling.task_ids,
        # Who launched this execution: "webui" when the console spawned it, else "cli".
        # Frozen here so the Runs list can label provenance long after run.pid is stale.
        "origin": run_liveness.run_origin(),
        # Frozen on the context, not stamped here: this function runs twice per execution.
        # Rerun and resume override it through `extra` to keep the original run's start.
        "started_at": ctx.started_at,
    }
    if ctx.adhoc is not None:
        metadata["adhoc"] = ctx.adhoc
    # Reuse the release snapshot frozen at run start for both metadata writes;
    # recomputing at teardown could capture a later symlink state.
    if ctx.wiek_browser_release is not None:
        metadata["wiek_browser_release"] = ctx.wiek_browser_release
    metadata.update(extra)
    (ctx.run_dir / "run_metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _mark_judging_started(run_dir: Path) -> None:
    """Mark auto-judge startup in run metadata for immediate WebUI feedback.

    progress() can then show a zero-complete judge placeholder before the first
    judge artifact lands. This best-effort marker affects display only. Full
    metadata rewrites omit it, so a rerun naturally clears the previous marker.
    """
    meta_path = run_dir / "run_metadata.json"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["judging_started_at"] = _now_iso()
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.warning("failed to mark judging_started_at: {}", exc)


def _build_rerun_tasks(
    cfg: HarnessConfig,
    run_dir: Path,
    rerun_ids: set[str],
    prev_meta: dict[str, Any],
) -> list[BenchmarkTask]:
    """Reconstruct exactly the requested rerun tasks from the dataset adapter + this
    run's own tasks.jsonl rows (base_task_id / iteration_index) — no re-sampling
    involved. Ids with no matching dataset task are warned and skipped."""
    rows = latest_by_task_id(run_dir)
    benchmark = prev_meta.get("benchmark") or cfg.run.benchmark
    is_adhoc = benchmark == "adhoc"
    adapter_index: dict[str, BenchmarkTask] = {}
    if is_adhoc:
        adhoc_source = prev_meta.get("adhoc") or cfg.adhoc.model_dump()
        adhoc_tasks, _, _ = build_adhoc_tasks(adhoc_source)
        adapter_index = {task.task_id: task for task in adhoc_tasks}
    else:
        adapter_index = {t.task_id: t for t in get_adapter(benchmark).load()}

    out: list[BenchmarkTask] = []
    missing: list[str] = []
    for tid in sorted(rerun_ids):
        rec = rows.get(tid)
        if rec is None:
            # The run's own tasks.jsonl is the authoritative task set: only ids that
            # were actually run here may be rerun. Never write a task outside this run
            # (a dataset id not sampled here, or any arbitrary id) into its run_dir.
            missing.append(tid)
            continue
        base_id = str(rec.get("base_task_id") or tid)
        iter_idx = int(rec.get("iteration_index") or 1)
        meta = {"base_task_id": base_id, "iteration_index": iter_idx}
        base = adapter_index.get(base_id) or adapter_index.get(tid)
        if base is None:
            missing.append(tid)
            continue
        out.append(replace(base, task_id=tid, metadata={**base.metadata, **meta}))
    if missing:
        logger.warning("rerun: {} task id(s) not in this run, skipped: {}", len(missing), missing)
    return out


def _resume_drift_error(run_dir: Path, tasks: list[BenchmarkTask]) -> str | None:
    """Return an error when re-sampling crosses the recorded resume boundary.

    Return an error message if the
    re-sampled ``tasks`` fail to reproduce this run's recorded planned set, else None.

    Primary check: exact set equality against the recorded ``planned_task_ids`` — the run's
    authoritative boundary, always written correctly (full set on a normal run, carried
    forward verbatim on rerun). This catches **same-count identity drift** too: a never-started
    task swapped for a foreign one keeps the count AND keeps every already-recorded task, so
    a count + tasks.jsonl-subset check alone would wave it through. Fall back to that weaker
    pair only for pre-feature snapshots that predate ``planned_task_ids`` entirely. Either
    way, any drift means refuse rather than append/run tasks outside the original run."""
    meta_path = run_dir / "run_metadata.json"
    if not meta_path.exists():
        return None
    prev = json.loads(meta_path.read_text(encoding="utf-8"))
    resampled = {t.task_id for t in tasks}

    planned_ids = prev.get("planned_task_ids")
    if planned_ids is not None:
        planned_set = set(planned_ids)
        if planned_set != resampled:
            missing = sorted(planned_set - resampled)[:3]
            foreign = sorted(resampled - planned_set)[:3]
            return (
                f"resume: re-sampled set differs from the recorded planned set "
                f"(missing {missing}, foreign {foreign}) — sampling boundary drift; refusing to resume"
            )
        return None

    # Pre-fix snapshot without planned_task_ids: best-effort count + tasks.jsonl-subset.
    planned = prev.get("task_count_planned")
    if planned is not None and planned != len(tasks):
        return (
            f"resume: re-sampled {len(tasks)} tasks but run_metadata recorded {planned} planned "
            f"— sampling boundary drift (config changed?); refusing to append foreign tasks"
        )
    attempted_foreign = set(latest_by_task_id(run_dir)) - resampled
    if attempted_foreign:
        return (
            f"resume: {len(attempted_foreign)} already-recorded task(s) not in the re-sampled set "
            f"(e.g. {sorted(attempted_foreign)[:3]}) — sampling boundary drift; refusing to resume"
        )
    return None


def _restore_adhoc_resume_config(cfg: HarnessConfig, meta: dict[str, Any]) -> None:
    """Restore the authoritative ad-hoc source before resume task reconstruction."""
    if meta.get("benchmark") != "adhoc":
        return
    tasks, snapshot, rubric_mode = build_adhoc_tasks(meta.get("adhoc"))
    if not tasks or snapshot is None:
        raise ValueError("adhoc resume metadata does not contain a task snapshot")
    cfg.adhoc.tasks = snapshot["tasks"]
    cfg.adhoc.task = None
    if meta.get("iterations") is not None:
        cfg.run.iterations = int(meta["iterations"])
    cfg.run.auto_judge = bool(meta.get("auto_judge")) and rubric_mode == "all"


def resume_preflight(cfg: HarnessConfig, run_dir: Path) -> tuple[str | None, list[BenchmarkTask]]:
    """Validate a WebUI resume before spawning. Returns ``(error, tasks)``: an error
    message (caller surfaces it as a 4xx) if the run cannot be resumed, else ``(None, tasks)``
    with the re-sampled task set for the caller's atomic has-gap check.

    The spawned run_eval re-samples and re-runs the same drift guard as its own safety net, but
    running it here too lets the WebUI fail the request synchronously — otherwise resume returns
    200 and the subprocess dies invisibly with exit 2, leaving ``cancelled`` set so the button
    reappears and the user re-clicks into the same silent failure (review #2).

    This covers only the **drift** check — a real, deterministic guard whose result depends solely
    on the frozen config + dataset + the recorded ``planned_task_ids`` (none of which a stopped run
    can mutate), so it holds regardless of locking. The **has-gap** check is deliberately NOT here:
    it reads mutable tasks.jsonl, so the caller runs ``resume_no_gap`` UNDER its spawn lock to make
    that read atomic with the spawn (review #3) — see that function."""
    meta_path = run_dir / "run_metadata.json"
    if not meta_path.exists():
        return f"run not found or never ran: {run_dir.name}", []
    try:
        _restore_adhoc_resume_config(
            cfg, json.loads(meta_path.read_text(encoding="utf-8"))
        )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return f"resume: invalid run metadata or adhoc task snapshot: {exc}", []
    tasks, _, _ = _build_tasks(cfg)
    tasks = _expand_iterations(tasks, cfg.run.iterations)
    if not tasks:
        return "resume: no tasks sampled from the frozen config — nothing to resume", []
    drift = _resume_drift_error(run_dir, tasks)
    if drift is not None:
        return drift, tasks
    return None, tasks


def resume_no_gap(run_dir: Path, tasks: list[BenchmarkTask]) -> bool:
    """True iff every re-sampled task is already done, i.e. there is nothing left to resume.

    Done-ness is decided by calling ``task_already_done`` — the **exact same function** the resume
    skip-loop uses (``_run_serial``/``_run_concurrent``): a task is done iff any of its
    tasks.jsonl rows has no error (NOT just its latest row). Calling the same function, rather than
    re-deriving the predicate (e.g. via ``latest_by_task_id``), makes it impossible for this guard
    and the in-loop skip to ever disagree — so "no gap here" ⟺ "the skip-loop would skip every task".

    MUST be called under the caller's spawn lock with ``is_running``/``is_judging`` already false:
    only a live run/rejudge process writes tasks.jsonl, so with both excluded the file is quiescent
    and this read is **atomic with the spawn** — the spawned proc reads the identical state. That
    closes the stale-read window: were this done before the lock, a rerun finishing in between
    could leave a no-gap run that resume still spawns, which is not free — run_eval would skip every
    task yet still run the post-loop export stage (re-renders ALL session HTML, one pi subprocess
    per task) and bump ``completed_at``. The atomic check refuses that case outright (review #3)."""
    return all(task_already_done(run_dir, t.task_id) for t in tasks)


def _purge_task_artifacts(run_dir: Path, task_id: str) -> None:
    """Clear all task-level products before a force-rerun so the new run leaves no
    stale leftovers, equivalent to a fresh run of this task. Best-effort;
    the tasks.jsonl row is overwritten separately (append_task_record force_overwrite).
    Clearing judges/<id>_judge.json lets the end-of-run auto_judge default selection
    re-judge exactly these ids."""
    screenshots = run_dir / "screenshots" / task_id
    if screenshots.exists():
        shutil.rmtree(screenshots, ignore_errors=True)
    files = [
        run_dir / "sessions_html" / f"{task_id}.html",
        run_dir / "sessions_live" / f"{task_id}.html",
        run_dir / "close_done" / f"{task_id}.json",
        run_dir / "system_prompt" / f"{task_id}.json",
        # wiek-browser space candidate read by the bottom close — stale state would make
        # a fresh attempt close the wrong space; a fresh task starts without it.
        run_dir / "browser_state" / f"{task_id}.json",
        run_dir / "pi_stderr" / f"{task_id}.log",
        run_dir / "attempts" / f"{task_id}.json",
    ]
    judges_dir = run_dir / "judges"
    if judges_dir.is_dir():
        files += list(judges_dir.glob(f"{task_id}_judge*.json"))
    for f in files:
        with contextlib.suppress(OSError):
            f.unlink(missing_ok=True)


def _warn_config_drift(
    cfg: HarnessConfig,
    prev_meta: dict[str, Any],
    browser_tool_name: str,
    *,
    action: str = "rerun",
) -> None:
    """Loud warning when a rerun's or resume's effective config diverges from the original
    run's snapshot because mixing two configs in one run directory is a data-integrity
    hazard. The WebUI paths reuse the frozen snapshot so they never drift; this guards
    the CLI, where the config file is free to move between legs."""
    effective_benchmark = (
        "adhoc" if adhoc_is_active(cfg.adhoc.model_dump()) else cfg.run.benchmark
    )
    checks = [
        ("benchmark", prev_meta.get("benchmark"), effective_benchmark),
        ("provider", prev_meta.get("provider"), cfg.run.provider),
        (
            "model",
            prev_meta.get("model"),
            cfg.providers.pi.model
            if cfg.run.provider == "pi"
            else cfg.providers.codex.model,
        ),
        ("browser_tool", prev_meta.get("browser_tool"), browser_tool_name),
    ]
    drift = [(k, o, n) for k, o, n in checks if o is not None and str(o) != str(n)]
    if drift:
        logger.warning(
            "{} config drift vs original run_metadata (mixing configs into one run!): {}",
            action,
            "; ".join(f"{k}: {o!r} -> {n!r}" for k, o, n in drift),
        )


def _install_sigint_handler(main_task: asyncio.Task) -> None:
    state = {"count": 0}

    def _handler() -> None:
        state["count"] += 1
        if state["count"] == 1:
            logger.warning("SIGINT: stopping provider processes and cancelling run...")
            kill_all_pi_processes()
            main_task.cancel()
        else:
            os._exit(130)

    try:
        asyncio.get_event_loop().add_signal_handler(signal.SIGINT, _handler)
    except (NotImplementedError, RuntimeError):
        pass


async def _run_stage_a(
    ctx: RunContext,
    tasks: list[BenchmarkTask],
    *,
    rerun_extra: dict[str, Any],
    carry_wall_s: float,
) -> bool:
    """Execute and finalize Stage A while the caller holds any runtime lease."""
    _write_run_metadata(ctx, tasks, dict(rerun_extra))

    # Clear only after the start write removes completed_at, preserving the progress invariant.
    if ctx.rerun_task_ids:
        for task_id in sorted(ctx.rerun_task_ids):
            _purge_task_artifacts(ctx.run_dir, task_id)

    logger.info(
        "run {} | {} tasks | provider={} | tool={} | model={}/{}",
        ctx.run_id,
        len(tasks),
        ctx.provider_name,
        ctx.browser_tool_name,
        ctx.model_provider,
        ctx.model,
    )

    wall_start = datetime.now(timezone.utc)
    main_task = asyncio.current_task()
    if main_task is not None:
        _install_sigint_handler(main_task)

    cancelled = False
    try:
        if ctx.cfg.run.concurrency >= 2:
            await _run_concurrent(ctx, tasks)
        else:
            await _run_serial(ctx, tasks)
    except asyncio.CancelledError:
        cancelled = True
        logger.warning("run cancelled")
    finally:
        ctx.progress.close()
        wall_s = (datetime.now(timezone.utc) - wall_start).total_seconds()
        _runtime_is_stable(ctx)
        skill = Path(ctx.skill_path)
        skill_hash_final = compute_file_hash(skill) if skill.exists() else ctx.skill_hash
        final_extra: dict[str, Any] = {
            **rerun_extra,
            "wall_clock_total_s": round(wall_s + carry_wall_s, 2),
            "skill_file_hash_final": skill_hash_final,
            "cancelled": cancelled,
        }
        if ctx.runtime_drift_error is None:
            final_extra["completed_at"] = _now_iso()
        else:
            final_extra["runtime_drift_error"] = ctx.runtime_drift_error
        _write_run_metadata(ctx, tasks, final_extra)
    return cancelled


async def main_async(
    cfg: HarnessConfig,
    config_path: str | None,
    run_id_override: str | None = None,
    rerun_task_ids: list[str] | None = None,
    allow_runtime_mismatch: bool = False,
) -> int:
    harness_root = str(Path.cwd())
    python_exe = sys.executable

    pi_home = resolve_pi_home(cfg)
    pi_agent_dir = pi_home / ".pi" / "agent"
    ext_file = pi_agent_dir / "extensions" / "wiek-bench.ts"
    if cfg.run.provider == "pi" and not ext_file.exists():
        logger.error("pi agent dir invalid: {} not found (set PI_HOME?)", ext_file)
        return 2

    pi_bin = os.environ.get(cfg.providers.pi.bin_env) or cfg.providers.pi.bin_default
    browser_tool_name = cfg.run.browser_tool
    bt_cfg = cfg.browser_tool_cfg(browser_tool_name)

    try:
        skill_path = resolve_skill_path(bt_cfg.skill_name, pi_home, cfg.skills.dir)
        skill_hash = compute_file_hash(skill_path)
    except FileNotFoundError as exc:
        logger.error("skill resolution failed: {}", exc)
        return 2

    try:
        provider_setup = _prepare_provider(
            cfg,
            pi_bin=pi_bin,
            pi_agent_dir=pi_agent_dir,
            skill_path=skill_path,
            python_exe=python_exe,
        )
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        logger.error("provider setup failed: {}", exc)
        return 2

    # wiek-browser snapshot + contract probe must happen later, while holding the Stage A lease.
    wiek_browser_release: dict[str, Any] | None = None

    output_dir = Path(cfg.run.output_dir)
    rerun_ids: set[str] = set(rerun_task_ids or [])
    prev_meta: dict[str, Any] = {}

    if rerun_ids:
        # For a selective force-rerun, rebuild exactly the requested ids in the
        # requested ids from the adapter + this run's tasks.jsonl, purge their products,
        # and force the full chain (auto_judge / auto_export) on.
        if not run_id_override:
            logger.error("--rerun-task-ids requires --run-id <existing run>")
            return 2
        run_id = run_id_override
        if "/" in run_id or "\\" in run_id or run_id in (".", ".."):
            logger.error("invalid --run-id (no path separators allowed): {!r}", run_id)
            return 2
        run_dir = (output_dir / run_id).resolve()
        if not (run_dir.exists() and any(run_dir.iterdir())):
            logger.error("rerun target run_dir missing or empty: {}", run_dir)
            return 2
        meta_path = run_dir / "run_metadata.json"
        prev_meta = (
            json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
        )
        benchmark_label = prev_meta.get("benchmark") or cfg.run.benchmark
        adhoc_node = prev_meta.get("adhoc")
        _warn_config_drift(cfg, prev_meta, browser_tool_name)
        if benchmark_label == "adhoc":
            _, adhoc_node, rubric_mode = build_adhoc_tasks(
                adhoc_node or cfg.adhoc.model_dump()
            )
            # Dataset reruns force the full chain. Ad-hoc preserves the original
            # opt-in and rechecks that its complete snapshot still supports Judge.
            cfg.run.auto_judge = bool(prev_meta.get("auto_judge")) and rubric_mode == "all"
        else:
            cfg.run.auto_judge = True
        cfg.run.auto_export_sessions = True
        tasks = _build_rerun_tasks(cfg, run_dir, rerun_ids, prev_meta)
        if not tasks:
            logger.error("rerun: none of the requested task ids matched this run")
            return 1
        # narrow to the ids that actually matched this run — audit + force-overwrite
        # then reflect exactly what was rerun, never a requested-but-foreign id. Products are
        # purged below, AFTER the start metadata write clears completed_at (see _write_run_metadata).
        rerun_ids = {t.task_id for t in tasks}
    else:
        if run_id_override:
            if "/" in run_id_override or "\\" in run_id_override or run_id_override in (".", ".."):
                logger.error("invalid --run-id (no path separators allowed): {!r}", run_id_override)
                return 2
            run_id = run_id_override
            run_dir = (output_dir / run_id).resolve()
            resume_meta_path = run_dir / "run_metadata.json"
            if cfg.run.resume and resume_meta_path.exists():
                try:
                    prev_meta = json.loads(resume_meta_path.read_text(encoding="utf-8"))
                    _restore_adhoc_resume_config(cfg, prev_meta)
                except (OSError, ValueError, json.JSONDecodeError) as exc:
                    logger.error("resume: invalid run metadata or adhoc task snapshot: {}", exc)
                    return 2
                # Resume appends rows to an existing run exactly like rerun does, so it
                # needs the same drift warning: the provider and skill above were already
                # prepared from the CURRENT config file, which may have moved since the
                # original leg. _resume_drift_error only compares task ids and would wave
                # a changed model or browser tool straight through.
                _warn_config_drift(cfg, prev_meta, browser_tool_name, action="resume")
        tasks, benchmark_label, adhoc_node = _build_tasks(cfg)
        tasks = _expand_iterations(tasks, cfg.run.iterations)
        if not tasks:
            logger.error("no tasks sampled")
            return 1
        # run_id: caller-injected (WebUI pre-generates it so its handle keys the real
        # id from the start) or self-generated for direct CLI runs.
        if run_id_override:
            # fail-loud: never let two processes write the same non-empty run_dir.
            if run_dir.exists() and any(run_dir.iterdir()) and not cfg.run.resume:
                logger.error(
                    "run_dir already exists and is non-empty: {} (resume=false; refusing to overwrite)",
                    run_dir,
                )
                return 2
            # Resume re-samples via _build_tasks, so its sampling-boundary guard
            # _build_tasks, so the re-sampled set MUST reproduce the original run's planned
            # set — else resume would append tasks outside it. Fail loud on drift.
            if cfg.run.resume and (drift := _resume_drift_error(run_dir, tasks)) is not None:
                logger.error("{}", drift)
                return 2
            # Resume continues the SAME run_id, so load the original run's metadata to preserve
            # its audit trail (started_at / reruns / wall-clock) below — without it every resume
            # would reset started_at and wipe the reruns array. Read here, before the
            # start metadata write overwrites the file.
            if cfg.run.resume and resume_meta_path.exists():
                prev_meta = json.loads(resume_meta_path.read_text(encoding="utf-8"))
        else:
            run_id = (
                f"{benchmark_label}_{provider_setup.name}_{browser_tool_name}_{_utc_stamp()}"
            )
            run_dir = (output_dir / run_id).resolve()
    # Both branches above have settled the task set by now. Check the resources those
    # tasks declare before anything is written or any model is called: a missing
    # attachment or a site host that is not running would otherwise reach the judge as
    # an ordinary task failure, indistinguishable from the agent failing the work.
    if (resource_error := task_resources.preflight(tasks)) is not None:
        logger.error("task resource preflight failed: {}", resource_error)
        return 2

    run_dir.mkdir(parents=True, exist_ok=True)
    # Publish the executing pid before any work starts, so a console attaching mid-run
    # (CLI-started run, or WebUI after a restart) can tell "still running" from "died".
    run_liveness.write_pid_file(run_dir)

    # Rerun and resume both continue an existing run_id in place, so they preserve the
    # original run's audit metadata (start time + rerun trail) rather than corrupting it with
    # a fresh in-place overwrite. Fresh runs leave this empty.
    rerun_extra: dict[str, Any] = {}
    carry_wall_s = 0.0
    if rerun_ids:
        rerun_extra["reruns"] = (prev_meta.get("reruns") or []) + [
            {"at": _now_iso(), "task_ids": sorted(rerun_ids), "count": len(rerun_ids)}
        ]
        if prev_meta.get("task_count_planned") is not None:
            rerun_extra["task_count_planned"] = prev_meta["task_count_planned"]
        # preserve the original planned boundary (rerun's `tasks` is only the reran subset —
        # recomputing planned_task_ids from it would shrink the run's recorded boundary). The
        # write is None-on-rerun (see _write_run_metadata), so prev_meta's value is the only
        # source; carried verbatim (pre-feature snapshots without it simply stay None).
        if prev_meta.get("planned_task_ids") is not None:
            rerun_extra["planned_task_ids"] = prev_meta["planned_task_ids"]
        if prev_meta.get("started_at"):
            rerun_extra["started_at"] = prev_meta["started_at"]
    elif cfg.run.resume and prev_meta:
        # Resume preserves the original run's start time + rerun audit trail (same run_id
        # continued rather than a new run. task_count_planned and planned_task_ids are not
        # carried — resume re-samples the full set, so the start write recomputes them identically.
        if prev_meta.get("started_at"):
            rerun_extra["started_at"] = prev_meta["started_at"]
        if prev_meta.get("reruns") is not None:
            rerun_extra["reruns"] = prev_meta["reruns"]
        # accumulate wall-clock across the original + resume legs so the run's recorded compute
        # time stays cumulative rather than reading only the resume leg (compare.py sums this).
        carry_wall_s = float(prev_meta.get("wall_clock_total_s") or 0.0)
    # An accepted runtime mismatch is a permanent property of the sample pool, so it has to
    # survive every later leg's full metadata rewrite — same reason `reruns` is carried.
    if prev_meta.get("wiek_browser_runtime_mismatch") is not None:
        rerun_extra["wiek_browser_runtime_mismatch"] = prev_meta["wiek_browser_runtime_mismatch"]

    codex_pricing: dict[str, Any] | None = None
    if provider_setup.name == "codex":
        service_tier = (cfg.providers.codex.service_tier or "default").strip().lower()
        previous_pricing = prev_meta.get("codex_pricing")
        if (
            isinstance(previous_pricing, dict)
            and previous_pricing.get("status") == "available"
            and previous_pricing.get("model") == provider_setup.model
            and previous_pricing.get("service_tier") == service_tier
        ):
            codex_pricing = previous_pricing
        else:
            codex_pricing = fetch_codex_pricing_snapshot(
                provider_setup.model,
                cfg.providers.codex.service_tier,
            )

    stage_a_stack = contextlib.ExitStack()
    try:
        if browser_tool_name == "wiek-browser":
            try:
                stage_a_stack.enter_context(wiek_release.stage_a_runtime_lease(cfg.wiek_browser))
                wiek_browser_release, skill_hash, accepted_mismatch = (
                    _prepare_wiek_browser_runtime(
                        cfg,
                        skill_path=skill_path,
                        expected_skill_hash=skill_hash,
                        previous_metadata=prev_meta,
                        allow_runtime_mismatch=allow_runtime_mismatch,
                    )
                )
                if accepted_mismatch is not None:
                    # wiek_browser_release records only the runtime this leg used; without
                    # this entry the overwrite would leave the run claiming that every task
                    # ran on it. Keep the superseded snapshot so the pool stays auditable.
                    rerun_extra["wiek_browser_runtime_mismatch"] = [
                        *(rerun_extra.get("wiek_browser_runtime_mismatch") or []),
                        {
                            "at": _now_iso(),
                            "reason": accepted_mismatch,
                            "previous_release": prev_meta.get("wiek_browser_release"),
                        },
                    ]
            except RuntimeError as exc:
                logger.error("wiek-browser runtime preflight failed: {}", exc)
                return 2

        progress = ProgressReporter(
            len(tasks),
            run_id=run_id,
            concurrent=cfg.run.concurrency >= 2,
            show_progress=cfg.run.show_progress,
            # Mirror events into the run dir regardless of TTY: a CLI run shows a tqdm
            # bar and emits no stdout NDJSON, but the console still needs live progress.
            event_log=run_dir / run_liveness.EVENT_LOG_FILENAME,
        )

        ctx = RunContext(
            cfg=cfg,
            run_id=run_id,
            run_dir=run_dir,
            started_at=_now_iso(),
            benchmark=benchmark_label,
            adhoc=adhoc_node,
            browser_tool_name=browser_tool_name,
            skill_path=str(skill_path),
            skill_hash=skill_hash,
            wiek_browser_release=wiek_browser_release,
            runtime_drift_error=None,
            pi_bin=pi_bin,
            pi_agent_dir=pi_agent_dir,
            codex_bin=provider_setup.codex_bin,
            codex_home=provider_setup.codex_home,
            codex_pricing=codex_pricing,
            provider_name=provider_setup.name,
            model=provider_setup.model,
            model_provider=provider_setup.model_provider,
            reasoning_level=provider_setup.reasoning_level,
            agent_workdir=provider_setup.workdir,
            provider_env=provider_setup.env,
            max_turns=provider_setup.max_turns,
            capture_stderr=provider_setup.capture_stderr,
            harness_root=harness_root,
            python_exe=python_exe,
            progress=progress,
            provider=provider_setup.provider,
            rerun_task_ids=rerun_ids,
        )
        cancelled = await _run_stage_a(
            ctx,
            tasks,
            rerun_extra=rerun_extra,
            carry_wall_s=carry_wall_s,
        )
    finally:
        stage_a_stack.close()

    if cancelled:
        return 130
    if ctx.runtime_drift_error is not None:
        return 2

    if cfg.run.auto_export_sessions:
        try:
            from wiek_bench.report.session_html import export_run_sessions_async

            await export_run_sessions_async(run_dir)
        except Exception as exc:  # noqa: BLE001
            logger.warning("auto-export sessions failed: {}", exc)
        # Export trajectory galleries under the same switch after agent sessions.
        # Run local I/O in a worker thread and isolate failures from session export.
        try:
            from wiek_bench.report.screenshots_html import export_run_screenshots_html

            await asyncio.to_thread(export_run_screenshots_html, run_dir)
        except Exception as exc:  # noqa: BLE001
            logger.warning("auto-export screenshot galleries failed: {}", exc)

    if cfg.run.auto_judge:
        try:
            import run_judge

            _mark_judging_started(run_dir)
            rc = await run_judge.judge_run(run_dir, cfg)
            return rc
        except Exception as exc:  # noqa: BLE001
            logger.warning("auto-judge failed: {}", exc)

    return 0


def _apply_cli_overrides(cfg: HarnessConfig, args: argparse.Namespace) -> HarnessConfig:
    if args.benchmark:
        cfg.run.benchmark = args.benchmark
    if args.browser_tool:
        cfg.run.browser_tool = args.browser_tool
    if args.browser_tool_mode:
        cfg.run.browser_tool_mode = args.browser_tool_mode
    if args.provider:
        cfg.run.provider = args.provider
    if args.pi_provider:
        cfg.providers.pi.provider = args.pi_provider
    if args.model:
        if cfg.run.provider == "codex":
            cfg.providers.codex.model = args.model
        else:
            cfg.providers.pi.model = args.model
    if args.thinking:
        cfg.providers.pi.thinking_level = args.thinking
    if args.reasoning_effort:
        cfg.providers.codex.reasoning_effort = args.reasoning_effort
    if args.codex_home:
        cfg.providers.codex.codex_home = args.codex_home
    cli_tasks = getattr(args, "task", None)
    tasks_json = getattr(args, "tasks_json", None)
    has_cli_adhoc = cli_tasks is not None or tasks_json is not None
    if cli_tasks is not None:
        text_values = [cli_tasks] if isinstance(cli_tasks, str) else list(cli_tasks)
        cfg.adhoc.tasks = text_tasks_to_entries(text_values)
        cfg.adhoc.task = None
    elif tasks_json is not None:
        json_path = Path(tasks_json)
        try:
            raw_tasks = json.loads(json_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SystemExit(f"failed to read --tasks-json {json_path}: {exc}") from exc
        try:
            cfg.adhoc.tasks = normalize_adhoc_node({"tasks": raw_tasks})
        except ValueError as exc:
            raise SystemExit(f"invalid --tasks-json {json_path}: {exc}") from exc
        cfg.adhoc.task = None
    if args.task_ids:
        cfg.sampling.task_ids = [t.strip() for t in args.task_ids.split(",") if t.strip()]
    if args.concurrency is not None:
        cfg.run.concurrency = args.concurrency
    if args.iterations is not None:
        cfg.run.iterations = args.iterations
    if args.retry_count is not None:
        cfg.run.retry_count = args.retry_count
    # --task-timeout and --max-turns select mutually exclusive limit modes.
    if args.task_timeout is not None and args.max_turns is not None:
        raise SystemExit("--task-timeout and --max-turns are mutually exclusive")
    if args.task_timeout is not None:
        cfg.limits.mode = "time"
        cfg.limits.task_timeout_seconds = args.task_timeout
    if args.max_turns is not None:
        cfg.limits.mode = "steps"
        cfg.limits.max_turns = args.max_turns
    if args.skill_name:
        cfg.browser_tools[cfg.run.browser_tool].skill_name = args.skill_name
    if args.task_prompt:
        cfg.prompts.task_template = args.task_prompt
    if args.tool_profile:
        cfg.providers.pi.tool_profile = args.tool_profile
    if args.output_dir:
        cfg.run.output_dir = args.output_dir
    if args.judge_model:
        cfg.judge.model = args.judge_model
    if args.judge_mode:
        cfg.judge.mode = args.judge_mode
    if args.max_screenshots is not None:
        val = str(args.max_screenshots).strip().lower()
        if val in {"all", "none", ""}:
            cfg.judge.max_screenshots = None
        else:
            try:
                cfg.judge.max_screenshots = int(val)
            except ValueError:
                raise SystemExit(
                    f"--max-screenshots must be an integer or 'all' "
                    f"(received {args.max_screenshots!r})"
                )
    if args.allowed_tools:
        cfg.providers.pi.allowed_tools = [t.strip() for t in args.allowed_tools.split(",") if t.strip()]
    if args.no_resume:
        cfg.run.resume = False
    auto_judge = getattr(args, "auto_judge", None)
    if auto_judge is not None:
        cfg.run.auto_judge = auto_judge
    elif has_cli_adhoc:
        cfg.run.auto_judge = False
    if args.no_auto_export_sessions:
        cfg.run.auto_export_sessions = False
    if args.no_progress:
        cfg.run.show_progress = False
    # CLI overrides mutate the model in place AFTER construction, which bypasses field +
    # model validators (pydantic only validates on construct, not on attribute assignment) —
    # e.g. `--concurrency 0` or `--task-timeout 0` would slip past `ge=1` / limits-positivity
    # and silently degrade downstream (serial path / no-op limit). Re-validate the whole config
    # once here, the CLI boundary, so bad overrides fail loud (same as WebUI's model_validate).
    try:
        return HarnessConfig.model_validate(cfg.model_dump())
    except ValidationError as exc:
        raise SystemExit(f"invalid CLI override: {exc}") from exc


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Stage A: run browser-agent benchmark tasks via Pi or Codex.")
    p.add_argument("--config", default="config.yaml")
    p.add_argument(
        "--run-id",
        help="caller-injected run_id (no path separators); reuse on resume, else fail-loud "
        "if the run_dir exists non-empty. Default: self-generate.",
    )
    p.add_argument(
        "--rerun-task-ids",
        help="selective force-rerun: comma-separated composite task_ids to re-run in-place, "
        "overwriting their rows + task-level products (requires --run-id).",
    )
    p.add_argument(
        "--allow-runtime-mismatch",
        action="store_true",
        help="let a rerun/resume proceed when the active wiek-browser runtime is no longer "
        "the one the run was recorded against. The run then mixes runtimes across its "
        "tasks; the acceptance is recorded in run_metadata.wiek_browser_runtime_mismatch.",
    )
    adhoc_input = p.add_mutually_exclusive_group()
    adhoc_input.add_argument(
        "--task",
        action="append",
        help="ad-hoc instruction; repeat for multiple tasks (mutually exclusive with --tasks-json)",
    )
    adhoc_input.add_argument(
        "--tasks-json",
        help="path to an Odysseys-shaped JSON task array",
    )
    p.add_argument("--benchmark")
    p.add_argument("--browser-tool")
    p.add_argument("--browser-tool-mode", choices=["strict", "loose", "off"])
    p.add_argument("--provider")
    p.add_argument("--pi-provider")
    p.add_argument("--model")
    p.add_argument(
        "--thinking", choices=["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    )
    p.add_argument(
        "--reasoning-effort", choices=["none", "minimal", "low", "medium", "high", "xhigh"]
    )
    p.add_argument("--codex-home")
    p.add_argument("--task-ids")
    p.add_argument("--concurrency", type=int)
    p.add_argument("--iterations", type=int)
    p.add_argument("--retry-count", type=int)
    p.add_argument(
        "--task-timeout",
        type=float,
        help="wall-clock timeout in seconds; mutually exclusive with --max-turns",
    )
    p.add_argument(
        "--max-turns",
        type=int,
        help="turn limit; mutually exclusive with --task-timeout",
    )
    p.add_argument("--skill-name")
    p.add_argument("--task-prompt", help="task template name (prompts/task/<name>.j2) or a .j2 path")
    p.add_argument("--tool-profile", choices=["full", "readonly"])
    p.add_argument("--output-dir")
    p.add_argument("--judge-model")
    p.add_argument("--judge-mode", choices=["single", "agent"], default=None)
    p.add_argument(
        "--max-screenshots",
        default=None,
        help="newest screenshots provided to the judge; integer or all (default)",
    )
    p.add_argument("--allowed-tools", help="explicit --tools override (comma-separated); wins over tool_profile")
    p.add_argument("--no-resume", action="store_true")
    auto_judge_group = p.add_mutually_exclusive_group()
    auto_judge_group.add_argument("--auto-judge", dest="auto_judge", action="store_true")
    auto_judge_group.add_argument("--no-auto-judge", dest="auto_judge", action="store_false")
    p.set_defaults(auto_judge=None)
    p.add_argument("--no-auto-export-sessions", action="store_true")
    p.add_argument("--no-progress", action="store_true")
    return p


def main() -> int:
    load_dotenv()
    args = build_parser().parse_args()
    cfg = load_config(args.config)
    cfg = _apply_cli_overrides(cfg, args)
    rerun_ids = (
        [t.strip() for t in args.rerun_task_ids.split(",") if t.strip()]
        if args.rerun_task_ids
        else None
    )
    try:
        return asyncio.run(
            main_async(
                cfg,
                args.config,
                run_id_override=args.run_id,
                rerun_task_ids=rerun_ids,
                allow_runtime_mismatch=args.allow_runtime_mismatch,
            )
        )
    except KeyboardInterrupt:
        kill_all_pi_processes()
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
