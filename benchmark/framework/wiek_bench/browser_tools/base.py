"""Browser-tool abstraction: AgentSurface (test variable) + EngineControl (control variable).

AgentSurface — how the agent calls the browser and how the harness parses that
command (per-tool, the thing under test). EngineControl — out-of-band observation
and teardown unified to CDP semantics (a control variable). The parsing rules
(subcommand / instance flag / pipeline segments) are single-sourced here; the TS
extension calls a Python helper rather than re-implementing them.
"""

from __future__ import annotations

import os
import shlex
from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True)
class InvocationContext:
    tool_name: str
    subcommand: str | None
    task_or_session: str | None


@dataclass(frozen=True)
class CloseResult:
    """Audit result of a teardown close.

    ``ok`` reflects the *real* close semantics, not "no exception was raised": an
    idempotent no-op on an already-gone instance is ``ok=True``; a non-zero return
    code, timeout, spawn error, or CDP transport error must be ``ok=False``. A
    best-effort close may keep going after a partial failure, but the failure must
    surface in ``error`` / ``stderr_tail`` — it is never audited as ``ok=True``.

    ``raw_returncode`` is the underlying close transport's exit code for a native
    close command; ``None`` for timeout / spawn error / no-process (CDP close).
    """

    ok: bool
    close_command: str
    raw_returncode: int | None = None
    stdout_tail: str = ""
    stderr_tail: str = ""
    error: str | None = None

    @classmethod
    def timeout(cls, close_command: str, *, exc: Exception, timeout_s: float) -> "CloseResult":
        """Native close timed out (no exit code; trimmed exc as stderr)."""
        return cls(
            ok=False, close_command=close_command, raw_returncode=None,
            stderr_tail=str(exc)[-500:], error=f"close timeout after {timeout_s}s",
        )

    @classmethod
    def spawn_error(cls, close_command: str, *, exc: Exception) -> "CloseResult":
        """Native close subprocess failed to spawn (no exit code)."""
        return cls(
            ok=False, close_command=close_command, raw_returncode=None,
            error=f"close spawn error: {exc}",
        )


@dataclass(frozen=True)
class CdpScreenshotParams:
    """Single-sourced screenshot parameters; every tool observes through these."""

    format: str = "png"
    full_page: bool = False
    quality: int | None = None

    def to_cdp(self) -> dict[str, object]:
        params: dict[str, object] = {"format": self.format}
        if self.full_page:
            params["captureBeyondViewport"] = True
        if self.quality is not None and self.format == "jpeg":
            params["quality"] = self.quality
        return params


@runtime_checkable
class AgentSurface(Protocol):
    name: str
    skill_name: str
    bin_env: str
    bin_default: str

    def bin(self) -> str: ...

    def detect_invocation(self, bash_command: str) -> InvocationContext | None: ...


@runtime_checkable
class EngineControl(Protocol):
    # Capture a screenshot through this tool's CDP runtime using unified params.
    def capture_screenshot(
        self, *, instance_id: str | None, output_path: str, params: CdpScreenshotParams
    ) -> None: ...

    # Idempotently release this tool's instance / page targets. Returns an audit
    # result; failures surface as ok=false and never fail the task by raising.
    def close_targets(self, *, instance_id: str | None) -> CloseResult: ...


@runtime_checkable
class BrowserTool(AgentSurface, EngineControl, Protocol):
    """Convenience: a concrete tool implements both layers."""

    # Prompt fragments injected by the runtime hook layer.
    def instance_constraint(self, task_id: str, mode: str) -> str: ...

    def cleanup_command(self, task_id: str) -> str: ...

    def inject_fragment(self, task_id: str, mode: str) -> str: ...

    # whether the task-isolation guard applies to this tool at all
    guard_applies: bool


_PIPELINE_OPERATORS_TWO = {"&&", "||"}
_PIPELINE_OPERATORS_ONE = {";", "|"}

