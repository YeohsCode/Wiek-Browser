from __future__ import annotations

import json
import shlex
import subprocess
from pathlib import Path

import pytest

from wiek_bench.browser_tools import wiek_browser
from wiek_bench.browser_tools.wiek_browser import (
    RUNTIME_CONTRACT_ENV,
    SDK_PATH_ENV,
    WiekBrowserRuntimeContract,
    WiekBrowserTool,
    classify_skill_runtime_contract,
    probe_runtime_contract,
    validate_skill_runtime_contract,
)
from wiek_bench.hooks import pi_extension_helper
from wiek_bench.runspace import make_task_runspace


def test_candidate_parser_accepts_both_surfaces_in_command_order() -> None:
    command = """
await useOrCreateTaskSpace('legacy space');
await taskSpaces.switch("facade space");
await completeTaskSpace(42, { keep: false });
await taskSpaces.complete('legacy space', { keep: false });
"""

    assert WiekBrowserTool().extract_space_candidates(command) == [
        "legacy space",
        "facade space",
        "42",
    ]


@pytest.mark.parametrize(
    ("contract", "accepted", "rejected"),
    [
        (
            WiekBrowserRuntimeContract.LEGACY_FLAT_V1,
            "await completeTaskSpace('x', { keep: false })",
            "await taskSpaces.complete('x', { keep: false })",
        ),
        (
            WiekBrowserRuntimeContract.TASKSPACES_FACADE_V1,
            "await taskSpaces.handOff('x')",
            "await handOffTaskSpace('x')",
        ),
    ],
)
def test_release_detection_uses_only_selected_contract(
    monkeypatch: pytest.MonkeyPatch,
    contract: WiekBrowserRuntimeContract,
    accepted: str,
    rejected: str,
) -> None:
    monkeypatch.setenv(RUNTIME_CONTRACT_ENV, contract.value)
    tool = WiekBrowserTool()

    assert tool.mentions_space_release(accepted) is True
    assert tool.mentions_space_release(rejected) is False


@pytest.mark.parametrize(
    ("contract", "switch_callee", "complete_callee", "other_complete"),
    [
        (
            WiekBrowserRuntimeContract.LEGACY_FLAT_V1,
            "switchTaskSpace",
            "completeTaskSpace",
            "taskSpaces.complete",
        ),
        (
            WiekBrowserRuntimeContract.TASKSPACES_FACADE_V1,
            "taskSpaces.switch",
            "taskSpaces.complete",
            "completeTaskSpace",
        ),
    ],
)
def test_generated_js_uses_one_contract_without_fallback(
    contract: WiekBrowserRuntimeContract,
    switch_callee: str,
    complete_callee: str,
    other_complete: str,
) -> None:
    screenshot_js = wiek_browser._screenshot_js({}, "/tmp/frame.png", ["space"], contract)
    close_js = wiek_browser._close_js(["space"], contract)

    assert f"await {switch_callee}(c)" in screenshot_js
    assert f"await {complete_callee}(c, {{ keep: false }})" in close_js
    assert f"{contract.output_callee}(JSON.stringify" in close_js
    assert other_complete not in close_js
    assert "catch" in close_js
    assert "runtime contract" not in close_js


