from __future__ import annotations

import json
import sys
from pathlib import Path


from wiek_bench.results import TaskAttemptRecord, write_task_attempt_records

SCRIPTS = (
    Path(__file__).parents[1]
    / ".claude"
    / "skills"
    / "pi-session-analyzer"
    / "scripts"
)
sys.path.insert(0, str(SCRIPTS))

from _pi_session_lib import classify_error, iter_tool_pairs  # noqa: E402
from analyze_run import build_run_analysis  # noqa: E402
from extract_errors import collect_errors  # noqa: E402
from retry_clusters import find_retry_clusters  # noqa: E402
from session_summary import summarize  # noqa: E402
from turn_timings import collect_turn_timings  # noqa: E402


def _write_pi_session(path: Path) -> None:
    entries = [
        {
            "type": "session",
            "version": 3,
            "id": "session-1",
            "cwd": "/tmp/work",
            "timestamp": "2026-07-06T10:00:00Z",
        },
        {
            "type": "message",
            "timestamp": "2026-07-06T10:00:01Z",
            "message": {
                "role": "user",
                "timestamp": 1783332001000,
                "content": [{"type": "text", "text": "task"}],
            },
        },
        {
            "type": "custom",
            "customType": "wiek-bench-think",
            "timestamp": "2026-07-06T10:00:03Z",
            "data": {"think_ms": 1000},
        },
        {
            "type": "message",
            "timestamp": "2026-07-06T10:00:04Z",
            "message": {
                "role": "assistant",
                # Deliberately stale: helper scripts must use the entry timestamp above.
                "timestamp": 1783332001000,
                "model": "test-model",
                "stopReason": "toolUse",
                "usage": {
                    "input": 10,
                    "output": 2,
                    "reasoning": 7,
                    "cost": {"total": 0.1},
                },
                "content": [
                    {"type": "thinking", "thinking": "think"},
                    {
                        "type": "toolCall",
                        "id": "call-1",
                        "name": "bash",
                        "arguments": {"command": "printf ok"},
                    },
                ],
            },
        },
        {
            "type": "message",
            "timestamp": "2026-07-06T10:00:04.500000Z",
            "message": {
                "role": "toolResult",
                "timestamp": 1783332100000,
                "toolCallId": "call-1",
                "toolName": "bash",
                "isError": False,
                "content": [{"type": "text", "text": "ok"}],
            },
        },
        {
            "type": "message",
            "timestamp": "2026-07-06T10:00:06.500000Z",
            "message": {
                "role": "assistant",
                "timestamp": 1783332004500,
                "model": "test-model",
                "stopReason": "error",
                "errorMessage": "WebSocket error",
                "diagnostics": [
                    {
                        "type": "provider_transport_failure",
                        "error": {"message": "WebSocket error"},
                    }
                ],
                "usage": {"input": 4, "output": 1, "reasoning": 0, "cost": {"total": 0.02}},
                "content": [],
            },
        },
    ]
    path.write_text(
        "".join(json.dumps(entry, ensure_ascii=False) + "\n" for entry in entries),
        encoding="utf-8",
    )


def test_summary_and_timings_use_report_parser_contract(tmp_path: Path) -> None:
    session = tmp_path / "session.jsonl"
    _write_pi_session(session)

    summary = summarize(session)
    turns = collect_turn_timings(session)
    pairs = list(iter_tool_pairs(session))

    assert summary["duration_s"] == 6.5
    assert summary["think_time_s"] == 1.0
    assert summary["llm_time_s"] == 4.0
    assert summary["env_time_s"] == 0.5
    assert summary["reasoning_tokens"] == 7
    assert summary["stop_reason_error"] == "provider_transport_failure: WebSocket error"
    assert summary["error_buckets"] == {"provider_transport": 1}
    assert turns[0]["think_s"] == 1.0
    assert turns[0]["llm_s"] == 2.0
    assert turns[0]["env_s"] == 0.5
    assert turns[0]["turn_s"] == 3.5
    assert pairs[0]["call_line"] == 4
    assert pairs[0]["result_line"] == 5
    assert pairs[0]["latency_s"] == 0.5


def test_extract_errors_includes_assistant_stop_with_line(tmp_path: Path) -> None:
    session = tmp_path / "session.jsonl"
    _write_pi_session(session)

    errors = collect_errors(session)

    assert len(errors) == 1
    assert errors[0]["error_type"] == "assistant_stop"
    assert errors[0]["source_line"] == 6
    assert errors[0]["call_turn_index"] == 2
    assert errors[0]["error_bucket"] == "provider_transport"


