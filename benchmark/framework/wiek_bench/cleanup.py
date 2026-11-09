"""Unconditional browser teardown after each task (15s budget, best-effort).

Runs `pi_extension_helper close` in a fresh subprocess so the Playwright sync API
executes on a clean main thread. The close itself is the unified CDP
``Target.closeTarget`` (keep one about:blank). Audit lands in close_done/<task_id>.json.
"""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone

from wiek_bench.runspace import TaskRunspace, merge_env


def _classify(provider_error: str | None) -> str:
    if provider_error and "timeout" in provider_error.lower():
        return "harness_timeout"
    if provider_error:
        return "harness_recovery"
    return "harness_post_run"


def maybe_close_after_run(
    *,
    runspace: TaskRunspace,
    browser_tool: str,
    task_id: str,
    provider_error: str | None,
    python_exe: str,
    harness_root: str,
    timeout_seconds: float = 15.0,
) -> tuple[str, int | None]:
    closed_by = _classify(provider_error)
    argv = [python_exe, "-m", "wiek_bench.hooks.pi_extension_helper", "close"]
    env = merge_env(runspace)
    returncode: int | None = None
    stdout = ""
    stderr = ""
    try:
        proc = subprocess.run(
            argv,
            cwd=harness_root,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
        returncode = proc.returncode
        stdout = proc.stdout
        stderr = proc.stderr
    except subprocess.TimeoutExpired as exc:
        stderr = f"close timeout after {timeout_seconds}s: {exc}"
    except Exception as exc:  # noqa: BLE001
        stderr = f"close spawn error: {exc}"

    # The helper's stdout is the real CloseResult JSON. The wrapper
    # exit code (`return_code`) only says the helper returned — it is NOT close success.
    # `ok` defaults to False: if no audit JSON came back (timeout / spawn error), the
    # close cannot be claimed as successful.
    close_info: dict = {}
    if stdout.strip():
        try:
            close_info = json.loads(stdout.strip().splitlines()[-1])
        except Exception:  # noqa: BLE001
            close_info = {}
    helper_failed = not close_info

    audit = {
        "task_id": task_id,
        "browser_tool": browser_tool,
        "closed_at": datetime.now(timezone.utc).isoformat(),
        "closed_by": closed_by,
        "command": "pi_extension_helper close",
        "close_command": close_info.get("close_command"),
        "ok": bool(close_info.get("ok", False)),
        "return_code": returncode,
        "raw_returncode": close_info.get("raw_returncode"),
        # stdout_tail / stderr_tail are the underlying close transport's
        # output (from the parsed CloseResult), NOT the helper wrapper's stdout (which
        # is just the JSON dump). Fall back to the raw wrapper streams only when the
        # helper produced no parseable audit (timeout / spawn error).
        "stdout_tail": (close_info.get("stdout_tail", "") if close_info else stdout)[-500:],
        "stderr_tail": (close_info.get("stderr_tail", "") if close_info else stderr)[-500:],
        "error": close_info.get("error")
        or (
            f"helper produced no close audit (wrapper rc={returncode}); {stderr.strip()[:200]}"
            if helper_failed
            else None
        ),
    }
    try:
        runspace.close_flag_path.parent.mkdir(parents=True, exist_ok=True)
        runspace.close_flag_path.write_text(
            json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception:  # noqa: BLE001
        pass
    return closed_by, returncode
