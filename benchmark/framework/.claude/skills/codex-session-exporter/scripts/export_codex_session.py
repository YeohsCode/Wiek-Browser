#!/usr/bin/env python3
"""Export a Codex rollout JSONL file as a self-contained HTML report.

This module intentionally uses only the Python standard library and does not
import the repository that happens to contain it.  Copy this directory anywhere
and run the script with Python 3.11 or newer.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import sys
from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any


CALL_TYPES = frozenset(
    {
        "function_call",
        "custom_tool_call",
        "web_search_call",
        "tool_search_call",
        "image_generation_call",
    }
)
OUTPUT_TYPES = frozenset(
    {
        "function_call_output",
        "custom_tool_call_output",
        "tool_search_call_output",
    }
)
TOOL_EVENT_HINTS = (
    "tool_call",
    "exec_command",
    "patch_apply",
    "web_search",
    "image_generation",
    "view_image",
    "dynamic_tool",
)
BINARY_KEYS = frozenset(
    {"data", "image_url", "imageUrl", "screenshot", "base64", "image"}
)
USAGE_KEYS = (
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
)


@dataclass(frozen=True)
class Record:
    """One parsed JSONL record with its immutable source position."""

    line: int
    timestamp: str
    entry_type: str
    payload: dict[str, Any]
    value: dict[str, Any]


@dataclass(frozen=True)
class Snapshot:
    """Raw bytes plus all valid records from one rollout file."""

    path: Path
    raw: bytes
    records: tuple[Record, ...]
    malformed_lines: tuple[int, ...]
    sha256: str


@dataclass
class TaskSpan:
    """Lifecycle and incremental usage for one native Codex task/turn."""

    number: int
    turn_id: str
    start_line: int
    started_at: str
    end_line: int | None = None
    ended_at: str = ""
    status: str = "incomplete"
    reason: str = ""
    duration_ms: float | None = None
    time_to_first_token_ms: float | None = None
    last_agent_message: str = ""
    model_responses: int = 0
    usage: dict[str, int] = field(default_factory=lambda: _empty_usage())
    rolled_back: bool = False


@dataclass(frozen=True)
class ToolCall:
    """A model-issued tool call paired with output and child telemetry."""

    record: Record
    call_id: str
    name: str
    arguments: Any
    output: Any
    child_records: tuple[Record, ...]


@dataclass(frozen=True)
class Analysis:
    """Derived session model used by the static renderer."""

    identity: dict[str, Any]
    meta_records: tuple[Record, ...]
    tasks: tuple[TaskSpan, ...]
    tools: tuple[ToolCall, ...]
    tool_by_line: dict[int, ToolCall]
    linked_child_lines: frozenset[int]
    observed_tools: Counter[str]
    dynamic_tools: tuple[dict[str, Any], ...]
    total_usage: dict[str, int]
    model_responses: int
    first_timestamp: str
    last_timestamp: str
    session_duration_s: float | None
    native_task_duration_s: float
    event_counts: Counter[str]


def _empty_usage() -> dict[str, int]:
    return {key: 0 for key in USAGE_KEYS}


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _duration_between(start: str, end: str) -> float | None:
    first = _parse_timestamp(start)
    last = _parse_timestamp(end)
    if first is None or last is None:
        return None
    return max(0.0, (last - first).total_seconds())


def read_snapshot(session_file: str | Path) -> Snapshot:
    """Read one JSONL snapshot without modifying or normalizing its raw bytes."""

    path = Path(session_file).expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"session file does not exist or is not a file: {path}")

    raw = path.read_bytes()
    records: list[Record] = []
    malformed: list[int] = []
    for line_number, raw_line in enumerate(raw.split(b"\n"), start=1):
        if not raw_line.strip():
            continue
        try:
            value = json.loads(raw_line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            malformed.append(line_number)
            continue
        if not isinstance(value, dict):
            malformed.append(line_number)
            continue
        payload = value.get("payload")
        records.append(
            Record(
                line=line_number,
                timestamp=str(value.get("timestamp") or ""),
                entry_type=str(value.get("type") or "unknown"),
                payload=payload if isinstance(payload, dict) else {},
                value=value,
            )
        )

    if not records or records[0].entry_type != "session_meta":
        raise ValueError("not a Codex rollout: first valid record is not session_meta")
    return Snapshot(
        path=path,
        raw=raw,
        records=tuple(records),
        malformed_lines=tuple(malformed),
        sha256=hashlib.sha256(raw).hexdigest(),
    )


def is_codex_session_file(path: str | Path) -> bool:
    """Return whether a file starts with a valid Codex session_meta record."""

    try:
        read_snapshot(path)
    except (OSError, ValueError):
        return False
    return True


def _usage(value: Any) -> dict[str, int]:
    result = _empty_usage()
    if not isinstance(value, dict):
        return result
    for key in USAGE_KEYS:
        raw_value = value.get(key)
        if isinstance(raw_value, (int, float)) and raw_value >= 0:
            result[key] = int(raw_value)
    if result["total_tokens"] == 0:
        result["total_tokens"] = (
            result["input_tokens"] + result["output_tokens"]
        )
    return result


def _add_usage(target: dict[str, int], value: Any) -> None:
    for key, amount in _usage(value).items():
        target[key] += amount


def _milliseconds(payload: dict[str, Any], *names: str) -> float | None:
    for name in names:
        value = payload.get(name)
        if isinstance(value, (int, float)) and value >= 0:
            return float(value)
    duration = payload.get("duration")
    if isinstance(duration, dict):
        seconds = duration.get("secs")
        nanos = duration.get("nanos")
        if isinstance(seconds, (int, float)) and isinstance(nanos, (int, float)):
            return (float(seconds) + float(nanos) / 1_000_000_000) * 1000
    return None


def _response_type(record: Record) -> str:
    return str(record.payload.get("type") or "")


def _event_type(record: Record) -> str:
    return str(record.payload.get("type") or "")


def _call_id(payload: dict[str, Any]) -> str:
    value = payload.get("call_id") or payload.get("id")
    return str(value) if isinstance(value, (str, int)) else ""


def _tool_name(payload: dict[str, Any]) -> str:
    item_type = str(payload.get("type") or "")
    name = str(payload.get("name") or "")
    namespace = str(payload.get("namespace") or "")
    if name:
        return f"{namespace}.{name}" if namespace else name
    return {
        "web_search_call": "web_search",
        "tool_search_call": "tool_search",
        "image_generation_call": "image_generation",
    }.get(item_type, item_type or "unknown")


def _tool_arguments(payload: dict[str, Any]) -> Any:
    item_type = str(payload.get("type") or "")
    if item_type == "custom_tool_call":
        return payload.get("input")
    if item_type == "function_call":
        return payload.get("arguments")
    excluded = {"type", "call_id", "id", "status", "result", "output"}
    return {key: value for key, value in payload.items() if key not in excluded}


def _tool_output_payload(payload: dict[str, Any]) -> Any:
    for key in ("output", "result", "content"):
        if key in payload:
            return payload[key]
    return payload


def _source_text(value: Any) -> str:
    if isinstance(value, str):
        return value.replace("\\\\", "\\")
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _is_tool_telemetry(record: Record) -> bool:
    if record.entry_type != "event_msg":
        return False
    event_type = _event_type(record)
    return any(hint in event_type for hint in TOOL_EVENT_HINTS)


def _telemetry_tool_name(record: Record) -> str:
    payload = record.payload
    event_type = _event_type(record)
    invocation = payload.get("invocation")
    if isinstance(invocation, dict):
        server = invocation.get("server")
        tool = invocation.get("tool")
        if server or tool:
            return f"mcp__{server or 'unknown'}__{tool or 'unknown'}"
    name = payload.get("tool_name") or payload.get("name")
    if isinstance(name, str) and name:
        return name
    return event_type.removesuffix("_begin").removesuffix("_end")


def _telemetry_signature(record: Record) -> str:
    payload = record.payload
    invocation = payload.get("invocation")
    if isinstance(invocation, dict):
        arguments = invocation.get("arguments")
        if isinstance(arguments, dict):
            code = arguments.get("code")
            title = arguments.get("title")
            if isinstance(code, str) and code:
                return code.replace("\\\\", "\\")
            if isinstance(title, str):
                return title
    for key in ("command", "cmd", "code", "title", "path"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value.replace("\\\\", "\\")
    return ""


def _flatten_dynamic_tools(meta_records: Iterable[Record]) -> tuple[dict[str, Any], ...]:
    found: dict[str, dict[str, Any]] = {}
    for record in meta_records:
        tools = record.payload.get("dynamic_tools")
        if not isinstance(tools, list):
            continue
        for item in tools:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "namespace" and isinstance(item.get("tools"), list):
                namespace = str(item.get("name") or "")
                for child in item["tools"]:
                    if not isinstance(child, dict):
                        continue
                    name = str(child.get("name") or "unknown")
                    full_name = f"{namespace}.{name}" if namespace else name
                    found.setdefault(
                        full_name,
                        {
                            "name": full_name,
                            "description": child.get("description"),
                            "inputSchema": child.get("inputSchema"),
                            "sourceLine": record.line,
                        },
                    )
            else:
                name = str(item.get("name") or "unknown")
                found.setdefault(
                    name,
                    {
                        "name": name,
                        "description": item.get("description"),
                        "inputSchema": item.get("inputSchema"),
                        "sourceLine": record.line,
                    },
                )
    return tuple(found[name] for name in sorted(found))


def _build_tasks(records: Sequence[Record]) -> tuple[TaskSpan, ...]:
    tasks: list[TaskSpan] = []
    by_turn_id: dict[str, TaskSpan] = {}
    active: TaskSpan | None = None

    for record in records:
        if record.entry_type != "event_msg":
            continue
        event_type = _event_type(record)
        payload = record.payload
        if event_type == "task_started":
            turn_id = str(payload.get("turn_id") or f"line-{record.line}")
            active = TaskSpan(
                number=len(tasks) + 1,
                turn_id=turn_id,
                start_line=record.line,
                started_at=record.timestamp,
            )
            tasks.append(active)
            by_turn_id[turn_id] = active
        elif event_type == "token_count":
            info = payload.get("info")
            last_usage = info.get("last_token_usage") if isinstance(info, dict) else None
            if active is not None and isinstance(last_usage, dict):
                active.model_responses += 1
                _add_usage(active.usage, last_usage)
        elif event_type in {"task_complete", "turn_aborted"}:
            turn_id = str(payload.get("turn_id") or "")
            task = by_turn_id.get(turn_id) or active
            if task is None:
                continue
            task.end_line = record.line
            task.ended_at = record.timestamp
            task.status = "complete" if event_type == "task_complete" else "aborted"
            task.reason = str(payload.get("reason") or "")
            task.duration_ms = _milliseconds(payload, "duration_ms", "durationMs")
            task.time_to_first_token_ms = _milliseconds(
                payload, "time_to_first_token_ms", "timeToFirstTokenMs"
            )
            task.last_agent_message = str(payload.get("last_agent_message") or "")
            if task is active:
                active = None
        elif event_type == "thread_rolled_back":
            count = payload.get("num_turns")
            if isinstance(count, int) and count > 0:
                for task in tasks[-count:]:
                    task.rolled_back = True

    last_line = records[-1].line if records else 0
    last_timestamp = records[-1].timestamp if records else ""
    for task in tasks:
        if task.end_line is None:
            task.end_line = last_line
            task.ended_at = last_timestamp
    return tuple(tasks)


def _task_for_line(tasks: Sequence[TaskSpan], line: int) -> TaskSpan | None:
    for task in reversed(tasks):
        if task.start_line <= line <= (task.end_line or line):
            return task
    return None


def _match_child_to_call(
    child: Record,
    calls_before_child: Sequence[tuple[Record, str, Any]],
) -> str | None:
    child_id = _call_id(child.payload)
    if child_id:
        exact = [call_id for _record, call_id, _args in calls_before_child if call_id == child_id]
        if len(exact) == 1:
            return exact[0]

    child_name = _telemetry_tool_name(child)
    signature = _telemetry_signature(child)
    candidates: list[str] = []
    for _record, call_id, arguments in calls_before_child:
        source = _source_text(arguments)
        name_matches = not child_name or child_name in source
        signature_matches = not signature or signature in source
        if name_matches and signature_matches:
            candidates.append(call_id)
    return candidates[0] if len(candidates) == 1 else None


def _build_tools(
    records: Sequence[Record],
) -> tuple[tuple[ToolCall, ...], frozenset[int], Counter[str]]:
    outputs: dict[str, Any] = {}
    calls_raw: list[tuple[Record, str, str, Any]] = []
    observed: Counter[str] = Counter()
    for record in records:
        if record.entry_type != "response_item":
            continue
        item_type = _response_type(record)
        if item_type in OUTPUT_TYPES:
            call_id = _call_id(record.payload)
            if call_id:
                outputs[call_id] = _tool_output_payload(record.payload)
        elif item_type in CALL_TYPES:
            call_id = _call_id(record.payload) or f"line-{record.line}"
            name = _tool_name(record.payload)
            arguments = _tool_arguments(record.payload)
            calls_raw.append((record, call_id, name, arguments))
            observed[name] += 1

    children: dict[str, list[Record]] = defaultdict(list)
    linked_lines: set[int] = set()
    for child in records:
        if not _is_tool_telemetry(child):
            continue
        calls_before = [
            (record, call_id, arguments)
            for record, call_id, _name, arguments in calls_raw
            if record.line < child.line
        ]
        parent_id = _match_child_to_call(child, calls_before)
        if parent_id is not None:
            children[parent_id].append(child)
            linked_lines.add(child.line)

    calls = tuple(
        ToolCall(
            record=record,
            call_id=call_id,
            name=name,
            arguments=arguments,
            output=(
                outputs[call_id]
                if call_id in outputs
                else {
                    key: record.payload[key]
                    for key in ("status", "result", "output", "revised_prompt", "saved_path")
                    if key in record.payload
                }
                or None
            ),
            child_records=tuple(children.get(call_id, [])),
        )
        for record, call_id, name, arguments in calls_raw
    )
    return calls, frozenset(linked_lines), observed


def analyze_snapshot(snapshot: Snapshot) -> Analysis:
    """Derive identity, task, token, tool, and lifecycle data from one snapshot."""

    records = snapshot.records
    meta_records = tuple(record for record in records if record.entry_type == "session_meta")
    identity = dict(meta_records[0].payload)
    tasks = _build_tasks(records)
    tools, linked_child_lines, observed_tools = _build_tools(records)

    total_usage = _empty_usage()
    model_responses = 0
    event_counts: Counter[str] = Counter()
    timestamps = [record.timestamp for record in records if _parse_timestamp(record.timestamp)]
    for record in records:
        subtype = _event_type(record) if record.entry_type == "event_msg" else _response_type(record)
        event_counts[f"{record.entry_type}:{subtype or '-'}"] += 1
        if record.entry_type == "event_msg" and subtype == "token_count":
            info = record.payload.get("info")
            if not isinstance(info, dict):
                continue
            last_usage = info.get("last_token_usage")
            if isinstance(last_usage, dict):
                model_responses += 1
            cumulative = info.get("total_token_usage")
            if isinstance(cumulative, dict):
                total_usage = _usage(cumulative)

    first_timestamp = timestamps[0] if timestamps else ""
    last_timestamp = timestamps[-1] if timestamps else ""
    session_duration_s = _duration_between(first_timestamp, last_timestamp)
    native_task_duration_s = sum(
        task.duration_ms / 1000 for task in tasks if task.duration_ms is not None
    )
    return Analysis(
        identity=identity,
        meta_records=meta_records,
        tasks=tasks,
        tools=tools,
        tool_by_line={tool.record.line: tool for tool in tools},
        linked_child_lines=linked_child_lines,
        observed_tools=observed_tools,
        dynamic_tools=_flatten_dynamic_tools(meta_records),
        total_usage=total_usage,
        model_responses=model_responses,
        first_timestamp=first_timestamp,
        last_timestamp=last_timestamp,
        session_duration_s=session_duration_s,
        native_task_duration_s=native_task_duration_s,
        event_counts=event_counts,
    )


def _is_data_string(value: str, key: str | None) -> bool:
    lowered = value[:80].lower()
    if lowered.startswith("data:") and ";base64," in lowered:
        return True
    if key in BINARY_KEYS and len(value) > 2000:
        return True
    return False


def _safe_visible(value: Any, *, key: str | None = None) -> Any:
    """Replace only embedded binary payloads; keep text and structured data exact."""

    if isinstance(value, str):
        if _is_data_string(value, key):
            mime = value[5:].split(";", 1)[0] if value.startswith("data:") else "binary"
            return f"<embedded {mime} omitted from view; {len(value):,} chars; present in raw JSONL>"
        return value
    if isinstance(value, list):
        return [_safe_visible(item) for item in value]
    if isinstance(value, dict):
        return {
            str(child_key): _safe_visible(child_value, key=str(child_key))
            for child_key, child_value in value.items()
        }
    return value


def _pretty(value: Any) -> str:
    safe = _safe_visible(value)
    if isinstance(safe, str):
        try:
            parsed = json.loads(safe)
        except json.JSONDecodeError:
            return safe
        return json.dumps(_safe_visible(parsed), ensure_ascii=False, indent=2)
    return json.dumps(safe, ensure_ascii=False, indent=2)


def _esc(value: Any) -> str:
    return html.escape(str(value if value is not None else ""))


def _clock(timestamp: str) -> str:
    return timestamp[11:19] if len(timestamp) >= 19 else timestamp


def _compact(value: str, limit: int = 100) -> str:
    text = " ".join(value.split())
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


def _message_content(payload: dict[str, Any]) -> tuple[str, list[str]]:
    content = payload.get("content")
    if isinstance(content, str):
        return content, []
    if not isinstance(content, list):
        return "", []
    text_parts: list[str] = []
    attachments: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = str(block.get("type") or "unknown")
        text = block.get("text")
        if block_type in {"input_text", "output_text", "text"} and isinstance(text, str):
            text_parts.append(text)
        elif "image" in block_type:
            value = block.get("image_url") or block.get("data") or block.get("url")
            size = len(value) if isinstance(value, str) else 0
            detail = block.get("detail") or (block.get("_meta") or {}).get("codex/imageDetail")
            attachments.append(
                f"{block_type}: embedded image, {size:,} chars"
                + (f", detail={detail}" if detail else "")
            )
        else:
            attachments.append(f"{block_type}: {_compact(_pretty(block), 180)}")
    return "\n\n".join(text_parts), attachments


def _reasoning_text(payload: dict[str, Any]) -> str:
    parts: list[str] = []
    for item in payload.get("summary") or []:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict) and isinstance(item.get("text"), str):
            parts.append(item["text"])
    return "\n".join(part for part in parts if part.strip())


def _event_text(payload: dict[str, Any]) -> str:
    for key in ("message", "text", "last_agent_message", "reasoning"):
        value = payload.get(key)
        if isinstance(value, str):
            return value
    return ""


def _format_duration(seconds: float | None) -> str:
    if seconds is None:
        return "n/a"
    if seconds < 60:
        return f"{seconds:.2f}s"
    minutes, remainder = divmod(seconds, 60)
    if minutes < 60:
        return f"{int(minutes)}m {remainder:.0f}s"
    hours, minutes = divmod(minutes, 60)
    return f"{int(hours)}h {int(minutes)}m"


def _format_ms(value: float | None) -> str:
    return _format_duration(value / 1000 if value is not None else None)


def _output_failed(value: Any) -> bool:
    text = _pretty(value).lower()
    if '"iserror": true' in text or '"success": false' in text:
        return True
    for marker in ('"exit_code": 0', "exit code: 0", "process exited with code 0"):
        if marker in text:
            return False
    return any(
        marker in text
        for marker in ("timed out", "declined", '"err"', "traceback", "process exited with code 1")
    )


def _child_status(record: Record) -> tuple[str, str]:
    payload = record.payload
    duration_ms = _milliseconds(payload, "duration_ms", "durationMs")
    status = str(payload.get("status") or "")
    success = payload.get("success")
    exit_code = payload.get("exit_code")
    result = payload.get("result")
    if not status:
        if success is False or (isinstance(exit_code, int) and exit_code != 0):
            status = "failed"
        elif isinstance(result, dict) and "Err" in result:
            status = "failed"
        elif success is True or (isinstance(result, dict) and "Ok" in result):
            status = "ok"
        else:
            status = "recorded"
    return status, _format_ms(duration_ms)


def _details(label: str, value: Any, *, css_class: str = "payload") -> str:
    text = _pretty(value)
    return (
        f'<details class="{_esc(css_class)}"><summary>{_esc(label)} '
        f'<span>{len(text):,} chars</span></summary><pre>{_esc(text)}</pre></details>'
    )


def _tool_body(tool: ToolCall) -> tuple[str, str, bool]:
    output_text = _pretty(tool.output) if tool.output is not None else ""
    failed = _output_failed(tool.output) if tool.output is not None else False
    body = '<div class="tool-columns">'
    body += f'<section><h4>Request</h4><pre>{_esc(_pretty(tool.arguments))}</pre></section>'
    body += "</div>"
    if tool.output is None:
        body += '<p class="notice warn">No paired model-visible tool output was emitted.</p>'
    else:
        state = "failed" if failed else "recorded"
        body += _details(f"Output · {state}", tool.output, css_class="payload tool-output")

    if tool.child_records:
        names = Counter(_telemetry_tool_name(record) for record in tool.child_records)
        summary = ", ".join(
            f"{name} ×{count}" if count > 1 else name for name, count in sorted(names.items())
        )
        children: list[str] = []
        for child in tool.child_records:
            status, duration = _child_status(child)
            children.append(
                '<section class="child-tool">'
                '<div class="child-head">'
                f'<strong>{_esc(_telemetry_tool_name(child))}</strong>'
                f'<span>{_esc(_event_type(child))} · {_esc(status)} · {_esc(duration)} · line {child.line}</span>'
                "</div>"
                f'{_details("Structured telemetry", child.payload)}'
                "</section>"
            )
        body += (
            '<details class="children"><summary><span>Child execution telemetry '
            f'({len(tool.child_records)})</span><span>{_esc(summary)}</span></summary>'
            f'<div class="child-list">{"".join(children)}</div></details>'
        )
    search = f"{tool.name} {_source_text(tool.arguments)} {output_text}"
    return body, search, failed


def _entry(
    *,
    index: int,
    record: Record,
    kind: str,
    role: str,
    phase: str,
    body: str,
    search: str,
    task: TaskSpan | None,
    failed: bool = False,
) -> tuple[str, str]:
    entry_id = f"entry-{index:04d}"
    task_classes = ""
    task_label = ""
    if task is not None:
        task_label = f"task {task.number}"
        if task.status == "aborted":
            task_classes += " task-aborted"
        if task.rolled_back:
            task_classes += " task-rolled-back"
            task_label += " · rolled back"
    if failed:
        task_classes += " entry-failed"
    search_value = _compact(search.lower(), 20_000)
    article = (
        f'<article class="entry {_esc(kind)}{task_classes}" id="{entry_id}" '
        f'data-kind="{_esc(kind)}" data-search="{_esc(search_value)}">'
        '<header class="entry-head">'
        f'<span class="entry-index">{index:03d}</span>'
        f'<strong class="entry-role">{_esc(role)}</strong>'
        f'<span class="entry-phase">{_esc(phase)}</span>'
        f'<span class="task-label">{_esc(task_label)}</span>'
        f'<time>{_esc(record.timestamp)}</time>'
        f'<span class="line-label">L{record.line}</span>'
        f'<a href="#{entry_id}" aria-label="Deep link">#</a>'
        f'</header><div class="entry-body">{body}</div></article>'
    )
    label = _compact(search) or phase or role
    nav = (
        f'<a class="nav-entry" href="#{entry_id}" data-target="{entry_id}" '
        f'data-kind="{_esc(kind)}" data-search="{_esc(search_value)}">'
        f'<span class="nav-mark">|</span><span>{index:03d} {_esc(label)}</span>'
        f'<time>{_esc(_clock(record.timestamp))}</time></a>'
    )
    return article, nav


def _is_suppressed_task(task: TaskSpan | None) -> bool:
    return bool(task is not None and task.status == "aborted" and task.rolled_back)


def _pre_world_state_groups(records: Sequence[Record]) -> dict[int, int]:
    """Map injected message lines before each task's first world_state to a group."""

    line_groups: dict[int, int] = {}
    candidates: list[int] = []
    collecting = True
    group_number = 0
    for record in records:
        if record.entry_type == "event_msg" and _event_type(record) == "task_started":
            candidates = []
            collecting = True
            continue
        if record.entry_type == "world_state" and collecting:
            if candidates:
                group_number += 1
                for line in candidates:
                    line_groups[line] = group_number
            candidates = []
            collecting = False
            continue
        if (
            collecting
            and record.entry_type == "response_item"
            and _response_type(record) == "message"
            and record.payload.get("role") in {"developer", "user"}
        ):
            candidates.append(record.line)
    return line_groups


