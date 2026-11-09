"""Pi/Codex session JSONL → SessionStats, the derived-metrics source of truth.

Pure stdlib, fault-tolerant: a missing file, broken JSON line, or absent field
yields a *partial* result with the cause recorded in ``parse_error`` / ``warnings``.
The main pipeline must never receive an exception from here (``safe_parse``).

``BashAction`` + ``bash_actions_from_session`` live here rather than in metrics
so the judge layer can depend on core alone.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from wiek_bench.codex_pricing import calculate_codex_cost_usd

# pi session JSONL is LF-framed; split on raw 0x0A only (header/entries are one line each).
_LF = b"\n"

CODEX_TOOL_CALL_TYPES = frozenset({"function_call", "custom_tool_call"})
CODEX_TOOL_OUTPUT_TYPES = frozenset(
    {"function_call_output", "custom_tool_call_output"}
)
SHELL_TOOL_NAMES = frozenset({"bash", "shell", "exec", "exec_command", "write_stdin"})

_SHELL_EXIT_FAILURE_RE = re.compile(
    r"(?im)^(?:process exited with code|command exited with code|exit code:)\s*[1-9]\d*\s*$"
)
_WIEK_BROWSER_WRAPPED_FAILURE_RE = re.compile(
    r"wiek(?:'s)? nodejs process exited with code [1-9]\d*",
    re.IGNORECASE,
)
_UNCAUGHT_REPL_FAILURE_RE = re.compile(
    r"(?im)^[ \t]*Uncaught(?:\b|:)",
)
_TOP_LEVEL_TRACEBACK_RE = re.compile(
    r"(?im)^[ \t]*Traceback \(most recent call last\):",
)
_TOP_LEVEL_AWAIT_SYNTAX_RE = re.compile(
    r"(?im)^[ \t]*SyntaxError:\s*await is only valid\b",
)
_MASKED_IO_FAILURE_RE = re.compile(
    r"(?im)^[ \t]*I/O Error:\s*Couldn't open file\b",
)
_WRITE_STDIN_FAILURE_RE = re.compile(
    r"(?im)^[ \t]*write_stdin failed:",
)


@dataclass
class SessionStats:
    session_id: str | None = None
    session_file: str | None = None
    cwd: str | None = None
    model: str | None = None
    final_output: str = ""
    stop_reason_error: str | None = None
    duration_s: float | None = None
    # Timing components sum intervals between entry timestamps. Sessions with
    # no timestamps retain ``None``. think_time_s sums wiek-bench-think entries.
    think_time_s: float | None = None
    llm_time_s: float | None = None
    env_time_s: float | None = None
    time_to_first_token_s: float | None = None
    # Prefer provider-reported reasoning usage. If no entry reports it, estimate
    # from thinking text with o200k_base; use ``None`` when tiktoken is absent.
    reasoning_tokens: int | None = None
    reasoning_tokens_is_estimate: bool = False
    num_turns: int = 0
    tool_calls: int = 0
    tool_failures: int = 0
    tool_call_dist: dict[str, int] = field(default_factory=dict)
    bash_cmd_dist: dict[str, int] = field(default_factory=dict)
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    cost_usd: float | None = None
    cost_is_estimate: bool = False
    cost_source: str | None = None
    parse_error: str | None = None
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class BashAction:
    command: str
    is_error: bool


@dataclass(frozen=True)
class TrajectoryStep:
    """One agent turn that issued ≥1 bash action, for the Odysseys paper-style action
    history: ``response`` = that turn's visible reply text, or its thinking
    when the visible text is empty (some agents narrate only via thinking); ``actions`` =
    the bash commands it ran in that turn (with each command's is_error)."""

    response: str
    actions: list[BashAction]


def _parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    text = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _text_from_content(content: Any) -> str:
    """Join text blocks from a message ``content`` (string or block list)."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "".join(parts)


def _tool_output_text(output: Any) -> str:
    if isinstance(output, str):
        return output
    if isinstance(output, (dict, list)):
        return json.dumps(output, ensure_ascii=False)
    return ""


def shell_output_is_error(output: Any) -> bool:
    """Return whether a shell-like tool result proves the whole call failed.

    Pi/Codex wrappers can report success even when the nested process or REPL cell
    failed. Keep this high precision: explicit exit markers, wiek-browser's nested
    exit marker, uncaught REPL failures, and known shell-pipeline masking cases count;
    caught sub-operation text such as ``click err ...`` does not.
    """
    text = _tool_output_text(output)
    if not text:
        return False
    return any(
        pattern.search(text)
        for pattern in (
            _SHELL_EXIT_FAILURE_RE,
            _WIEK_BROWSER_WRAPPED_FAILURE_RE,
            _UNCAUGHT_REPL_FAILURE_RE,
            _TOP_LEVEL_TRACEBACK_RE,
            _TOP_LEVEL_AWAIT_SYNTAX_RE,
            _MASKED_IO_FAILURE_RE,
            _WRITE_STDIN_FAILURE_RE,
        )
    )


def _pi_tool_result_is_error(message: dict[str, Any]) -> bool:
    if message.get("isError") is True:
        return True
    if message.get("toolName") != "bash":
        return False
    return shell_output_is_error(_text_from_content(message.get("content")))


def extract_stop_reason_error(message: dict[str, Any]) -> str | None:
    """Root-cause summary when an assistant message stopped with stopReason=="error".

    A diagnostics ``provider_transport_failure`` takes priority so the
    ``provider_transport_failure:`` prefix survives for transport_failure_count; else
    the plain ``errorMessage``; else a generic fallback. ``None`` if not an error stop.

    Public so the judge layer detects the same signal from its event stream as the
    Stage A parser does from the session file — one extraction rule, two call sites.
    """
    if message.get("stopReason") != "error":
        return None
    for diag in message.get("diagnostics") or []:
        if isinstance(diag, dict) and diag.get("type") == "provider_transport_failure":
            err = diag.get("error")
            detail = err.get("message") if isinstance(err, dict) else None
            return f"provider_transport_failure: {detail or 'transport error'}"
    err_msg = message.get("errorMessage")
    if isinstance(err_msg, str) and err_msg.strip():
        return err_msg
    return "stop reason error"


_O200K_ENCODING: Any = None


def _estimate_reasoning_tokens(thinking_text: str, warnings: list[str]) -> int | None:
    """Estimate thinking-text tokens with o200k_base, or return ``None`` without tiktoken."""
    if not thinking_text:
        return 0
    global _O200K_ENCODING
    if _O200K_ENCODING is None:
        try:
            import tiktoken

            _O200K_ENCODING = tiktoken.get_encoding("o200k_base")
        except Exception as exc:  # noqa: BLE001 - missing package/cache both degrade to None
            _O200K_ENCODING = False
            warnings.append(f"tiktoken unavailable, reasoning_tokens=None: {exc}")
    if _O200K_ENCODING is False:
        warnings.append("tiktoken unavailable, reasoning_tokens=None")
        return None
    try:
        return len(_O200K_ENCODING.encode(thinking_text, disallowed_special=()))
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"reasoning token encode failed: {exc}")
        return None


def _iter_entries(path: Path) -> list[dict[str, Any]]:
    raw = path.read_bytes()
    entries: list[dict[str, Any]] = []
    for line in raw.split(_LF):
        if not line.strip():
            continue
        entries.append(json.loads(line.decode("utf-8")))
    return entries


def _is_codex_rollout(entries: list[dict[str, Any]]) -> bool:
    return bool(entries and entries[0].get("type") == "session_meta")


def _codex_content_text(content: Any, *, output: bool = False) -> str:
    if not isinstance(content, list):
        return ""
    wanted = "output_text" if output else "input_text"
    return "".join(
        str(block.get("text") or "")
        for block in content
        if isinstance(block, dict) and block.get("type") == wanted
    )


def _codex_arguments(payload: dict[str, Any]) -> dict[str, Any]:
    is_custom = payload.get("type") == "custom_tool_call"
    raw = payload.get("input") if is_custom else payload.get("arguments")
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {"input": raw} if is_custom else {}
    if isinstance(parsed, dict):
        return parsed
    return {"input": raw} if is_custom else {}


def _codex_shell_command(payload: dict[str, Any]) -> str | None:
    name = payload.get("name")
    args = _codex_arguments(payload)
    if name == "exec_command":
        value = args.get("cmd")
    elif name == "write_stdin":
        value = args.get("chars")
    elif name in {"shell", "bash"}:
        value = args.get("command")
    elif name == "exec":
        # Codex's unified JavaScript runtime records the source passed to
        # tools.exec_command/tools.write_stdin as custom_tool_call input. Treat
        # the whole source as one command, symmetric with Pi's nodejs heredoc.
        value = args.get("input") or args.get("cmd") or args.get("command")
    else:
        return None
    return value if isinstance(value, str) and value.strip() else None


def _codex_output_is_error(output: Any, *, tool_name: str | None = None) -> bool:
    text = _tool_output_text(output)
    if not text:
        return False
    lowered = text.lower()
    if "is_error: true" in lowered:
        return True
    if tool_name is not None and tool_name not in SHELL_TOOL_NAMES:
        return False
    return shell_output_is_error(text)


def _codex_usage(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    return {
        "input_tokens": int(value.get("input_tokens", 0) or 0),
        "cached_input_tokens": int(value.get("cached_input_tokens", 0) or 0),
        "output_tokens": int(value.get("output_tokens", 0) or 0),
        "reasoning_output_tokens": int(value.get("reasoning_output_tokens", 0) or 0),
    }


def _codex_usage_delta(
    total: dict[str, int], previous: dict[str, int] | None
) -> dict[str, int]:
    if previous is None:
        return dict(total)
    return {key: max(0, value - previous.get(key, 0)) for key, value in total.items()}


def _milliseconds(payload: dict[str, Any], *names: str) -> float | None:
    for name in names:
        value = payload.get(name)
        if isinstance(value, (int, float)) and value >= 0:
            return float(value)
    return None


def _codex_item_duration_s(item: dict[str, Any]) -> float | None:
    duration_ms = _milliseconds(item, "duration_ms", "durationMs")
    if duration_ms is not None:
        return duration_ms / 1000.0
    duration = item.get("duration")
    if not isinstance(duration, dict):
        return None
    seconds = duration.get("secs")
    nanoseconds = duration.get("nanos")
    if (
        not isinstance(seconds, (int, float))
        or not isinstance(nanoseconds, (int, float))
        or seconds < 0
        or nanoseconds < 0
    ):
        return None
    return float(seconds) + float(nanoseconds) / 1_000_000_000


def _parse_codex_entries(
    path: Path,
    entries: list[dict[str, Any]],
    *,
    pricing_snapshot: dict[str, Any] | None = None,
) -> SessionStats:
    stats = SessionStats(session_file=str(path), cost_usd=None)
    first_ts: datetime | None = None
    last_ts: datetime | None = None
    call_started: dict[str, datetime] = {}
    call_names: dict[str, str] = {}
    call_ids: set[str] = set()
    derived_call_durations: dict[str, float] = {}
    native_call_durations: dict[str, float] = {}
    derived_env_time = 0.0
    native_duration_s: float | None = None
    last_assistant_text = ""
    last_usage: dict[str, Any] | None = None
    previous_total_usage: dict[str, int] | None = None
    token_usages: list[dict[str, int]] = []

    for entry in entries:
        if not isinstance(entry, dict):
            stats.warnings.append("non-dict entry skipped")
            continue
        ts = _parse_ts(entry.get("timestamp"))
        if ts is not None:
            first_ts = first_ts or ts
            last_ts = ts
        etype = entry.get("type")
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        if etype == "session_meta":
            stats.session_id = payload.get("id") or payload.get("session_id")
            stats.cwd = payload.get("cwd")
        elif etype == "turn_context":
            stats.model = payload.get("model") or stats.model
            stats.cwd = payload.get("cwd") or stats.cwd
        elif etype == "response_item":
            ptype = payload.get("type")
            if ptype == "message" and payload.get("role") == "assistant":
                text = _codex_content_text(payload.get("content"), output=True)
                if text.strip():
                    last_assistant_text = text
            elif ptype in CODEX_TOOL_CALL_TYPES:
                name = str(payload.get("name") or "unknown")
                stats.tool_calls += 1
                stats.tool_call_dist[name] = stats.tool_call_dist.get(name, 0) + 1
                call_id = payload.get("call_id")
                if isinstance(call_id, str):
                    call_ids.add(call_id)
                    call_names[call_id] = name
                    if ts is not None:
                        call_started[call_id] = ts
                command = _codex_shell_command(payload)
                if command and name == "exec_command":
                    head = command.strip().split()[0]
                    stats.bash_cmd_dist[head] = stats.bash_cmd_dist.get(head, 0) + 1
            elif ptype in CODEX_TOOL_OUTPUT_TYPES:
                call_id = payload.get("call_id")
                tool_name = call_names.get(call_id) if isinstance(call_id, str) else None
                if _codex_output_is_error(payload.get("output"), tool_name=tool_name):
                    stats.tool_failures += 1
                started = call_started.get(call_id) if isinstance(call_id, str) else None
                if started is not None and ts is not None:
                    duration_s = max(0.0, (ts - started).total_seconds())
                    derived_env_time += duration_s
                    derived_call_durations[call_id] = duration_s
        elif etype == "event_msg":
            ptype = payload.get("type")
            if ptype == "token_count":
                stats.num_turns += 1
                info = payload.get("info") or {}
                total = _codex_usage(info.get("total_token_usage"))
                last = _codex_usage(info.get("last_token_usage"))
                if total is not None:
                    last_usage = total
                    token_usages.append(last or _codex_usage_delta(total, previous_total_usage))
                    previous_total_usage = total
            elif ptype == "task_complete":
                duration_ms = _milliseconds(payload, "duration_ms", "durationMs")
                if duration_ms is not None:
                    native_duration_s = duration_ms / 1000.0
                ttft_ms = _milliseconds(
                    payload,
                    "time_to_first_token_ms",
                    "timeToFirstTokenMs",
                )
                if ttft_ms is not None:
                    stats.time_to_first_token_s = ttft_ms / 1000.0
            elif ptype == "item_completed":
                item = payload.get("item")
                if isinstance(item, dict) and item.get("type") in {
                    "CommandExecution",
                    "DynamicToolCall",
                    "McpToolCall",
                    "command_execution",
                    "commandExecution",
                    "dynamic_tool_call",
                    "dynamicToolCall",
                    "mcp_tool_call",
                    "mcpToolCall",
                }:
                    duration_s = _codex_item_duration_s(item)
                    item_id = item.get("id")
                    if duration_s is not None and isinstance(item_id, str):
                        native_call_durations[item_id] = duration_s
            elif ptype in {"turn_aborted", "error"}:
                detail = payload.get("message") or payload.get("reason") or ptype
                stats.stop_reason_error = str(detail)

    stats.final_output = last_assistant_text
    if last_usage is not None:
        stats.input_tokens = int(last_usage.get("input_tokens", 0) or 0)
        stats.output_tokens = int(last_usage.get("output_tokens", 0) or 0)
        stats.cache_read_tokens = int(last_usage.get("cached_input_tokens", 0) or 0)
        stats.reasoning_tokens = int(last_usage.get("reasoning_output_tokens", 0) or 0)
        stats.reasoning_tokens_is_estimate = False
    stats.cost_usd = calculate_codex_cost_usd(stats.model, token_usages, pricing_snapshot)
    if stats.cost_usd is not None:
        stats.cost_is_estimate = True
        tier_source = pricing_snapshot.get("service_tier_source") if pricing_snapshot else None
        stats.cost_source = "models.dev + OpenAI API pricing" if tier_source else "models.dev"
    if native_duration_s is not None:
        stats.duration_s = native_duration_s
    elif first_ts is not None and last_ts is not None:
        stats.duration_s = max(0.0, (last_ts - first_ts).total_seconds())
    if stats.duration_s is not None:
        env_time = derived_env_time
        for call_id, duration_s in native_call_durations.items():
            if call_id in call_ids:
                env_time += duration_s - derived_call_durations.get(call_id, 0.0)
        stats.env_time_s = env_time
        stats.llm_time_s = max(0.0, stats.duration_s - env_time)
    return stats


def parse_codex_rollout_entries(
    session_file: str | Path,
    entries: list[dict[str, Any]],
    *,
    pricing_snapshot: dict[str, Any] | None = None,
) -> SessionStats:
    """Parse a caller-owned immutable Codex rollout snapshot."""
    return _parse_codex_entries(Path(session_file), entries, pricing_snapshot=pricing_snapshot)


def parse_session_file(
    path: str | Path, *, pricing_snapshot: dict[str, Any] | None = None
) -> SessionStats:
    """Parse a Pi session or Codex rollout. May raise on unreadable input."""
    p = Path(path)
    stats = SessionStats(session_file=str(p))
    if not p.exists():
        stats.parse_error = "session file does not exist"
        return stats

    entries: list[dict[str, Any]] = []
    try:
        entries = _iter_entries(p)
    except Exception as exc:  # noqa: BLE001 - record and continue with whatever parsed
        stats.parse_error = f"read error: {exc}"
        return stats

    if _is_codex_rollout(entries):
        return _parse_codex_entries(p, entries, pricing_snapshot=pricing_snapshot)

    stats.cost_usd = 0.0
    first_ts: datetime | None = None
    last_ts: datetime | None = None
    prev_ts: datetime | None = None
    llm_time = 0.0
    env_time = 0.0
    think_ms: int | None = None
    thinking_parts: list[str] = []
    last_assistant_text = ""
    last_assistant_stop_error: str | None = None
    reasoning_real_sum = 0
    reasoning_real_seen = False

    for entry in entries:
        if not isinstance(entry, dict):
            stats.warnings.append("non-dict entry skipped")
            continue
        etype = entry.get("type")
        ts = _parse_ts(entry.get("timestamp"))
        if ts is not None:
            if first_ts is None:
                first_ts = ts
            last_ts = ts
        # An assistant timestamp marks response completion, so the interval from
        # the previous entry belongs to the LLM round trip. A toolResult interval
        # belongs to environment execution. Clamp negative values to zero.
        # Custom entries do not advance prev_ts because wiek-bench-think lands
        # before the assistant message and would otherwise erase the LLM interval.
        span = (ts - prev_ts).total_seconds() if ts is not None and prev_ts is not None else None
        if ts is not None and etype != "custom":
            prev_ts = ts

        if etype == "custom":
            if entry.get("customType") == "wiek-bench-think":
                value = (entry.get("data") or {}).get("think_ms")
                if isinstance(value, (int, float)) and value >= 0:
                    think_ms = (think_ms or 0) + int(value)
            continue
        if etype == "session":
            stats.session_id = entry.get("id")
            stats.cwd = entry.get("cwd")
            version = entry.get("version")
            if version is not None and version != 3:
                stats.warnings.append(f"unexpected session version: {version}")
            continue
        if etype != "message":
            continue

        message = entry.get("message")
        if not isinstance(message, dict):
            continue
        role = message.get("role")

        if role == "assistant":
            stats.num_turns += 1
            if span is not None:
                llm_time += max(0.0, span)
            if message.get("model"):
                stats.model = message["model"]
            usage = message.get("usage") or {}
            stats.input_tokens += int(usage.get("input", 0) or 0)
            stats.output_tokens += int(usage.get("output", 0) or 0)
            stats.cache_read_tokens += int(usage.get("cacheRead", 0) or 0)
            stats.cache_creation_tokens += int(usage.get("cacheWrite", 0) or 0)
            if "reasoning" in usage:
                reasoning_real_seen = True
                reasoning_real_sum += int(usage.get("reasoning", 0) or 0)
            cost = usage.get("cost") or {}
            stats.cost_usd = float(stats.cost_usd or 0.0) + float(
                cost.get("total", 0.0) or 0.0
            )
            stats.cost_source = "provider_usage"

            # last assistant message wins; tracked independent of text (a transport
            # failure stops with only thinking/no text yet must still be detected).
            last_assistant_stop_error = extract_stop_reason_error(message)

            text = _text_from_content(message.get("content"))
            if text.strip():
                last_assistant_text = text
            for block in message.get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "thinking" and isinstance(block.get("thinking"), str):
                    thinking_parts.append(block["thinking"])
                if block.get("type") != "toolCall":
                    continue
                name = block.get("name") or "unknown"
                stats.tool_calls += 1
                stats.tool_call_dist[name] = stats.tool_call_dist.get(name, 0) + 1
                if name == "bash":
                    command = (block.get("arguments") or {}).get("command")
                    if isinstance(command, str) and command.strip():
                        head = command.strip().split()[0]
                        stats.bash_cmd_dist[head] = stats.bash_cmd_dist.get(head, 0) + 1
        elif role == "toolResult":
            if _pi_tool_result_is_error(message):
                stats.tool_failures += 1
            if span is not None:
                env_time += max(0.0, span)

    stats.final_output = last_assistant_text
    stats.stop_reason_error = last_assistant_stop_error
    if reasoning_real_seen:
        stats.reasoning_tokens = reasoning_real_sum
        stats.reasoning_tokens_is_estimate = False
    else:
        stats.reasoning_tokens = _estimate_reasoning_tokens("".join(thinking_parts), stats.warnings)
        stats.reasoning_tokens_is_estimate = True
    if first_ts is not None and last_ts is not None:
        stats.duration_s = max(0.0, (last_ts - first_ts).total_seconds())
        # When thinking is measurable, report LLM time excluding thinking.
        if think_ms is not None:
            stats.think_time_s = think_ms / 1000.0
            stats.llm_time_s = max(0.0, llm_time - stats.think_time_s)
        else:
            stats.llm_time_s = llm_time
        stats.env_time_s = env_time
    return stats


def safe_parse(
    path: str | Path, *, pricing_snapshot: dict[str, Any] | None = None
) -> SessionStats:
    """Like ``parse_session_file`` but never raises."""
    try:
        return parse_session_file(path, pricing_snapshot=pricing_snapshot)
    except Exception as exc:  # noqa: BLE001
        return SessionStats(session_file=str(path), parse_error=f"parse failed: {exc}")


def bash_actions_from_session(session_file: str | Path) -> list[BashAction]:
    """Pair assistant bash toolCalls with their toolResults → ordered BashActions.

    Pairing prefers ``toolCallId``; falls back to matching pending calls in order.
    """
    p = Path(session_file)
    if not p.exists():
        return []
    try:
        entries = _iter_entries(p)
    except Exception:  # noqa: BLE001
        return []
    if _is_codex_rollout(entries):
        return _codex_bash_actions(entries)

    # bash toolCalls (in source order) and bash toolResults (each consumed at most once).
    pending: list[tuple[str | None, str]] = []  # (toolCallId, command)
    results: list[dict[str, Any]] = []  # {id, is_error, used}
    id_to_idx: dict[str, int] = {}

    for entry in entries:
        if not isinstance(entry, dict) or entry.get("type") != "message":
            continue
        message = entry.get("message")
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "assistant":
            for block in message.get("content") or []:
                if not isinstance(block, dict) or block.get("type") != "toolCall":
                    continue
                if block.get("name") != "bash":
                    continue
                command = (block.get("arguments") or {}).get("command")
                if isinstance(command, str):
                    pending.append((block.get("id"), command))
        elif role == "toolResult" and message.get("toolName") == "bash":
            call_id = message.get("toolCallId")
            idx = len(results)
            results.append(
                {
                    "id": call_id if isinstance(call_id, str) else None,
                    "is_error": _pi_tool_result_is_error(message),
                    "used": False,
                }
            )
            if isinstance(call_id, str) and call_id not in id_to_idx:
                id_to_idx[call_id] = idx

    actions: list[BashAction] = []
    for call_id, command in pending:
        chosen: dict[str, Any] | None = None
        if call_id is not None and call_id in id_to_idx and not results[id_to_idx[call_id]]["used"]:
            chosen = results[id_to_idx[call_id]]
        else:
            chosen = next((r for r in results if not r["used"]), None)
        if chosen is not None:
            chosen["used"] = True
            actions.append(
                BashAction(command=command, is_error=chosen["is_error"])
            )
        else:
            actions.append(BashAction(command=command, is_error=False))
    return actions


def _codex_bash_actions(entries: list[dict[str, Any]]) -> list[BashAction]:
    calls: list[tuple[str | None, str, str]] = []
    outputs: dict[str, Any] = {}
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("type") != "response_item":
            continue
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        if payload.get("type") in CODEX_TOOL_CALL_TYPES:
            command = _codex_shell_command(payload)
            if command:
                call_id = payload.get("call_id")
                calls.append(
                    (
                        call_id if isinstance(call_id, str) else None,
                        command,
                        str(payload.get("name") or "unknown"),
                    )
                )
        elif payload.get("type") in CODEX_TOOL_OUTPUT_TYPES:
            call_id = payload.get("call_id")
            if isinstance(call_id, str):
                outputs[call_id] = payload.get("output")
    return [
        BashAction(
            command=command,
            is_error=_codex_output_is_error(outputs.get(call_id), tool_name=tool_name),
        )
        for call_id, command, tool_name in calls
    ]


def trajectory_steps_from_session(session_file: str | Path) -> list[TrajectoryStep]:
    """Group a pi session into per-turn ``(response, bash actions)`` steps for the Odysseys
    paper-style action history.

    A step = one assistant turn that issued ≥1 bash command; ``response`` is that turn's
    visible reply text, falling back to its thinking when the visible text is empty (this
    agent narrates via thinking, not visible text). Action-less turns (planning / the final
    answer) are skipped — matching the paper's "judge sees the steps, not the agent's final
    answer". Commands keep their is_error flag, paired in source order via
    ``bash_actions_from_session`` (one BashAction per bash toolCall), so slicing per turn
    aligns exactly. Returns ``[]`` on a missing / unreadable session (caller falls back)."""
    p = Path(session_file)
    if not p.exists():
        return []
    try:
        entries = _iter_entries(p)
    except Exception:  # noqa: BLE001
        return []
    if _is_codex_rollout(entries):
        return _codex_trajectory_steps(entries)
    paired = bash_actions_from_session(p)  # one BashAction per bash toolCall, source order
    steps: list[TrajectoryStep] = []
    idx = 0
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("type") != "message":
            continue
        message = entry.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        content = message.get("content") or []
        n_bash = sum(
            1
            for b in content
            if isinstance(b, dict) and b.get("type") == "toolCall" and b.get("name") == "bash"
        )
        if n_bash == 0:
            continue  # skip action-less turns (planning / final answer)
        turn_actions = paired[idx : idx + n_bash]
        idx += n_bash
        response = _text_from_content(content).strip()
        if not response:
            response = "".join(
                b.get("thinking", "")
                for b in content
                if isinstance(b, dict) and b.get("type") == "thinking"
            ).strip()
        steps.append(TrajectoryStep(response=response, actions=list(turn_actions)))
    return steps


def _codex_trajectory_steps(entries: list[dict[str, Any]]) -> list[TrajectoryStep]:
    paired = _codex_bash_actions(entries)
    action_idx = 0
    pending_count = 0
    response_parts: list[str] = []
    steps: list[TrajectoryStep] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        if entry.get("type") == "response_item":
            if (
                payload.get("type") in CODEX_TOOL_CALL_TYPES
                and _codex_shell_command(payload)
            ):
                pending_count += 1
            elif payload.get("type") == "reasoning":
                summary = payload.get("summary") or []
                response_parts.extend(str(part) for part in summary if str(part).strip())
            elif payload.get("type") == "message" and payload.get("role") == "assistant":
                text = _codex_content_text(payload.get("content"), output=True).strip()
                if text:
                    response_parts.append(text)
        if entry.get("type") == "event_msg" and payload.get("type") == "token_count":
            if pending_count:
                actions = paired[action_idx : action_idx + pending_count]
                action_idx += pending_count
                steps.append(
                    TrajectoryStep(response="\n".join(response_parts).strip(), actions=list(actions))
                )
            pending_count = 0
            response_parts = []
    return steps
