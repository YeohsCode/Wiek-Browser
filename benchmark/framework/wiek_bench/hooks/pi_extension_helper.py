"""Python helper invoked by the pi extension (single-sourced parsing + CDP execution).

Subcommands (each a fresh subprocess, so Playwright sync-API runs on a clean main
thread):
  validate    stdin=command  → exit 0 pass / exit 1 + reason (guard)
  screenshot  stdin=command  → capture via CDP after a browser command (always exit 0)
  inject      (env only)     → print task-id isolation + cleanup fragment to stdout
  close       (env only)     → close all page targets via CDP (best-effort, prints JSON)

Env contract: WIEK_BENCH_TASK_ID / WIEK_BENCH_BROWSER_TOOL / WIEK_BENCH_BROWSER_TOOL_MODE /
WIEK_BENCH_SCREENSHOT_FRAMES_DIR.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from wiek_bench import screenshotter
from wiek_bench.browser_tools import (
    CDP_SCREENSHOT_PARAMS,
    get_browser_tool,
    is_task_management_subcommand,
    split_pipeline_segments,
)


def _env(name: str) -> str | None:
    value = os.environ.get(name)
    return value if value else None


def _contexts(tool, command: str) -> list:
    """(segment, InvocationContext) pairs for a command.

    Tools without a subcommand system (guard_applies=False)
    detect via a whole-command feature-string scan: per-segment splitting would
    separate the binary token from the `captureScreenshot`/`Target.closeTarget`
    feature string (heredoc JS bodies routinely contain `||`/`&&`/`;`), defeating
    the screenshot-skip. Such tools must be parsed on the whole command. The segment
    string is returned alongside each ctx so callers can do per-segment checks — e.g.
    the strict guard's space-release exemption must not leak across `&&`-joined segments.
    """
    if not getattr(tool, "guard_applies", True):
        ctx = tool.detect_invocation(command)
        return [(command, ctx)] if ctx is not None else []
    pairs = []
    for seg in split_pipeline_segments(command):
        ctx = tool.detect_invocation(seg)
        if ctx is not None:
            pairs.append((seg, ctx))
    if not pairs:
        whole = tool.detect_invocation(command)
        if whole is not None:
            pairs.append((command, whole))
    return pairs


def cmd_validate(command: str) -> int:
    task_id = _env("WIEK_BENCH_TASK_ID")
    tool_name = _env("WIEK_BENCH_BROWSER_TOOL")
    mode = (_env("WIEK_BENCH_BROWSER_TOOL_MODE") or "strict").lower()
    if not task_id or not tool_name or mode == "off":
        return 0
    tool = get_browser_tool(tool_name)
    if not getattr(tool, "guard_applies", True):
        return 0
    mentions_release = getattr(tool, "mentions_space_release", None)
    for seg, ctx in _contexts(tool, command):
        if ctx.tool_name != tool_name:
            continue
        # Canonical V2 validates the actual JS selection before historical flag
        # and release exemptions. A finish() in one segment cannot waive scope.
        validate_instance = getattr(tool, "validate_instance_command", None)
        if validate_instance is not None:
            handled, error = validate_instance(seg, task_id, mode)
            if handled:
                if error:
                    print(error)
                    return 1
                continue
        if is_task_management_subcommand(ctx.tool_name, ctx.subcommand):
            continue
        # space-release commands (taskSpaces.complete/taskSpaces.handOff) are the
        # new-model equivalent of `taskspace close/complete`: they intentionally run on a bare
        # `wiek-browser nodejs` (no --taskspace), so exempt THIS SEGMENT from the instance-flag
        # check — otherwise the harness's own cleanup command would be blocked by its own guard
        # Per-segment handling prevents a release segment from whitelisting a
        # plain no-flag segment.
        # joined by `&&`/`;`.
        if mentions_release is not None and mentions_release(seg):
            continue
        if ctx.task_or_session is None:
            if mode == "strict":
                print(
                    f"This {tool_name} command is missing its required instance flag "
                    f"for task '{task_id}'. Re-run it bound to this task's instance."
                )
                return 1
            continue
        if ctx.task_or_session != task_id:
            print(
                f"This {tool_name} command targets instance '{ctx.task_or_session}', "
                f"but this task must use '{task_id}'. Re-run with the correct instance id."
            )
            return 1
    return 0


def _append_error(frames_dir: Path, payload: dict) -> None:
    try:
        with (frames_dir / screenshotter.ERRORS_NAME).open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001
        pass


def _record_space_candidates(tool, command: str) -> None:
    """Append space candidates parsed from the command to browser_state/<task_id>.json.

    Single-sourced parsing lives on the tool (wiek-browser only). Best-effort: any error
    is swallowed so the screenshot hook never disturbs the agent.
    """
    extract = getattr(tool, "extract_space_candidates", None)
    if not callable(extract):
        return
    state_path = _env("WIEK_BENCH_BROWSER_STATE_PATH")
    if not state_path:
        return
    candidates = extract(command)
    if not candidates:
        return
    path = Path(state_path)
    existing: list[str] = []
    if path.exists():
        try:
            existing = list(json.loads(path.read_text(encoding="utf-8")).get("taskspaces", []))
        except Exception:  # noqa: BLE001
            existing = []
    merged = existing[:]
    for c in candidates:
        if c not in merged:
            merged.append(c)
    if merged == existing:
        return
    payload = {
        "task_id": _env("WIEK_BENCH_TASK_ID"),
        "browser_tool": _env("WIEK_BENCH_BROWSER_TOOL"),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "taskspaces": merged,
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def cmd_screenshot(command: str) -> int:
    frames_dir_env = _env("WIEK_BENCH_SCREENSHOT_FRAMES_DIR")
    tool_name = _env("WIEK_BENCH_BROWSER_TOOL")
    if not frames_dir_env or not tool_name:
        return 0
    frames_dir = Path(frames_dir_env)
    frames_dir.mkdir(parents=True, exist_ok=True)
    try:
        tool = get_browser_tool(tool_name)
    except ValueError:
        return 0
    contexts = _contexts(tool, command)
    if not contexts:
        return 0
    # Record space candidates for the fallback close — even when this command skips the
    # screenshot.
    _record_space_candidates(tool, command)
    # Skip if any segment is a screenshot/close/task-management command, or the body
    # releases a space (taskSpaces.complete/taskSpaces.handOff).
    # (Whole-command release check is fine here: screenshot-skip is conservative — if any
    # part releases a space, don't shoot. The per-segment distinction only matters for the
    # guard's exemption in cmd_validate.)
    for _seg, ctx in contexts:
        if ctx.subcommand in {"screenshot", "close"}:
            return 0
        if is_task_management_subcommand(ctx.tool_name, ctx.subcommand):
            return 0
    if getattr(tool, "mentions_space_release", None) and tool.mentions_space_release(command):
        return 0
    last = contexts[-1][1]
    instance_id = last.task_or_session or _env("WIEK_BENCH_TASK_ID")
    # Capture into the next candidate frame, then dedup-commit: unique → kept, duplicate →
    # deleted but its command still recorded in the manifest.
    candidate = screenshotter.next_frame_candidate(frames_dir)
    # wiek-browser captures a separately numbered AX tree through the same CDP
    # session. Other tools expose no supports_ax_tree attribute and skip it.
    wants_tree = getattr(tool, "supports_ax_tree", False)
    tree_candidate = screenshotter.next_tree_candidate(frames_dir) if wants_tree else None
    capture_kwargs = {"tree_output_path": str(tree_candidate)} if tree_candidate else {}
    try:
        tool.capture_screenshot(
            instance_id=instance_id,
            output_path=str(candidate),
            params=CDP_SCREENSHOT_PARAMS,
            **capture_kwargs,
        )
        if not candidate.exists():
            _append_error(frames_dir, {"stage": "screenshot.fail", "command": command[:300]})
            if tree_candidate is not None:
                tree_candidate.unlink(missing_ok=True)
            return 0
    except Exception as exc:  # noqa: BLE001
        # Capture may write a partial frame or tree before raising. Remove those
        # candidates so they cannot be mistaken for valid, manifested evidence.
        candidate.unlink(missing_ok=True)
        if tree_candidate is not None:
            tree_candidate.unlink(missing_ok=True)
        _append_error(
            frames_dir, {"stage": "screenshot.error", "error": str(exc), "command": command[:300]}
        )
        return 0
        # A missing AX tree after a successful screenshot is best-effort
        # evidence failure and must not invalidate the screenshot.
    if tree_candidate is not None and not tree_candidate.exists():
        _append_error(frames_dir, {"stage": "tree.fail", "command": command[:300]})
    screenshotter.commit_capture(frames_dir, candidate, command, tree_candidate=tree_candidate)
    return 0


def cmd_inject() -> int:
    task_id = _env("WIEK_BENCH_TASK_ID")
    tool_name = _env("WIEK_BENCH_BROWSER_TOOL")
    mode = (_env("WIEK_BENCH_BROWSER_TOOL_MODE") or "strict").lower()
    if mode == "off":  # Injection shares the guard's mode switch.
        return 0
    if not task_id or not tool_name:
        return 0
    try:
        tool = get_browser_tool(tool_name)
    except ValueError:
        return 0
    sys.stdout.write(tool.inject_fragment(task_id, mode))
    return 0


def _close_failure(close_command: str | None, error: str) -> dict:
    return {
        "ok": False,
        "raw_returncode": None,
        "stdout_tail": "",
        "stderr_tail": "",
        "close_command": close_command,
        "error": error,
    }


def cmd_close() -> int:
    # Wrapper may exit 0 (don't pollute the provider flow), but the stdout JSON must
    # Carry the real close result: ok / raw_returncode / stdout_tail /
    # stderr_tail / close_command. Never print {"ok": true} after catching an error.
    task_id = _env("WIEK_BENCH_TASK_ID")
    tool_name = _env("WIEK_BENCH_BROWSER_TOOL")
    if not tool_name:
        print(json.dumps(_close_failure(None, "no browser tool")))
        return 0
    try:
        tool = get_browser_tool(tool_name)
        instance_id = task_id if getattr(tool, "guard_applies", True) else None
        result = tool.close_targets(instance_id=instance_id)
        print(json.dumps(asdict(result)))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps(_close_failure(None, str(exc))))
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if not argv:
        print("usage: pi_extension_helper <validate|screenshot|inject|close>", file=sys.stderr)
        return 2
    action = argv[0]
    if action == "inject":
        return cmd_inject()
    if action == "close":
        return cmd_close()
    command = sys.stdin.read()
    if not command.strip():
        return 0
    if action == "validate":
        return cmd_validate(command)
    if action == "screenshot":
        return cmd_screenshot(command)
    print(f"unknown action: {action}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