def _pre_turn_context_user_lines(records: Sequence[Record]) -> frozenset[int]:
    """Return user message lines emitted before the current task's turn_context."""

    lines: set[int] = set()
    before_turn_context = True
    for record in records:
        if record.entry_type == "event_msg" and _event_type(record) == "task_started":
            before_turn_context = True
            continue
        if record.entry_type == "turn_context":
            before_turn_context = False
            continue
        if (
            before_turn_context
            and record.entry_type == "response_item"
            and _response_type(record) == "message"
            and record.payload.get("role") == "user"
        ):
            lines.add(record.line)
    return frozenset(lines)


def _folded_message(label: str, body: str, text_length: int) -> str:
    return (
        f'<details class="message-details"><summary>{_esc(label)} '
        f'<span>{text_length:,} chars</span></summary>'
        f'<div class="message-details-body">{body}</div></details>'
    )


def _context_child(
    *,
    index: int,
    record: Record,
    kind: str,
    role: str,
    phase: str,
    body: str,
) -> str:
    return (
        f'<details class="context-child {_esc(kind)}">'
        '<summary><span>'
        f'<span class="entry-index">{index:03d}</span> '
        f'<strong class="entry-role">{_esc(role)}</strong> '
        f'<span class="entry-phase">{_esc(phase)}</span>'
        '</span><span class="context-child-meta">'
        f'{_esc(record.timestamp)} · L{record.line}</span></summary>'
        f'<div class="context-child-body">{body}</div></details>'
    )


