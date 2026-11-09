"""Self-contained Pi-style HTML renderer for Codex rollout JSONL."""

from __future__ import annotations

import base64
import html
import json
from collections import Counter
from pathlib import Path
from typing import Any

from wiek_bench.codex_context import (
    CodexRolloutSnapshot,
    build_codex_context_audit,
    load_current_codex_context_audit,
    read_codex_rollout_snapshot,
)
from wiek_bench.session_parser import (
    CODEX_TOOL_CALL_TYPES,
    CODEX_TOOL_OUTPUT_TYPES,
    parse_codex_rollout_entries,
)


_STYLE = r"""
:root {
  color-scheme: dark;
  --bg: #111213;
  --panel: #181a1b;
  --panel-2: #202224;
  --line: #34373a;
  --line-strong: #555a5e;
  --text: #e8e8e5;
  --muted: #9da2a6;
  --blue: #7bc8e6;
  --green: #8fd694;
  --yellow: #e3c969;
  --red: #ef8f86;
  --sidebar: 390px;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  letter-spacing: 0;
}
button, input { font: inherit; letter-spacing: 0; }
button { color: inherit; }
.sidebar {
  position: fixed;
  inset: 0 auto 0 0;
  z-index: 20;
  width: var(--sidebar);
  display: flex;
  flex-direction: column;
  background: #151617;
  border-right: 1px solid var(--line);
}
.sidebar-head { padding: 16px; border-bottom: 1px solid var(--line); }
.sidebar-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.sidebar-title strong { color: var(--blue); font-size: 13px; overflow: hidden; text-overflow: ellipsis; }
.search {
  width: 100%;
  margin-top: 13px;
  padding: 9px 10px;
  color: var(--text);
  background: #0f1011;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  outline: none;
}
.search:focus { border-color: var(--blue); }
.filters { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 9px; }
.filter, .action {
  min-height: 30px;
  padding: 5px 8px;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 4px;
  cursor: pointer;
}
.filter:hover, .action:hover, .filter.active { border-color: var(--blue); color: var(--blue); }
.tree { flex: 1; min-height: 0; overflow: auto; padding: 8px 0 24px; }
.nav-entry {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  gap: 7px;
  align-items: start;
  padding: 6px 12px 6px 15px;
  color: var(--muted);
  text-decoration: none;
  border-left: 2px solid transparent;
}
.nav-entry:hover { color: var(--text); background: var(--panel); border-left-color: var(--blue); }
.nav-entry.hidden { display: none; }
.tree-mark { color: var(--line-strong); }
.nav-entry[data-kind="user"] .tree-mark { color: var(--green); }
.nav-entry[data-kind="assistant"] .tree-mark { color: var(--blue); }
.nav-entry[data-kind="tool"] .tree-mark { color: var(--yellow); }
.nav-entry[data-kind="nested-tool"] .tree-mark { color: var(--yellow); }
.nav-entry[data-kind="reasoning"] .tree-mark { color: #c7a6dc; }
.nav-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-entry time { color: #71767a; font-size: 10px; white-space: nowrap; }
.tree-count { padding: 8px 15px; color: var(--muted); border-top: 1px solid var(--line); }
.resize-handle { position: absolute; inset: 0 -4px 0 auto; width: 8px; cursor: col-resize; }
.main { margin-left: var(--sidebar); min-width: 0; }
.content { width: min(900px, calc(100% - 48px)); margin: 0 auto; padding: 30px 0 90px; }
.topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.eyebrow { color: var(--blue); font-weight: 700; text-transform: uppercase; }
h1 { margin: 6px 0 0; font-size: 20px; line-height: 1.3; overflow-wrap: anywhere; }
.shortcuts { margin-top: 6px; color: var(--muted); font-size: 10px; }
.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.menu-button { display: none; }
.meta-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 22px 0 28px;
  border-top: 1px solid var(--line-strong);
  border-left: 1px solid var(--line);
}
.meta-cell {
  min-height: 66px;
  padding: 10px;
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.meta-cell span { display: block; color: var(--muted); font-size: 10px; text-transform: uppercase; }
.meta-cell strong { display: block; margin-top: 5px; font-size: 13px; overflow-wrap: anywhere; }
.section { margin-top: 22px; border: 1px solid var(--line); border-radius: 4px; background: var(--panel); }
.section-head, details.section > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  min-height: 42px;
  padding: 10px 13px;
  font-weight: 700;
  cursor: pointer;
  list-style: none;
}
details.section > summary::-webkit-details-marker { display: none; }
.section-head { cursor: default; }
.section-meta { color: var(--muted); font-size: 10px; font-weight: 400; text-align: right; }
.section-body { padding: 0 13px 13px; border-top: 1px solid var(--line); }
.status { font-weight: 700; }
.status.passed, .ok { color: var(--green); }
.status.incomplete, .warn { color: var(--yellow); }
.status.failed, .error { color: var(--red); }
.notice { margin: 12px 0 0; padding-left: 10px; border-left: 3px solid var(--yellow); color: var(--muted); }
pre {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  tab-size: 2;
}
.prompt { max-height: 520px; overflow: auto; padding: 12px 0; }
.data-table { width: 100%; border-collapse: collapse; margin-top: 6px; table-layout: fixed; }
.data-table th, .data-table td {
  padding: 8px 6px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--line);
  overflow-wrap: anywhere;
}
.data-table th { color: var(--muted); font-size: 10px; text-transform: uppercase; }
.data-table th:first-child, .data-table td:first-child { width: 22%; }
.data-table th:last-child, .data-table td:last-child { width: 18%; }
.transcript-title {
  margin: 34px 0 8px;
  padding-bottom: 8px;
  font-size: 13px;
  border-bottom: 1px solid var(--line-strong);
}
.entry {
  margin-top: 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--panel);
  scroll-margin-top: 12px;
}
.entry.hidden-by-toggle { display: none; }
.entry-head {
  display: grid;
  grid-template-columns: auto 1fr auto auto auto;
  gap: 9px;
  align-items: center;
  min-height: 38px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
}
.entry-index { color: var(--muted); }
.entry-role { font-weight: 700; text-transform: uppercase; }
.entry.user .entry-role { color: var(--green); }
.entry.assistant .entry-role { color: var(--blue); }
.entry.tool .entry-role, .entry.nested-tool .entry-role { color: var(--yellow); }
.entry.reasoning .entry-role { color: #c7a6dc; }
.entry.developer .entry-role, .entry.runtime .entry-role { color: var(--red); }
.entry-phase { color: var(--muted); font-size: 10px; }
.entry time { color: var(--muted); font-size: 10px; white-space: nowrap; }
.deep-link { color: var(--muted); text-decoration: none; }
.deep-link:hover { color: var(--blue); }
.entry-body { padding: 12px; }
.entry-body details > summary { color: var(--muted); cursor: pointer; }
.entry-body details > pre { margin-top: 10px; }
.tool-grid { display: grid; grid-template-columns: 1fr; gap: 10px; }
.tool-label { margin-bottom: 5px; color: var(--muted); font-size: 10px; text-transform: uppercase; }
.tool-output { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.tool-output summary { color: var(--yellow); cursor: pointer; }
.tool-output pre { margin-top: 9px; max-height: 520px; overflow: auto; }
.nested-tool-group {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.nested-tool-group > summary {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--yellow);
  cursor: pointer;
  list-style: none;
}
.nested-tool-group > summary::-webkit-details-marker { display: none; }
.nested-tool-group > summary::before { content: "+"; color: var(--muted); }
.nested-tool-group[open] > summary::before { content: "−"; }
.nested-tool-summary { margin-left: auto; color: var(--muted); text-align: right; }
.nested-tool-list { margin-top: 10px; padding-left: 12px; border-left: 2px solid var(--yellow); }
.nested-tool-child { padding: 10px 0; }
.nested-tool-child + .nested-tool-child { border-top: 1px solid var(--line); }
.nested-tool-child-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 9px;
}
.nested-tool-name { color: var(--yellow); font-weight: 700; }
.nested-tool-meta { color: var(--muted); text-align: right; }
.reasoning-note { color: var(--muted); font-style: italic; }
.source { margin-top: 25px; color: var(--muted); overflow-wrap: anywhere; }
.empty { padding: 14px 0; color: var(--muted); }
body.hide-thinking .entry.reasoning { display: none; }
body.hide-tools .entry.tool, body.hide-tools .entry.nested-tool { display: none; }
@media (max-width: 980px) {
  :root { --sidebar: 340px; }
  .meta-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
  .sidebar { transform: translateX(-100%); transition: transform 160ms ease; width: min(88vw, 390px); }
  body.sidebar-open .sidebar { transform: translateX(0); }
  .main { margin-left: 0; }
  .content { width: calc(100% - 28px); padding-top: 18px; }
  .topbar { flex-direction: column; }
  .actions { justify-content: flex-start; }
  .menu-button { display: inline-block; }
  .entry-head { grid-template-columns: auto 1fr auto auto; }
  .entry-phase { grid-column: 2 / 3; }
  .resize-handle { display: none; }
}
@media print {
  .sidebar, .actions, .shortcuts { display: none !important; }
  .main { margin-left: 0; }
  .content { width: 100%; padding: 0; }
  body { background: #fff; color: #111; }
  .section, .entry { break-inside: avoid; border-color: #999; background: #fff; }
}
"""


