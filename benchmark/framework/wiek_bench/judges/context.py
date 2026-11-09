"""Shared pi-judge runtime context + helpers."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from wiek_bench.judges.pi_judge import pi_judge_json
from wiek_bench.screenshotter import MANIFEST_NAME
from wiek_bench.session_parser import BashAction, TrajectoryStep

if TYPE_CHECKING:
    from collections.abc import Callable

    from pydantic import BaseModel

    from wiek_bench.judges.pi_judge import PiJudgeResult

_MAX_TASK_CHARS = 200_000
_MAX_RESULT_CHARS = 200_000
_MAX_TRAJECTORY_CHARS = 600_000


@dataclass
class PiJudgeContext:
    pi_bin: str
    pi_agent_dir: str
    model: str
    thinking_level: str
    retry_max: int
    timeout_s: float
    # Maximum screenshots visible to the judge. ``None`` means all; frames/
    # always retains every deduplicated screenshot.
    max_screenshots: int | None = None
    image_concurrency: int = 4
    score_threshold: int = 3
    # Judge mode and agent-channel settings. ``mode`` is the global default;
    # unsupported judges fall back to ``single`` through ``effective_mode``.
    mode: str = "single"
    agent_tools: list[str] = field(default_factory=list)
    judge_skill_path: str | None = None
    agent_timeout_s: float = 900.0

    @property
    def workspace(self) -> str:
        """Shared pi cwd for judge subprocesses: <PI_HOME>/.pi/agent/workspace."""
        return str(Path(self.pi_agent_dir) / "workspace")

    def effective_mode(self, supports_agent: bool = True) -> str:
        """Intersect the global mode with one judge's agent-mode capability."""
        return self.mode if (self.mode == "single" or supports_agent) else "single"

    def timeout_for(self, mode: str) -> float:
        """Use the larger timeout for agent tool loops and the normal one for single."""
        return self.agent_timeout_s if mode == "agent" else self.timeout_s

    def cap_screenshots(self, shots: list[Path]) -> list[Path]:
        """Return all screenshots or the newest configured subset.

        Non-positive limits select no screenshots.
        """
        if self.max_screenshots is None:
            return list(shots)
        if self.max_screenshots <= 0:
            return []
        return list(shots[-self.max_screenshots :])

    def scope_kwargs(self, scoped: list[Path], all_shots: list[Path]) -> dict[str, object]:
        """Build the agent prompt's frame scope from one centralized slice.

        ``scoped`` is the result of ``cap_screenshots``. Centralizing the frame
        names and counts keeps agent-mode limits consistent across judges.
        """
        return {
            "image_count": len(scoped),
            "scoped_frames": [p.name for p in scoped],
            "total_frames": len(all_shots),
        }

    @property
    def probe_script(self) -> str | None:
        """Absolute path to the judge skill's probe.py, injected into the agent-mode
        investigation prompt. The judge's cwd is the pi workspace (not the skill dir), so a
        relative ``scripts/probe.py`` won't resolve, so inject the absolute path."""
        if not self.judge_skill_path:
            return None
        return str(Path(self.judge_skill_path) / "scripts" / "probe.py")

    async def run_json(
        self,
        *,
        make_message: Callable[[str], str],
        schema: type[BaseModel],
        images: list[Path],
        supports_agent: bool,
        make_system: Callable[[str], str | None] | None = None,
    ) -> tuple[PiJudgeResult, str]:
        """One judge json call. The effective mode is resolved HERE (once) and drives the
        rendered message (``make_message(mode)``), the optional system prompt
        (``make_system(mode)``) and the pi channel, so message / system / channel can never
        drift apart. Returns ``(result, mode)`` so the caller records the exact mode it ran
        in without re-deriving effective_mode.

        ``make_system`` (when given) returns the pi ``--system-prompt`` for this mode, or
        ``None`` to keep pi's default coding-assistant prompt. odysseys single passes the
        paper's FULL_TRAJ_JUDGMENT_SYSTEM so the judge's system message matches
        the paper; agent mode returns ``None`` to keep the default scaffolding
        required by its tools and judge skill.

        Agent mode does not attach images directly. It injects the
        frames/manifest.jsonl path so the judge can map commands to screenshots
        and read only the originals it needs. Only single mode attaches
        thumbnails to the message."""
        mode = self.effective_mode(supports_agent)
        payload_images = [] if mode == "agent" else images
        result = await pi_judge_json(
            model=self.model,
            thinking_level=self.thinking_level,
            message=make_message(mode),
            schema=schema,
            images=payload_images,
            retry_max=self.retry_max,
            timeout_s=self.timeout_for(mode),
            pi_bin=self.pi_bin,
            pi_agent_dir=self.pi_agent_dir,
            cwd=self.workspace,
            mode=mode,
            tools=self.agent_tools,
            skill_path=self.judge_skill_path,
            system_prompt=make_system(mode) if make_system else None,
        )
        return result, mode


def truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "\n...[truncated]..."


def truncate_middle(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + "\n...[truncated middle]...\n" + text[-half:]


def format_trajectory(actions: list[BashAction]) -> str:
    if len(actions) > 100:
        actions = actions[:50] + actions[-50:]
    lines: list[str] = []
    for a in actions:
        tag = " [ERROR]" if a.is_error else ""
        lines.append(f"$ {a.command}{tag}")
    return truncate_middle("\n".join(lines), _MAX_TRAJECTORY_CHARS)


# Per-step response cap for the Odysseys paper-style per-turn history: the
# visible reply or thinking fallback can run long — cap each step so one verbose turn can't
# dominate. The whole trajectory string is bounded by the shared _MAX_TRAJECTORY_CHARS.
_MAX_STEP_RESPONSE_CHARS = 10_000


def format_trajectory_steps(steps: list[TrajectoryStep]) -> str:
    """Render per-turn steps as the Odysseys paper-style action history:

        1. Response: <that turn's reply / thinking>
        Action: <cmd> -> <cmd> [ERROR] -> <cmd>
        2. Response: ...
        Action: ...

    A step omits the ``Response:`` line when the turn had no reply/thinking text. Same caps as
    ``format_trajectory`` (≤100 steps → first 50 + last 50; whole string middle-truncated to
    ``_MAX_TRAJECTORY_CHARS``) plus a per-step Response cap (``_MAX_STEP_RESPONSE_CHARS``) so a
    long thinking block can't swamp the prompt."""
    if len(steps) > 100:
        steps = steps[:50] + steps[-50:]
    lines: list[str] = []
    for i, step in enumerate(steps, start=1):
        parts: list[str] = []
        response = truncate(step.response, _MAX_STEP_RESPONSE_CHARS)
        if response:
            parts.append(f"Response: {response}")
        if step.actions:
            action_line = " -> ".join(
                a.command + (" [ERROR]" if a.is_error else "") for a in step.actions
            )
            parts.append(f"Action: {action_line}")
        if parts:
            lines.append(f"{i}. " + "\n".join(parts))
    return truncate_middle("\n".join(lines), _MAX_TRAJECTORY_CHARS)


def screenshots_dir_of(screenshots: list[Path]) -> str | None:
    """Directory holding the selected screenshots, the agent-mode judge's read entry
    point; None when there are no screenshots."""
    return str(screenshots[0].parent) if screenshots else None


def manifest_path_of(screenshots: list[Path]) -> str | None:
    """Return the frames/manifest.jsonl path inferred from the first screenshot.

    Return ``None`` when there are no screenshots or the manifest is absent.
    """
    if not screenshots:
        return None
    manifest = screenshots[0].parent / MANIFEST_NAME
    return str(manifest) if manifest.exists() else None


def clip_task(text: str) -> str:
    return truncate(text, _MAX_TASK_CHARS)


def clip_result(text: str) -> str:
    return truncate(text, _MAX_RESULT_CHARS)
