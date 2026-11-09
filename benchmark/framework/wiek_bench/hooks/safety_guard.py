"""Destructive-command guard for the unattended agent (bash tool only).

Invoked by the ``safety-guard`` pi extension, one fresh subprocess per suspicious
bash command:

  stdin=command  → exit 0 allow / exit 1 deny with the reason on stdout

The rule set is vendored from the operator's Claude Code ``block_dangerous.py``
hook and deliberately kept separate from it: this copy answers to the harness,
where the agent runs unattended and the blast radius is the benchmark itself
(``agent-home/`` credentials, ``runs/`` artifacts, the repository).

The one rule that is *not* a copy is ``rm``. Upstream blacklists a handful of
protected targets, which leaves ``rm -rf <repo>/runs`` and
``rm -rf <repo>/agent-home`` wide open. Here it is a whitelist instead: the agent
owns ``WIEK_BENCH_AGENT_WORKSPACE`` and may delete anything inside it, while a
delete reaching outside that subtree is denied regardless of flags. Nothing the
agent legitimately does needs to remove a file it did not create.

Every denial is advisory to the model, not fatal to the task: the extension
returns the reason as the tool result and the agent keeps working.
"""

from __future__ import annotations

import os
import re
import shlex
import sys
from collections.abc import Callable
from pathlib import Path

CommandMatcher = Callable[[str, list[str], bool], bool]

WORKSPACE_ENV = "WIEK_BENCH_AGENT_WORKSPACE"

CONTROL_CHARS = frozenset(";&|\n()")
SHELLS = frozenset({"bash", "dash", "ksh", "sh", "zsh"})
DATABASE_CLIENTS = frozenset({"duckdb", "mariadb", "mysql", "psql", "sqlite3", "sqlcmd"})
SUDO_OPTIONS_WITH_VALUE = frozenset({
    "-C", "-R", "-T", "-g", "-h", "-p", "-u",
    "--chdir", "--close-from", "--group", "--host", "--prompt", "--user",
})
GIT_OPTIONS_WITH_VALUE = frozenset({
    "-C", "-c", "--exec-path", "--git-dir", "--namespace", "--work-tree",
})
SQL_DESTRUCTION_PATTERN = re.compile(
    r"\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b",
    re.IGNORECASE,
)
FORK_BOMB_PATTERN = re.compile(r"^\s*:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:\s*$")
ENV_ASSIGNMENT_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=.*$", re.DOTALL)
HEREDOC_PATTERN = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


# --------------------------------------------------------------------------
# heredoc handling
#
# The harness's own browser commands are `wiek-browser nodejs ... <<'EOF' <js> EOF`.
# Feeding that JS to shlex either throws (an apostrophe inside the body reads as an
# unterminated quote, which would silently skip the guard on the single most common
# command shape here) or tokenizes prose into what looks like a command. So bodies are
# cut out before parsing, and re-checked only when the heredoc feeds a shell.
# --------------------------------------------------------------------------


def _host_executable(text: str) -> str:
    """Last command word before a heredoc operator — its interpreter."""
    tail = text
    for char in CONTROL_CHARS:
        tail = tail.rsplit(char, 1)[-1]
    tokens = tail.split()
    return Path(tokens[0]).name if tokens else ""


def _split_heredocs(command: str) -> tuple[str, list[str]]:
    """Strip heredoc bodies; return the outer command plus bodies fed to a shell."""
    lines = command.split("\n")
    kept: list[str] = []
    shell_bodies: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        match = HEREDOC_PATTERN.search(line)
        if match is None:
            kept.append(line)
            index += 1
            continue
        delimiter = match.group(2)
        is_shell = _host_executable(line[: match.start()]) in SHELLS
        kept.append(line[: match.start()])
        body: list[str] = []
        index += 1
        while index < len(lines) and lines[index].strip() != delimiter:
            body.append(lines[index])
            index += 1
        index += 1  # consume the terminator (or run off the end on an unclosed body)
        if is_shell:
            shell_bodies.append("\n".join(body))
    return "\n".join(kept), shell_bodies


# --------------------------------------------------------------------------
# command parsing (vendored)
# --------------------------------------------------------------------------


