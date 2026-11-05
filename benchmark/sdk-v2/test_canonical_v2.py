from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shlex
import struct
import subprocess

import pytest

from ego_bench.browser_tools import canonical_v2 as v2, ego_browser
from ego_bench.browser_tools.base import CdpScreenshotParams
from ego_bench.browser_tools.ego_browser import EgoBrowserRuntimeContract as Contract, EgoBrowserTool
from ego_bench.hooks import pi_extension_helper as hook


@pytest.fixture(autouse=True)
def scope(monkeypatch, tmp_path):
    sdk = tmp_path / "index.js"
    sdk.write_text("// test runtime")
    monkeypatch.setenv(ego_browser.RUNTIME_CONTRACT_ENV, Contract.CANONICAL_V2.value)
    monkeypatch.setenv(ego_browser.SDK_PATH_ENV, str(sdk))
    monkeypatch.setenv("EGO_BENCH_TASK_ID", "task")
    monkeypatch.setenv("EGO_BENCH_BROWSER_TOOL", "ego-browser")
    monkeypatch.setenv("EGO_BENCH_BROWSER_TOOL_MODE", "strict")
    monkeypatch.setenv("EGO_BROWSER_BIN", "ego-browser")


def command(source, sdk=None):
    return shlex.join(["ego-browser", "nodejs", "--sdk-path", sdk or ego_browser._sdk_path_from_env(), "-e", source])


@pytest.mark.parametrize("source", [
    "const t=await taskSpace('task'); await t.page('p1').goto('http://localhost/');",
    'const t=await taskSpace("task"); await t.finish({keep:[]});',
    "await taskSpace('task'); await taskSpace('task');",
])
def test_valid_scope(source):
    assert hook.cmd_validate(command(source)) == 0


@pytest.mark.parametrize("source", [
    "await taskSpace('other');",
    "await taskSpace('task'); await taskSpace('other');",
    "await taskSpace(7);",
    "await taskSpace(name);",
    "// await taskSpace('task')\nconsole.log('no scope');",
    'console.log("taskSpace(\'task\')");',
    "const select=taskSpace; await select('task');",
    "await globalThis.taskSpace('task');",
    "await taskSpace?.('task');",
    "await taskSpace('task'); await ego.cdp('Target.closeTarget',{});",
    "const taskSpace=()=>{}; await taskSpace('task');",
    "await taskSpace('task'); await import('node:fs');",
    "await taskSpace('task'); eval('anything');",
    "await taskSpace('task'); await taskSpaces.complete('other');",
    "await taskSpace('other'); await t.finish({keep:[]});",
])
def test_guard_rejects_dynamic_wrong_or_spoofed_scope(source):
    assert hook.cmd_validate(command(source)) == 1


def test_no_legacy_flag_or_release_exemption():
    assert hook.cmd_validate("ego-browser --taskspace=task nodejs -e '1'") == 1
    assert hook.cmd_validate("ego-browser taskspace close other") == 1
    assert hook.cmd_validate(command("await taskSpace('task')", "/other/sdk.js")) == 1
    assert hook.cmd_validate(command("await taskSpace('task'); await t.finish({keep:[]})") + " && " + command("await taskSpace('other')")) == 1


def test_exact_harness_cleanup_is_scoped_and_guard_accepted():
    tool = EgoBrowserTool()
    cleanup = tool.cleanup_command("task")
    assert "--taskspace" not in cleanup
    assert hook.cmd_validate(cleanup) == 0
    assert hook.cmd_validate(cleanup + " && " + command("await taskSpace('other')")) == 1
    assert hook.cmd_validate(EgoBrowserTool().cleanup_command("other")) == 1


def test_parser_preserves_numeric_vs_named_candidates_and_ignores_comments():
    tool = EgoBrowserTool()
    assert tool.extract_space_candidates("await taskSpace('7'); await taskSpace(7); /*taskSpace('x')*/") == ["7", 7]
    assert tool.mentions_space_release(command("const t=await taskSpace('task'); await t.finish({keep:[]})"))
    assert not tool.mentions_space_release(command('console.log("t.finish({})")'))


def test_strict_capture_cleanup_never_use_injected_other_candidates(monkeypatch, tmp_path):
    state = tmp_path / "state.json"
    state.write_text(json.dumps({"taskspaces": ["other", 7]}))
    monkeypatch.setenv("EGO_BENCH_BROWSER_STATE_PATH", str(state))
    assert v2.candidates(EgoBrowserTool(), "task") == ["task"]
    monkeypatch.setenv("EGO_BENCH_BROWSER_TOOL_MODE", "off")
    assert v2.candidates(EgoBrowserTool(), "task") == ["other", 7, "task"]


