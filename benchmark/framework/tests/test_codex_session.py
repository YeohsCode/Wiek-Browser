from __future__ import annotations

import base64
import json
import re
from pathlib import Path

import pytest

from wiek_bench.codex_context import (
    build_codex_context_audit,
    codex_context_audit_is_current,
    write_codex_context_audit,
)
from wiek_bench.report.codex_session_html import render_codex_session_html
from wiek_bench.session_parser import (
    bash_actions_from_session,
    safe_parse,
    trajectory_steps_from_session,
)


_PRICING = {
    "status": "available",
    "model": "gpt-5.4",
    "rates": {"input": 2.5, "cache_read": 0.25, "output": 15.0},
    "context_tiers": [],
    "service_tier_multiplier": 1.0,
    "service_tier_source": None,
}


def _write_rollout(path: Path) -> None:
    entries = [
        {
            "timestamp": "2026-07-09T10:00:00Z",
            "type": "session_meta",
            "payload": {
                "id": "thread-1",
                "cwd": "/tmp/work",
                "cli_version": "0.143.0",
                "model_provider": "openai",
                "base_instructions": {"text": "BASE SYSTEM INSTRUCTIONS"},
            },
        },
        {
            "timestamp": "2026-07-09T10:00:01Z",
            "type": "turn_context",
            "payload": {
                "model": "gpt-5.4",
                "cwd": "/tmp/work",
                "effort": "medium",
                "approval_policy": "never",
                "sandbox_policy": {"type": "danger-full-access"},
            },
        },
        {
            "timestamp": "2026-07-09T10:00:01Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "developer",
                "content": [
                    {
                        "type": "input_text",
                        "text": (
                            "<skills_instructions>\n"
                            "- only-skill: Test skill (file: /tmp/skills/only-skill/SKILL.md)\n"
                            "</skills_instructions>"
                        ),
                    }
                ],
            },
        },
        {
            "timestamp": "2026-07-09T10:00:01Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "<environment_context>clean</environment_context>"}
                ],
            },
        },
        {
            "timestamp": "2026-07-09T10:00:01Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "Complete the task"}],
            },
        },
        {
            "timestamp": "2026-07-09T10:00:01Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": (
                            "<skill>\n<name>only-skill</name>\n"
                            "<path>/tmp/skills/only-skill/SKILL.md</path>\nbody\n</skill>"
                        ),
                    }
                ],
            },
        },
        {
            "timestamp": "2026-07-09T10:00:02Z",
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "call_id": "call-1",
                "arguments": json.dumps({"cmd": "printf hello"}),
            },
        },
        {
            "timestamp": "2026-07-09T10:00:03Z",
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call-1",
                "output": "Process exited with code 0\nOutput:\nhello",
            },
        },
        {
            "timestamp": "2026-07-09T10:00:04Z",
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": 100,
                        "cached_input_tokens": 40,
                        "output_tokens": 20,
                        "reasoning_output_tokens": 5,
                    },
                    "total_token_usage": {
                        "input_tokens": 100,
                        "cached_input_tokens": 40,
                        "output_tokens": 20,
                        "reasoning_output_tokens": 5,
                    }
                },
            },
        },
        {
            "timestamp": "2026-07-09T10:00:04.500000Z",
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "item": {
                    "type": "CommandExecution",
                    "id": "call-1",
                    "duration": {"secs": 0, "nanos": 750_000_000},
                },
            },
        },
        {
            "timestamp": "2026-07-09T10:00:05Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "phase": "final_answer",
                "content": [{"type": "output_text", "text": "DONE"}],
            },
        },
        {
            "timestamp": "2026-07-09T10:00:06Z",
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": 80,
                        "cached_input_tokens": 40,
                        "output_tokens": 10,
                        "reasoning_output_tokens": 0,
                    },
                    "total_token_usage": {
                        "input_tokens": 180,
                        "cached_input_tokens": 80,
                        "output_tokens": 30,
                        "reasoning_output_tokens": 5,
                    }
                },
            },
        },
        {
            "timestamp": "2026-07-09T10:00:06Z",
            "type": "event_msg",
            "payload": {
                "type": "task_complete",
                "duration_ms": 5500,
                "time_to_first_token_ms": 650,
            },
        },
    ]
    path.write_text("".join(json.dumps(entry) + "\n" for entry in entries), encoding="utf-8")