def _split_command(command: str) -> list[list[str]]:
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|\n()<>")
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
    except ValueError:
        # Unparseable after heredoc stripping is rare. Allowing it keeps a quoting
        # quirk from voiding a benchmark task; the extension logs the miss.
        return []

    segments: list[list[str]] = []
    current: list[str] = []
    for token in tokens:
        if token and all(char in CONTROL_CHARS for char in token):
            if current:
                segments.append(current)
                current = []
            continue
        current.append(token)
    if current:
        segments.append(current)
    return segments


def _consume_options(tokens: list[str], start: int, options_with_value: frozenset[str]) -> int:
    index = start
    while index < len(tokens):
        token = tokens[index]
        if token == "--":
            return index + 1
        option_name = token.split("=", 1)[0]
        if option_name in options_with_value:
            index += 1 if "=" in token else 2
            continue
        if token.startswith("-"):
            index += 1
            continue
        break
    return index


def _unwrap_command(tokens: list[str]) -> tuple[str, list[str], bool]:
    remaining = list(tokens)
    used_sudo = False

    while remaining:
        while remaining and ENV_ASSIGNMENT_PATTERN.fullmatch(remaining[0]):
            remaining.pop(0)
        if not remaining:
            break

        executable = Path(remaining[0]).name
        if executable == "sudo":
            used_sudo = True
            index = _consume_options(remaining, 1, SUDO_OPTIONS_WITH_VALUE)
            remaining = remaining[index:]
            continue
        if executable in {"env", "command", "nohup"}:
            index = _consume_options(remaining, 1, frozenset())
            remaining = remaining[index:]
            continue
        return executable, remaining[1:], used_sudo

    return "", [], used_sudo


def _short_flags(arguments: list[str]) -> set[str]:
    flags: set[str] = set()
    for argument in arguments:
        if argument.startswith("-") and not argument.startswith("--"):
            flags.update(argument[1:])
    return flags


# --------------------------------------------------------------------------
# rm: workspace whitelist
# --------------------------------------------------------------------------


def _rm_targets(arguments: list[str]) -> list[str]:
    targets: list[str] = []
    options_finished = False
    for argument in arguments:
        if not options_finished and argument == "--":
            options_finished = True
            continue
        if not options_finished and argument.startswith("-"):
            continue
        targets.append(argument)
    return targets


def _inside_workspace(target: str, workspace: Path, *, cwd_known: bool) -> bool:
    """True only when ``target`` provably resolves inside ``workspace``.

    Undecidable inputs resolve to False: an unexpanded ``$VAR`` stays literal, and a
    relative path is unanchored once the command has already `cd`-ed somewhere. Both
    then read as outside and get denied, which is the safe direction.
    """
    expanded = os.path.expandvars(os.path.expanduser(target))
    if "$" in expanded:
        # expandvars leaves unknown names literal. The guard's environment is not the
        # shell's (`X=/etc; rm -rf $X` assigns inside the command), so an unresolved
        # variable could point anywhere — never treat it as a workspace-relative path.
        return False
    if not os.path.isabs(expanded):
        if not cwd_known:
            return False
        expanded = str(workspace / expanded)
    # realpath resolves the existing prefix, so `workspace/../..` cannot sneak out
    # and a symlink cannot point the delete elsewhere.
    resolved = Path(os.path.realpath(expanded))
    root = Path(os.path.realpath(workspace))
    return resolved == root or root in resolved.parents


def _matches_rm(executable: str, arguments: list[str], used_sudo: bool) -> bool:
    del used_sudo  # rm is judged by target, and sudo is caught by _matches_sudo
    return executable == "rm"


def _rm_reason(arguments: list[str], workspace: Path, *, cwd_known: bool) -> str | None:
    outside = [
        target
        for target in _rm_targets(arguments)
        if not _inside_workspace(target, workspace, cwd_known=cwd_known)
    ]
    if not outside:
        return None
    return (
        f"deletes {', '.join(outside)} outside the agent workspace ({workspace})"
        if cwd_known
        else f"deletes {', '.join(outside)} after a `cd`, so the target cannot be "
        f"proven to sit inside the agent workspace ({workspace})"
    )


# --------------------------------------------------------------------------
# remaining rules (vendored unchanged)
# --------------------------------------------------------------------------


def _matches_sudo(executable: str, arguments: list[str], used_sudo: bool) -> bool:
    del executable, arguments
    return used_sudo