_SCRIPT = r"""
(() => {
  const body = document.body;
  const entries = [...document.querySelectorAll('.nav-entry')];
  const search = document.getElementById('search');
  const count = document.getElementById('tree-count');
  let filter = 'default';

  const applyFilter = () => {
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    for (const entry of entries) {
      const kind = entry.dataset.kind;
      const isTool = kind === 'tool' || kind === 'nested-tool';
      const matchesQuery = !query || entry.dataset.search.includes(query);
      const matchesFilter = filter === 'all' || filter === 'default'
        || (filter === 'no-tools' && !isTool)
        || (filter === 'user' && kind === 'user')
        || (filter === 'labeled' && entry.dataset.labeled === 'true');
      const show = matchesQuery && matchesFilter;
      entry.classList.toggle('hidden', !show);
      if (show) visible += 1;
    }
    count.textContent = `${visible} / ${entries.length} entries`;
  };

  search.addEventListener('input', applyFilter);
  for (const button of document.querySelectorAll('.filter')) {
    button.addEventListener('click', () => {
      filter = button.dataset.filter;
      document.querySelectorAll('.filter').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      applyFilter();
    });
  }

  const toggle = (className, buttonId, shown, hidden) => {
    body.classList.toggle(className);
    document.getElementById(buttonId).textContent = body.classList.contains(className) ? shown : hidden;
  };
  document.getElementById('toggle-thinking').addEventListener('click', () =>
    toggle('hide-thinking', 'toggle-thinking', 'Show thinking', 'Hide thinking'));
  document.getElementById('toggle-tools').addEventListener('click', () =>
    toggle('hide-tools', 'toggle-tools', 'Show tools', 'Hide tools'));
  document.getElementById('menu').addEventListener('click', () => body.classList.toggle('sidebar-open'));
  document.querySelectorAll('.nav-entry').forEach((entry) => entry.addEventListener('click', () =>
    body.classList.remove('sidebar-open')));

  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key.toLowerCase() === 't') document.getElementById('toggle-thinking').click();
    if (event.key.toLowerCase() === 'o') document.getElementById('toggle-tools').click();
  });

  document.getElementById('download').addEventListener('click', () => {
    const encoded = document.getElementById('raw-jsonl').textContent.trim();
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/x-ndjson' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = body.dataset.downloadName;
    link.click();
    URL.revokeObjectURL(url);
  });

  const handle = document.getElementById('resize-handle');
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      const width = Math.max(280, Math.min(560, moveEvent.clientX));
      document.documentElement.style.setProperty('--sidebar', `${width}px`);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener(
      'pointerup',
      () => handle.removeEventListener('pointermove', move),
      { once: true },
    );
  });

  applyFilter();
})();
"""


