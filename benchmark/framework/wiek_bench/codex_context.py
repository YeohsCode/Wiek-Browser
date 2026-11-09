"""Audit Codex rollout context without inventing SDK-opaque data."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import threading
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from wiek_bench.session_parser import CODEX_TOOL_CALL_TYPES, CODEX_TOOL_OUTPUT_TYPES


_FORBIDDEN_CONTEXT_MARKERS = (
    "AGENTS.md instructions",
    "<INSTRUCTIONS>",
    "<apps_instructions>",
    "<memory_instructions>",
    "<plugins_instructions>",
    "<recommended_plugins>",
    "## Memory",
    "MEMORY_SUMMARY BEGINS",
    "/.agents/skills/",
)

_SHELL_READ_TOOL_NAMES = {"exec_command"}
_DIRECT_READ_TOOL_NAMES = {"read", "read_file"}
_DIRECT_READ_PATH_ARGUMENTS = {"path", "file_path", "filePath"}
_SHELL_READ_COMMANDS = {"cat", "head", "tail", "sed", "awk", "less", "more", "bat"}
_SHELL_CONTROL_TOKENS = {";", "&&", "||", "|", "&"}


@dataclass(frozen=True)
class CodexRolloutSnapshot:
    session_path: Path
    raw: bytes
    entries: tuple[tuple[int, dict[str, Any]], ...]
    malformed_lines: tuple[int, ...]
    sha256: str


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256(value: bytes | str) -> str:
    raw = value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(raw).hexdigest()


def read_codex_rollout_snapshot(session_file: str | Path) -> CodexRolloutSnapshot:
    """Capture immutable rollout bytes and parse only complete JSONL records from them."""
    session_path = Path(session_file).resolve()
    entries: list[tuple[int, dict[str, Any]]] = []
    malformed_lines: list[int] = []
    raw = session_path.read_bytes()
    for line_number, raw_line in enumerate(raw.split(b"\n"), start=1):
        if not raw_line.strip():
            continue
        try:
            value = json.loads(raw_line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            malformed_lines.append(line_number)
            continue
        if isinstance(value, dict):
            entries.append((line_number, value))
        else:
            malformed_lines.append(line_number)
    return CodexRolloutSnapshot(
        session_path=session_path,
        raw=raw,
        entries=tuple(entries),
        malformed_lines=tuple(malformed_lines),
        sha256=_sha256(raw),
    )


def read_codex_rollout(
    session_file: str | Path,
) -> tuple[list[tuple[int, dict[str, Any]]], list[int], str]:
    """Compatibility tuple view over :func:`read_codex_rollout_snapshot`."""
    snapshot = read_codex_rollout_snapshot(session_file)
    return list(snapshot.entries), list(snapshot.malformed_lines), snapshot.sha256


def _content_blocks(payload: dict[str, Any]) -> list[dict[str, str]]:
    content = payload.get("content")
    if not isinstance(content, list):
        return []
    blocks: list[dict[str, str]] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        text = block.get("text")
        if isinstance(text, str):
            blocks.append({"type": str(block.get("type") or "input_text"), "text": text})
    return blocks


def _message_kind(role: str, text: str, task_prompt: str | None) -> str:
    stripped = text.lstrip()
    if role == "developer":
        return "developer_instructions"
    if stripped.startswith("<environment_context>"):
        return "environment_context"
    if stripped.startswith("<skill>"):
        return "skill_content"
    if task_prompt is not None and text == task_prompt:
        return "task_prompt"
    return "user_input"


def _model_visible_messages(
    entries: Sequence[tuple[int, dict[str, Any]]], task_prompt: str | None
) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    for line_number, entry in entries:
        payload = entry.get("payload")
        if (
            entry.get("type") != "response_item"
            or not isinstance(payload, dict)
            or payload.get("type") != "message"
            or payload.get("role") not in {"developer", "user"}
        ):
            continue
        blocks = _content_blocks(payload)
        text = "\n\n".join(block["text"] for block in blocks)
        role = str(payload["role"])
        messages.append(
            {
                "role": role,
                "kind": _message_kind(role, text, task_prompt),
                "content": blocks,
                "timestamp": entry.get("timestamp"),
                "provenance": {
                    "entryType": "response_item",
                    "line": line_number,
                    "jsonPointer": "/payload/content",
                },
            }
        )
    return messages


def _message_text(message: dict[str, Any]) -> str:
    return "\n\n".join(
        str(block.get("text") or "")
        for block in message.get("content") or []
        if isinstance(block, dict)
    )


def _infer_task_prompt(messages: list[dict[str, Any]]) -> str:
    for message in messages:
        if message.get("role") == "user" and message.get("kind") == "user_input":
            return _message_text(message)
    return ""


def _declared_skills(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    skills: list[dict[str, Any]] = []
    pattern = re.compile(r"(?m)^- ([^:\n]+): .*?\(file: ([^)]+)\)$")
    for message in messages:
        if message.get("kind") != "developer_instructions":
            continue
        for name, path in pattern.findall(_message_text(message)):
            skills.append({"name": name, "path": path})
    return skills


def _loaded_skills(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    skills: list[dict[str, Any]] = []
    for message in messages:
        if message.get("kind") != "skill_content":
            continue
        text = _message_text(message)
        name_match = re.search(r"<name>(.*?)</name>", text, re.DOTALL)
        path_match = re.search(r"<path>(.*?)</path>", text, re.DOTALL)
        content_match = re.search(r"</path>\n(.*)\n</skill>\s*$", text, re.DOTALL)
        skill_path = path_match.group(1).strip() if path_match else ""
        expanded_content = content_match.group(1) if content_match else None
        expanded_content_sha256 = _sha256(expanded_content) if expanded_content is not None else None
        try:
            source_file_sha256 = _sha256(Path(skill_path).read_bytes()) if skill_path else None
        except OSError:
            source_file_sha256 = None
        provenance = message.get("provenance") or {}
        skills.append(
            {
                "name": name_match.group(1).strip() if name_match else "",
                "path": skill_path,
                "expandedMessageSha256": _sha256(text),
                "expandedContentSha256": expanded_content_sha256,
                "sourceFileSha256": source_file_sha256,
                "matchesSourceFile": (
                    expanded_content_sha256 == source_file_sha256
                    if expanded_content_sha256 is not None and source_file_sha256 is not None
                    else None
                ),
                "contentMessageLine": provenance.get("line"),
            }
        )
    return skills


def _runtime_context(entries: Sequence[tuple[int, dict[str, Any]]]) -> dict[str, Any]:
    turn_context: dict[str, Any] = {}
    world_state: dict[str, Any] = {}
    for _line_number, entry in entries:
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        if entry.get("type") == "turn_context" and not turn_context:
            turn_context = payload
        elif entry.get("type") == "world_state" and not world_state:
            state = payload.get("state")
            world_state = state if isinstance(state, dict) else payload
    return {"turnContext": turn_context, "worldState": world_state}


def _observed_tools(entries: Sequence[tuple[int, dict[str, Any]]]) -> list[dict[str, Any]]:
    names: Counter[str] = Counter()
    for _line_number, entry in entries:
        payload = entry.get("payload")
        if (
            entry.get("type") == "response_item"
            and isinstance(payload, dict)
            and payload.get("type") in CODEX_TOOL_CALL_TYPES
        ):
            names[str(payload.get("name") or "unknown")] += 1
    return [{"name": name, "callCount": count} for name, count in sorted(names.items())]


def _function_arguments(payload: dict[str, Any]) -> dict[str, Any]:
    is_custom = payload.get("type") == "custom_tool_call"
    arguments = payload.get("input") if is_custom else payload.get("arguments")
    if isinstance(arguments, dict):
        return arguments
    if not isinstance(arguments, str):
        return {}
    try:
        value = json.loads(arguments)
    except json.JSONDecodeError:
        return {"input": arguments} if is_custom else {}
    if isinstance(value, dict):
        return value
    return {"input": arguments} if is_custom else {}


def _path_matches(value: str, target_path: str) -> bool:
    if value == target_path:
        return True
    try:
        return Path(value).resolve() == Path(target_path).resolve()
    except (OSError, RuntimeError):
        return False


def _shell_command_reads_path(command: str, target_path: str) -> bool:
    lexer = shlex.shlex(
        command.replace("\n", ";"), posix=True, punctuation_chars=";&|<>"
    )
    lexer.whitespace_split = True
    lexer.commenters = ""
    try:
        tokens = list(lexer)
    except ValueError:
        return False

    commands: list[list[str]] = [[]]
    for token in tokens:
        if token in _SHELL_CONTROL_TOKENS:
            commands.append([])
        else:
            commands[-1].append(token)
    for tokens_for_command in commands:
        if tokens_for_command[:1] == ["command"]:
            tokens_for_command = tokens_for_command[1:]
        if not tokens_for_command:
            continue
        reader = Path(tokens_for_command[0]).name
        arguments = tokens_for_command[1:]
        if reader not in _SHELL_READ_COMMANDS:
            continue
        if reader == "sed" and any(
            value == "--in-place"
            or value.startswith("--in-place=")
            or (value.startswith("-") and "i" in value[1:])
            for value in arguments
        ):
            continue
        for index, value in enumerate(arguments):
            previous = arguments[index - 1] if index else None
            if previous is not None and ">" in previous:
                continue
            if _path_matches(value, target_path):
                return True
    return False


def _direct_read_targets_path(arguments: dict[str, Any], target_path: str) -> bool:
    for key in _DIRECT_READ_PATH_ARGUMENTS:
        value = arguments.get(key)
        if isinstance(value, str) and _path_matches(value, target_path):
            return True
    return False


def _function_outputs(
    entries: Sequence[tuple[int, dict[str, Any]]],
) -> dict[str, tuple[int, dict[str, Any]]]:
    outputs: dict[str, tuple[int, dict[str, Any]]] = {}
    for line_number, entry in entries:
        payload = entry.get("payload")
        if not (
            entry.get("type") == "response_item"
            and isinstance(payload, dict)
            and payload.get("type") in CODEX_TOOL_OUTPUT_TYPES
        ):
            continue
        call_id = payload.get("call_id")
        if isinstance(call_id, str):
            outputs[call_id] = (line_number, payload)
    return outputs


def _function_output_succeeded(payload: dict[str, Any]) -> bool:
    if (
        "output" not in payload
        or payload.get("is_error") is True
        or payload.get("isError") is True
    ):
        return False
    output = payload.get("output")
    text = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
    lowered = text.lower()
    return not bool(
        re.search(r"process exited with code [1-9]\d*", lowered)
        or re.search(r"exit code:\s*[1-9]\d*", lowered)
    )


def _skill_read_evidence(
    entries: Sequence[tuple[int, dict[str, Any]]], target_path: str | None
) -> dict[str, Any]:
    calls: list[dict[str, Any]] = []
    outputs = _function_outputs(entries)
    if target_path:
        for line_number, entry in entries:
            payload = entry.get("payload")
            if not (
                entry.get("type") == "response_item"
                and isinstance(payload, dict)
                and payload.get("type") in CODEX_TOOL_CALL_TYPES
            ):
                continue
            tool_name = str(payload.get("name") or "")
            arguments = _function_arguments(payload)
            command: str | None = None
            if tool_name in _DIRECT_READ_TOOL_NAMES:
                is_read = _direct_read_targets_path(arguments, target_path)
            elif tool_name in _SHELL_READ_TOOL_NAMES:
                raw_command = arguments.get("cmd", arguments.get("command"))
                command = raw_command if isinstance(raw_command, str) else None
                is_read = bool(
                    command and _shell_command_reads_path(command, target_path)
                )
            else:
                is_read = False
            call_id = payload.get("call_id")
            output_entry = outputs.get(call_id) if isinstance(call_id, str) else None
            if is_read and output_entry is not None and _function_output_succeeded(output_entry[1]):
                calls.append(
                    {
                        "toolName": tool_name,
                        "callId": call_id,
                        "line": line_number,
                        "outputLine": output_entry[0],
                        "command": command,
                    }
                )

    observed = bool(calls)
    if target_path is None:
        reason = "No unique skill path was available for read detection."
    elif observed:
        reason = "A successful rollout function call explicitly read the declared SKILL.md path."
    else:
        reason = (
            "No successful rollout function call explicitly reading the declared SKILL.md path "
            "was observed."
        )
    return {
        "status": "observed" if observed else "not_observed",
        "targetPath": target_path,
        "source": "rollout_function_call_and_output",
        "calls": calls,
        "reason": reason,
    }


def _rollout_lifecycle(entries: Sequence[tuple[int, dict[str, Any]]]) -> str:
    status = "unknown"
    for _line_number, entry in entries:
        payload = entry.get("payload")
        if entry.get("type") != "event_msg" or not isinstance(payload, dict):
            continue
        event_type = payload.get("type")
        if event_type == "task_complete":
            status = "completed"
        elif event_type == "turn_aborted":
            status = "interrupted"
        elif event_type == "error":
            status = "error"
    return status


def _source_meta(
    entries: Sequence[tuple[int, dict[str, Any]]],
    session_path: Path | None,
    rollout_sha256: str | None,
) -> tuple[dict[str, Any], str, int | None]:
    meta: dict[str, Any] = {}
    line_number: int | None = None
    for current_line, entry in entries:
        if entry.get("type") == "session_meta" and isinstance(entry.get("payload"), dict):
            meta = entry["payload"]
            line_number = current_line
            break
    base = meta.get("base_instructions")
    base_text = base.get("text", "") if isinstance(base, dict) else ""
    source = {
        "kind": "codex_rollout",
        "sessionId": meta.get("id") or meta.get("session_id"),
        "sessionFile": str(session_path) if session_path is not None else None,
        "cliVersion": meta.get("cli_version"),
        "capturedAt": _now_iso(),
        "rolloutSha256": rollout_sha256,
        "baseInstructions": {
            "status": "captured" if base_text else "unavailable",
            "line": line_number,
            "jsonPointer": "/payload/base_instructions/text" if base_text else None,
        },
    }
    return source, str(base_text), line_number


def build_codex_context_audit(
    session_file: str | Path | None,
    *,
    task_prompt: str | None = None,
    expected_skill_name: str | None = None,
    expected_skill_path: str | Path | None = None,
    config_overrides: Iterable[str] = (),
    launch_configuration: dict[str, Any] | None = None,
    lifecycle_status: str | None = None,
    lifecycle_error: str | None = None,
    rollout_snapshot: CodexRolloutSnapshot | None = None,
) -> dict[str, Any]:
    """Build a provider-specific prompt audit from the task's rollout truth."""
    session_path = Path(session_file).resolve() if session_file is not None else None
    entries: Sequence[tuple[int, dict[str, Any]]] = ()
    malformed_lines: Sequence[int] = ()
    rollout_sha256: str | None = None
    errors: list[str] = []
    if rollout_snapshot is not None:
        session_path = rollout_snapshot.session_path
        entries = rollout_snapshot.entries
        malformed_lines = rollout_snapshot.malformed_lines
        rollout_sha256 = rollout_snapshot.sha256
    elif session_path is None or not session_path.is_file():
        errors.append("session rollout unavailable")
        session_path = None
    else:
        rollout_snapshot = read_codex_rollout_snapshot(session_path)
        entries = rollout_snapshot.entries
        malformed_lines = rollout_snapshot.malformed_lines
        rollout_sha256 = rollout_snapshot.sha256
    if malformed_lines:
        errors.append(f"malformed JSONL lines skipped: {malformed_lines}")

    messages = _model_visible_messages(entries, task_prompt)
    resolved_prompt = task_prompt if task_prompt is not None else _infer_task_prompt(messages)
    if task_prompt is None and resolved_prompt:
        for message in messages:
            if message.get("role") == "user" and _message_text(message) == resolved_prompt:
                message["kind"] = "task_prompt"
                break
    declared_skills = _declared_skills(messages)
    loaded_skills = _loaded_skills(messages)
    source, base_instructions, base_line = _source_meta(
        entries, session_path, rollout_sha256
    )
    runtime_context = _runtime_context(entries)
    turn_context = runtime_context["turnContext"]
    world_state = runtime_context["worldState"]

    system_message: list[dict[str, Any]] = []
    if base_instructions:
        system_message.append(
            {
                "role": "system",
                "kind": "base_instructions",
                "content": [{"type": "input_text", "text": base_instructions}],
                "timestamp": None,
                "provenance": {
                    "entryType": "session_meta",
                    "line": base_line,
                    "jsonPointer": "/payload/base_instructions/text",
                },
            }
        )
    model_visible_messages = system_message + messages

    expected_name = expected_skill_name
    if expected_skill_path is not None:
        expected_path = str(Path(expected_skill_path).resolve())
    else:
        expected_path = None
    declared_names = [str(skill.get("name") or "") for skill in declared_skills]
    loaded_names = [str(skill.get("name") or "") for skill in loaded_skills]
    declared_paths = [
        str(Path(skill.get("path") or "").resolve()) for skill in declared_skills
    ]
    loaded_paths = [
        str(Path(skill.get("path") or "").resolve()) for skill in loaded_skills
    ]
    audit_context = "\n".join(
        _message_text(message)
        for message in messages
        if message.get("kind") in {"developer_instructions", "environment_context"}
    )
    forbidden_found = [marker for marker in _FORBIDDEN_CONTEXT_MARKERS if marker in audit_context]
    world_state_contamination = {
        "agentsMd": bool(world_state.get("agents_md")),
        "appsInstructions": bool(world_state.get("apps_instructions")),
        "pluginsInstructions": bool(world_state.get("plugins_instructions")),
    }
    world_state_clean = not any(world_state_contamination.values())
    checks_complete = bool(
        base_instructions
        and messages
        and declared_skills
        and expected_name
        and expected_path
    )
    expected_loaded_names = ([], [expected_name])
    skill_ok = bool(
        expected_name
        and expected_path
        and declared_names == [expected_name]
        and declared_paths == [expected_path]
        and loaded_names in expected_loaded_names
        and (not loaded_paths or loaded_paths == [expected_path])
    )
    if checks_complete:
        isolation_status = (
            "passed" if skill_ok and not forbidden_found and world_state_clean else "failed"
        )
    else:
        isolation_status = "incomplete"

    if not base_instructions:
        errors.append("session_meta.payload.base_instructions.text unavailable")
    if not messages:
        errors.append("model-visible developer/user messages unavailable")

    rollout_lifecycle = _rollout_lifecycle(entries)
    effective_lifecycle = lifecycle_status or rollout_lifecycle
    if effective_lifecycle != "completed":
        errors.append(f"task lifecycle is {effective_lifecycle}")
    elif rollout_lifecycle != "completed":
        errors.append("rollout terminal task_complete marker unavailable")

    captured_launch = {
        "approvalMode": turn_context.get("approval_policy"),
        "sandbox": (turn_context.get("sandbox_policy") or {}).get("type")
        if isinstance(turn_context.get("sandbox_policy"), dict)
        else turn_context.get("sandbox_policy"),
        "model": turn_context.get("model"),
        "reasoningEffort": turn_context.get("effort"),
        "configOverrides": list(config_overrides),
    }
    captured_launch.update(launch_configuration or {})

    read_target_path = expected_path
    if expected_path is not None and len(declared_skills) == 1 and declared_paths == [expected_path]:
        read_target_path = str(declared_skills[0].get("path") or "") or None
    preloaded = bool(loaded_skills)
    skill_delivery = {
        "mode": "runtime_expansion" if preloaded else "progressive_disclosure",
        "preloaded": preloaded,
        "readEvidence": _skill_read_evidence(entries, read_target_path),
    }

    return {
        "schemaVersion": 2,
        "provider": "codex",
        "captureStatus": "complete" if not errors else ("partial" if entries else "unavailable"),
        "source": source,
        "mode": "app-server",
        "cwd": (
            turn_context.get("cwd") or (entries[0][1].get("payload") or {}).get("cwd")
            if entries
            else None
        ),
        "systemPrompt": base_instructions,
        "systemPromptOptions": {
            "captureSource": "codex rollout JSONL",
            "modelVisibleMessagesSource": "response_item developer/user messages",
            "configOverrides": list(config_overrides),
            "skills": declared_skills,
        },
        "activeTools": None,
        "allToolNames": None,
        "prompt": resolved_prompt,
        "modelVisibleMessages": model_visible_messages,
        "declaredSkills": declared_skills,
        "loadedSkills": loaded_skills,
        "skillDelivery": skill_delivery,
        "runtimeContext": runtime_context,
        "launchConfiguration": captured_launch,
        "lifecycle": {
            "status": effective_lifecycle,
            "providerStatus": lifecycle_status,
            "rolloutStatus": rollout_lifecycle,
            "error": lifecycle_error,
        },
        "toolInventory": {
            "status": "not_exposed_by_codex_sdk_or_rollout",
            "activeTools": None,
            "allToolNames": None,
            "reason": (
                "Codex records actual function calls but does not expose the complete "
                "built-in tool inventory or parameter schemas."
            ),
        },
        "observedToolCalls": _observed_tools(entries),
        "isolation": {
            "status": isolation_status,
            "expectedSkill": {"name": expected_name, "path": expected_path},
            "declaredSkillNames": declared_names,
            "loadedSkillNames": loaded_names,
            "forbiddenMarkersChecked": list(_FORBIDDEN_CONTEXT_MARKERS),
            "forbiddenMarkersFound": forbidden_found,
            "worldStateObserved": bool(world_state),
            "worldStateContamination": world_state_contamination,
        },
        "errors": errors,
    }


def write_codex_context_audit(
    out_path: str | Path,
    session_file: str | Path | None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Atomically write one Codex task audit and return the serialized payload."""
    payload = build_codex_context_audit(session_file, **kwargs)
    target = Path(out_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.parent / f".{target.name}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return payload


def codex_context_audit_is_current(
    audit_path: str | Path, session_file: str | Path
) -> bool:
    """Return whether an audit describes the current bytes of this rollout."""
    try:
        snapshot = read_codex_rollout_snapshot(session_file)
    except OSError:
        return False
    return load_current_codex_context_audit(audit_path, snapshot) is not None


def load_current_codex_context_audit(
    audit_path: str | Path, snapshot: CodexRolloutSnapshot
) -> dict[str, Any] | None:
    """Load an audit only when its source path and hash match this exact snapshot."""
    try:
        payload = json.loads(Path(audit_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    source = payload.get("source") if isinstance(payload, dict) else None
    if not (
        isinstance(source, dict)
        and payload.get("schemaVersion") == 2
        and isinstance(payload.get("lifecycle"), dict)
        and source.get("sessionFile") == str(snapshot.session_path)
        and source.get("rolloutSha256") == snapshot.sha256
    ):
        return None
    return payload