def _git_subcommand(arguments: list[str]) -> tuple[str, list[str]]:
    index = 0
    while index < len(arguments):
        token = arguments[index]
        if token == "--":
            index += 1
            break
        option_name = token.split("=", 1)[0]
        if option_name in GIT_OPTIONS_WITH_VALUE:
            index += 1 if "=" in token else 2
            continue
        if token.startswith("-"):
            index += 1
            continue
        return token, arguments[index + 1:]
    if index < len(arguments):
        return arguments[index], arguments[index + 1:]
    return "", []


def _git_parts(executable: str, arguments: list[str]) -> tuple[str, list[str]]:
    if executable != "git":
        return "", []
    return _git_subcommand(arguments)


def _matches_git_reset(executable: str, arguments: list[str], used_sudo: bool) -> bool:
    del used_sudo
    subcommand, subarguments = _git_parts(executable, arguments)
    return subcommand == "reset" and "--hard" in subarguments


def _matches_git_clean(executable: str, arguments: list[str], used_sudo: bool) -> bool:
    del used_sudo
    subcommand, subarguments = _git_parts(executable, arguments)
    if subcommand != "clean":
        return False
    flags = _short_flags(subarguments)
    if "n" in flags or "--dry-run" in subarguments:
        return False
    return {"f", "d", "x"}.issubset(flags)


def _matches_git_branch(executable: str, arguments: list[str], used_sudo: bool) -> bool:
    del used_sudo
    subcommand, subarguments = _git_parts(executable, arguments)
    if subcommand != "branch":
        return False
    flags = _short_flags(subarguments)
    return "D" in flags or (
        ("d" in flags or "--delete" in subarguments)
        and ("f" in flags or "--force" in subarguments)
    )


def _protected_remote_ref(argument: str) -> bool:
    ref = argument.removeprefix("+")
    destination = ref.rsplit(":", 1)[-1].removeprefix("refs/heads/")
    return destination in {"main", "master"}


def _matches_git_push(executable: str, arguments: list[str], used_sudo: bool) -> bool:
    del used_sudo
    subcommand, subarguments = _git_parts(executable, arguments)
    if subcommand != "push":
        return False

    flags = _short_flags(subarguments)
    if "n" in flags or "--dry-run" in subarguments:
        return False

    force = "f" in flags or any(
        argument == "--force" or argument.startswith("--force-with-lease")
        for argument in subarguments
    )
    operands = [argument for argument in subarguments if not argument.startswith("-")]
    refs = operands[1:] if len(operands) > 1 else []

    if any(argument.startswith("+") and _protected_remote_ref(argument) for argument in refs):
        return True
    if any(argument.startswith(":") and _protected_remote_ref(argument) for argument in refs):
        return True
    if "--delete" in subarguments and any(_protected_remote_ref(argument) for argument in refs):
        return True
    if not force:
        return False
    if len(operands) <= 1:
        return True
    return any(_protected_remote_ref(argument) for argument in refs)


def _matches_sql(executable: str, arguments: list[str], used_sudo: bool) -> bool:
    del used_sudo
    return executable in DATABASE_CLIENTS and bool(
        SQL_DESTRUCTION_PATTERN.search(" ".join(arguments))
    )


def _matches_dd(executable: str, arguments: list[str], used_sudo: bool) -> bool:
    del used_sudo
    if executable != "dd":
        return False
    for argument in arguments:
        if argument.startswith("of="):
            target = argument[3:]
            if target.startswith("/dev/") and target != "/dev/null":
                return True
    for index, argument in enumerate(arguments[:-1]):
        if argument in {">", ">>"}:
            target = arguments[index + 1]
            if target.startswith("/dev/") and target != "/dev/null":
                return True
    return False


def _has_help(arguments: list[str]) -> bool:
    return "-h" in arguments or "--help" in arguments


def _matches_disk_format(executable: str, arguments: list[str], used_sudo: bool) -> bool:
    del used_sudo
    if _has_help(arguments):
        return False
    has_device = any(argument.startswith("/dev/") for argument in arguments)
    if executable == "mkfs" or executable.startswith("mkfs.") or executable.startswith("newfs_"):
        return has_device
    return (
        executable == "diskutil"
        and bool(arguments)
        and arguments[0] in {"eraseDisk", "partitionDisk"}
        and has_device
    )