def is_codex_session_file(path: str | Path) -> bool:
    try:
        with Path(path).open(encoding="utf-8") as handle:
            first = next((line for line in handle if line.strip()), "")
        return bool(first and json.loads(first).get("type") == "session_meta")
    except (OSError, json.JSONDecodeError):
        return False


def _esc(value: Any) -> str:
    return html.escape(str(value if value is not None else ""))


def _entries(snapshot: CodexRolloutSnapshot) -> list[dict[str, Any]]:
    return [entry for _line, entry in snapshot.entries]


def _message_text(content: Any) -> str:
    if not isinstance(content, list):
        return ""
    return "\n\n".join(
        str(block.get("text") or "")
        for block in content
        if isinstance(block, dict)
        and block.get("type") in {"input_text", "output_text"}
        and block.get("text")
    )


def _compact(value: str, limit: int = 72) -> str:
    text = " ".join(value.split())
    return text if len(text) <= limit else f"{text[: limit - 3]}..."


def _clock(timestamp: Any) -> str:
    value = str(timestamp or "")
    return value[11:19] if len(value) >= 19 else value


def _pretty_json(value: Any) -> str:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return value
    return json.dumps(value, ensure_ascii=False, indent=2)


def _reasoning_text(payload: dict[str, Any]) -> str:
    parts: list[str] = []
    for value in payload.get("summary") or []:
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, dict) and isinstance(value.get("text"), str):
            parts.append(value["text"])
    return "\n".join(part for part in parts if part.strip())


def _message_kind(role: str, text: str) -> str:
    stripped = text.lstrip()
    if role == "developer":
        return "developer"
    if stripped.startswith("<environment_context>"):
        return "environment"
    if stripped.startswith("<skill>"):
        return "skill"
    return role


def _collapsible_text(text: str, label: str, *, force: bool = False) -> str:
    content = f"<pre>{_esc(text)}</pre>"
    if force or len(text) > 3000:
        return (
            f"<details><summary>{_esc(label)} ({len(text):,} chars)</summary>"
            f"{content}</details>"
        )
    return content