def _context_group(
    group_number: int,
    task: TaskSpan | None,
    children: Sequence[str],
    records: Sequence[Record],
    search: str,
) -> tuple[str, str]:
    group_id = f"pre-world-state-{group_number}"
    task_label = f"Task {task.number}" if task is not None else "Session"
    search_value = _compact(search.lower(), 20_000)
    first_line = records[0].line
    last_line = records[-1].line
    timestamp = records[0].timestamp
    article = (
        f'<details class="context-group" id="{group_id}" data-kind="context" '
        f'data-search="{_esc(search_value)}">'
        f'<summary><span>{_esc(task_label)} · pre-world-state context</span>'
        f'<span class="context-group-meta">{len(children)} records · '
        f'L{first_line}–L{last_line}</span></summary>'
        f'<div class="context-children">{"".join(children)}</div></details>'
    )
    nav = (
        f'<a class="nav-entry" href="#{group_id}" data-target="{group_id}" '
        f'data-kind="context" data-search="{_esc(search_value)}">'
        '<span class="nav-mark">|</span>'
        f'<span>{_esc(task_label)} · pre-world-state context ({len(children)})</span>'
        f'<time>{_esc(_clock(timestamp))}</time></a>'
    )
    return article, nav


def _rollback_child(
    *,
    index: int,
    record: Record,
    kind: str,
    role: str,
    phase: str,
    body: str,
) -> str:
    """Render one second-level, default-collapsed record in suppressed history."""

    return (
        f'<details class="rollback-child {_esc(kind)}">'
        '<summary><span>'
        f'<span class="entry-index">{index:03d}</span> '
        f'<strong class="entry-role">{_esc(role)}</strong> '
        f'<span class="entry-phase">{_esc(phase)}</span>'
        '</span><span class="rollback-child-meta">'
        f'{_esc(record.timestamp)} · L{record.line}</span></summary>'
        f'<div class="rollback-child-body">{body}</div></details>'
    )


