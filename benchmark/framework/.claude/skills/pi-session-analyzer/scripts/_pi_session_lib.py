"""Shared streaming utilities for Pi sessions, tool pairs, and error buckets.

All readers scan line by line. Top-level timestamps and line numbers remain the
evidence coordinates, while message timestamps are exposed unchanged. This module
provides APIs without producing output.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

from _project import shell_output_is_error


# Error bucket patterns shared with the documented investigation workflow.

ERR_BUCKETS: list[tuple[str, re.Pattern[str]]] = [
    (
        "provider_transport",
        re.compile(
            r"provider_transport_failure|WebSocket error|connection (?:closed|reset)",
            re.IGNORECASE,
        ),
    ),
    ("empty_cell", re.compile(r"error:\s*empty cell", re.IGNORECASE)),
    # A declared task resource the agent looked for at the wrong path. Must be
    # tested before the generic missing_path. See wiek_bench/task_resources.py:
    # attachments are staged into task-files/ under the agent's working dir.
    (
        "task_resource_missing",
        re.compile(
            r"task-files/"
            r"|\.(?:pdf|csv|png|jpe?g|docx?|xlsx?|txt|json)\S*:?\s*No such file or directory"
        ),
    ),
    ("missing_path", re.compile(r"No such file or directory")),
    ("js_invalid_regex", re.compile(r"Invalid regular expression")),
    ("js_invalid_token", re.compile(r"Invalid or unexpected token")),
    ("js_syntax", re.compile(r"SyntaxError")),
    ("js_undef_access", re.compile(r"Cannot read properties of (?:null|undefined)")),
    ("js_ref_or_type", re.compile(r"ReferenceError|TypeError")),
    (
        "locator_miss",
        re.compile(
            r"matched 0 elements|Element not found|Could not locate element|not a valid selector"
        ),
    ),
    # wiek-lite made raw locators strict (2026-07, "enforce raw locator strictness"):
    # a selector matching several elements now throws instead of taking the first.
    # The opposite disease from locator_miss, so it must not share its bucket.
    ("locator_ambiguous", re.compile(r"matched [2-9]\d* elements|strict mode violation")),
    ("http_4xx", re.compile(r"failed: HTTP 4\d\d|status (?:code )?4\d\d")),
    ("http_5xx", re.compile(r"failed: HTTP 5\d\d|status (?:code )?5\d\d")),
    ("target_gone", re.compile(r"No target with given id|Target (?:closed|crashed|detached)")),
    ("ipc_timeout", re.compile(r"IPC request timed out|CDP request timed out|Runtime\.evaluate timed out")),
    ("command_timeout", re.compile(r"Command timed out|timed out after \d", re.IGNORECASE)),
    ("auth_required", re.compile(r"sign in|log in|\u767b\u5f55|\u672a\u767b\u5f55|authentication required", re.IGNORECASE)),
    ("captcha", re.compile(r"captcha|verify you are human|\u4eba\u673a\u9a8c\u8bc1", re.IGNORECASE)),
    # wiek-browser hard stop: the user took the task space back. Not a
    # tool defect and not retryable — the agent is supposed to stop and ask.
    (
        "user_control_stop",
        re.compile(
            r"user has taken control|user is controlling|task space is inactive|is not assigned"
        ),
    ),
    # The agent's own `throw new Error(...)` inside the heredoc: its verification
    # tripped. That is the script self-checking, not the browser tool breaking —
    # last resort before the generic exit-code bucket, so a runtime error that
    # also happens to print "Error:" keeps its specific bucket.
    ("script_assertion", re.compile(r"^\s*Error:", re.MULTILINE)),
    ("nonzero_exit", re.compile(r"Command exited with code [1-9]")),
]


def classify_error(text: str) -> str:
    """Classify error text, returning ``other`` when no pattern matches."""
    for name, pat in ERR_BUCKETS:
        if pat.search(text):
            return name
    return "other"


# Timestamp parsing.

def parse_iso(ts: Any) -> datetime | None:
    """Parse supported Pi session timestamp variants.

    Session headers and older versions use ISO 8601 strings, while newer messages
    may use epoch milliseconds. Invalid values return None.
    """
    if ts is None or ts == "":
        return None
    # Epoch milliseconds.
    if isinstance(ts, (int, float)) and not isinstance(ts, bool):
        try:
            from datetime import timezone
            return datetime.fromtimestamp(ts / 1000.0, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(ts, str):
        # Treat numeric strings as epoch milliseconds.
        if ts.isdigit():
            try:
                from datetime import timezone
                return datetime.fromtimestamp(int(ts) / 1000.0, tz=timezone.utc)
            except (OverflowError, OSError, ValueError):
                return None
        try:
            if ts.endswith("Z"):
                ts = ts[:-1] + "+00:00"
            return datetime.fromisoformat(ts)
        except ValueError:
            return None
    return None


# Streaming iteration.

def iter_entries_with_lines(path: str | Path) -> Iterator[tuple[int, dict[str, Any]]]:
    """Yield ``(one-based line, JSON object)`` pairs and skip invalid rows."""
    p = Path(path)
    with p.open("r", encoding="utf-8") as fh:
        for line_number, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                yield line_number, obj


def iter_entries(path: str | Path) -> Iterator[dict[str, Any]]:
    """Yield JSON objects; use ``iter_entries_with_lines`` for evidence coordinates."""
    for _, entry in iter_entries_with_lines(path):
        yield entry


def join_text_blocks(content: Any) -> str:
    """Join text blocks from message content."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    out: list[str] = []
    for c in content:
        if isinstance(c, dict) and c.get("type") == "text":
            t = c.get("text")
            if isinstance(t, str):
                out.append(t)
    return "".join(out)