def test_codex_rollout_routes_through_session_sot(tmp_path: Path) -> None:
    session = tmp_path / "rollout.jsonl"
    _write_rollout(session)

    stats = safe_parse(session, pricing_snapshot=_PRICING)
    actions = bash_actions_from_session(session)
    steps = trajectory_steps_from_session(session)

    assert stats.session_id == "thread-1"
    assert stats.model == "gpt-5.4"
    assert stats.final_output == "DONE"
    assert stats.duration_s == 5.5
    assert stats.time_to_first_token_s == 0.65
    assert stats.think_time_s is None
    assert stats.env_time_s == 0.75
    assert stats.llm_time_s == 4.75
    assert stats.num_turns == 2
    assert stats.tool_call_dist == {"exec_command": 1}
    assert stats.bash_cmd_dist == {"printf": 1}
    assert stats.input_tokens == 180
    assert stats.output_tokens == 30
    assert stats.cache_read_tokens == 80
    assert stats.reasoning_tokens == 5
    assert stats.cost_usd == pytest.approx(0.00072)
    assert stats.cost_is_estimate is True
    assert stats.cost_source == "models.dev"
    assert actions[0].command == "printf hello"
    assert actions[0].is_error is False
    assert steps[0].actions == actions


def test_codex_tool_time_uses_native_duration_per_call(tmp_path: Path) -> None:
    session = tmp_path / "mixed-tool-time.jsonl"
    entries = [
        {
            "timestamp": "2026-07-09T10:00:00Z",
            "type": "session_meta",
            "payload": {"id": "thread-mixed"},
        },
        {
            "timestamp": "2026-07-09T10:00:00Z",
            "type": "turn_context",
            "payload": {"model": "gpt-5.4"},
        },
        {
            "timestamp": "2026-07-09T10:00:00Z",
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "call_id": "call-native",
                "arguments": "{}",
            },
        },
        {
            "timestamp": "2026-07-09T10:00:01Z",
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call-native",
                "output": "ok",
            },
        },
        {
            "timestamp": "2026-07-09T10:00:01Z",
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "item": {
                    "type": "CommandExecution",
                    "id": "call-native",
                    "duration": {"secs": 0, "nanos": 750_000_000},
                },
            },
        },
        {
            "timestamp": "2026-07-09T10:00:02Z",
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "call_id": "call-fallback",
                "arguments": "{}",
            },
        },
        {
            "timestamp": "2026-07-09T10:00:03Z",
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call-fallback",
                "output": "ok",
            },
        },
        {
            "timestamp": "2026-07-09T10:00:04Z",
            "type": "event_msg",
            "payload": {"type": "task_complete", "duration_ms": 4000},
        },
    ]
    session.write_text(
        "".join(json.dumps(entry) + "\n" for entry in entries),
        encoding="utf-8",
    )

    stats = safe_parse(session, pricing_snapshot=_PRICING)

    assert stats.env_time_s == 1.75
    assert stats.llm_time_s == 2.25
    assert stats.cost_usd is None