# Single source for task-management exemptions: subcommands that manage the tool's
# own browsing contexts rather than driving a page, so the isolation guard lets them
# through. Tools registered from outside this package declare theirs by calling
# ``register_task_management_subcommands``; an unregistered tool exempts nothing.
_TASK_MGMT_SUBCOMMANDS: dict[str, set[str]] = {
    "wiek-browser": {"taskspace"},
}


def register_task_management_subcommands(tool_name: str, subcommands: set[str]) -> None:
    _TASK_MGMT_SUBCOMMANDS[tool_name] = set(subcommands)


def is_task_management_subcommand(tool_name: str, subcommand: str | None) -> bool:
    if subcommand is None:
        return False
    return subcommand in _TASK_MGMT_SUBCOMMANDS.get(tool_name, set())


def split_pipeline_segments(cmd: str) -> list[str]:
    """Split a shell command on && || ; | at the top level (quote/escape aware)."""
    segments: list[str] = []
    buf: list[str] = []
    i = 0
    n = len(cmd)
    in_single = False
    in_double = False
    while i < n:
        c = cmd[i]
        if in_single:
            buf.append(c)
            if c == "'":
                in_single = False
            i += 1
            continue
        if in_double:
            if c == "\\" and i + 1 < n:
                buf.append(c)
                buf.append(cmd[i + 1])
                i += 2
                continue
            buf.append(c)
            if c == '"':
                in_double = False
            i += 1
            continue
        if c == "'":
            in_single = True
            buf.append(c)
            i += 1
            continue
        if c == '"':
            in_double = True
            buf.append(c)
            i += 1
            continue
        if c == "\\" and i + 1 < n:
            buf.append(c)
            buf.append(cmd[i + 1])
            i += 2
            continue
        if cmd[i : i + 2] in _PIPELINE_OPERATORS_TWO:
            segments.append("".join(buf))
            buf = []
            i += 2
            continue
        if c in _PIPELINE_OPERATORS_ONE:
            segments.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(c)
        i += 1
    segments.append("".join(buf))
    return [s.strip() for s in segments if s.strip()]


def tokenize(segment: str) -> list[str]:
    """shlex tokens; fall back to whitespace split on unbalanced quotes."""
    try:
        return shlex.split(segment)
    except ValueError:
        return segment.split()


def resolve_bin(bin_env: str, bin_default: str) -> str:
    return os.environ.get(bin_env) or bin_default


def parse_flag_invocation(
    *,
    bash_command: str,
    tool_name: str,
    bin_path: str,
    instance_flag: str,
    value_flags: set[str],
) -> InvocationContext | None:
    """Parse a single command segment for a value-flag style CLI.

    Returns None when the command does not invoke this tool's binary.
    """
    tokens = tokenize(bash_command)
    if not tokens:
        return None
    bin_base = os.path.basename(bin_path)
    bin_idx = -1
    for i, tok in enumerate(tokens):
        if tok == bin_path or os.path.basename(tok) == bin_base:
            bin_idx = i
            break
    if bin_idx < 0:
        return None

    instance: str | None = None
    subcommand: str | None = None
    rest = tokens[bin_idx + 1 :]
    k = 0
    while k < len(rest):
        tok = rest[k]
        if tok.startswith(instance_flag + "="):
            instance = tok.split("=", 1)[1]
            k += 1
            continue
        if tok == instance_flag:
            if k + 1 < len(rest):
                instance = rest[k + 1]
                k += 2
            else:
                k += 1
            continue
        matched_value_flag = False
        for vf in value_flags:
            if tok == vf:
                k += 2
                matched_value_flag = True
                break
            if tok.startswith(vf + "="):
                k += 1
                matched_value_flag = True
                break
        if matched_value_flag:
            continue
        if tok.startswith("-"):
            k += 1
            continue
        if subcommand is None:
            subcommand = tok
        k += 1
    # parsing is position-agnostic for the instance flag
    return InvocationContext(tool_name=tool_name, subcommand=subcommand, task_or_session=instance)