def test_canonical_probe_prefers_v2_over_installed_legacy_guards_without_calls(monkeypatch):
    real_run = subprocess.run
    def probe(argv, **kwargs):
        # Calling any helper throws; a successful probe proves zero calls.
        prelude = "const taskSpace=()=>{throw Error('mutation')}; const listTaskSpaces=taskSpace; globalThis.useOrCreateTaskSpace=taskSpace;globalThis.switchTaskSpace=taskSpace;globalThis.completeTaskSpace=taskSpace;globalThis.cliLog=console.log;\n"
        return real_run(["node", "--input-type=module", "-e", prelude + argv[-1]], **kwargs)
    monkeypatch.setattr(ego_browser.subprocess, "run", probe)
    assert ego_browser.probe_runtime_contract(bin_path="unused", sdk_path=ego_browser._sdk_path_from_env()) is Contract.CANONICAL_V2


def test_skill_pair_requires_canonical_examples(tmp_path):
    sdk = tmp_path / "index.js"; sdk.write_text("fixture")
    skill = tmp_path / "ego-browser/SKILL.md"; skill.parent.mkdir()
    skill.write_text("const t=await taskSpace('task');")
    assert ego_browser.validate_skill_runtime_contract(skill_path=skill, sdk_path=sdk, runtime_contract=Contract.CANONICAL_V2) is Contract.CANONICAL_V2
    skill.write_text("No examples")
    with pytest.raises(RuntimeError, match="unambiguous"):
        ego_browser.validate_skill_runtime_contract(skill_path=skill, sdk_path=sdk, runtime_contract=Contract.CANONICAL_V2)


def test_stale_file_and_rc_zero_without_marker_cannot_pass(monkeypatch, tmp_path):
    output = tmp_path / "frame.png"; output.write_bytes(b"stale")
    monkeypatch.setattr(EgoBrowserTool, "_run_nodejs", lambda *args: subprocess.CompletedProcess([], 0, "", "runtime rejected"))
    with pytest.raises(RuntimeError, match="marker missing"):
        EgoBrowserTool().capture_screenshot(instance_id="task", output_path=str(output), params=CdpScreenshotParams())
    assert output.read_bytes() == b"stale"
    assert not list(tmp_path.glob(".canonical-v2-*"))


@pytest.mark.parametrize("failure", ["hash", "viewport", "scope", "exit", "nonce", "png", "missing"])
def test_fresh_capture_requires_receipt_and_fixed_png(monkeypatch, tmp_path, failure):
    # Run real generated JS against a controlled Page transport, then corrupt one
    # independent boundary before Python accepts it.
    real_run = subprocess.run
    def run(_tool, source):
        data = b"\x89PNG\r\n\x1a\n" + b"\0" * 8 + struct.pack(">II", 1280, 800)
        prelude = f"""
const listTaskSpaces=async()=>[{{id:7,name:'task',ownership:'agent'}}];
const taskSpace=async()=>({{tabs:async()=>[{{active:true,targetId:'p1',page:{{cdp:async(method)=>method==='Page.captureScreenshot'?{{data:{json.dumps(__import__('base64').b64encode(data).decode())}}}:{{nodes:[]}}}}}}]}});
"""
        result = real_run(["node", "--input-type=module", "-e", prelude + source], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout)
        if failure == "hash": payload["sha256"] = "wrong"
        if failure == "viewport": payload["viewport"]["width"] = 8
        if failure == "scope": payload["targetId"] = None
        if failure == "exit": result.returncode = 1
        if failure == "nonce": payload["canonicalMarker"] = "stale"
        # Locate the uniquely owned temporary image by known fixture root.
        image = next(tmp_path.glob(".canonical-v2-*/capture"))
        if failure == "missing": image.unlink()
        if failure == "png":
            image.write_bytes(b"invalid screenshot" * 2)
            payload["sha256"] = hashlib.sha256(image.read_bytes()).hexdigest()
        result.stdout = json.dumps(payload)
        return result
    monkeypatch.setattr(EgoBrowserTool, "_run_nodejs", run)
    with pytest.raises(RuntimeError):
        EgoBrowserTool().capture_screenshot(instance_id="task", output_path=str(tmp_path / "out.png"), params=CdpScreenshotParams())
    assert not (tmp_path / "out.png").exists()


def test_incomplete_cleanup_receipt_remains_failure(monkeypatch):
    real_run = subprocess.run
    def run(_tool, source):
        prelude = "const listTaskSpaces=async()=>[{id:7,name:'task',ownership:'agent'}];const taskSpace=async()=>({finish:async()=>({closedSpace:false,preservedUnmanagedCount:1})});"
        return real_run(["node", "--input-type=module", "-e", prelude + source], capture_output=True, text=True)
    monkeypatch.setattr(EgoBrowserTool, "_run_nodejs", run)
    result = EgoBrowserTool().close_targets(instance_id="task")
    assert result.ok is False
    assert "protected" in result.error
    assert '"preservedUnmanagedCount": 1' in result.stdout_tail