def test_codex_rollout_renders_static_html(tmp_path: Path) -> None:
    session = tmp_path / "rollout.jsonl"
    output = tmp_path / "session.html"
    _write_rollout(session)

    render_codex_session_html(session, output, task_id="task-1")
    document = output.read_text(encoding="utf-8")

    assert "Codex session report" in document
    assert "gpt-5.4" in document
    assert "TTFT" in document
    assert "0.7s" in document
    assert "Think time" in document
    assert "not exposed" in document
    assert "printf hello" in document
    assert "DONE" in document
    assert "Search session entries" in document
    assert "Default" in document
    assert "No-tools" in document
    assert "Base System Instructions" in document
    assert "Developer Instructions" in document
    assert "Tools Used" in document
    assert "Available Tools" in document
    assert "not_exposed_by_codex_sdk_or_rollout" in document
    assert '<details class="section"><summary><span>Context Isolation</span>' in document
    assert '<tr><td>exec_command</td><td>1</td></tr>' in document
    used_tools_start = document.index("<span>Tools Used</span>")
    available_tools_start = document.index("<span>Available Tools</span>")
    runtime_start = document.index("<span>Runtime and Launch Configuration</span>")
    assert "exec_command" in document[used_tools_start:available_tools_start]
    assert "exec_command" not in document[available_tools_start:runtime_start]
    assert '<body class="hide-thinking"' in document
    assert "Show thinking" in document
    assert "JSONL" in document
    encoded = re.search(
        r'<script id="raw-jsonl" type="application/octet-stream">([^<]+)</script>',
        document,
    )
    assert encoded is not None
    assert base64.b64decode(encoded.group(1)) == session.read_bytes()


def test_codex_custom_tool_call_is_parsed_and_rendered(tmp_path: Path) -> None:
    session = tmp_path / "custom-tool-rollout.jsonl"
    output = tmp_path / "custom-tool-session.html"
    entries = [
        {
            "timestamp": "2026-07-13T08:28:48Z",
            "type": "session_meta",
            "payload": {"id": "thread-custom", "cwd": "/tmp/work"},
        },
        {
            "timestamp": "2026-07-13T08:28:48Z",
            "type": "turn_context",
            "payload": {"model": "gpt-5.5"},
        },
        {
            "timestamp": "2026-07-13T08:28:49Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "call-browser",
                "input": (
                    'const t = ALL_TOOLS.find(x => x.name === "mcp__node_repl__js"); '
                    'const r = await tools[t.name]({title:"打开 OpenAI 的 X 主页", '
                    'code:`return "https://x.com/OpenAI";`});'
                ),
            },
        },
        {
            "timestamp": "2026-07-13T08:28:49.500Z",
            "type": "event_msg",
            "payload": {
                "type": "mcp_tool_call_end",
                "call_id": "exec-browser",
                "invocation": {
                    "server": "node_repl",
                    "tool": "js",
                    "arguments": {
                        "title": "打开 OpenAI 的 X 主页",
                        "code": 'return "https://x.com/OpenAI";',
                    },
                },
                "result": {"Ok": {"content": []}},
            },
        },
        {
            "timestamp": "2026-07-13T08:28:50Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call-browser",
                "output": [
                    {
                        "type": "input_text",
                        "text": '{"url":"https://x.com/OpenAI","title":"x.com/OpenAI"}',
                    }
                ],
            },
        },
        {
            "timestamp": "2026-07-13T08:28:50.500Z",
            "type": "event_msg",
            "payload": {
                "type": "mcp_tool_call_end",
                "call_id": "exec-unlinked",
                "invocation": {
                    "server": "other",
                    "tool": "lookup",
                    "arguments": {
                        "title": "Unlinked lookup",
                        "code": "return 2;",
                    },
                },
                "result": {"Ok": {"content": []}},
            },
        },
        {
            "timestamp": "2026-07-13T08:28:51Z",
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {},
                    "total_token_usage": {},
                },
            },
        },
        {
            "timestamp": "2026-07-13T08:28:52Z",
            "type": "event_msg",
            "payload": {"type": "task_complete", "duration_ms": 4000},
        },
    ]
    session.write_text(
        "".join(json.dumps(entry, ensure_ascii=False) + "\n" for entry in entries),
        encoding="utf-8",
    )

    stats = safe_parse(session)
    audit = build_codex_context_audit(session)
    render_codex_session_html(session, output)
    document = output.read_text(encoding="utf-8")

    assert stats.tool_calls == 1
    assert stats.tool_call_dist == {"exec": 1}
    assert stats.tool_failures == 0
    assert stats.env_time_s == 1.0
    assert stats.llm_time_s == 3.0
    assert audit["observedToolCalls"] == [{"name": "exec", "callCount": 1}]
    assert document.count('class="entry tool"') == 1
    assert document.count('class="entry nested-tool"') == 1
    assert document.count('class="nested-tool-group"') == 1
    assert document.count('class="nested-tool-child"') == 1
    assert "tool: exec" in document
    assert "Child MCP tool (1)" in document
    assert "unlinked mcp: mcp__other__lookup" in document
    assert "mcp__node_repl__js" in document
    assert "打开 OpenAI 的 X 主页" in document
    assert "https://x.com/OpenAI" in document
    assert '<tr><td>exec</td><td>1</td></tr>' in document
    assert "Child MCP Tools" in document
    assert '<tr><td>mcp__node_repl__js</td><td>1</td></tr>' in document
    assert "excluded from Tool calls" in document