def _rollback_group(
    task: TaskSpan,
    children: Sequence[str],
    search: str,
) -> tuple[str, str]:
    """Render one default-hidden, two-level group for aborted rolled-back history."""

    group_id = f"rollback-task-{task.number}"
    search_value = _compact(search.lower(), 20_000)
    article = (
        f'<details class="rollback-group suppressed-history task-aborted task-rolled-back" '
        f'id="{group_id}" data-kind="rollback" data-search="{_esc(search_value)}">'
        '<summary><span>'
        f'Task {task.number} · aborted · rolled back'
        '</span><span class="rollback-group-meta">'
        f'{len(children)} records · {_esc(_format_ms(task.duration_ms))} · '
        f'L{task.start_line}–L{task.end_line}</span></summary>'
        f'<div class="rollback-children">{"".join(children)}</div></details>'
    )
    nav = (
        f'<a class="nav-entry suppressed-history" href="#{group_id}" '
        f'data-target="{group_id}" data-kind="rollback" data-search="{_esc(search_value)}">'
        '<span class="nav-mark">|</span>'
        f'<span>Task {task.number} · aborted · rolled back ({len(children)})</span>'
        f'<time>{_esc(_clock(task.started_at))}</time></a>'
    )
    return article, nav


def _generic_body(record: Record, label: str) -> str:
    return _details(label, record.payload)


