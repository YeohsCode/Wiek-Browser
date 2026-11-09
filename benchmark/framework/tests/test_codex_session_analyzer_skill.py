from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / ".claude" / "skills" / "codex-session-analyzer" / "scripts"


def _entry(entry_type: str, timestamp: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"type": entry_type, "timestamp": timestamp, "payload": payload}


def _write_rollout(path: Path) -> None:
    entries = [
        _entry(
            "session_meta",
            "2026-01-01T00:00:00Z",
            {
                "id": "codex-test",
                "cwd": "/tmp/workspace",
                "cli_version": "test",
                "originator": "test",
            },
        ),
        _entry("event_msg", "2026-01-01T00:00:00Z", {"type": "task_started"}),
        _entry("turn_context", "2026-01-01T00:00:00Z", {"model": "gpt-5.5"}),
        _entry(
            "event_msg",
            "2026-01-01T00:00:00.100Z",
            {"type": "user_message", "message": "test prompt"},
        ),
        _entry(
            "response_item",
            "2026-01-01T00:00:00.500Z",
            {
                "type": "function_call",
                "name": "exec_command",
                "call_id": "call-1",
                "arguments": json.dumps({"cmd": "wiek-browser nodejs"}),
            },
        ),
        _entry(
            "response_item",
            "2026-01-01T00:00:01Z",
            {
                "type": "function_call_output",
                "call_id": "call-1",
                "output": (
                    "Process exited with code 0\nOutput:\n"
                    "ElementResolutionError: matched 0 elements\n"
                    "wiek's nodejs process exited with code 1."
                ),
            },
        ),
        _entry(
            "event_msg",
            "2026-01-01T00:00:02Z",
            {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": 80,
                        "cached_input_tokens": 40,
                        "output_tokens": 10,
                        "reasoning_output_tokens": 2,
                    },
                    "last_token_usage": {
                        "input_tokens": 80,
                        "cached_input_tokens": 40,
                        "output_tokens": 10,
                        "reasoning_output_tokens": 2,
                    },
                },
            },
        ),
        _entry(
            "response_item",
            "2026-01-01T00:00:03Z",
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "FINAL ANSWER: done"}],
            },
        ),
        _entry(
            "event_msg",
            "2026-01-01T00:00:04Z",
            {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": 100,
                        "cached_input_tokens": 50,
                        "output_tokens": 20,
                        "reasoning_output_tokens": 5,
                    },
                    "last_token_usage": {
                        "input_tokens": 20,
                        "cached_input_tokens": 10,
                        "output_tokens": 10,
                        "reasoning_output_tokens": 3,
                    },
                },
            },
        ),
        _entry(
            "event_msg",
            "2026-01-01T00:00:05Z",
            {
                "type": "task_complete",
                "duration_ms": 5000,
                "time_to_first_token_ms": 1200,
                "last_agent_message": "FINAL ANSWER: done",
            },
        ),
    ]
    path.write_text(
        "".join(json.dumps(entry, ensure_ascii=False) + "\n" for entry in entries),
        encoding="utf-8",
    )


def _run(script: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPTS / script), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def test_summary_promotes_wrapped_error_into_report_failure_count(
    tmp_path: Path,
) -> None:
    session = tmp_path / "rollout.jsonl"
    _write_rollout(session)

    result = _run("session_summary.py", str(session))

    assert result.returncode == 0, result.stderr
    summary = json.loads(result.stdout)
    assert summary["duration_s"] == 5.0
    assert summary["num_turns"] == 2
    assert summary["tool_calls"] == 1
    assert summary["tool_failures"] == 1
    assert summary["embedded_output_errors"] == 0
    assert summary["env_time_s"] == 0.5
    assert summary["llm_time_s"] == 4.5
    assert summary["reasoning_tokens"] == 5
    assert summary["final_output_present"] is True


