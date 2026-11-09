"""Per-task runspace: provider workdir plus screenshot/artifact paths and env."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

from wiek_bench.browser_tools.wiek_browser import RUNTIME_CONTRACT_ENV, SDK_PATH_ENV
from wiek_bench.task_resources import stage_attachments


@dataclass
class TaskRunspace:
    run_id: str
    task_id: str
    run_dir: Path
    workdir: Path
    frames_dir: Path
    close_flag_path: Path
    browser_state_path: Path
    pi_stderr_path: Path
    sysprompt_path: Path
    env_overrides: dict[str, str] = field(default_factory=dict)
    # Staged attachment paths, in declaration order, for the prompt to name.
    attachment_paths: list[Path] = field(default_factory=list)


def make_task_runspace(
    *,
    run_id: str,
    task_id: str,
    run_dir: str | Path,
    browser_tool: str,
    browser_tool_mode: str,
    harness_root: str | Path,
    workdir: str | Path,
    python_exe: str,
    wiek_browser_runtime_contract: str | None = None,
    wiek_browser_sdk_path: str | None = None,
    provider_env: dict[str, str] | None = None,
    bin_env: str | None = None,
    bin_overrides: dict[str, str] | None = None,
    attachments: Sequence[Path] = (),
) -> TaskRunspace:
    run_dir = Path(run_dir).resolve()
    workdir = Path(workdir).resolve()  # Rebuilt once at run start, not per task.
    # Captures are deduplicated incrementally into frames/ without raw staging.
    frames_dir = run_dir / "screenshots" / task_id / "frames"

    sysprompt_path = run_dir / "system_prompt" / f"{task_id}.json"
    close_flag_path = run_dir / "close_done" / f"{task_id}.json"
    browser_state_path = run_dir / "browser_state" / f"{task_id}.json"
    pi_stderr_path = run_dir / "pi_stderr" / f"{task_id}.log"
    for d in (
        frames_dir,
        sysprompt_path.parent,
        close_flag_path.parent,
        browser_state_path.parent,
        pi_stderr_path.parent,
    ):
        d.mkdir(parents=True, exist_ok=True)
    harness_root = str(harness_root)

    env: dict[str, str] = {
        "WIEK_BENCH_RUN_ID": run_id,
        "WIEK_BENCH_TASK_ID": task_id,
        "PI_BENCH_TASK_ID": task_id,
        "WIEK_BENCH_BROWSER_TOOL": browser_tool,
        "WIEK_BENCH_BROWSER_TOOL_MODE": browser_tool_mode,
        "WIEK_BENCH_SCREENSHOT_FRAMES_DIR": str(frames_dir),
        "WIEK_BENCH_BROWSER_STATE_PATH": str(browser_state_path),
        "WIEK_BENCH_HARNESS_ROOT": harness_root,
        # The safety guard's whitelist root: deletes are allowed here and nowhere else.
        "WIEK_BENCH_AGENT_WORKSPACE": str(workdir),
        "WIEK_BENCH_SYSPROMPT_PATH": str(sysprompt_path),
        "WIEK_BENCH_PYTHON": python_exe,
        "PYTHONPATH": harness_root,
    }
    env.update(provider_env or {})
    if browser_tool == "wiek-browser":
        if not wiek_browser_runtime_contract or not wiek_browser_sdk_path:
            raise ValueError(
                "wiek-browser runspace requires runtime_contract and sdk_path from Stage A preflight"
            )
        env[RUNTIME_CONTRACT_ENV] = wiek_browser_runtime_contract
        env[SDK_PATH_ENV] = wiek_browser_sdk_path
    # Forward the active tool's own binary variable. Keying off the tool's declared
    # ``bin_env`` keeps this free of any per-tool name list, so a browser tool added
    # from outside this package needs no change here.
    for key in filter(None, {bin_env, *(bin_overrides or {})}):
        value = (bin_overrides or {}).get(key) or os.environ.get(key)
        if value:
            env[key] = value

    return TaskRunspace(
        run_id=run_id,
        task_id=task_id,
        run_dir=run_dir,
        workdir=workdir,
        frames_dir=frames_dir,
        close_flag_path=close_flag_path,
        browser_state_path=browser_state_path,
        pi_stderr_path=pi_stderr_path,
        sysprompt_path=sysprompt_path,
        env_overrides=env,
        attachment_paths=stage_attachments(attachments, workdir=workdir, task_id=task_id),
    )


def merge_env(runspace: TaskRunspace) -> dict[str, str]:
    """Full environment for the pi subprocess: os.environ + per-task overrides."""
    return {**os.environ, **runspace.env_overrides}