def test_codex_exec_custom_tool_yields_bash_actions(tmp_path: Path) -> None:
    """Treat an exec custom-tool input as one command in the unified Codex runtime.

    This mirrors Pi's treatment of a nodejs heredoc and preserves trajectory checks.
    """
    session = tmp_path / "exec-rollout.jsonl"
    entries = [
        {"type": "session_meta", "payload": {"id": "thread-exec"}},
        {
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "call-1",
                "input": (
                    'const r = await tools.exec_command({cmd:"wiek-browser nodejs -e '
                    "'await page.mouse.wheel(0, 1200)'\", workdir:\"/tmp\"});"
                ),
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call-1",
                "output": [{"type": "input_text", "text": "ok"}],
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "call-2",
                "input": 'await tools.write_stdin({session_id: 3, chars: "page.url()\\n"});',
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call-2",
                "output": [{"type": "input_text", "text": "is_error: true\nwrite_stdin failed: dead"}],
            },
        },
    ]
    session.write_text(
        "".join(json.dumps(entry, ensure_ascii=False) + "\n" for entry in entries),
        encoding="utf-8",
    )

    actions = bash_actions_from_session(session)

    assert len(actions) == 2
    assert "mouse.wheel(0, 1200)" in actions[0].command
    assert actions[0].is_error is False
    assert "write_stdin" in actions[1].command
    assert actions[1].is_error is True


def test_codex_context_audit_preserves_prompt_layers_and_tool_boundary(tmp_path: Path) -> None:
    session = tmp_path / "rollout.jsonl"
    output = tmp_path / "system_prompt" / "task-1.json"
    _write_rollout(session)

    payload = build_codex_context_audit(
        session,
        task_prompt="Complete the task",
        expected_skill_name="only-skill",
        expected_skill_path="/tmp/skills/only-skill/SKILL.md",
        config_overrides=("features.memories=false",),
    )
    written = write_codex_context_audit(
        output,
        session,
        task_prompt="Complete the task",
        expected_skill_name="only-skill",
        expected_skill_path="/tmp/skills/only-skill/SKILL.md",
    )

    assert payload["captureStatus"] == "complete"
    assert payload["systemPrompt"] == "BASE SYSTEM INSTRUCTIONS"
    assert [message["kind"] for message in payload["modelVisibleMessages"]] == [
        "base_instructions",
        "developer_instructions",
        "environment_context",
        "task_prompt",
        "skill_content",
    ]
    assert payload["loadedSkills"][0]["name"] == "only-skill"
    assert payload["loadedSkills"][0]["expandedMessageSha256"]
    assert payload["loadedSkills"][0]["sourceFileSha256"] is None
    assert payload["loadedSkills"][0]["matchesSourceFile"] is None
    assert payload["skillDelivery"]["mode"] == "runtime_expansion"
    assert payload["skillDelivery"]["preloaded"] is True
    assert payload["skillDelivery"]["readEvidence"]["status"] == "not_observed"
    assert payload["isolation"]["status"] == "passed"
    assert payload["activeTools"] is None
    assert payload["toolInventory"]["activeTools"] is None
    assert payload["observedToolCalls"] == [{"name": "exec_command", "callCount": 1}]
    assert written["source"]["rolloutSha256"] == payload["source"]["rolloutSha256"]
    assert json.loads(output.read_text(encoding="utf-8"))["provider"] == "codex"
    assert codex_context_audit_is_current(output, session) is True

    with session.open("ab") as handle:
        handle.write(b'{"type":')
    partial = build_codex_context_audit(session)

    assert codex_context_audit_is_current(output, session) is False
    assert partial["captureStatus"] == "partial"
    assert len(partial["errors"]) == 1
    assert partial["errors"][0].startswith("malformed JSONL lines skipped:")