def call_signature(tool_name: str, arguments: dict[str, Any]) -> str:
    """Stable, whitespace-normalized representation used for retry comparison."""
    normalized = json.dumps(arguments, ensure_ascii=False, sort_keys=True, default=str)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return f"{tool_name}:{normalized}"


def call_fingerprint(tool_name: str, arguments: dict[str, Any]) -> str:
    """Short evidence handle for exact tool + arguments identity."""
    return hashlib.sha256(call_signature(tool_name, arguments).encode("utf-8")).hexdigest()[:12]


# toolCall-to-toolResult pairing.

def iter_tool_pairs(path: str | Path) -> Iterator[dict[str, Any]]:
    """Yield tool calls and paired results in call order.

    Each item includes call identity, arguments, source coordinates, turn index,
    result coordinates, error status and bucket, result text, and latency.
    """
    pending: dict[str, dict[str, Any]] = {}
    assistant_turn = 0
    for line_number, ev in iter_entries_with_lines(path):
        if ev.get("type") != "message":
            continue
        m = ev.get("message", {})
        role = m.get("role")
        ts = parse_iso(ev.get("timestamp"))
        message_ts = parse_iso(m.get("timestamp"))
        content = m.get("content") or []

        if role == "assistant":
            assistant_turn += 1
            if not isinstance(content, list):
                continue
            for c in content:
                if isinstance(c, dict) and c.get("type") == "toolCall":
                    cid = c.get("id")
                    if not isinstance(cid, str):
                        continue
                    pending[cid] = {
                        "call_id": cid,
                        "tool_name": str(c.get("name") or "unknown"),
                        "arguments": c.get("arguments") or {},
                        "call_ts": ts,
                        "message_ts": message_ts,
                        "call_line": line_number,
                        "call_turn_index": assistant_turn,
                    }
            continue

        if role == "toolResult":
            cid = m.get("toolCallId")
            if not isinstance(cid, str):
                continue
            slot = pending.pop(cid, None)
            if slot is None:
                slot = {
                    "call_id": cid,
                    "tool_name": str(m.get("toolName") or "unknown"),
                    "arguments": {},
                    "call_ts": None,
                    "message_ts": None,
                    "call_line": None,
                    "call_turn_index": None,
                }
            slot["result_ts"] = ts
            slot["result_line"] = line_number
            result_text = join_text_blocks(content)
            slot["is_error"] = bool(m.get("isError")) or (
                slot["tool_name"] == "bash" and shell_output_is_error(result_text)
            )
            slot["result_text"] = result_text
            if slot["call_ts"] and ts:
                slot["latency_s"] = (ts - slot["call_ts"]).total_seconds()
            else:
                slot["latency_s"] = None
            slot["error_bucket"] = classify_error(slot["result_text"]) if slot["is_error"] else None
            yield slot

    # Emit unresolved calls with a null result timestamp.
    for slot in pending.values():
        slot["result_ts"] = None
        slot["result_line"] = None
        slot["is_error"] = None
        slot["result_text"] = ""
        slot["latency_s"] = None
        slot["error_bucket"] = None
        yield slot


