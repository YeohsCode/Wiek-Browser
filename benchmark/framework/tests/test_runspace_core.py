from __future__ import annotations

from pathlib import Path

import pytest

from wiek_bench.browser_tools.wiek_browser import RUNTIME_CONTRACT_ENV, SDK_PATH_ENV
from wiek_bench.runspace import make_task_runspace, merge_env


def test_make_task_runspace_creates_paths_and_merges_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DEMO_BROWSER_BIN", "/global/demo-browser")
    runspace = make_task_runspace(
        run_id="run-1",
        task_id="task-1",
        run_dir=tmp_path / "run",
        browser_tool="demo-browser",
        browser_tool_mode="strict",
        harness_root=tmp_path,
        workdir=tmp_path / "work",
        python_exe="/usr/bin/python3",
        provider_env={"SHARED": "provider"},
        bin_env="DEMO_BROWSER_BIN",
        bin_overrides={"DEMO_BROWSER_BIN": "/override/demo-browser"},
    )

    assert runspace.frames_dir.is_dir()
    assert runspace.sysprompt_path.parent.is_dir()
    assert runspace.env_overrides["WIEK_BENCH_TASK_ID"] == "task-1"
    assert runspace.env_overrides["DEMO_BROWSER_BIN"] == "/override/demo-browser"
    assert runspace.env_overrides["SHARED"] == "provider"

    monkeypatch.setenv("SHARED", "process")
    assert merge_env(runspace)["SHARED"] == "provider"


def test_wiek_browser_runspace_requires_preflight_contract(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="requires runtime_contract and sdk_path"):
        make_task_runspace(
            run_id="run-1",
            task_id="task-1",
            run_dir=tmp_path / "run",
            browser_tool="wiek-browser",
            browser_tool_mode="strict",
            harness_root=tmp_path,
            workdir=tmp_path / "work",
            python_exe="/usr/bin/python3",
        )


def test_wiek_browser_runspace_injects_preflight_values(tmp_path: Path) -> None:
    runspace = make_task_runspace(
        run_id="run-1",
        task_id="task-1",
        run_dir=tmp_path / "run",
        browser_tool="wiek-browser",
        browser_tool_mode="strict",
        harness_root=tmp_path,
        workdir=tmp_path / "work",
        python_exe="/usr/bin/python3",
        wiek_browser_runtime_contract="contract-value",
        wiek_browser_sdk_path="/sdk/path",
    )

    assert runspace.env_overrides[RUNTIME_CONTRACT_ENV] == "contract-value"
    assert runspace.env_overrides[SDK_PATH_ENV] == "/sdk/path"


def test_bin_env_is_forwarded_without_an_explicit_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A tool registered outside this package gets its binary variable forwarded."""
    monkeypatch.setenv("THIRD_PARTY_BROWSER_BIN", "/opt/third-party-browser")
    runspace = make_task_runspace(
        run_id="run-1",
        task_id="task-1",
        run_dir=tmp_path / "run",
        browser_tool="third-party-browser",
        browser_tool_mode="strict",
        harness_root=tmp_path,
        workdir=tmp_path / "work",
        python_exe="/usr/bin/python3",
        bin_env="THIRD_PARTY_BROWSER_BIN",
    )

    assert runspace.env_overrides["THIRD_PARTY_BROWSER_BIN"] == "/opt/third-party-browser"
