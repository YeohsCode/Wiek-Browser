---
name: codex-session-exporter
description: Export Codex rollout/session JSONL as a self-contained HTML report that can be opened offline. Use when a user provides a complete session file path or Codex session ID, or asks to export a Codex session to HTML, generate a session report, or convert a rollout to HTML. Supports exact full-ID lookup in the CODEX_HOME sessions and archived_sessions directories.
---

# Codex Session Exporter

Use the bundled script for path resolution and HTML export. Do not rewrite the parser ad hoc.

## Workflow

1. Obtain the user's input: an existing JSONL path or a complete UUID session ID.
2. Determine the output path. Use a user-specified path exactly; otherwise, use
   `codex-session-<session-id>.html` in the current working directory.
3. Run:

```bash
python3 "$SKILL_DIR/scripts/export_session.py" "$SESSION_OR_ID" \
  --output "$OUTPUT_HTML"
```

4. Return both absolute paths printed by the script: `Session source` and
   `HTML report exported`.

`SKILL_DIR` is the current skill's real directory. Do not assume the caller runs from the
repository root.

## Session ID lookup

Accept only a complete UUID, not a prefix or fuzzy ID. Search these locations in order by default:

- `$CODEX_HOME/sessions/**/rollout-*-<session-id>.jsonl`
- `$CODEX_HOME/archived_sessions/**/rollout-*-<session-id>.jsonl`
- Use `~/.codex` when `CODEX_HOME` is unset

If the session is under an isolated benchmark `agent-home/.codex`, pass that home explicitly:

```bash
python3 "$SKILL_DIR/scripts/export_session.py" "$SESSION_ID" \
  --codex-home "/absolute/path/to/agent-home/.codex" \
  --output "$OUTPUT_HTML"
```

If no session is found, report the searched CODEX_HOME. If multiple files match, do not choose
one; ask the user for a complete path.

## Constraints

- Use Python 3.11+ and do not install dependencies.
- Do not modify the original JSONL.
- Do not attempt to decrypt reasoning; show only plaintext summaries already present in the
  rollout.
- Preserve the report's ability to download the original JSONL. The report contains the complete
  session text; do not upload or share it without user authorization.
- For export-only requests, do not invoke the benchmark parser or analysis scripts. Use
  `codex-session-analyzer` when the user needs an explanation of failures, timing, or tool paths.