# Assistant-turn metadata.

def iter_assistant_turns(path: str | Path) -> Iterator[dict[str, Any]]:
    """Yield metadata for each assistant turn.

    Includes source coordinates, model and stop metadata, joined thinking and text,
    tool calls, token usage, and cost.
    """
    idx = 0
    for line_number, ev in iter_entries_with_lines(path):
        if ev.get("type") != "message":
            continue
        m = ev.get("message", {})
        if m.get("role") != "assistant":
            continue
        idx += 1
        content = m.get("content") or []
        thinking_parts: list[str] = []
        text_parts: list[str] = []
        calls: list[dict[str, Any]] = []
        if isinstance(content, list):
            for c in content:
                if not isinstance(c, dict):
                    continue
                t = c.get("type")
                if t == "thinking":
                    th = c.get("thinking")
                    if isinstance(th, str):
                        thinking_parts.append(th)
                elif t == "text":
                    tx = c.get("text")
                    if isinstance(tx, str):
                        text_parts.append(tx)
                elif t == "toolCall":
                    calls.append({
                        "id": c.get("id"),
                        "name": c.get("name"),
                        "arguments": c.get("arguments") or {},
                    })
        usage = m.get("usage") or {}
        cost = (usage.get("cost") or {}) if isinstance(usage, dict) else {}
        yield {
            "turn_index": idx,
            "source_line": line_number,
            "ts": parse_iso(ev.get("timestamp")),
            "message_ts": parse_iso(m.get("timestamp")),
            "model": m.get("model"),
            "stop_reason": m.get("stopReason"),
            "response_id": m.get("responseId"),
            "thinking": "".join(thinking_parts),
            "text": "".join(text_parts),
            "tool_calls": calls,
            "usage": {
                "input": int(usage.get("input") or 0),
                "output": int(usage.get("output") or 0),
                "cacheRead": int(usage.get("cacheRead") or 0),
                "cacheWrite": int(usage.get("cacheWrite") or 0),
                "totalTokens": int(usage.get("totalTokens") or 0),
                "reasoning": (
                    int(usage.get("reasoning") or 0) if "reasoning" in usage else None
                ),
                "cost_total": float(cost.get("total") or 0.0),
            },
        }


# Session header.

def read_session_header(path: str | Path) -> dict[str, Any]:
    """Read the session header, returning an empty mapping when absent."""
    for ev in iter_entries(path):
        if ev.get("type") == "session":
            return {
                "session_id": ev.get("id"),
                "version": ev.get("version"),
                "timestamp": parse_iso(ev.get("timestamp")),
                "cwd": ev.get("cwd"),
            }
    return {}


def read_first_user_prompt(path: str | Path) -> str:
    """Read the first user prompt, returning an empty string when absent."""
    for ev in iter_entries(path):
        if ev.get("type") != "message":
            continue
        m = ev.get("message", {})
        if m.get("role") != "user":
            continue
        return join_text_blocks(m.get("content"))
    return ""


# JSONL serialization.

def to_jsonl(obj: dict[str, Any]) -> str:
    """Serialize datetimes as ISO strings without adding a newline."""
    def default(value: Any) -> str:
        if isinstance(value, datetime):
            return value.isoformat()
        raise TypeError(f"unserializable {type(value).__name__}")
    return json.dumps(obj, ensure_ascii=False, default=default)