def _timeline(snapshot: Snapshot, analysis: Analysis) -> tuple[str, str, int]:
    articles: list[str] = []
    navigation: list[str] = []
    pre_world_line_groups = _pre_world_state_groups(snapshot.records)
    pre_turn_user_lines = _pre_turn_context_user_lines(snapshot.records)
    context_children: dict[int, list[str]] = defaultdict(list)
    context_records: dict[int, list[Record]] = defaultdict(list)
    context_search: dict[int, list[str]] = defaultdict(list)
    context_placeholders: dict[int, str] = {}
    rollback_children: dict[int, list[str]] = defaultdict(list)
    rollback_search: dict[int, list[str]] = defaultdict(list)
    rollback_placeholders: dict[int, str] = {}
    index = 0
    top_level_count = 0

    response_messages: Counter[tuple[str, str]] = Counter()
    response_reasoning: Counter[str] = Counter()
    for record in snapshot.records:
        if record.entry_type != "response_item":
            continue
        item_type = _response_type(record)
        if item_type == "message":
            text, _attachments = _message_content(record.payload)
            response_messages[(str(record.payload.get("role") or ""), text)] += 1
        elif item_type == "reasoning":
            text = _reasoning_text(record.payload)
            if text:
                response_reasoning[text] += 1

    seen_event_messages: Counter[tuple[str, str]] = Counter()
    seen_event_reasoning: Counter[str] = Counter()

    for record in snapshot.records:
        payload = record.payload
        entry_type = record.entry_type
        subtype = _response_type(record) if entry_type == "response_item" else _event_type(record)
        task = _task_for_line(analysis.tasks, record.line)
        suppressed_task = _is_suppressed_task(task)
        context_group_number = pre_world_line_groups.get(record.line)
        nested_context = context_group_number is not None and not suppressed_task
        nested_group = suppressed_task or nested_context
        kind = "runtime"
        role = entry_type
        phase = subtype or entry_type
        body = ""
        search = ""
        failed = False

        if entry_type == "session_meta":
            if record is analysis.meta_records[0]:
                continue
            kind = "lineage"
            role = "session lineage"
            search = _pretty(payload)
            body = _generic_body(record, "Additional session_meta payload")
        elif entry_type == "response_item":
            if subtype in OUTPUT_TYPES:
                continue
            if subtype == "message":
                message_role = str(payload.get("role") or "message")
                text, attachments = _message_content(payload)
                role = message_role
                kind = message_role if message_role in {"user", "assistant", "developer"} else "message"
                phase = str(payload.get("phase") or "message")
                search = " ".join([text, *attachments])
                body = f"<pre>{_esc(text)}</pre>" if text else '<p class="empty">No text block.</p>'
                if attachments:
                    items = "".join(f"<li>{_esc(item)}</li>" for item in attachments)
                    body += f'<div class="attachments"><strong>Attachments</strong><ul>{items}</ul></div>'
                if not nested_group and message_role == "developer":
                    body = _folded_message("Developer message", body, len(text))
                elif (
                    not nested_group
                    and message_role == "user"
                    and record.line in pre_turn_user_lines
                ):
                    body = _folded_message("Pre-turn user message", body, len(text))
            elif subtype == "reasoning":
                kind = role = "reasoning"
                phase = "thinking"
                text = _reasoning_text(payload)
                encrypted = bool(payload.get("encrypted_content") or payload.get("encryptedContent"))
                search = text or "encrypted reasoning"
                if text:
                    body = (
                        '<details class="reasoning-details"><summary>Reasoning summary '
                        f'<span>{len(text):,} chars</span></summary><pre>{_esc(text)}</pre></details>'
                    )
                else:
                    state = "Encrypted reasoning exists; no plaintext summary was emitted." if encrypted else "No plaintext reasoning summary was emitted."
                    body = f'<details class="reasoning-details"><summary>Reasoning metadata</summary><p class="notice">{_esc(state)}</p></details>'
            elif subtype in CALL_TYPES:
                tool = analysis.tool_by_line.get(record.line)
                if tool is None:
                    continue
                kind = "tool"
                role = tool.name
                phase = tool.call_id
                body, search, failed = _tool_body(tool)
            elif subtype == "agent_message":
                kind = "agent"
                role = "inter-agent message"
                text = _event_text(payload) or _pretty(payload.get("message"))
                metadata = payload.get("inter_agent_communication_metadata")
                search = f"{text} {_pretty(metadata)}"
                body = f"<pre>{_esc(text)}</pre>" + _details("Inter-agent metadata", metadata)
            else:
                kind = "runtime"
                role = f"response: {subtype or 'unknown'}"
                search = _pretty(payload)
                body = _generic_body(record, "Response item payload")
        elif entry_type == "event_msg":
            if record.line in analysis.linked_child_lines:
                continue
            if subtype in {"agent_message", "user_message"}:
                message_role = "assistant" if subtype == "agent_message" else "user"
                text = _event_text(payload)
                key = (message_role, text)
                seen_event_messages[key] += 1
                if text and seen_event_messages[key] <= response_messages[key]:
                    continue
                kind = message_role
                role = f"{message_role} fallback"
                phase = f"event_msg.{subtype}"
                search = text
                body = f"<pre>{_esc(text)}</pre>" + '<p class="provenance">Fallback event: no matching response_item.message was found.</p>'
            elif subtype == "agent_reasoning":
                text = _event_text(payload)
                seen_event_reasoning[text] += 1
                if text and seen_event_reasoning[text] <= response_reasoning[text]:
                    continue
                kind = role = "reasoning"
                phase = "event fallback"
                search = text
                body = (
                    '<details class="reasoning-details"><summary>Reasoning event fallback</summary>'
                    f'<pre>{_esc(text)}</pre><p class="provenance">No matching response_item reasoning summary was found.</p></details>'
                )
            elif subtype == "token_count":
                info = payload.get("info")
                if not isinstance(info, dict):
                    continue
                kind = "usage"
                role = "model usage"
                last_usage = _usage(info.get("last_token_usage"))
                phase = f"+{last_usage['total_tokens']:,} tokens"
                search = _pretty(payload)
                body = _details("Token and rate-limit snapshot", payload)
            elif subtype in {"task_started", "task_complete", "turn_aborted"}:
                kind = "lifecycle"
                role = subtype.replace("_", " ")
                phase = str(payload.get("turn_id") or "")
                search = _pretty(payload)
                body = _generic_body(record, "Lifecycle payload")
                if subtype == "task_complete":
                    final_text = str(payload.get("last_agent_message") or "")
                    final_key = ("assistant", final_text)
                    if (
                        final_text
                        and response_messages[final_key] == 0
                        and seen_event_messages[final_key] == 0
                    ):
                        body = (
                            f'<pre>{_esc(final_text)}</pre>'
                            '<p class="provenance">Final response fallback from '
                            'task_complete.last_agent_message; no matching assistant '
                            'message record was found.</p>'
                            + body
                        )
                failed = subtype == "turn_aborted"
            elif subtype in {"error", "stream_error"}:
                kind = "error"
                role = subtype.replace("_", " ")
                search = _pretty(payload)
                body = _generic_body(record, "Error payload")
                failed = True
            elif _is_tool_telemetry(record):
                kind = "tool"
                role = f"unlinked {_telemetry_tool_name(record)}"
                phase = subtype
                search = _pretty(payload)
                body = (
                    '<p class="notice warn">This structured tool event could not be uniquely linked to a model-visible parent call.</p>'
                    + _generic_body(record, "Structured tool telemetry")
                )
                failed = _child_status(record)[0] == "failed"
            else:
                kind = "lifecycle" if any(word in subtype for word in ("thread", "compact", "goal", "review", "setting", "sub_agent")) else "runtime"
                role = subtype.replace("_", " ") or "event"
                search = _pretty(payload)
                body = _generic_body(record, "Event payload")
        else:
            kind = "runtime"
            role = entry_type.replace("_", " ")
            search = _pretty(record.value)
            body = _details("Top-level record", record.value)

        index += 1
        if suppressed_task:
            assert task is not None
            rollback_children[task.number].append(
                _rollback_child(
                    index=index,
                    record=record,
                    kind=kind,
                    role=role,
                    phase=phase,
                    body=body,
                )
            )
            rollback_search[task.number].append(f"{role} {phase} {search}")
            if task.number not in rollback_placeholders:
                placeholder = f"<!-- suppressed-rollback-task-{task.number} -->"
                rollback_placeholders[task.number] = placeholder
                articles.append(placeholder)
                navigation.append(placeholder)
                top_level_count += 1
            continue
        if nested_context:
            assert context_group_number is not None
            context_children[context_group_number].append(
                _context_child(
                    index=index,
                    record=record,
                    kind=kind,
                    role=role,
                    phase=phase,
                    body=body,
                )
            )
            context_records[context_group_number].append(record)
            context_search[context_group_number].append(f"{role} {phase} {search}")
            if context_group_number not in context_placeholders:
                placeholder = f"<!-- pre-world-state-context-{context_group_number} -->"
                context_placeholders[context_group_number] = placeholder
                articles.append(placeholder)
                navigation.append(placeholder)
                top_level_count += 1
            continue
        article, nav = _entry(
            index=index,
            record=record,
            kind=kind,
            role=role,
            phase=phase,
            body=body,
            search=search,
            task=task,
            failed=failed,
        )
        articles.append(article)
        navigation.append(nav)
        top_level_count += 1

    article_html = "".join(articles)
    navigation_html = "".join(navigation)
    for group_number, placeholder in context_placeholders.items():
        records = context_records[group_number]
        task = _task_for_line(analysis.tasks, records[0].line)
        group, nav = _context_group(
            group_number,
            task,
            context_children[group_number],
            records,
            " ".join(context_search[group_number]),
        )
        article_html = article_html.replace(placeholder, group)
        navigation_html = navigation_html.replace(placeholder, nav)
    for task in analysis.tasks:
        placeholder = rollback_placeholders.get(task.number)
        if placeholder is None:
            continue
        group, nav = _rollback_group(
            task,
            rollback_children[task.number],
            " ".join(rollback_search[task.number]),
        )
        article_html = article_html.replace(placeholder, group)
        navigation_html = navigation_html.replace(placeholder, nav)

    return article_html, navigation_html, top_level_count


