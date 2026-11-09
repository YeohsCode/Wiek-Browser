"""Stream Codex rollouts and expose line-addressable evidence helpers."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

from _project import (
    CODEX_TOOL_CALL_TYPES,
    CODEX_TOOL_OUTPUT_TYPES,
    _codex_arguments,
    _codex_item_duration_s,
    _codex_output_is_error,
    _codex_shell_command,
)


ERR_BUCKETS: list[tuple[str, re.Pattern[str]]] = [
    ("provider_transport", re.compile(r"transport|websocket|connection (?:closed|reset)", re.I)),
    ("locator_miss", re.compile(r"ElementResolutionError|matched 0 elements|Could not locate|Locator .* 0 elements")),
    ("js_syntax", re.compile(r"SyntaxError|Invalid or unexpected token")),
    ("js_undef_access", re.compile(r"Cannot read properties of (?:null|undefined)")),
    ("js_ref_or_type", re.compile(r"ReferenceError|TypeError")),
    ("ipc_timeout", re.compile(r"IPC request timed out|CDP request timed out|Runtime\.evaluate timed out")),
    ("command_timeout", re.compile(r"timed out after|command timed out", re.I)),
    ("target_gone", re.compile(r"No target with given id|Target (?:closed|crashed|detached)")),
    ("http_4xx", re.compile(r"HTTP 4\d\d|status (?:code )?4\d\d")),
    ("http_5xx", re.compile(r"HTTP 5\d\d|status (?:code )?5\d\d")),
    ("auth_required", re.compile(r"sign in|log in|\u767b\u5f55|\u672a\u767b\u5f55|authentication required", re.I)),
    ("captcha", re.compile(r"captcha|verify you are human|\u4eba\u673a\u9a8c\u8bc1", re.I)),
    ("nonzero_exit", re.compile(r"(?:process|command|nodejs process) exited with code [1-9]\d*", re.I)),
]


def classify_error(text: str) -> str:
    for name, pattern in ERR_BUCKETS:
        if pattern.search(text):
            return name
    return "other"


def parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def iter_entries_with_lines(path: str | Path) -> Iterator[tuple[int, dict[str, Any]]]:
    with Path(path).open("r", encoding="utf-8") as handle:
        for line_number, raw in enumerate(handle, 1):
            if not raw.strip():
                continue
            try:
                entry = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict):
                yield line_number, entry


def json_default(item: Any) -> str:
    if isinstance(item, datetime):
        return item.isoformat()
    raise TypeError(f"unserializable {type(item).__name__}")


def to_jsonl(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, default=json_default)


def content_text(content: Any, kind: str) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        str(block.get("text") or "")
        for block in content
        if isinstance(block, dict) and block.get("type") == kind
    )


def reasoning_summary(value: Any) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    parts: list[str] = []
    for item in value:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict):
            text = item.get("text") or item.get("summary")
            if isinstance(text, str):
                parts.append(text)
    return "".join(parts)


def call_signature(tool_name: str, arguments: dict[str, Any]) -> str:
    normalized = json.dumps(arguments, ensure_ascii=False, sort_keys=True, default=str)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return f"{tool_name}:{normalized}"


def call_fingerprint(tool_name: str, arguments: dict[str, Any]) -> str:
    return hashlib.sha256(call_signature(tool_name, arguments).encode("utf-8")).hexdigest()[:12]


def _native_durations(path: str | Path) -> dict[str, float]:
    durations: dict[str, float] = {}
    accepted = {
        "CommandExecution",
        "DynamicToolCall",
        "McpToolCall",
        "command_execution",
        "commandExecution",
        "dynamic_tool_call",
        "dynamicToolCall",
        "mcp_tool_call",
        "mcpToolCall",
    }
    for _, entry in iter_entries_with_lines(path):
        if entry.get("type") != "event_msg":
            continue
        payload = entry.get("payload")
        if not isinstance(payload, dict) or payload.get("type") != "item_completed":
            continue
        item = payload.get("item")
        if not isinstance(item, dict) or item.get("type") not in accepted:
            continue
        item_id = item.get("id")
        duration = _codex_item_duration_s(item)
        if isinstance(item_id, str) and duration is not None:
            durations[item_id] = duration
    return durations


def iter_tool_pairs(path: str | Path) -> Iterator[dict[str, Any]]:
    native = _native_durations(path)
    pending: dict[str, dict[str, Any]] = {}
    turn_index = 1
    for line_number, entry in iter_entries_with_lines(path):
        entry_type = entry.get("type")
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        if entry_type == "event_msg" and payload.get("type") == "token_count":
            turn_index += 1
            continue
        if entry_type != "response_item":
            continue
        payload_type = payload.get("type")
        if payload_type in CODEX_TOOL_CALL_TYPES:
            call_id = payload.get("call_id")
            if not isinstance(call_id, str):
                continue
            arguments = _codex_arguments(payload)
            tool_name = str(payload.get("name") or "unknown")
            pending[call_id] = {
                "call_id": call_id,
                "call_type": payload_type,
                "call_line": line_number,
                "result_line": None,
                "call_turn_index": turn_index,
                "tool_name": tool_name,
                "arguments": arguments,
                "command": _codex_shell_command(payload),
                "call_ts": parse_iso(entry.get("timestamp")),
            }
            continue
        if payload_type not in CODEX_TOOL_OUTPUT_TYPES:
            continue
        call_id = payload.get("call_id")
        if not isinstance(call_id, str):
            continue
        slot = pending.pop(
            call_id,
            {
                "call_id": call_id,
                "call_type": None,
                "call_line": None,
                "result_line": None,
                "call_turn_index": None,
                "tool_name": "unknown",
                "arguments": {},
                "command": None,
                "call_ts": None,
            },
        )
        result_ts = parse_iso(entry.get("timestamp"))
        output = payload.get("output")
        result_text = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
        derived = (
            max(0.0, (result_ts - slot["call_ts"]).total_seconds())
            if result_ts is not None and slot["call_ts"] is not None
            else None
        )
        is_error = _codex_output_is_error(output, tool_name=slot["tool_name"])
        embedded_error = False
        slot.update(
            {
                "result_line": line_number,
                "result_type": payload_type,
                "result_ts": result_ts,
                "result_text": result_text,
                "is_error": is_error,
                "embedded_error": embedded_error,
                "error_bucket": (
                    classify_error(result_text) if is_error or embedded_error else None
                ),
                "latency_s": native.get(call_id, derived),
                "duration_source": "item_completed" if call_id in native else "call_to_output",
            }
        )
        yield slot

    for slot in pending.values():
        slot.update(
            {
                "result_line": None,
                "result_type": None,
                "result_ts": None,
                "result_text": "",
                "is_error": None,
                "embedded_error": None,
                "error_bucket": None,
                "latency_s": native.get(slot["call_id"]),
                "duration_source": (
                    "item_completed" if slot["call_id"] in native else None
                ),
            }
        )
        yield slot


def iter_turns(path: str | Path) -> Iterator[dict[str, Any]]:
    turn_index = 1
    current: dict[str, Any] = {
        "turn_index": turn_index,
        "reasoning": [],
        "reasoning_lines": [],
        "agent_messages": [],
        "agent_message_lines": [],
        "text": [],
        "text_lines": [],
        "tool_calls": [],
    }
    for line_number, entry in iter_entries_with_lines(path):
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        if entry.get("type") == "response_item":
            payload_type = payload.get("type")
            if payload_type == "reasoning":
                text = reasoning_summary(payload.get("summary"))
                if text:
                    current["reasoning"].append(text)
                    current["reasoning_lines"].append(line_number)
            elif payload_type == "message" and payload.get("role") == "assistant":
                text = content_text(payload.get("content"), "output_text")
                if text:
                    current["text"].append(text)
                    current["text_lines"].append(line_number)
            elif payload_type in CODEX_TOOL_CALL_TYPES:
                current["tool_calls"].append(
                    {
                        "line": line_number,
                        "id": payload.get("call_id"),
                        "name": payload.get("name"),
                        "arguments": _codex_arguments(payload),
                    }
                )
            continue
        if entry.get("type") != "event_msg":
            continue
        event_type = payload.get("type")
        if event_type == "agent_message":
            message = payload.get("message")
            if isinstance(message, str) and message:
                current["agent_messages"].append(message)
                current["agent_message_lines"].append(line_number)
            continue
        if event_type != "token_count":
            continue
        info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
        current.update(
            {
                "source_line": line_number,
                "ts": parse_iso(entry.get("timestamp")),
                "complete": True,
                "reasoning": "".join(current["reasoning"]),
                "agent_messages": "".join(current["agent_messages"]),
                "text": "".join(current["text"]),
                "last_token_usage": info.get("last_token_usage"),
                "total_token_usage": info.get("total_token_usage"),
                "model_context_window": info.get("model_context_window"),
                "rate_limits": payload.get("rate_limits"),
            }
        )
        yield current
        turn_index += 1
        current = {
            "turn_index": turn_index,
            "reasoning": [],
            "reasoning_lines": [],
            "agent_messages": [],
            "agent_message_lines": [],
            "text": [],
            "text_lines": [],
            "tool_calls": [],
        }

    if any(
        current[key]
        for key in ("reasoning", "agent_messages", "text", "tool_calls")
    ):
        current.update(
            {
                "source_line": None,
                "ts": None,
                "complete": False,
                "reasoning": "".join(current["reasoning"]),
                "agent_messages": "".join(current["agent_messages"]),
                "text": "".join(current["text"]),
                "last_token_usage": None,
                "total_token_usage": None,
                "model_context_window": None,
                "rate_limits": None,
            }
        )
        yield current


def read_session_header(path: str | Path) -> dict[str, Any]:
    model = None
    header: dict[str, Any] = {}
    for line_number, entry in iter_entries_with_lines(path):
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        if entry.get("type") == "session_meta":
            header = {
                "source_line": line_number,
                "session_id": payload.get("id") or payload.get("session_id"),
                "cwd": payload.get("cwd"),
                "timestamp": parse_iso(entry.get("timestamp")),
                "cli_version": payload.get("cli_version"),
                "originator": payload.get("originator"),
                "model_provider": payload.get("model_provider"),
            }
        elif entry.get("type") == "turn_context":
            model = payload.get("model") or model
        if header and model:
            break
    header["model"] = model
    return header


def read_first_user_prompt(path: str | Path) -> dict[str, Any]:
    fallback: dict[str, Any] | None = None
    for line_number, entry in iter_entries_with_lines(path):
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        if entry.get("type") == "event_msg" and payload.get("type") == "user_message":
            message = payload.get("message")
            if isinstance(message, str):
                return {"source_line": line_number, "text": message}
        if (
            fallback is None
            and entry.get("type") == "response_item"
            and payload.get("type") == "message"
            and payload.get("role") == "user"
        ):
            text = content_text(payload.get("content"), "input_text")
            if text:
                fallback = {"source_line": line_number, "text": text}
    return fallback or {"source_line": None, "text": ""}


def terminal_events(path: str | Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_number, entry in iter_entries_with_lines(path):
        payload = entry.get("payload")
        if not isinstance(payload, dict) or entry.get("type") != "event_msg":
            continue
        event_type = payload.get("type")
        if event_type not in {"task_complete", "turn_aborted", "error"}:
            continue
        rows.append(
            {
                "source_line": line_number,
                "timestamp": parse_iso(entry.get("timestamp")),
                "type": event_type,
                "message": payload.get("message") or payload.get("reason"),
                "duration_ms": payload.get("duration_ms") or payload.get("durationMs"),
                "time_to_first_token_ms": payload.get("time_to_first_token_ms")
                or payload.get("timeToFirstTokenMs"),
                "last_agent_message": payload.get("last_agent_message"),
            }
        )
    return rows
