from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import run_eval
from wiek_bench.config import HarnessConfig
from wiek_bench.datasets import BenchmarkTask
from wiek_bench.providers import AgentRunResult
from wiek_bench.results import (
    TaskAttemptRecord,
    read_task_attempt_records,
    write_task_attempt_records,
)


def _write_success_session(path: Path) -> None:
    entries = [
        {
            "type": "session",
            "version": 3,
            "id": path.stem,
            "timestamp": "2026-07-06T10:00:00Z",
        },
        {
            "type": "message",
            "timestamp": "2026-07-06T10:00:01Z",
            "message": {
                "role": "assistant",
                "stopReason": "stop",
                "content": [{"type": "text", "text": "FINAL ANSWER: done"}],
            },
        },
    ]
    path.write_text("".join(json.dumps(entry) + "\n" for entry in entries), encoding="utf-8")


def test_attempt_records_atomically_replace_one_task(tmp_path: Path) -> None:
    first = TaskAttemptRecord(task_id="task-1", attempt_index=1, failure_reason="boom")
    second = TaskAttemptRecord(task_id="task-1", attempt_index=1, session_id="new")

    write_task_attempt_records(tmp_path, "task-1", [first])
    write_task_attempt_records(tmp_path, "task-1", [second])

    assert read_task_attempt_records(tmp_path, "task-1") == [second.to_dict()]
    assert read_task_attempt_records(tmp_path, "missing") == []


def test_execute_task_persists_each_retry_session(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    failed_session = tmp_path / "failed.jsonl"
    success_session = tmp_path / "success.jsonl"
    _write_success_session(failed_session)
    _write_success_session(success_session)

    class FakeProvider:
        def __init__(self) -> None:
            self.calls = 0

        async def run(self, **kwargs: Any) -> AgentRunResult:
            self.calls += 1
            session = failed_session if self.calls == 1 else success_session
            callback = kwargs.get("on_session_file")
            if callback:
                callback(str(session))
            return AgentRunResult(
                task_id="task-1",
                session_id=f"session-{self.calls}",
                session_file=str(session),
                started_at=f"2026-07-06T10:00:0{self.calls}Z",
                ended_at=f"2026-07-06T10:00:0{self.calls + 1}Z",
                error="provider boom" if self.calls == 1 else None,
            )

    class FakeProgress:
        line_mode = False
        # Mirrors ProgressReporter: no stdout NDJSON and no event log here, so the
        # turns poller stays off unless a step limit needs it.
        emits_events = False
        on_event = None

        def session_known(self, task_id: str, session_file: str) -> None:
            del task_id, session_file

        def task_attempt(self, task_id: str, *, attempt: int) -> None:
            del task_id, attempt

    async def no_isolation(*args: Any, **kwargs: Any) -> None:
        del args, kwargs

    monkeypatch.setattr(run_eval, "_isolate_failed_attempt", no_isolation)
    monkeypatch.setattr(
        run_eval,
        "maybe_close_after_run",
        lambda **kwargs: ("harness_post_run", 0),
    )
    monkeypatch.setattr(run_eval, "compress_frames", lambda path: None)
    monkeypatch.setattr(
        run_eval,
        "load_frames",
        lambda path: SimpleNamespace(
            frame_paths=[], manifest_path=None, errors_path=None, tree_paths=[]
        ),
    )
    cfg = HarnessConfig()
    cfg.run.retry_count = 1
    workdir = tmp_path / "work"
    workdir.mkdir()
    wiek_browser_sdk = tmp_path / "index.js"
    wiek_browser_sdk.write_text("// fixture", encoding="utf-8")
    provider = FakeProvider()
    ctx = run_eval.RunContext(
        cfg=cfg,
        run_id="run-1",
        run_dir=tmp_path / "run",
        started_at="2026-07-06T09:00:00+00:00",
        benchmark="adhoc",
        adhoc={"task": "do it"},
        browser_tool_name="wiek-browser",
        skill_path="/tmp/SKILL.md",
        skill_hash=None,
        wiek_browser_release={
            "runtime_contract": "legacy-flat-v1",
            "index_js_realpath": str(wiek_browser_sdk),
        },
        pi_bin="pi",
        pi_agent_dir=tmp_path / "pi",
        codex_bin=None,
        codex_home=None,
        codex_pricing=None,
        provider_name="pi",
        model="test-model",
        model_provider="test-provider",
        reasoning_level="off",
        agent_workdir=workdir,
        provider_env={},
        max_turns=None,
        capture_stderr=False,
        harness_root=str(Path(__file__).parents[1]),
        python_exe=sys.executable,
        progress=FakeProgress(),
        provider=provider,
        rerun_task_ids=set(),
    )
    task = BenchmarkTask(
        task_id="task-1",
        benchmark="adhoc",
        instruction="do it",
        metadata={"base_task_id": "task-1", "iteration_index": 1},
    )

    record = asyncio.run(run_eval._execute_task(ctx, task, concurrency_slot=1))
    attempts = read_task_attempt_records(ctx.run_dir, task.task_id)

    assert record.attempt_count == 2
    assert record.session_file == str(success_session)
    assert [attempt["session_file"] for attempt in attempts] == [
        str(failed_session),
        str(success_session),
    ]
    assert attempts[0]["failure_reason"] == "provider boom"
    assert attempts[1]["failure_reason"] is None