STYLE = r"""
:root {
  color-scheme: dark;
  --bg: #0f1011; --panel: #17191a; --panel-2: #1d2022; --line: #34383b;
  --text: #ececea; --muted: #999fa3; --blue: #75c7e5; --green: #8bd29a;
  --yellow: #e3c76a; --red: #ed8a82; --violet: #c7a7dd; --sidebar: 370px;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--text); font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
button, input { font: inherit; color: inherit; }
button { cursor: pointer; }
.sidebar { position: fixed; inset: 0 auto 0 0; z-index: 10; width: var(--sidebar); display: flex; flex-direction: column; background: #131516; border-right: 1px solid var(--line); }
.sidebar-head { padding: 16px; border-bottom: 1px solid var(--line); }
.sidebar-title { display: flex; justify-content: space-between; gap: 12px; }
.sidebar-title strong { overflow: hidden; color: var(--blue); text-overflow: ellipsis; white-space: nowrap; }
.search { width: 100%; margin-top: 12px; padding: 9px 10px; background: #0c0d0e; border: 1px solid #52575a; border-radius: 3px; outline: none; }
.search:focus { border-color: var(--blue); }
.filters { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.filter, .action { min-height: 30px; padding: 5px 8px; background: transparent; border: 1px solid var(--line); border-radius: 3px; }
.filter:hover, .action:hover, .filter.active { color: var(--blue); border-color: var(--blue); }
.action:disabled { color: var(--muted); border-color: var(--line); cursor: default; opacity: .55; }
.tree { flex: 1; min-height: 0; overflow: auto; padding: 7px 0 18px; }
.nav-entry { display: grid; grid-template-columns: 15px minmax(0,1fr) auto; gap: 6px; padding: 6px 12px; color: var(--muted); text-decoration: none; border-left: 2px solid transparent; }
.nav-entry:hover { color: var(--text); background: var(--panel); border-left-color: var(--blue); }
.nav-entry span:nth-child(2) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-entry time { color: #707679; font-size: 10px; }
.nav-entry[data-kind="user"] .nav-mark { color: var(--green); }
.nav-entry[data-kind="assistant"] .nav-mark { color: var(--blue); }
.nav-entry[data-kind="tool"] .nav-mark { color: var(--yellow); }
.nav-entry[data-kind="reasoning"] .nav-mark { color: var(--violet); }
.nav-entry[data-kind="error"] .nav-mark { color: var(--red); }
.nav-entry[data-kind="rollback"] .nav-mark { color: var(--red); }
.nav-entry[data-kind="context"] .nav-mark { color: var(--blue); }
.tree-count { padding: 9px 14px; color: var(--muted); border-top: 1px solid var(--line); }
.main { margin-left: var(--sidebar); }
.content { width: min(980px, calc(100% - 48px)); margin: 0 auto; padding: 30px 0 90px; }
.topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.eyebrow { color: var(--blue); font-weight: 700; text-transform: uppercase; }
h1 { margin: 5px 0 0; font-size: 20px; line-height: 1.3; overflow-wrap: anywhere; }
h2 { font-size: 13px; }
h4 { margin: 0 0 6px; color: var(--muted); font-size: 10px; text-transform: uppercase; }
.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
.meta-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); margin: 22px 0; border-top: 1px solid #555; border-left: 1px solid var(--line); }
.meta-cell { min-height: 65px; padding: 10px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.meta-cell span { display: block; color: var(--muted); font-size: 10px; text-transform: uppercase; }
.meta-cell strong { display: block; margin-top: 5px; overflow-wrap: anywhere; }
.section { margin-top: 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 3px; }
.section > summary, .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 42px; padding: 10px 12px; font-weight: 700; }
.section > summary { cursor: pointer; }
.section-body { padding: 0 12px 12px; border-top: 1px solid var(--line); }
.section-meta { color: var(--muted); font-size: 10px; font-weight: 400; text-align: right; }
.data-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.data-table th, .data-table td { padding: 8px 6px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.data-table th { color: var(--muted); font-size: 10px; text-transform: uppercase; }
.transcript-title { margin: 30px 0 8px; padding-bottom: 8px; border-bottom: 1px solid #555; }
.entry { margin-top: 11px; background: var(--panel); border: 1px solid var(--line); border-radius: 3px; scroll-margin-top: 10px; }
.entry.task-aborted { border-left: 3px solid var(--red); }
.entry.task-rolled-back { box-shadow: inset 4px 0 0 #b872d0; }
.entry.entry-failed { border-color: #7c4643; }
.entry-head { display: grid; grid-template-columns: auto minmax(100px,auto) minmax(80px,1fr) auto auto auto auto; gap: 8px; align-items: center; min-height: 39px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
.entry-index, .entry-phase, .task-label, .line-label, .entry-head time, .entry-head a { color: var(--muted); font-size: 10px; }
.entry-role { text-transform: uppercase; }
.entry.user .entry-role { color: var(--green); }
.entry.assistant .entry-role { color: var(--blue); }
.entry.tool .entry-role { color: var(--yellow); }
.entry.reasoning .entry-role { color: var(--violet); }
.entry.error .entry-role, .entry-failed .entry-role { color: var(--red); }
.entry-body { padding: 12px; }
.context-group { margin-top: 11px; background: var(--panel); border: 1px solid #416a78; border-left: 3px solid var(--blue); border-radius: 3px; scroll-margin-top: 10px; }
.context-group > summary { display: flex; justify-content: space-between; gap: 16px; min-height: 42px; padding: 10px 12px; color: var(--blue); font-weight: 700; }
.context-group-meta { color: var(--muted); font-size: 10px; font-weight: 400; text-align: right; }
.context-children { padding: 0 12px 12px 18px; border-top: 1px solid var(--line); }
.context-child { margin-top: 10px; background: #131516; border: 1px solid var(--line); border-radius: 3px; }
.context-child > summary { display: flex; justify-content: space-between; gap: 14px; padding: 9px 10px; }
.context-child-body { padding: 11px; border-top: 1px solid var(--line); }
.context-child-meta { color: var(--muted); font-size: 10px; text-align: right; }
.context-child.developer .entry-role { color: var(--red); }
.context-child.user .entry-role { color: var(--green); }
.rollback-group { margin-top: 11px; background: var(--panel); border: 1px solid #754844; border-left: 3px solid var(--red); border-radius: 3px; scroll-margin-top: 10px; }
.rollback-group > summary { display: flex; justify-content: space-between; gap: 16px; min-height: 42px; padding: 10px 12px; color: var(--red); font-weight: 700; }
.rollback-group-meta { color: var(--muted); font-size: 10px; font-weight: 400; text-align: right; }
.rollback-children { padding: 0 12px 12px 18px; border-top: 1px solid var(--line); }
.rollback-child { margin-top: 10px; background: #131516; border: 1px solid var(--line); border-radius: 3px; }
.rollback-child > summary { display: flex; justify-content: space-between; gap: 14px; padding: 9px 10px; }
.rollback-child-body { padding: 11px; border-top: 1px solid var(--line); }
.rollback-child-meta { color: var(--muted); font-size: 10px; text-align: right; }
.rollback-child.tool .entry-role { color: var(--yellow); }
.rollback-child.reasoning .entry-role { color: var(--violet); }
.rollback-child.user .entry-role { color: var(--green); }
.rollback-child.assistant .entry-role { color: var(--blue); }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; tab-size: 2; }
details > summary { cursor: pointer; }
.payload > summary { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); }
.payload > pre { max-height: 620px; margin-top: 10px; overflow: auto; padding: 10px; background: #111314; border: 1px solid var(--line); }
.tool-output { margin-top: 11px; padding-top: 10px; border-top: 1px solid var(--line); }
.tool-columns section > pre { max-height: 520px; overflow: auto; }
.children { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); }
.children > summary { display: flex; justify-content: space-between; gap: 12px; color: var(--yellow); }
.child-list { margin-top: 10px; padding-left: 12px; border-left: 2px solid var(--yellow); }
.child-tool { padding: 10px 0; }
.child-tool + .child-tool { border-top: 1px solid var(--line); }
.child-head { display: flex; justify-content: space-between; gap: 14px; margin-bottom: 8px; }
.child-head strong { color: var(--yellow); }
.child-head span { color: var(--muted); text-align: right; }
.reasoning-details > summary { display: flex; justify-content: space-between; color: var(--violet); }
.reasoning-details > pre { margin-top: 10px; }
.message-details > summary { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); }
.message-details-body { margin-top: 10px; }
.attachments { margin-top: 12px; padding: 10px; background: var(--panel-2); border: 1px solid var(--line); }
.attachments ul { margin: 6px 0 0; padding-left: 18px; }
.notice { padding-left: 9px; color: var(--muted); border-left: 3px solid var(--yellow); }
.notice.warn { color: var(--yellow); }
.provenance { margin: 10px 0 0; color: var(--muted); font-size: 10px; }
.empty, .source-note { color: var(--muted); }
.source-note { margin-top: 24px; overflow-wrap: anywhere; }
.suppressed-history { display: none; }
body.show-suppressed-history details.suppressed-history { display: block; }
body.show-suppressed-history tr.suppressed-history { display: table-row; }
body.show-suppressed-history a.suppressed-history { display: grid; }
.hidden { display: none !important; }
.menu-button { display: none; }
@media (max-width: 850px) {
  .sidebar { width: min(88vw,380px); transform: translateX(-100%); transition: transform 150ms ease; }
  body.sidebar-open .sidebar { transform: translateX(0); }
  .main { margin-left: 0; }
  .content { width: calc(100% - 28px); padding-top: 18px; }
  .topbar { flex-direction: column; }
  .actions { justify-content: flex-start; }
  .menu-button { display: inline-block; }
  .meta-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }
  .entry-head { grid-template-columns: auto 1fr auto auto; }
  .entry-phase, .task-label, .line-label { display: none; }
}
@media print {
  .sidebar, .actions { display: none; }
  .main { margin-left: 0; }
  .content { width: 100%; padding: 0; }
  body, .section, .entry { color: #111; background: #fff; }
}
"""


