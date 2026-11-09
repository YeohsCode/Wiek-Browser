from __future__ import annotations

from pathlib import Path

import pytest

from wiek_bench.hooks.safety_guard import find_danger

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT / "agent-home" / ".pi" / "agent" / "workspace"


ALLOWED = [
    # The agent owns its workspace; deleting what it created there is normal work.
    "rm -rf ./tmp",
    "rm -rf out/cache",
    "rm -f note.txt",
    f"rm -rf {WORKSPACE}/task-files/scratch",
    "ls -la && echo hello",
    "cat results.json | head -20",
    "git status",
    "git log --oneline -5",
    # A dry run destroys nothing.
    "git clean -fdxn",
    "git push --dry-run --force origin main",
    # The dominant command shape in this harness: an apostrophe in the JS body used to
    # throw off shlex and skip the guard entirely, so these must stay parseable.
    "wiek-browser nodejs --taskspace t1 <<'EOF'\n"
    "const x = \"it's a test\";\n"
    "await page.click('#confirm');\n"
    "EOF",
    # Prose inside a non-shell heredoc is data, not a command.
    "wiek-browser nodejs --taskspace t1 <<'EOF'\n"
    "// rm -rf / mentioned in a JS comment\n"
    "const form = document.querySelector('form');\n"
    "EOF",
]

DENIED = [
    # Upstream block_dangerous.py catches these too.
    "rm -rf /",
    "rm -rf ~",
    "sudo rm -rf /var/log",
    'bash -c "rm -rf ~"',
    'eval "rm -rf /"',
    ":(){ :|:& };:",
    "git reset --hard",
    "git clean -fdx",
    "git branch -D main",
    "git push --force origin main",
    "dd if=/dev/zero of=/dev/disk0",
    "psql -c 'DROP TABLE users'",
    "chmod -R 777 /",
    # The gap this guard exists to close: upstream allows every one of these, and each
    # destroys something the harness cannot recover.
    "rm -rf ~/Projects/wiek-benchmark",
    f"rm -rf {ROOT}/runs",
    f"rm -rf {ROOT}/agent-home",
    "rm -rf ../../../runs",
    "rm -f ~/.pi/agent/auth.json",
    # Escaping upward from inside the workspace still lands outside it.
    f"rm -rf {WORKSPACE}/../../..",
    # A shell heredoc body is executed, so it is checked.
    "bash <<'EOF'\nrm -rf ~/Projects\nEOF",
    # sudo is never needed for a browser task.
    "sudo systemctl stop nginx",
]


@pytest.mark.parametrize("command", ALLOWED)
def test_allows_legitimate_commands(command: str) -> None:
    assert find_danger(command, WORKSPACE) is None


@pytest.mark.parametrize("command", DENIED)
def test_denies_destructive_commands(command: str) -> None:
    assert find_danger(command, WORKSPACE) is not None


def test_relative_target_after_cd_is_undecidable_and_denied() -> None:
    """`cd` unanchors later relative paths, so they can no longer be proven safe."""
    assert find_danger("cd /tmp && rm -rf junk", WORKSPACE) is not None
    # Without the cd the same relative target resolves inside the workspace.
    assert find_danger("rm -rf junk", WORKSPACE) is None


def test_unexpandable_variable_is_treated_as_outside() -> None:
    assert find_danger("rm -rf $UNSET_TARGET_DIR", WORKSPACE) is not None


def test_reason_names_the_offending_target() -> None:
    reason = find_danger("rm -rf ~/Projects/wiek-benchmark", WORKSPACE)
    assert reason is not None
    assert "~/Projects/wiek-benchmark" in reason


def test_workspace_env_is_published_to_the_agent(tmp_path: Path) -> None:
    """The guard is inert without WIEK_BENCH_AGENT_WORKSPACE, so runspace must set it."""
    from wiek_bench.hooks.safety_guard import WORKSPACE_ENV
    from wiek_bench.runspace import make_task_runspace

    runspace = make_task_runspace(
        run_id="run-1",
        task_id="task-1",
        run_dir=tmp_path / "run",
        browser_tool="demo-browser",
        browser_tool_mode="off",
        harness_root=tmp_path,
        workdir=tmp_path / "work",
        python_exe="/usr/bin/python3",
    )
    assert runspace.env_overrides[WORKSPACE_ENV] == str((tmp_path / "work").resolve())