def test_error_and_timing_evidence_are_line_addressable(tmp_path: Path) -> None:
    session = tmp_path / "rollout.jsonl"
    _write_rollout(session)

    errors = _run("extract_errors.py", str(session))
    timings = _run("turn_timings.py", str(session), "--jsonl")

    assert errors.returncode == 0, errors.stderr
    error = json.loads(errors.stdout)
    assert error["error_type"] == "function_call_output"
    assert error["source_line"] == 6
    assert error["call_line"] == 5
    assert error["error_bucket"] == "locator_miss"
    assert timings.returncode == 0, timings.stderr
    rows = [json.loads(line) for line in timings.stdout.splitlines()]
    assert len(rows) == 2
    assert sum(row["env_s"] for row in rows) == 0.5
    assert rows[0]["reasoning_tokens"] == 2
    assert rows[1]["reasoning_tokens"] == 3


def test_custom_tool_call_pair_is_line_addressable(tmp_path: Path) -> None:
    session = tmp_path / "custom-tool-rollout.jsonl"
    entries = [
        _entry(
            "session_meta",
            "2026-01-01T00:00:00Z",
            {"id": "codex-custom", "cwd": "/tmp/workspace"},
        ),
        _entry("turn_context", "2026-01-01T00:00:00Z", {"model": "gpt-5.5"}),
        _entry(
            "response_item",
            "2026-01-01T00:00:00.500Z",
            {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "call-custom",
                "input": "nodeRepl.write('browser result')",
            },
        ),
        _entry(
            "response_item",
            "2026-01-01T00:00:01Z",
            {
                "type": "custom_tool_call_output",
                "call_id": "call-custom",
                "output": [{"type": "input_text", "text": "browser result"}],
            },
        ),
        _entry(
            "event_msg",
            "2026-01-01T00:00:02Z",
            {
                "type": "token_count",
                "info": {"last_token_usage": {}, "total_token_usage": {}},
            },
        ),
        _entry(
            "event_msg",
            "2026-01-01T00:00:03Z",
            {"type": "task_complete", "duration_ms": 3000},
        ),
    ]
    session.write_text(
        "".join(json.dumps(entry, ensure_ascii=False) + "\n" for entry in entries),
        encoding="utf-8",
    )

    summary_result = _run("session_summary.py", str(session))
    calls_result = _run("extract_tool_calls.py", str(session), "--full")

    assert summary_result.returncode == 0, summary_result.stderr
    summary = json.loads(summary_result.stdout)
    assert summary["tool_calls"] == 1
    assert summary["tool_call_dist"] == {"exec": 1}
    assert summary["env_time_s"] == 0.5
    assert calls_result.returncode == 0, calls_result.stderr
    call = json.loads(calls_result.stdout)
    assert call["call_line"] == 3
    assert call["result_line"] == 4
    assert call["call_type"] == "custom_tool_call"
    assert call["result_type"] == "custom_tool_call_output"
    assert call["tool_name"] == "exec"
    assert call["status"] == "ok"
    assert call["arguments"] == {"input": "nodeRepl.write('browser result')"}
    assert "browser result" in call["result_text"]


def test_analyze_run_json_uses_codex_provider_and_serializes_terminal_time(
    tmp_path: Path,
) -> None:
    session = tmp_path / "rollout.jsonl"
    _write_rollout(session)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "run_metadata.json").write_text(
        json.dumps(
            {
                "run_id": "codex-test-run",
                "provider": "codex",
                "model": "gpt-5.5",
            }
        ),
        encoding="utf-8",
    )
    (run_dir / "tasks.jsonl").write_text(
        json.dumps(
            {
                "task_id": "task__iter1",
                "base_task_id": "task",
                "iteration_index": 1,
                "provider": "codex",
                "session_file": str(session),
                "attempt_count": 1,
                "verdict": False,
                "score": 0.5,
            }
        )
        + "\n",
        encoding="utf-8",
    )

    result = _run("analyze_run.py", str(run_dir), "--json")

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["provider"] == "codex"
    assert payload["aggregate"]["tool_failures"] == 1
    assert payload["aggregate"]["embedded_output_errors"] == 0
    assert payload["selected"][0]["session"]["terminal_events"][0]["timestamp"].endswith(
        "+00:00"
    )