SCRIPT = r"""
(() => {
  const entries = [...document.querySelectorAll('.entry, .rollback-group')];
  const navEntries = [...document.querySelectorAll('.nav-entry')];
  const search = document.getElementById('search');
  const count = document.getElementById('tree-count');
  const suppressedToggle = document.getElementById('suppressed-toggle');
  let filter = 'all';
  let showSuppressed = false;
  const kinds = {
    messages: new Set(['user', 'assistant', 'developer', 'message', 'agent']),
    tools: new Set(['tool']),
    lifecycle: new Set(['lifecycle', 'runtime', 'lineage', 'usage', 'rollback', 'context']),
    errors: new Set(['error'])
  };

  const applyFilter = () => {
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    for (const entry of entries) {
      const targetFilter = filter === 'all' || (kinds[filter]?.has(entry.dataset.kind)) ||
        (filter === 'errors' && entry.classList.contains('entry-failed'));
      const allowedByHistory = showSuppressed || !entry.classList.contains('suppressed-history');
      const show = allowedByHistory && targetFilter && (!query || entry.dataset.search.includes(query));
      entry.classList.toggle('hidden', !show);
      const nav = document.querySelector(`.nav-entry[data-target="${entry.id}"]`);
      if (nav) nav.classList.toggle('hidden', !show);
      if (show) visible += 1;
    }
    count.textContent = `${visible} / ${entries.length} entries`;
  };
  search.addEventListener('input', applyFilter);
  document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => {
    filter = button.dataset.filter;
    document.querySelectorAll('.filter').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    applyFilter();
  }));
  document.getElementById('menu').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
  navEntries.forEach((entry) => entry.addEventListener('click', () => document.body.classList.remove('sidebar-open')));
  suppressedToggle.addEventListener('click', () => {
    showSuppressed = !showSuppressed;
    document.body.classList.toggle('show-suppressed-history', showSuppressed);
    if (showSuppressed) {
      document.querySelectorAll('.rollback-group, .rollback-child').forEach((item) => { item.open = false; });
    }
    suppressedToggle.textContent = showSuppressed
      ? `Hide aborted rollbacks (${suppressedToggle.dataset.count})`
      : `Show aborted rollbacks (${suppressedToggle.dataset.count})`;
    applyFilter();
  });
  document.getElementById('reasoning-toggle').addEventListener('click', (event) => {
    const details = [...document.querySelectorAll('.entry .reasoning-details')];
    const shouldOpen = details.some((item) => !item.open);
    details.forEach((item) => { item.open = shouldOpen; });
    event.currentTarget.textContent = shouldOpen ? 'Fold reasoning' : 'Open reasoning';
  });
  document.getElementById('children-toggle').addEventListener('click', (event) => {
    const details = [...document.querySelectorAll('.entry .children')];
    const shouldOpen = details.some((item) => !item.open);
    details.forEach((item) => { item.open = shouldOpen; });
    event.currentTarget.textContent = shouldOpen ? 'Fold child tools' : 'Open child tools';
  });
  document.getElementById('download').addEventListener('click', () => {
    const encoded = document.getElementById('raw-jsonl').textContent.trim();
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes], {type: 'application/x-ndjson'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = document.body.dataset.downloadName;
    link.click();
    URL.revokeObjectURL(url);
  });
  applyFilter();
})();
"""


def _summary_cells(snapshot: Snapshot, analysis: Analysis) -> str:
    identity = analysis.identity
    turn_context = next(
        (record.payload for record in snapshot.records if record.entry_type == "turn_context"),
        {},
    )
    git = identity.get("git") if isinstance(identity.get("git"), dict) else {}
    complete = sum(task.status == "complete" for task in analysis.tasks)
    aborted = sum(task.status == "aborted" for task in analysis.tasks)
    incomplete = sum(task.status == "incomplete" for task in analysis.tasks)
    values = (
        ("Session wall time", _format_duration(analysis.session_duration_s)),
        ("Native task time", _format_duration(analysis.native_task_duration_s)),
        ("Tasks", f"{len(analysis.tasks)} · {complete} complete / {aborted} aborted / {incomplete} incomplete"),
        ("Model responses", analysis.model_responses),
        ("Tool calls", len(analysis.tools)),
        ("Child telemetry", len(analysis.linked_child_lines)),
        ("Input tokens", f"{analysis.total_usage['input_tokens']:,}"),
        ("Cached input", f"{analysis.total_usage['cached_input_tokens']:,}"),
        ("Output tokens", f"{analysis.total_usage['output_tokens']:,}"),
        ("Reasoning tokens", f"{analysis.total_usage['reasoning_output_tokens']:,}"),
        ("Model", turn_context.get("model") or "n/a"),
        ("Provider", identity.get("model_provider") or "n/a"),
        ("CLI", identity.get("cli_version") or "n/a"),
        ("Approval", turn_context.get("approval_policy") or "n/a"),
        ("Git branch", git.get("branch") or "n/a"),
        ("Malformed lines", len(snapshot.malformed_lines)),
    )
    return "".join(
        f'<div class="meta-cell"><span>{_esc(label)}</span><strong>{_esc(value)}</strong></div>'
        for label, value in values
    )


def _task_section(tasks: Sequence[TaskSpan]) -> str:
    if not tasks:
        body = '<p class="empty">No task_started lifecycle event was recorded.</p>'
    else:
        rows: list[str] = []
        for task in tasks:
            state = task.status + (" · rolled back" if task.rolled_back else "")
            row_class = ' class="suppressed-history"' if _is_suppressed_task(task) else ""
            rows.append(
                f"<tr{row_class}>"
                f"<td>{task.number}</td><td>{_esc(task.turn_id)}</td><td>{_esc(state)}</td>"
                f"<td>{_esc(_format_ms(task.duration_ms))}</td>"
                f"<td>{task.model_responses}</td>"
                f"<td>{task.usage['input_tokens']:,} / {task.usage['output_tokens']:,} / {task.usage['reasoning_output_tokens']:,}</td>"
                f"<td>L{task.start_line}–L{task.end_line}</td></tr>"
            )
        body = (
            '<table class="data-table"><thead><tr><th>#</th><th>Turn ID</th><th>Status</th>'
            '<th>Native duration</th><th>Responses</th><th>Tokens in / out / reasoning</th><th>Lines</th>'
            f'</tr></thead><tbody>{"".join(rows)}</tbody></table>'
        )
    return (
        '<section class="section"><div class="section-head"><span>Task / turn lifecycle</span>'
        '<span class="section-meta">aborted + rolled-back rows follow the transcript visibility toggle</span></div>'
        f'<div class="section-body">{body}</div></section>'
    )