def test_codex_context_audit_requires_configured_skill_and_clean_context(tmp_path: Path) -> None:
    session = tmp_path / "rollout.jsonl"
    _write_rollout(session)

    unconfigured = build_codex_context_audit(session)
    timeout = build_codex_context_audit(
        session,
        expected_skill_name="only-skill",
        expected_skill_path="/tmp/skills/only-skill/SKILL.md",
        lifecycle_status="timeout",
        lifecycle_error="task timeout after 1s",
    )
    wrong_expected_skill = build_codex_context_audit(
        session,
        expected_skill_name="managed-skill",
        expected_skill_path="/tmp/skills/managed-skill/SKILL.md",
    )
    missing_expected_path = build_codex_context_audit(
        session,
        expected_skill_name="only-skill",
    )

    assert unconfigured["isolation"]["status"] == "incomplete"
    assert unconfigured["isolation"]["expectedSkill"] == {"name": None, "path": None}
    assert timeout["captureStatus"] == "partial"
    assert timeout["lifecycle"] == {
        "status": "timeout",
        "providerStatus": "timeout",
        "rolloutStatus": "completed",
        "error": "task timeout after 1s",
    }
    assert wrong_expected_skill["isolation"]["status"] == "failed"
    assert missing_expected_path["isolation"]["status"] == "incomplete"
    assert missing_expected_path["skillDelivery"]["readEvidence"]["targetPath"] is None

    records = [json.loads(line) for line in session.read_text(encoding="utf-8").splitlines()]
    for record in records:
        payload = record.get("payload") or {}
        if payload.get("type") == "message" and payload.get("role") == "developer":
            payload["content"].append(
                {"type": "input_text", "text": "## Memory\nMEMORY_SUMMARY BEGINS\nleak"}
            )
            break
    session.write_text(
        "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
    )
    contaminated = build_codex_context_audit(
        session,
        expected_skill_name="only-skill",
        expected_skill_path="/tmp/skills/only-skill/SKILL.md",
    )

    assert contaminated["isolation"]["status"] == "failed"
    assert contaminated["isolation"]["forbiddenMarkersFound"] == [
        "## Memory",
        "MEMORY_SUMMARY BEGINS",
    ]


def test_codex_context_audit_rejects_extra_declared_or_conflicting_loaded_skill(
    tmp_path: Path,
) -> None:
    session = tmp_path / "rollout.jsonl"
    _write_rollout(session)
    original = [json.loads(line) for line in session.read_text(encoding="utf-8").splitlines()]

    extra_declared = json.loads(json.dumps(original))
    for record in extra_declared:
        payload = record.get("payload") or {}
        if payload.get("type") == "message" and payload.get("role") == "developer":
            payload["content"][0]["text"] += (
                "\n- extra-skill: Extra (file: /tmp/skills/extra-skill/SKILL.md)"
            )
            break
    session.write_text(
        "".join(json.dumps(record) + "\n" for record in extra_declared), encoding="utf-8"
    )
    extra = build_codex_context_audit(
        session,
        expected_skill_name="only-skill",
        expected_skill_path="/tmp/skills/only-skill/SKILL.md",
    )
    assert extra["isolation"]["status"] == "failed"

    conflicting_loaded = json.loads(json.dumps(original))
    for record in conflicting_loaded:
        payload = record.get("payload") or {}
        if payload.get("type") == "message" and payload.get("role") == "user":
            text = payload.get("content", [{}])[0].get("text", "")
            if text.startswith("<skill>"):
                payload["content"][0]["text"] = text.replace(
                    "only-skill", "other-skill"
                )
                break
    session.write_text(
        "".join(json.dumps(record) + "\n" for record in conflicting_loaded),
        encoding="utf-8",
    )
    conflicting = build_codex_context_audit(
        session,
        expected_skill_name="only-skill",
        expected_skill_path="/tmp/skills/only-skill/SKILL.md",
    )

    assert conflicting["isolation"]["status"] == "failed"