def test_cleanup_command_pins_sdk_and_uses_selected_contract(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    sdk = tmp_path / "runtime with spaces" / "index.js"
    sdk.parent.mkdir()
    sdk.write_text("// fixture", encoding="utf-8")
    monkeypatch.setenv(RUNTIME_CONTRACT_ENV, WiekBrowserRuntimeContract.LEGACY_FLAT_V1.value)
    monkeypatch.setenv(SDK_PATH_ENV, str(sdk))
    monkeypatch.setenv("WIEK_BROWSER_BIN", "/Applications/wiek browser")

    argv = shlex.split(WiekBrowserTool().cleanup_command("task name"))

    assert argv[:4] == [
        "/Applications/wiek browser",
        "nodejs",
        "--sdk-path",
        str(sdk.resolve()),
    ]
    assert argv[4] == "-e"
    assert "completeTaskSpace" in argv[5]
    assert "taskSpaces.complete" not in argv[5]


def test_injected_release_is_exempt_only_for_selected_contract(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    sdk = tmp_path / "index.js"
    sdk.write_text("// fixture", encoding="utf-8")
    monkeypatch.setenv("WIEK_BENCH_TASK_ID", "task")
    monkeypatch.setenv("WIEK_BENCH_BROWSER_TOOL", "wiek-browser")
    monkeypatch.setenv("WIEK_BENCH_BROWSER_TOOL_MODE", "strict")
    monkeypatch.setenv(RUNTIME_CONTRACT_ENV, WiekBrowserRuntimeContract.LEGACY_FLAT_V1.value)
    monkeypatch.setenv(SDK_PATH_ENV, str(sdk))

    command = WiekBrowserTool().cleanup_command("task")

    assert pi_extension_helper.cmd_validate(command) == 0
    assert pi_extension_helper.cmd_validate(
        "wiek-browser nodejs -e \"await taskSpaces.complete('task', { keep: false })\""
    ) == 1


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        (
            {"legacy": True, "facade": False, "screenshot": True},
            WiekBrowserRuntimeContract.LEGACY_FLAT_V1,
        ),
        (
            {"legacy": False, "facade": True, "screenshot": True},
            WiekBrowserRuntimeContract.TASKSPACES_FACADE_V1,
        ),
    ],
)
def test_probe_selects_exactly_one_runtime_surface(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    payload: dict[str, bool],
    expected: WiekBrowserRuntimeContract,
) -> None:
    sdk = tmp_path / "index.js"
    sdk.write_text("// fixture", encoding="utf-8")
    marker = json.dumps({"wiekBenchRuntimeContractProbe": payload})
    captured: list[str] = []

    def fake_run(argv: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        captured.extend(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=marker, stderr="")

    monkeypatch.setattr(wiek_browser.subprocess, "run", fake_run)

    assert probe_runtime_contract(bin_path="wiek-browser", sdk_path=sdk) is expected
    assert captured[:4] == ["wiek-browser", "nodejs", "--sdk-path", str(sdk.resolve())]


@pytest.mark.parametrize(
    "payload",
    [
        {"legacy": False, "facade": False, "screenshot": True},
        {"legacy": True, "facade": True, "screenshot": True},
    ],
)
def test_probe_rejects_unknown_or_ambiguous_runtime(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, payload: dict[str, bool]
) -> None:
    sdk = tmp_path / "index.js"
    sdk.write_text("// fixture", encoding="utf-8")
    marker = json.dumps({"wiekBenchRuntimeContractProbe": payload})
    monkeypatch.setattr(
        wiek_browser.subprocess,
        "run",
        lambda argv, **_kwargs: subprocess.CompletedProcess(argv, 0, stdout=marker, stderr=""),
    )

    with pytest.raises(RuntimeError, match="exactly one supported surface"):
        probe_runtime_contract(bin_path="wiek-browser", sdk_path=sdk)


def test_probe_rejects_runtime_without_screenshot_transport(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    sdk = tmp_path / "index.js"
    sdk.write_text("// fixture", encoding="utf-8")
    marker = json.dumps(
        {
            "wiekBenchRuntimeContractProbe": {
                "legacy": True,
                "facade": False,
                "screenshot": False,
            }
        }
    )
    monkeypatch.setattr(
        wiek_browser.subprocess,
        "run",
        lambda argv, **_kwargs: subprocess.CompletedProcess(argv, 0, stdout=marker, stderr=""),
    )

    with pytest.raises(RuntimeError, match="no supported screenshot transport"):
        probe_runtime_contract(bin_path="wiek-browser", sdk_path=sdk)


def test_skill_is_secondary_validation_but_must_be_release_paired(tmp_path: Path) -> None:
    release = tmp_path / "release"
    skill = release / "wiek-browser" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    sdk = release / "index.js"
    sdk.write_text("// fixture", encoding="utf-8")
    skill.write_text(
        "await useOrCreateTaskSpace('x')\nawait completeTaskSpace('x', { keep: false })\n",
        encoding="utf-8",
    )

    assert classify_skill_runtime_contract(skill) is WiekBrowserRuntimeContract.LEGACY_FLAT_V1
    assert (
        validate_skill_runtime_contract(
            skill_path=skill,
            sdk_path=sdk,
            runtime_contract=WiekBrowserRuntimeContract.LEGACY_FLAT_V1,
        )
        is WiekBrowserRuntimeContract.LEGACY_FLAT_V1
    )
    with pytest.raises(RuntimeError, match="contract mismatch"):
        validate_skill_runtime_contract(
            skill_path=skill,
            sdk_path=sdk,
            runtime_contract=WiekBrowserRuntimeContract.TASKSPACES_FACADE_V1,
        )

    unrelated = tmp_path / "other" / "SKILL.md"
    unrelated.parent.mkdir()
    unrelated.write_text(skill.read_text(encoding="utf-8"), encoding="utf-8")
    with pytest.raises(RuntimeError, match="SKILL/runtime mismatch"):
        validate_skill_runtime_contract(
            skill_path=unrelated,
            sdk_path=sdk,
            runtime_contract=WiekBrowserRuntimeContract.LEGACY_FLAT_V1,
        )


def test_wiek_runspace_requires_and_exports_preflight_contract(tmp_path: Path) -> None:
    sdk = tmp_path / "index.js"
    sdk.write_text("// fixture", encoding="utf-8")
    with pytest.raises(ValueError, match="requires runtime_contract and sdk_path"):
        make_task_runspace(
            run_id="run",
            task_id="task",
            run_dir=tmp_path / "run-missing",
            browser_tool="wiek-browser",
            browser_tool_mode="off",
            harness_root=tmp_path,
            workdir=tmp_path,
            python_exe="python",
        )

    runspace = make_task_runspace(
        run_id="run",
        task_id="task",
        run_dir=tmp_path / "run",
        browser_tool="wiek-browser",
        browser_tool_mode="off",
        harness_root=tmp_path,
        workdir=tmp_path,
        python_exe="python",
        wiek_browser_runtime_contract=WiekBrowserRuntimeContract.LEGACY_FLAT_V1.value,
        wiek_browser_sdk_path=str(sdk),
        provider_env={
            RUNTIME_CONTRACT_ENV: WiekBrowserRuntimeContract.TASKSPACES_FACADE_V1.value,
            SDK_PATH_ENV: "/wrong/index.js",
        },
    )

    assert runspace.env_overrides[RUNTIME_CONTRACT_ENV] == "legacy-flat-v1"
    assert runspace.env_overrides[SDK_PATH_ENV] == str(sdk)