def _tool_section(analysis: Analysis) -> str:
    if not analysis.observed_tools:
        rows = '<tr><td colspan="2">No model-visible tool calls.</td></tr>'
    else:
        rows = "".join(
            f"<tr><td>{_esc(name)}</td><td>{count}</td></tr>"
            for name, count in sorted(analysis.observed_tools.items())
        )
    return (
        '<section class="section"><div class="section-head"><span>Observed tools</span>'
        '<span class="section-meta">model-issued calls; child telemetry is not double-counted</span></div>'
        '<div class="section-body"><table class="data-table"><thead><tr><th>Tool</th><th>Calls</th></tr></thead>'
        f'<tbody>{rows}</tbody></table></div></section>'
    )


def _dynamic_tools_section(tools: Sequence[dict[str, Any]]) -> str:
    if not tools:
        content = '<p class="empty">No session_meta.dynamic_tools records were emitted.</p>'
    else:
        rows = "".join(
            "<tr>"
            f'<td>{_esc(tool.get("name"))}</td>'
            f'<td>{_esc(_compact(str(tool.get("description") or ""), 220))}</td>'
            f'<td>L{_esc(tool.get("sourceLine"))}</td></tr>'
            for tool in tools
        )
        content = (
            '<table class="data-table"><thead><tr><th>Name</th><th>Description</th><th>Source</th></tr></thead>'
            f'<tbody>{rows}</tbody></table>{_details("Recorded schemas", list(tools))}'
        )
    return (
        '<details class="section"><summary><span>Known dynamic tools</span>'
        f'<span class="section-meta">partial inventory from session_meta · {len(tools)} entries</span></summary>'
        f'<div class="section-body"><p class="notice">This is the dynamic inventory recorded by the rollout, not a claim that every built-in tool was enumerated.</p>{content}</div></details>'
    )


def _lineage_section(meta_records: Sequence[Record]) -> str:
    rows: list[str] = []
    for index, record in enumerate(meta_records):
        payload = record.payload
        session_id = payload.get("id") or payload.get("session_id") or "n/a"
        label = "current identity" if index == 0 else "additional meta / lineage"
        rows.append(
            f"<tr><td>{index + 1}</td><td>{_esc(session_id)}</td><td>{_esc(label)}</td>"
            f"<td>{_esc(payload.get('thread_source') or payload.get('source'))}</td><td>L{record.line}</td></tr>"
        )
    return (
        '<details class="section"><summary><span>Identity and lineage</span>'
        f'<span class="section-meta">first session_meta defines report identity · {len(meta_records)} records</span></summary>'
        '<div class="section-body"><table class="data-table"><thead><tr><th>#</th><th>Session ID</th>'
        f'<th>Meaning</th><th>Source</th><th>Line</th></tr></thead><tbody>{"".join(rows)}</tbody></table>'
        f'{_details("All session_meta payloads", [record.payload for record in meta_records])}</div></details>'
    )


def _event_section(analysis: Analysis) -> str:
    rows = "".join(
        f"<tr><td>{_esc(name)}</td><td>{count}</td></tr>"
        for name, count in analysis.event_counts.most_common()
    )
    return (
        '<details class="section"><summary><span>Raw event coverage</span>'
        f'<span class="section-meta">{sum(analysis.event_counts.values())} parsed records by type</span></summary>'
        '<div class="section-body"><table class="data-table"><thead><tr><th>Record type</th><th>Count</th></tr></thead>'
        f'<tbody>{rows}</tbody></table></div></details>'
    )


def render_report(snapshot: Snapshot, analysis: Analysis, *, title: str | None = None) -> str:
    """Render an analyzed snapshot as a single-file static HTML document."""

    identity = analysis.identity
    session_id = str(identity.get("id") or identity.get("session_id") or snapshot.path.stem)
    report_title = title or session_id
    timeline, navigation, entry_count = _timeline(snapshot, analysis)
    suppressed_count = sum(_is_suppressed_task(task) for task in analysis.tasks)
    suppressed_disabled = " disabled" if suppressed_count == 0 else ""
    raw_jsonl = base64.b64encode(snapshot.raw).decode("ascii")
    malformed_notice = ""
    if snapshot.malformed_lines:
        malformed_notice = (
            '<p class="notice warn">Malformed JSONL lines were preserved in the raw download but could not be rendered: '
            f'{_esc(", ".join(map(str, snapshot.malformed_lines)))}</p>'
        )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{_esc(report_title)} · Codex session</title><style>{STYLE}</style></head>
<body data-download-name="{_esc(snapshot.path.name)}">
<aside class="sidebar"><div class="sidebar-head"><div class="sidebar-title"><strong>{_esc(report_title)}</strong><span>CODEX</span></div>
<input id="search" class="search" type="search" placeholder="Search visible process data" aria-label="Search report">
<div class="filters"><button class="filter active" data-filter="all">All</button><button class="filter" data-filter="messages">Messages</button>
<button class="filter" data-filter="tools">Tools</button><button class="filter" data-filter="lifecycle">Lifecycle</button><button class="filter" data-filter="errors">Errors</button></div></div>
<nav class="tree">{navigation}</nav><div class="tree-count" id="tree-count">{entry_count} / {entry_count} entries</div></aside>
<main class="main"><div class="content"><header class="topbar"><div><div class="eyebrow">Codex session report</div>
<h1>Session: {_esc(session_id)}</h1></div><div class="actions"><button class="action menu-button" id="menu">Menu</button>
<button class="action" id="suppressed-toggle" data-count="{suppressed_count}"{suppressed_disabled}>Show aborted rollbacks ({suppressed_count})</button>
<button class="action" id="reasoning-toggle">Open reasoning</button><button class="action" id="children-toggle">Open child tools</button>
<button class="action" id="download">Download raw JSONL</button></div></header>
<section class="meta-grid">{_summary_cells(snapshot, analysis)}</section>{malformed_notice}
{_lineage_section(analysis.meta_records)}{_task_section(analysis.tasks)}{_tool_section(analysis)}
{_dynamic_tools_section(analysis.dynamic_tools)}{_event_section(analysis)}
<h2 class="transcript-title">Process timeline</h2>{timeline}
<p class="source-note">Source: {_esc(snapshot.path)}<br>SHA-256: {_esc(snapshot.sha256)}<br>
Visible binary payloads are represented by metadata only; the exact original bytes remain in “Download raw JSONL”. Think time is not reported because the rollout does not expose it directly.</p>
</div></main><script id="raw-jsonl" type="application/octet-stream">{raw_jsonl}</script><script>{SCRIPT}</script></body></html>"""


def export_session(
    session_file: str | Path,
    output: str | Path | None = None,
    *,
    title: str | None = None,
) -> Path:
    """Validate a Codex session and export its standalone HTML report."""

    snapshot = read_snapshot(session_file)
    target = (
        Path(output).expanduser().resolve()
        if output is not None
        else snapshot.path.with_suffix(".html")
    )
    if target == snapshot.path:
        raise ValueError("output path must differ from the source session file")
    analysis = analyze_snapshot(snapshot)
    document = render_report(snapshot, analysis, title=title)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(document, encoding="utf-8")
    return target


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Export one Codex rollout/session JSONL as a self-contained HTML report.",
    )
    parser.add_argument("session_file", type=Path, help="Path to rollout/session JSONL")
    parser.add_argument("-o", "--output", type=Path, help="Output HTML path")
    parser.add_argument("--title", help="Optional report title")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the command-line exporter."""

    args = _parser().parse_args(argv)
    try:
        output = export_session(args.session_file, args.output, title=args.title)
    except (OSError, ValueError) as exc:
        print(f"Export failed: {exc}", file=sys.stderr)
        return 1
    print(f"HTML report exported: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