def test_codex_context_audit_accepts_progressive_skill_read(tmp_path: Path) -> None:
    session = tmp_path / "rollout.jsonl"
    output = tmp_path / "session.html"
    audit_path = tmp_path / "system_prompt.json"
    _write_rollout(session)
    records = [json.loads(line) for line in session.read_text(encoding="utf-8").splitlines()]
    records = [
        record
        for record in records
        if not (
            (record.get("payload") or {}).get("type") == "message"
            and "<skill>" in json.dumps(record.get("payload"), ensure_ascii=False)
        )
    ]
    for record in records:
        payload = record.get("payload") or {}
        if payload.get("type") == "function_call":
            payload["arguments"] = json.dumps(
                {"cmd": "cat /tmp/skills/only-skill/SKILL.md"}
            )
        elif payload.get("type") == "function_call_output":
            payload["output"] = "Process exited with code 0\nOutput:\nbody"
    session.write_text(
        "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
    )

    payload = write_codex_context_audit(
        audit_path,
        session,
        task_prompt="Complete the task",
        expected_skill_name="only-skill",
        expected_skill_path="/tmp/skills/only-skill/SKILL.md",
    )
    render_codex_session_html(
        session,
        output,
        task_id="task-1",
        context_audit_path=audit_path,
    )
    document = output.read_text(encoding="utf-8")

    assert payload["loadedSkills"] == []
    assert payload["skillDelivery"]["mode"] == "progressive_disclosure"
    assert payload["skillDelivery"]["preloaded"] is False
    assert payload["skillDelivery"]["readEvidence"] == {
        "status": "observed",
        "targetPath": "/tmp/skills/only-skill/SKILL.md",
        "source": "rollout_function_call_and_output",
        "calls": [
            {
                "toolName": "exec_command",
                "callId": "call-1",
                "line": 6,
                "outputLine": 7,
                "command": "cat /tmp/skills/only-skill/SKILL.md",
            }
        ],
        "reason": "A successful rollout function call explicitly read the declared SKILL.md path.",
    }
    assert payload["isolation"]["status"] == "passed"
    assert "progressive_disclosure" in document
    assert "Skill read evidence" in document
    assert "observed" in document
    assert "Skill read target" in document
    assert "Declared skills" in document
    assert "/tmp/skills/only-skill/SKILL.md" in document
    assert "A successful rollout function call explicitly read the declared SKILL.md path." in document
    assert "exec_command" in document
    assert "call-1" in document
    assert "cat /tmp/skills/only-skill/SKILL.md" in document


def test_codex_skill_read_evidence_does_not_treat_path_reference_as_read(
    tmp_path: Path,
) -> None:
    session = tmp_path / "rollout.jsonl"
    _write_rollout(session)
    records = [json.loads(line) for line in session.read_text(encoding="utf-8").splitlines()]
    for record in records:
        payload = record.get("payload") or {}
        if payload.get("type") == "function_call":
            payload["arguments"] = json.dumps(
                {
                    "cmd": (
                        "cat /tmp/skills/only-skill/SKILL.md.bak && "
                        "cat /tmp/other-skill/SKILL.md > "
                        "/tmp/skills/only-skill/SKILL.md && "
                        "printf 'x|cat /tmp/skills/only-skill/SKILL.md'"
                    )
                }
            )
            break
    session.write_text(
        "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
    )

    payload = build_codex_context_audit(
        session,
        expected_skill_name="only-skill",
        expected_skill_path="/tmp/skills/only-skill/SKILL.md",
    )

    assert payload["skillDelivery"]["readEvidence"]["status"] == "not_observed"
    assert payload["skillDelivery"]["readEvidence"]["calls"] == []