def _tool_outputs(entries: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    outputs: dict[str, dict[str, Any]] = {}
    for entry in entries:
        payload = entry.get("payload")
        if (
            entry.get("type") == "response_item"
            and isinstance(payload, dict)
            and payload.get("type") in CODEX_TOOL_OUTPUT_TYPES
            and isinstance(payload.get("call_id"), str)
        ):
            outputs[payload["call_id"]] = payload
    return outputs


def _nested_mcp_events(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        entry
        for entry in entries
        if entry.get("type") == "event_msg"
        and isinstance(entry.get("payload"), dict)
        and entry["payload"].get("type") == "mcp_tool_call_end"
    ]


def _mcp_tool_name(payload: dict[str, Any]) -> str:
    invocation = payload.get("invocation")
    if not isinstance(invocation, dict):
        return "mcp__unknown__unknown"
    server = str(invocation.get("server") or "unknown")
    tool = str(invocation.get("tool") or "unknown")
    return f"mcp__{server}__{tool}"


def _duration_text(value: Any) -> str:
    if not isinstance(value, dict):
        return "duration unavailable"
    seconds = value.get("secs")
    nanos = value.get("nanos")
    if not isinstance(seconds, (int, float)) or not isinstance(nanos, (int, float)):
        return "duration unavailable"
    return f"{float(seconds) + float(nanos) / 1_000_000_000:.2f}s"


def _normalized_exec_source(value: Any) -> str:
    return str(value or "").replace("\\\\", "\\")


def _nested_mcp_groups(
    entries: list[dict[str, Any]],
) -> tuple[dict[str, list[dict[str, Any]]], set[int]]:
    exec_calls: list[tuple[int, str, str]] = []
    for position, entry in enumerate(entries):
        payload = entry.get("payload")
        if (
            entry.get("type") == "response_item"
            and isinstance(payload, dict)
            and payload.get("type") == "custom_tool_call"
            and payload.get("name") == "exec"
            and isinstance(payload.get("call_id"), str)
        ):
            exec_calls.append(
                (
                    position,
                    payload["call_id"],
                    _normalized_exec_source(payload.get("input")),
                )
            )

    groups: dict[str, list[dict[str, Any]]] = {}
    linked_entry_ids: set[int] = set()
    for position, entry in enumerate(entries):
        payload = entry.get("payload")
        if (
            entry.get("type") != "event_msg"
            or not isinstance(payload, dict)
            or payload.get("type") != "mcp_tool_call_end"
        ):
            continue
        invocation = payload.get("invocation")
        invocation = invocation if isinstance(invocation, dict) else {}
        arguments = invocation.get("arguments")
        arguments = arguments if isinstance(arguments, dict) else {}
        code = arguments.get("code")
        title = arguments.get("title")
        signature = code if isinstance(code, str) and code else title
        if not isinstance(signature, str) or not signature:
            continue
        tool_name = _mcp_tool_name(payload)
        normalized_signature = _normalized_exec_source(signature)
        candidates = [
            call_id
            for call_position, call_id, source in exec_calls
            if call_position < position
            and tool_name in source
            and normalized_signature in source
        ]
        if len(candidates) != 1:
            continue
        groups.setdefault(candidates[0], []).append(entry)
        linked_entry_ids.add(id(entry))
    return groups, linked_entry_ids


def _nested_mcp_render(
    payload: dict[str, Any],
) -> tuple[str, str, str, str, str]:
    invocation = payload.get("invocation")
    invocation = invocation if isinstance(invocation, dict) else {}
    arguments = invocation.get("arguments")
    arguments = arguments if isinstance(arguments, dict) else {}
    result = payload.get("result")
    tool_name = _mcp_tool_name(payload)
    title = str(arguments.get("title") or "MCP execution")
    arguments_text = _pretty_json(arguments)
    result_text = _pretty_json(result)
    if isinstance(result, dict) and "Ok" in result:
        status = "ok"
    elif isinstance(result, dict) and "Err" in result:
        status = "error"
    else:
        status = "unknown"
    duration = _duration_text(payload.get("duration"))
    search_text = f"{tool_name} {title} {arguments_text} {result_text}"
    body = (
        '<div class="tool-grid"><div><div class="tool-label">Invocation</div>'
        f'<pre>{_esc(arguments_text)}</pre></div></div>'
        '<details class="tool-output"><summary>MCP result · '
        f'{_esc(status)} · {_esc(duration)} '
        f'({len(result_text):,} chars)</summary><pre>{_esc(result_text)}</pre></details>'
    )
    return tool_name, title, f"{status} · {duration}", body, search_text


def _nested_mcp_group_html(
    events: list[dict[str, Any]],
) -> tuple[str, str]:
    children: list[str] = []
    search_parts: list[str] = []
    names: Counter[str] = Counter()
    for entry in events:
        payload = entry["payload"]
        tool_name, title, meta, body, search_text = _nested_mcp_render(payload)
        names[tool_name] += 1
        search_parts.append(search_text)
        children.append(
            '<section class="nested-tool-child">'
            '<div class="nested-tool-child-head">'
            f'<span class="nested-tool-name">{_esc(tool_name)}</span>'
            f'<span class="nested-tool-meta">{_esc(title)} · {_esc(meta)}</span>'
            f"</div>{body}</section>"
        )
    name_summary = ", ".join(
        f"{name} ×{count}" if count > 1 else name
        for name, count in sorted(names.items())
    )
    label = "Child MCP tool" if len(events) == 1 else "Child MCP tools"
    html_text = (
        '<details class="nested-tool-group"><summary>'
        f'<span>{label} ({len(events)})</span>'
        f'<span class="nested-tool-summary">{_esc(name_summary)}</span></summary>'
        f'<div class="nested-tool-list">{"".join(children)}</div></details>'
    )
    return html_text, " ".join(search_parts)


def _nested_mcp_section(entries: list[dict[str, Any]]) -> str:
    counts: Counter[str] = Counter()
    for entry in _nested_mcp_events(entries):
        counts[_mcp_tool_name(entry["payload"])] += 1
    if not counts:
        return ""
    rows = "".join(
        f"<tr><td>{_esc(name)}</td><td>{count}</td></tr>"
        for name, count in sorted(counts.items())
    )
    return f"""
<section class="section"><div class="section-head"><span>Child MCP Tools</span>
<span class="section-meta">inner execution telemetry · excluded from Tool calls</span></div>
<div class="section-body"><p class="notice">Uniquely matched calls are nested under their
parent exec entry. Unmatched events remain top-level instead of guessing a parent.</p>
<table class="data-table"><thead><tr><th>Tool</th><th>Calls</th></tr></thead>
<tbody>{rows}</tbody></table></div></section>
"""


def _entry_html(
    *,
    index: int,
    kind: str,
    role: str,
    phase: str,
    timestamp: Any,
    body: str,
) -> tuple[str, str]:
    entry_id = f"entry-{index:03d}"
    article = (
        f'<article class="entry {_esc(kind)}" id="{entry_id}" data-kind="{_esc(kind)}">'
        f'<header class="entry-head"><span class="entry-index">{index:02d}</span>'
        f'<span class="entry-role">{_esc(role)}</span><span class="entry-phase">{_esc(phase)}</span>'
        f'<time>{_esc(timestamp)}</time><a class="deep-link" href="#{entry_id}" title="Link">#</a>'
        f'</header><div class="entry-body">{body}</div></article>'
    )
    return article, entry_id


def _timeline(entries: list[dict[str, Any]]) -> tuple[str, str, int]:
    outputs = _tool_outputs(entries)
    nested_mcp_groups, linked_nested_entry_ids = _nested_mcp_groups(entries)
    articles: list[str] = []
    navigation: list[str] = []
    index = 0
    for entry in entries:
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue
        entry_type = entry.get("type")
        timestamp = entry.get("timestamp")
        kind = ""
        role = ""
        phase = ""
        text_for_search = ""
        body = ""

        if entry_type == "turn_context" and index == 0:
            kind = role = "runtime"
            phase = "turn context"
            text_for_search = _pretty_json(payload)
            body = _collapsible_text(text_for_search, "Runtime context", force=True)
        elif entry_type == "event_msg" and payload.get("type") == "mcp_tool_call_end":
            if id(entry) in linked_nested_entry_ids:
                continue
            tool_name, title, meta, body, search_text = _nested_mcp_render(payload)
            kind = "nested-tool"
            role = f"unlinked mcp: {tool_name}"
            phase = title
            text_for_search = f"{search_text} {meta}"
        elif entry_type != "response_item":
            continue
        elif payload.get("type") in CODEX_TOOL_OUTPUT_TYPES:
            continue
        elif payload.get("type") == "message":
            role = str(payload.get("role") or "message")
            text_for_search = _message_text(payload.get("content"))
            kind = _message_kind(role, text_for_search)
            phase = str(payload.get("phase") or kind.replace("_", " "))
            force = kind in {"developer", "environment", "skill"}
            body = _collapsible_text(text_for_search, phase, force=force)
        elif payload.get("type") == "reasoning":
            kind = role = "reasoning"
            phase = "thinking"
            text_for_search = _reasoning_text(payload)
            if text_for_search:
                body = _collapsible_text(text_for_search, "Reasoning summary")
            else:
                body = (
                    '<p class="reasoning-note">Encrypted reasoning is present in the rollout, '
                    "but no plaintext summary was emitted.</p>"
                )
        elif payload.get("type") in CODEX_TOOL_CALL_TYPES:
            name = str(payload.get("name") or "unknown")
            kind = "tool"
            role = f"tool: {name}"
            phase = str(payload.get("call_id") or "")
            raw_arguments = (
                payload.get("input")
                if payload.get("type") == "custom_tool_call"
                else payload.get("arguments")
            )
            arguments = _pretty_json(raw_arguments)
            call_id = payload.get("call_id")
            output = outputs.get(call_id, {}).get("output") if isinstance(call_id, str) else None
            output_text = _pretty_json(output) if isinstance(output, (dict, list)) else str(output or "")
            text_for_search = f"{name} {arguments} {output_text}"
            body = (
                '<div class="tool-grid"><div><div class="tool-label">Arguments</div>'
                f'<pre>{_esc(arguments)}</pre></div></div>'
                '<details class="tool-output"><summary>Tool output '
                f'({len(output_text):,} chars)</summary><pre>{_esc(output_text)}</pre></details>'
            )
            child_events = (
                nested_mcp_groups.get(call_id, []) if isinstance(call_id, str) else []
            )
            if child_events:
                nested_html, nested_search = _nested_mcp_group_html(child_events)
                body += nested_html
                text_for_search += f" {nested_search}"
        else:
            continue

        index += 1
        article, entry_id = _entry_html(
            index=index,
            kind=kind,
            role=role,
            phase=phase,
            timestamp=timestamp,
            body=body,
        )
        articles.append(article)
        label = _compact(text_for_search) or phase or role
        navigation.append(
            f'<a class="nav-entry" href="#{entry_id}" data-kind="{_esc(kind)}" '
            f'data-labeled="false" data-search="{_esc(text_for_search.lower())}">'
            f'<span class="tree-mark">|</span><span class="nav-label">{index:02d} {_esc(label)}</span>'
            f'<time>{_esc(_clock(timestamp))}</time></a>'
        )
    return "".join(articles), "".join(navigation), index


def _first_payload(entries: list[dict[str, Any]], entry_type: str) -> dict[str, Any]:
    for entry in entries:
        if entry.get("type") == entry_type and isinstance(entry.get("payload"), dict):
            return entry["payload"]
    return {}


def _audit_payload(
    snapshot: CodexRolloutSnapshot, audit_path: str | Path | None
) -> dict[str, Any]:
    if audit_path is not None:
        payload = load_current_codex_context_audit(audit_path, snapshot)
        if payload is not None:
            return payload
    return build_codex_context_audit(
        snapshot.session_path,
        rollout_snapshot=snapshot,
    )


def _audit_sections(audit: dict[str, Any]) -> str:
    system_prompt = str(audit.get("systemPrompt") or "")
    model_messages = audit.get("modelVisibleMessages") or []
    developer_text = "\n\n".join(
        _message_text(message.get("content"))
        for message in model_messages
        if isinstance(message, dict) and message.get("role") == "developer"
    )
    rows: list[str] = []
    for message in model_messages:
        if not isinstance(message, dict):
            continue
        text = _message_text(message.get("content"))
        provenance = message.get("provenance") or {}
        rows.append(
            "<tr>"
            f'<td>{_esc(message.get("role"))}</td><td>{_esc(message.get("kind"))}</td>'
            f'<td>{len(text):,}</td><td>{_esc(provenance.get("line"))}</td>'
            "</tr>"
        )
    messages_table = (
        '<table class="data-table"><thead><tr><th>Role</th><th>Input kind</th>'
        '<th>Chars</th><th>JSONL line</th></tr></thead><tbody>'
        f'{"".join(rows)}</tbody></table>'
    )

    tool_inventory = audit.get("toolInventory") or {}
    observed = audit.get("observedToolCalls") or []
    observed_rows = "".join(
        f'<tr><td>{_esc(tool.get("name"))}</td>'
        f'<td>{_esc(tool.get("callCount"))}</td></tr>'
        for tool in observed
        if isinstance(tool, dict)
    )
    inventory_notice = (
        f'<p class="notice"><strong>Inventory status: {_esc(tool_inventory.get("status"))}</strong><br>'
        f'{_esc(tool_inventory.get("reason"))}</p>'
    )
    used_tools_table = (
        '<table class="data-table"><thead><tr><th>Tool</th><th>Calls</th>'
        f'</tr></thead><tbody>{observed_rows}</tbody></table>'
        if observed_rows
        else '<p class="empty">No tool calls were observed in this session.</p>'
    )
    isolation = audit.get("isolation") or {}
    isolation_status = str(isolation.get("status") or "incomplete")
    loaded = ", ".join(str(name) for name in isolation.get("loadedSkillNames") or []) or "none"
    expected_skill = isolation.get("expectedSkill") or {}
    expected_skill_text = " · ".join(
        str(value) for value in (expected_skill.get("name"), expected_skill.get("path")) if value
    ) or "not configured"
    declared_skills = audit.get("declaredSkills") or []
    declared_skill_text = ", ".join(
        " · ".join(
            str(value) for value in (skill.get("name"), skill.get("path")) if value
        )
        for skill in declared_skills
        if isinstance(skill, dict)
    ) or "none"
    loaded_skills = audit.get("loadedSkills") or []
    loaded_skill_paths = ", ".join(
        str(skill.get("path"))
        for skill in loaded_skills
        if isinstance(skill, dict) and skill.get("path")
    ) or "none"
    skill_content_match = ", ".join(
        f'{skill.get("name")}: {skill.get("matchesSourceFile")}'
        for skill in loaded_skills
        if isinstance(skill, dict)
    ) or "unknown"
    skill_delivery = audit.get("skillDelivery")
    if not isinstance(skill_delivery, dict):
        skill_delivery = {
            "mode": "runtime_expansion" if loaded_skills else "progressive_disclosure",
            "preloaded": bool(loaded_skills),
            "readEvidence": {"status": "not_observed", "calls": []},
        }
    read_evidence = skill_delivery.get("readEvidence")
    if not isinstance(read_evidence, dict):
        read_evidence = {"status": "not_observed", "calls": []}
    read_calls = read_evidence.get("calls") or []
    read_call_details = (
        f'<details><summary>{len(read_calls)} observed call(s)</summary>'
        f'<pre class="prompt">{_esc(_pretty_json(read_calls))}</pre></details>'
        if read_calls
        else "none"
    )
    forbidden = ", ".join(str(name) for name in isolation.get("forbiddenMarkersFound") or []) or "none"
    world_contamination = ", ".join(
        str(name)
        for name, found in (isolation.get("worldStateContamination") or {}).items()
        if found
    ) or "none"
    runtime = audit.get("runtimeContext") or {}
    launch = audit.get("launchConfiguration") or {}
    lifecycle = audit.get("lifecycle") or {}

    return f"""
<details class="section"><summary><span>Base System Instructions</span>
<span class="section-meta">rollout session_meta · {len(system_prompt):,} chars</span></summary>
<div class="section-body"><pre class="prompt">{_esc(system_prompt)}</pre></div></details>
<details class="section"><summary><span>Developer Instructions</span>
<span class="section-meta">model-visible response_item · {len(developer_text):,} chars</span></summary>
<div class="section-body"><pre class="prompt">{_esc(developer_text)}</pre></div></details>
<section class="section"><div class="section-head"><span>Model-visible Input Sequence</span>
<span class="section-meta">system + developer + user · exact rollout order</span></div>
<div class="section-body">{messages_table}</div></section>
<details class="section"><summary><span>Context Isolation</span>
<span class="status {_esc(isolation_status)}">{_esc(isolation_status)}</span></summary>
<div class="section-body"><table class="data-table"><tbody>
<tr><th>Expected skill</th><td>{_esc(expected_skill_text)}</td><td></td></tr>
<tr><th>Declared skills</th><td>{_esc(declared_skill_text)}</td><td></td></tr>
<tr><th>Skill delivery</th><td>{_esc(skill_delivery.get("mode"))}</td><td></td></tr>
<tr><th>Preloaded skill content</th><td>{_esc(skill_delivery.get("preloaded"))}</td><td></td></tr>
<tr><th>Skill read evidence</th><td>{_esc(read_evidence.get("status"))}</td><td></td></tr>
<tr><th>Skill read target</th><td>{_esc(read_evidence.get("targetPath"))}</td><td></td></tr>
<tr><th>Skill read reason</th><td>{_esc(read_evidence.get("reason"))}</td><td></td></tr>
<tr><th>Skill read calls</th><td colspan="2">{read_call_details}</td></tr>
<tr><th>Runtime-expanded skills</th><td>{_esc(loaded)}</td><td></td></tr>
<tr><th>Runtime-expanded paths</th><td>{_esc(loaded_skill_paths)}</td><td></td></tr>
<tr><th>Skill content match</th><td>{_esc(skill_content_match)}</td><td></td></tr>
<tr><th>Forbidden context found</th><td>{_esc(forbidden)}</td><td></td></tr>
<tr><th>World-state additions</th><td>{_esc(world_contamination)}</td><td></td></tr>
<tr><th>Lifecycle</th><td>{_esc(lifecycle.get("status"))}</td><td></td></tr>
<tr><th>Capture status</th><td>{_esc(audit.get("captureStatus"))}</td><td></td></tr>
</tbody></table></div></details>
<section class="section"><div class="section-head"><span>Tools Used</span>
<span class="section-meta">model-visible tool calls</span></div>
<div class="section-body">{used_tools_table}</div></section>
<section class="section"><div class="section-head"><span>Available Tools</span>
<span class="section-meta">complete inventory and schemas</span></div>
<div class="section-body">{inventory_notice}</div></section>
<details class="section"><summary><span>Runtime and Launch Configuration</span>
<span class="section-meta">turn_context + world_state + client parameters</span></summary>
<div class="section-body"><pre class="prompt">{
        _esc(_pretty_json({"runtimeContext": runtime, "launchConfiguration": launch}))
    }</pre></div></details>
"""


def render_codex_session_html(
    session_file: str | Path,
    out_path: str | Path,
    *,
    task_id: str | None = None,
    context_audit_path: str | Path | None = None,
) -> Path:
    source = Path(session_file).resolve()
    target = Path(out_path)
    snapshot = read_codex_rollout_snapshot(source)
    entries = _entries(snapshot)
    stats = parse_codex_rollout_entries(source, entries)
    meta = _first_payload(entries, "session_meta")
    turn = _first_payload(entries, "turn_context")
    audit = _audit_payload(snapshot, context_audit_path)
    timeline_html, navigation_html, entry_count = _timeline(entries)

    title = task_id or stats.session_id or source.stem
    duration = "n/a" if stats.duration_s is None else f"{stats.duration_s:.1f}s"
    ttft = (
        "not exposed"
        if stats.time_to_first_token_s is None
        else f"{stats.time_to_first_token_s:.1f}s"
    )
    message_counts: Counter[str] = Counter()
    for entry in entries:
        payload = entry.get("payload")
        if (
            entry.get("type") == "response_item"
            and isinstance(payload, dict)
            and payload.get("type") == "message"
        ):
            message_counts[str(payload.get("role") or "message")] += 1
    message_summary = ", ".join(
        f"{count} {role}" for role, count in sorted(message_counts.items())
    ) or "0"
    git = meta.get("git") if isinstance(meta.get("git"), dict) else {}
    model_provider = meta.get("model_provider") or "openai"
    model = stats.model or turn.get("model") or "n/a"
    sandbox = turn.get("sandbox_policy")
    sandbox_name = sandbox.get("type") if isinstance(sandbox, dict) else sandbox
    nested_mcp_events = _nested_mcp_events(entries)
    meta_cells = (
        ("Date", meta.get("timestamp") or entries[0].get("timestamp") if entries else "n/a"),
        ("Model", f"{model_provider}/{model}"),
        ("Messages", message_summary),
        ("Tool calls", stats.tool_calls),
        ("Nested MCP", len(nested_mcp_events)),
        ("Tokens", f"in {stats.input_tokens:,} / out {stats.output_tokens:,}"),
        ("Cached input", f"{stats.cache_read_tokens:,}"),
        ("Reasoning", f"{(stats.reasoning_tokens or 0):,}"),
        ("Duration", duration),
        ("TTFT", ttft),
        ("LLM time", "n/a" if stats.llm_time_s is None else f"{stats.llm_time_s:.1f}s"),
        ("Tool time", "n/a" if stats.env_time_s is None else f"{stats.env_time_s:.1f}s"),
        ("Think time", "not exposed"),
        ("Approval", turn.get("approval_policy") or "n/a"),
        ("Sandbox", sandbox_name or "n/a"),
        ("CLI", meta.get("cli_version") or "n/a"),
        ("Git", git.get("branch") or "n/a"),
    )
    meta_html = "".join(
        f'<div class="meta-cell"><span>{_esc(label)}</span><strong>{_esc(value)}</strong></div>'
        for label, value in meta_cells
    )
    raw_jsonl = base64.b64encode(snapshot.raw).decode("ascii")
    audit_html = _audit_sections(audit)
    nested_mcp_html = _nested_mcp_section(entries)
    session_id = stats.session_id or meta.get("id") or "n/a"

    document = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{_esc(title)} · Codex session</title><style>{_STYLE}</style></head>
<body class="hide-thinking" data-download-name="{_esc(source.name)}">
<aside class="sidebar"><div class="sidebar-head"><div class="sidebar-title">
<strong>{_esc(title)}</strong><span>Codex</span></div>
<input class="search" id="search" type="search" placeholder="Search session entries"
aria-label="Search session entries">
<div class="filters">
<button class="filter active" data-filter="default">Default</button>
<button class="filter" data-filter="no-tools">No-tools</button>
<button class="filter" data-filter="user">User</button>
<button class="filter" data-filter="labeled">Labeled</button>
<button class="filter" data-filter="all">All</button>
</div></div><nav class="tree">{navigation_html}</nav>
<div class="tree-count" id="tree-count">{entry_count} / {entry_count} entries</div>
<div class="resize-handle" id="resize-handle" aria-hidden="true"></div></aside>
<main class="main"><div class="content"><header class="topbar"><div>
<div class="eyebrow">Codex session report</div><h1>Session: {_esc(session_id)}</h1>
<div class="shortcuts">T toggle thinking · O toggle tools</div></div><div class="actions">
<button class="action menu-button" id="menu">Menu</button>
<button class="action" id="toggle-thinking">Show thinking</button>
<button class="action" id="toggle-tools">Hide tools</button>
<button class="action" id="download">JSONL</button></div></header>
<section class="meta-grid">{meta_html}</section>
{audit_html}
{nested_mcp_html}
<h2 class="transcript-title">Transcript</h2>{timeline_html}
<p class="source">Source: {_esc(source)}</p>
</div></main>
<script id="raw-jsonl" type="application/octet-stream">{raw_jsonl}</script>
<script>{_SCRIPT}</script></body></html>"""
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(document, encoding="utf-8")
    return target