def test_retry_clusters_report_evidence_lines_and_fingerprints(tmp_path: Path) -> None:
    session = tmp_path / "retries.jsonl"
    entries: list[dict[str, object]] = [
        {
            "type": "session",
            "version": 3,
            "id": "retry-session",
            "timestamp": "2026-07-06T10:00:00Z",
        }
    ]
    for index, command in enumerate(("printf value=1", "printf  value=1"), 1):
        entries += [
            {
                "type": "message",
                "timestamp": f"2026-07-06T10:00:0{index}Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "toolCall",
                            "id": f"call-{index}",
                            "name": "bash",
                            "arguments": {"command": command},
                        }
                    ],
                },
            },
            {
                "type": "message",
                "timestamp": f"2026-07-06T10:00:0{index}.500000Z",
                "message": {
                    "role": "toolResult",
                    "toolCallId": f"call-{index}",
                    "toolName": "bash",
                    "isError": index == 1,
                    "content": [{"type": "text", "text": "result"}],
                },
            },
        ]
    session.write_text(
        "".join(json.dumps(entry) + "\n" for entry in entries), encoding="utf-8"
    )

    clusters = find_retry_clusters(session)

    assert len(clusters) == 1
    assert clusters[0]["count"] == 2
    assert [call["call_line"] for call in clusters[0]["calls"]] == [2, 4]
    assert clusters[0]["calls"][0]["fingerprint"] == clusters[0]["calls"][1]["fingerprint"]
    assert clusters[0]["calls"][0]["status"] == "error"


def test_missing_tool_result_is_not_reported_as_success(tmp_path: Path) -> None:
    session = tmp_path / "missing.jsonl"
    session.write_text(
        json.dumps({"type": "session", "version": 3, "id": "s"})
        + "\n"
        + json.dumps(
            {
                "type": "message",
                "timestamp": "2026-07-06T10:00:01Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "toolCall", "id": "missing", "name": "bash", "arguments": {}}
                    ],
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )

    pair = next(iter_tool_pairs(session))

    assert pair["result_line"] is None
    assert pair["is_error"] is None


def test_run_analysis_uses_persisted_attempt_provenance(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    session = tmp_path / "session.jsonl"
    _write_pi_session(session)
    (run_dir / "run_metadata.json").write_text(
        json.dumps({"run_id": "run-1"}) + "\n", encoding="utf-8"
    )
    (run_dir / "tasks.jsonl").write_text(
        json.dumps(
            {
                "task_id": "task-1",
                "base_task_id": "task-1",
                "iteration_index": 1,
                "session_file": str(session),
                "attempt_count": 2,
                "verdict": False,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    write_task_attempt_records(
        run_dir,
        "task-1",
        [
            TaskAttemptRecord(
                task_id="task-1",
                attempt_index=1,
                session_file="/tmp/first.jsonl",
                failure_reason="provider failure",
            ),
            TaskAttemptRecord(
                task_id="task-1",
                attempt_index=2,
                session_file=str(session),
            ),
        ],
    )

    analysis = build_run_analysis(run_dir, task_ids=["task-1"])

    assert analysis["warnings"] == []
    assert [attempt["attempt_index"] for attempt in analysis["selected"][0]["attempts"]] == [
        1,
        2,
    ]


def test_error_buckets_separate_causes_that_share_an_exit_code() -> None:
    """ERR_BUCKETS is ordered, and these cases only classify right in that order.

    Every one of them is a real tool result from a run; before the buckets below
    existed they all collapsed into ``nonzero_exit``, which reads as one failure
    mode when they are four different ones.
    """
    strict = (
        'ElementResolutionError: Locator text=No thanks matched 2 elements\n'
        "Command exited with code 1"
    )
    assert classify_error(strict) == "locator_ambiguous"
    assert classify_error("ElementResolutionError: matched 0 elements") == "locator_miss"

    # The agent's own guard, not a broken tool.
    assert classify_error("Error: Austin navigation failed\nCommand exited with code 1") == (
        "script_assertion"
    )
    # ...but a JS-level fault keeps its specific bucket even though it also
    # prints an "Error:" line.
    assert classify_error("Error: Cannot read properties of null (reading 'x')") == (
        "js_undef_access"
    )

    # A declared task attachment, which must outrank the generic missing path.
    assert classify_error("ls: data/task/resume.pdf: No such file or directory") == (
        "task_resource_missing"
    )
    assert classify_error("bash: /opt/nope/run.sh: No such file or directory") == "missing_path"

    assert classify_error(
        "Error: listTabs: The user has taken control of this task space"
    ) == "user_control_stop"
