#!/usr/bin/env python3
"""wiek-bench-judge probe: one-shot extraction from a tested agent session JSONL.

Pure standard library (no third-party deps), so the judge's bash can always run it with
`python3 <skill>/scripts/probe.py ...` regardless of the active environment.

Usage:
    probe.py summary <session.jsonl>
    probe.py errors  <session.jsonl>
    probe.py calls   <session.jsonl> [--name bash] [--errors-only] [--full]
    probe.py axtree  <tree.json> [--grep <text>]... [--regex] [--role <role>]
                     [--properties] [--show-ancestors] [--full]

`calls` recovers each command's REAL output (the output that is intentionally NOT in the
judge prompt's command list) by pairing assistant toolCall with its toolResult. `axtree`
queries a saved CDP getFullAXTree snapshot (frames/trees/NNN.json) — summary + matching
nodes — so the judge need not read the whole (possibly large) tree.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from collections.abc import Iterator
from typing import Any


ToolCall = dict[str, Any]
ToolResult = dict[str, Any]
CollectedSession = tuple[list[ToolCall], dict[str, ToolResult], int, str]
AXNode = dict[str, Any]


def _iter(path: str) -> Iterator[dict[str, Any]]:
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def _text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def _collect(path: str) -> CollectedSession:
    entries = list(_iter(path))
    if entries and entries[0].get("type") == "session_meta":
        return _collect_codex(entries)

    calls: list[ToolCall] = []          # {id, name, command, args}
    results: dict[str, ToolResult] = {}  # toolCallId -> {isError, output, toolName}
    last_text = ""
    turns = 0
    for e in entries:
        if not isinstance(e, dict) or e.get("type") != "message":
            continue
        m = e.get("message") or {}
        role = m.get("role")
        if role == "assistant":
            turns += 1
            for b in m.get("content") or []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and b.get("text"):
                    last_text = b["text"]
                elif b.get("type") == "toolCall":
                    args = b.get("arguments") if isinstance(b.get("arguments"), dict) else {}
                    calls.append(
                        {
                            "id": b.get("id"),
                            "name": b.get("name") or "?",
                            "command": args.get("command"),
                            "args": args,
                        }
                    )
        elif role == "toolResult":
            results[m.get("toolCallId")] = {
                "isError": bool(m.get("isError")),
                "output": _text(m.get("content")),
                "toolName": m.get("toolName"),
            }
    return calls, results, turns, last_text


def _codex_args(payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get("arguments")
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _codex_text(content: object) -> str:
    if not isinstance(content, list):
        return ""
    return "\n".join(
        str(block.get("text") or "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "output_text"
    )


def _codex_result(output: object, tool_name: str | None) -> ToolResult:
    text = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
    is_error = False
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        parsed = None
    if isinstance(parsed, dict):
        code = parsed.get("exit_code")
        if isinstance(code, int):
            is_error = code != 0
        if isinstance(parsed.get("output"), str):
            text = parsed["output"]
    if not is_error:
        lowered = text.lower()
        is_error = bool(
            "is_error: true" in lowered
            or re.search(r"process exited with code [1-9]\d*", lowered)
            or re.search(r"exit code:\s*[1-9]\d*", lowered)
        )
    return {"isError": is_error, "output": text, "toolName": tool_name}


def _collect_codex(entries: list[dict[str, Any]]) -> CollectedSession:
    calls: list[ToolCall] = []
    results: dict[str, ToolResult] = {}
    names: dict[str, str] = {}
    last_text = ""
    turns = 0
    fallback_turns = 0
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        if entry.get("type") == "event_msg" and payload.get("type") == "token_count":
            turns += 1
            continue
        if entry.get("type") != "response_item":
            continue
        kind = payload.get("type")
        if kind == "message" and payload.get("role") == "assistant":
            text = _codex_text(payload.get("content"))
            if text:
                last_text = text
                fallback_turns += 1
        elif kind in {"function_call", "custom_tool_call"}:
            args = _codex_args(payload)
            call_id = payload.get("call_id") or payload.get("id")
            name = payload.get("name") or "?"
            command = args.get("cmd") or args.get("command") or args.get("chars")
            calls.append({"id": call_id, "name": name, "command": command, "args": args})
            if isinstance(call_id, str):
                names[call_id] = name
        elif kind in {"function_call_output", "custom_tool_call_output"}:
            call_id = payload.get("call_id") or payload.get("id")
            if isinstance(call_id, str):
                results[call_id] = _codex_result(payload.get("output"), names.get(call_id))
    return calls, results, turns or fallback_turns, last_text


def cmd_summary(path: str) -> None:
    calls, results, turns, last_text = _collect(path)
    out = {
        "assistant_turns": turns,
        "tool_calls": len(calls),
        "tool_call_dist": dict(Counter(c["name"] for c in calls)),
        "tool_errors": sum(1 for r in results.values() if r["isError"]),
        "last_assistant_text": last_text[-2000:],
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


def cmd_errors(path: str) -> None:
    calls, results, _, _ = _collect(path)
    by_id = {c["id"]: c for c in calls}
    n = 0
    for cid, r in results.items():
        if not r["isError"]:
            continue
        n += 1
        c = by_id.get(cid) or {}
        print(f"--- error #{n} [{c.get('name', '?')}] ---")
        if c.get("command"):
            print(f"$ {c['command']}")
        elif c.get("args"):
            print(json.dumps(c["args"], ensure_ascii=False)[:500])
        print((r["output"] or "").strip()[:2000])
        print()
    if n == 0:
        print("(no tool errors in this session)")


def cmd_calls(path: str, name: str | None, errors_only: bool, full: bool) -> None:
    calls, results, _, _ = _collect(path)
    limit = None if full else 2000
    shown = 0
    for c in calls:
        if name and c["name"] != name:
            continue
        r = results.get(c["id"]) or {}
        if errors_only and not r.get("isError"):
            continue
        shown += 1
        tag = " [ERROR]" if r.get("isError") else ""
        head = c.get("command") or json.dumps(c.get("args") or {}, ensure_ascii=False)
        print(f"$ [{c['name']}]{tag} {head}")
        body = (r.get("output") or "").strip()
        print(body if limit is None else body[:limit])
        print()
    if shown == 0:
        print("(no matching tool calls)")


def _ax_str(v: object) -> str:
    """Flatten a CDP AXValue (`{value, type}`) — or a plain scalar — to its string."""
    if isinstance(v, dict):
        val = v.get("value")
        return "" if val is None else str(val)
    return "" if v is None else str(v)


def _ax_schema_version(data: dict[str, Any]) -> int:
    raw = data.get("schema_version", 1)
    return raw if isinstance(raw, int) and not isinstance(raw, bool) and raw >= 1 else 1


def _ax_has_hierarchy(schema_version: int, nodes: list[object]) -> bool:
    typed_nodes = [node for node in nodes if isinstance(node, dict)]
    return bool(typed_nodes) and schema_version >= 2 and all(
        "parent_index" in node for node in typed_nodes
    )


def _ax_properties_text(node: AXNode) -> str:
    properties = node.get("properties")
    if properties in (None, {}, []):
        return ""
    return json.dumps(
        properties,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _ax_patterns(grep: list[str] | str | None, regex: bool) -> list[re.Pattern[str]]:
    patterns = [grep] if isinstance(grep, str) else list(grep or [])
    if not regex:
        for pattern in patterns:
            if "|" in pattern:
                raise ValueError(
                    "literal --grep pattern contains '|'; use --regex for alternation "
                    "or repeat --grep for OR matching"
                )
        return [re.compile(re.escape(pattern), re.IGNORECASE) for pattern in patterns]
    compiled: list[re.Pattern[str]] = []
    for pattern in patterns:
        try:
            compiled.append(re.compile(pattern, re.IGNORECASE))
        except re.error as exc:
            raise ValueError(f"invalid --grep regex {pattern!r}: {exc}") from exc
    return compiled


def _ax_matches(patterns: list[re.Pattern[str]], fields: list[str]) -> bool:
    if not patterns:
        return True
    return any(pattern.search(field) for pattern in patterns for field in fields)


def _ax_node_label(node: AXNode) -> str:
    return f'[{_ax_str(node.get("role"))}] "{_ax_str(node.get("name"))}"'


def _ax_ancestors(nodes: list[object], node_index: int) -> list[AXNode]:
    ancestors: list[AXNode] = []
    visited = {node_index}
    current = nodes[node_index]
    while isinstance(current, dict):
        parent_index = current.get("parent_index")
        if (
            not isinstance(parent_index, int)
            or isinstance(parent_index, bool)
            or parent_index < 0
            or parent_index >= len(nodes)
            or parent_index in visited
        ):
            break
        parent = nodes[parent_index]
        if not isinstance(parent, dict):
            break
        ancestors.append(parent)
        visited.add(parent_index)
        current = parent
    ancestors.reverse()
    return ancestors


def cmd_axtree(
    path: str,
    grep: list[str] | str | None,
    role: str | None,
    full: bool,
    regex: bool = False,
    properties: bool = False,
    show_ancestors: bool = False,
) -> None:
    """Query a saved getFullAXTree snapshot (frames/trees/NNN.json) without reading the whole
    (possibly large) tree: a summary (node count + role histogram) then the non-ignored nodes
    as `[role] "name" = value`, optionally filtered by --grep (role/name/value substring) or
    --role (exact role)."""
    patterns = _ax_patterns(grep, regex)
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"(cannot read AX tree {path}: {exc})")
        return
    nodes = data.get("nodes") if isinstance(data, dict) else None
    if not isinstance(nodes, list):
        print("(no nodes in AX tree)")
        return
    kept = [
        (index, node)
        for index, node in enumerate(nodes)
        if isinstance(node, dict) and not node.get("ignored")
    ]
    roles = Counter(_ax_str(node.get("role")) for _, node in kept)
    schema_version = _ax_schema_version(data)
    has_hierarchy = _ax_has_hierarchy(schema_version, nodes)
    print(
        json.dumps(
            {
                "total_nodes": len(nodes),
                "ignored": len(nodes) - len(kept),
                "role_dist": dict(roles.most_common()),
                "schema_version": schema_version,
                "has_hierarchy": has_hierarchy,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    limit = None if full else 200
    shown = 0
    print("---")
    if show_ancestors and not has_hierarchy:
        print(
            f"(hierarchy unavailable: AX tree schema v{schema_version} "
            "has no usable parent_index data)"
        )
    for node_index, n in kept:
        r = _ax_str(n.get("role"))
        if role and r != role:
            continue
        nm = _ax_str(n.get("name"))
        val = _ax_str(n.get("value"))
        properties_text = _ax_properties_text(n)
        fields = [r, nm, val]
        if properties:
            fields.append(properties_text)
        if not _ax_matches(patterns, fields):
            continue
        if limit is not None and shown >= limit:
            print(f"... (truncated at {limit}; narrow with --grep/--role or pass --full)")
            break
        shown += 1
        line = f'[{r}] "{nm}"'
        if val:
            line += f' = "{val}"'
        if properties and properties_text:
            line += f" properties={properties_text}"
        if show_ancestors and has_hierarchy:
            ancestors = _ax_ancestors(nodes, node_index)
            chain = " > ".join(_ax_node_label(ancestor) for ancestor in ancestors)
            line += f" depth={len(ancestors)}"
            line += f" ancestors={chain}" if chain else " ancestors=(root)"
        print(line)
    if shown == 0:
        print("(no matching nodes)")


def main() -> None:
    p = argparse.ArgumentParser(description="Probe a pi session JSONL for the wiek-bench judge.")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("summary")
    s.add_argument("session")
    e = sub.add_parser("errors")
    e.add_argument("session")
    c = sub.add_parser("calls")
    c.add_argument("session")
    c.add_argument("--name")
    c.add_argument("--errors-only", action="store_true")
    c.add_argument("--full", action="store_true")
    x = sub.add_parser("axtree")
    x.add_argument("tree")
    x.add_argument("--grep", action="append", default=[])
    x.add_argument("--regex", action="store_true")
    x.add_argument("--role")
    x.add_argument("--properties", action="store_true")
    x.add_argument("--show-ancestors", action="store_true")
    x.add_argument("--full", action="store_true")
    a = p.parse_args()
    if a.cmd == "summary":
        cmd_summary(a.session)
    elif a.cmd == "errors":
        cmd_errors(a.session)
    elif a.cmd == "calls":
        cmd_calls(a.session, a.name, a.errors_only, a.full)
    elif a.cmd == "axtree":
        try:
            cmd_axtree(
                a.tree,
                a.grep,
                a.role,
                a.full,
                regex=a.regex,
                properties=a.properties,
                show_ancestors=a.show_ancestors,
            )
        except ValueError as exc:
            x.error(str(exc))


if __name__ == "__main__":
    main()
