from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from wiek_bench.session_parser import bash_actions_from_session, safe_parse


def _write_jsonl(path: Path, entries: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(entry, ensure_ascii=False) + "\n" for entry in entries),
        encoding="utf-8",
    )


def test_codex_tool_failures_include_code_zero_wrappers(tmp_path: Path) -> None:
    session = tmp_path / "codex-rollout.jsonl"
    cases = [
        (
            "exec_command",
            {"cmd": "false"},
            "Process exited with code 1\nOutput:\nfailed",
        ),
        (
            "exec_command",
            {"cmd": "wiek-browser nodejs"},
            "Process exited with code 0\nOutput:\nwiek's nodejs process exited with code 1.",
        ),
        (
            "write_stdin",
            {"chars": "document.body.innerText\n"},
            (
                "Process running with session ID 42\nOutput:\n"
                "Uncaught ReferenceError: document is not defined\r\nrepl> "
            ),
        ),
        (
            "exec_command",
            {"cmd": "pdftotext missing.pdf -"},
            (
                "Process exited with code 0\nOutput:\n"
                "I/O Error: Couldn't open file 'missing.pdf': No such file or directory."
            ),
        ),
        (
            "write_stdin",
            {"chars": "\u0003"},
            "write_stdin failed: stdin is closed for this session",
        ),
        (
            "exec_command",
            {"cmd": "wiek-browser nodejs"},
            "SyntaxError: await is only valid in async functions",
        ),
        (
            "exec_command",
            {"cmd": "printf ok"},
            "Process exited with code 0\nOutput:\nok",
        ),
        (
            "write_stdin",
            {"chars": "retryClick()\n"},
            "click err ElementResolutionError: matched 0 elements\nrecovered with fallback",
        ),
    ]
    entries: list[dict[str, Any]] = [
        {
            "timestamp": "2026-01-01T00:00:00Z",
            "type": "session_meta",
            "payload": {"id": "codex-tool-errors"},
        }
    ]
    for index, (name, arguments, output) in enumerate(cases, 1):
        call_id = f"call-{index}"
        entries.extend(
            [
                {
                    "timestamp": f"2026-01-01T00:00:{index:02d}Z",
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": name,
                        "call_id": call_id,
                        "arguments": json.dumps(arguments),
                    },
                },
                {
                    "timestamp": f"2026-01-01T00:01:{index:02d}Z",
                    "type": "response_item",
                    "payload": {
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": output,
                    },
                },
            ]
        )
    _write_jsonl(session, entries)

    stats = safe_parse(session)
    actions = bash_actions_from_session(session)

    assert stats.tool_calls == 8
    assert stats.tool_failures == 6
    assert [action.is_error for action in actions] == [
        True,
        True,
        True,
        True,
        True,
        True,
        False,
        False,
    ]


def test_pi_tool_failures_include_masked_bash_errors(tmp_path: Path) -> None:
    session = tmp_path / "pi-session.jsonl"
    cases = [
        ("bash", True, "Command timed out after 60 seconds"),
        ("bash", False, "wiek's nodejs process exited with code 1."),
        ("bash", False, "SyntaxError: await is only valid in async functions"),
        (
            "bash",
            False,
            ("Traceback (most recent call last):\nModuleNotFoundError: No module named 'markdown'"),
        ),
        ("bash", False, "ok"),
        (
            "bash",
            False,
            "click err ElementResolutionError: matched 0 elements\nrecovered with fallback",
        ),
        (
            "read",
            False,
            "documentation example: wiek's nodejs process exited with code 1.",
        ),
    ]
    tool_calls = [
        {
            "type": "toolCall",
            "id": f"call-{index}",
            "name": tool_name,
            "arguments": ({"command": f"command-{index}"} if tool_name == "bash" else {"path": "SKILL.md"}),
        }
        for index, (tool_name, _, _) in enumerate(cases, 1)
    ]
    entries: list[dict[str, Any]] = [
        {
            "type": "session",
            "id": "pi-tool-errors",
            "version": 3,
            "timestamp": "2026-01-01T00:00:00Z",
        },
        {
            "type": "message",
            "timestamp": "2026-01-01T00:00:01Z",
            "message": {
                "role": "assistant",
                "content": tool_calls,
                "usage": {},
            },
        },
    ]
    for index, (tool_name, is_error, result_text) in enumerate(cases, 1):
        entries.append(
            {
                "type": "message",
                "timestamp": f"2026-01-01T00:01:{index:02d}Z",
                "message": {
                    "role": "toolResult",
                    "toolCallId": f"call-{index}",
                    "toolName": tool_name,
                    "isError": is_error,
                    "content": [{"type": "text", "text": result_text}],
                },
            }
        )
    _write_jsonl(session, entries)

    stats = safe_parse(session)
    actions = bash_actions_from_session(session)

    assert stats.tool_calls == 7
    assert stats.tool_failures == 4
    assert [action.is_error for action in actions] == [
        True,
        True,
        True,
        True,
        False,
        False,
    ]