def test_codex_skill_read_evidence_requires_successful_output(tmp_path: Path) -> None:
    session = tmp_path / "rollout.jsonl"
    _write_rollout(session)
    records = [json.loads(line) for line in session.read_text(encoding="utf-8").splitlines()]
    for record in records:
        payload = record.get("payload") or {}
        if payload.get("type") == "function_call":
            payload["arguments"] = json.dumps(
                {"cmd": "cat /tmp/skills/only-skill/SKILL.md"}
            )
        elif payload.get("type") == "function_call_output":
            payload["output"] = "Process exited with code 1\nOutput:\ncat: file not found"
    session.write_text(
        "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
    )

    failed = build_codex_context_audit(
        session,
        expected_skill_name="only-skill",
        expected_skill_path="/tmp/skills/only-skill/SKILL.md",
    )
    assert failed["skillDelivery"]["readEvidence"]["status"] == "not_observed"

    records = [
        record
        for record in records
        if (record.get("payload") or {}).get("type") != "function_call_output"
    ]
    session.write_text(
        "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
    )
    missing = build_codex_context_audit(
        session,
        expected_skill_name="only-skill",
        expected_skill_path="/tmp/skills/only-skill/SKILL.md",
    )

    assert missing["skillDelivery"]["readEvidence"]["status"] == "not_observed"
    assert missing["skillDelivery"]["readEvidence"]["calls"] == []


def test_codex_direct_read_evidence_requires_exact_path(tmp_path: Path) -> None:
    session = tmp_path / "rollout.jsonl"
    _write_rollout(session)
    records = [json.loads(line) for line in session.read_text(encoding="utf-8").splitlines()]
    for record in records:
        payload = record.get("payload") or {}
        if payload.get("type") == "function_call":
            payload["name"] = "read_file"
            payload["arguments"] = json.dumps(
                {"path": "/tmp/skills/only-skill/SKILL.md.bak"}
            )
            break
    session.write_text(
        "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
    )

    wrong_path = build_codex_context_audit(
        session,
        expected_skill_name="only-skill",
        expected_skill_path="/tmp/skills/only-skill/SKILL.md",
    )
    assert wrong_path["skillDelivery"]["readEvidence"]["status"] == "not_observed"

    for record in records:
        payload = record.get("payload") or {}
        if payload.get("type") == "function_call":
            payload["arguments"] = json.dumps(
                {"path": "/tmp/skills/only-skill/SKILL.md"}
            )
            break
    session.write_text(
        "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
    )
    exact_path = build_codex_context_audit(
        session,
        expected_skill_name="only-skill",
        expected_skill_path="/tmp/skills/only-skill/SKILL.md",
    )

    assert exact_path["skillDelivery"]["readEvidence"]["status"] == "observed"
    assert exact_path["skillDelivery"]["readEvidence"]["calls"][0]["toolName"] == "read_file"


def test_codex_html_renders_legacy_audit_without_skill_delivery(tmp_path: Path) -> None:
    session = tmp_path / "rollout.jsonl"
    audit_path = tmp_path / "system_prompt.json"
    output = tmp_path / "session.html"
    _write_rollout(session)
    audit = write_codex_context_audit(
        audit_path,
        session,
        task_prompt="Complete the task",
        expected_skill_name="only-skill",
        expected_skill_path="/tmp/skills/only-skill/SKILL.md",
    )
    audit.pop("skillDelivery")
    audit_path.write_text(json.dumps(audit), encoding="utf-8")

    render_codex_session_html(
        session,
        output,
        task_id="task-1",
        context_audit_path=audit_path,
    )
    document = output.read_text(encoding="utf-8")

    assert "runtime_expansion" in document
    assert "Preloaded skill content" in document
    assert "True" in document