def _is_root_or_home(target: str) -> bool:
    normalized = os.path.normpath(os.path.expanduser(os.path.expandvars(target)))
    return normalized in {"/", os.path.normpath(str(Path.home()))}


def _matches_chmod_chown(executable: str, arguments: list[str], used_sudo: bool) -> bool:
    del used_sudo
    if executable not in {"chmod", "chown"} or _has_help(arguments):
        return False
    flags = _short_flags(arguments)
    long_recursive = "--recursive" in arguments
    targets = [argument for argument in arguments if not argument.startswith("-")]
    if executable == "chown":
        return ("R" in flags or long_recursive) and any(
            _is_root_or_home(target) for target in targets[1:]
        )
    if not targets:
        return False
    return targets[0] in {"000", "0000", "777", "0777"} and any(
        _is_root_or_home(target) for target in targets[1:]
    )


DANGEROUS_PATTERNS: list[tuple[str, CommandMatcher]] = [
    ("sudo (privilege escalation is never needed for a benchmark task)", _matches_sudo),
    ("git reset --hard", _matches_git_reset),
    ("git clean force-removes untracked and ignored files", _matches_git_clean),
    ("git branch force-delete", _matches_git_branch),
    ("git push force-updates or deletes main/master", _matches_git_push),
    ("database DROP / TRUNCATE", _matches_sql),
    ("dd writes to a block device", _matches_dd),
    ("disk format", _matches_disk_format),
    ("chmod/chown on / or the home directory", _matches_chmod_chown),
]


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------


def _find_shell_payload(arguments: list[str]) -> str | None:
    for index, argument in enumerate(arguments[:-1]):
        if argument.startswith("-") and "c" in argument[1:]:
            return arguments[index + 1]
    return None


def find_danger(
    command: str,
    workspace: Path,
    *,
    sudo_context: bool = False,
    cwd_known: bool = True,
    depth: int = 0,
) -> str | None:
    """Reason this command is denied, or None to allow it."""
    if depth > 3:
        return None
    if FORK_BOMB_PATTERN.fullmatch(command.strip()):
        return "fork bomb"

    outer, shell_bodies = _split_heredocs(command)
    for body in shell_bodies:
        reason = find_danger(
            body, workspace, sudo_context=sudo_context, cwd_known=cwd_known, depth=depth + 1
        )
        if reason is not None:
            return reason

    segments = _split_command(outer)
    # A `cd` anywhere in the command unanchors every later relative path, so the
    # whole command is judged with relative targets treated as undecidable.
    if any(_unwrap_command(segment)[0] == "cd" for segment in segments):
        cwd_known = False

    for segment in segments:
        executable, arguments, used_sudo = _unwrap_command(segment)
        effective_sudo = sudo_context or used_sudo
        if executable in SHELLS:
            nested = _find_shell_payload(arguments)
            if nested is not None:
                reason = find_danger(
                    nested,
                    workspace,
                    sudo_context=effective_sudo,
                    cwd_known=cwd_known,
                    depth=depth + 1,
                )
                if reason is not None:
                    return reason
            continue
        if executable == "eval":
            reason = find_danger(
                " ".join(arguments),
                workspace,
                sudo_context=effective_sudo,
                cwd_known=cwd_known,
                depth=depth + 1,
            )
            if reason is not None:
                return reason
            continue
        if _matches_rm(executable, arguments, effective_sudo):
            reason = _rm_reason(arguments, workspace, cwd_known=cwd_known)
            if reason is not None:
                return f"`rm` {reason}"
        for label, matcher in DANGEROUS_PATTERNS:
            if matcher(executable, arguments, effective_sudo):
                return label
    return None


def deny_message(reason: str) -> str:
    return (
        f"Blocked by the wiek-bench safety guard: {reason}. "
        "This command was not executed. The agent workspace is the only writable scope "
        "for destructive operations — confine deletes to files you created there, and "
        "never touch the harness repository, its runs/ artifacts, or agent-home/. "
        "Continue the task without this command."
    )


def main(argv: list[str] | None = None) -> int:
    del argv
    workspace_env = os.environ.get(WORKSPACE_ENV)
    if not workspace_env:
        return 0  # not a harness-managed run; the guard has no scope to enforce
    command = sys.stdin.read()
    if not command.strip():
        return 0
    reason = find_danger(command, Path(workspace_env))
    if reason is None:
        return 0
    print(deny_message(reason))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
