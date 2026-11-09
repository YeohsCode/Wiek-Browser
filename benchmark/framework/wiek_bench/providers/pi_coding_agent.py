"""pi-coding-agent Stage A agent driver.

A pi subprocess is spawned per task in ``--mode rpc``; the shared JSONL RPC client
lives in ``wiek_bench.pi_rpc`` and is reused by the judge. The
session file pi writes is the single source of truth — this layer only returns a
thin ``PiRunResult`` with locators, never derived metrics.
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from wiek_bench.providers.base import AgentRunResult, SessionFileCallback

# Re-exported for backward-compatible imports (providers/__init__ + callers).
from wiek_bench.pi_rpc import (
    EventCallback,
    PiRpcError,
    PiRpcSession,
    kill_all_pi_processes,
)

__all__ = [
    "EventCallback",
    "PiAgentSpec",
    "PiProvider",
    "PiRpcError",
    "PiRpcSession",
    "PiRunResult",
    "build_agent_argv",
    "kill_all_pi_processes",
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


PiRunResult = AgentRunResult


def build_agent_argv(
    *,
    pi_bin: str,
    provider: str,
    model: str,
    thinking_level: str,
    allowed_tools: list[str],
    skill_path: str | Path,
) -> list[str]:
    return [
        pi_bin,
        "--mode",
        "rpc",
        "--provider",
        provider,
        "--model",
        model,
        "--thinking",
        thinking_level,
        "--tools",
        ",".join(allowed_tools) if allowed_tools else "",
        "--no-skills",
        "--skill",
        str(skill_path),
        "--no-context-files",
        "--no-prompt-templates",
        "--no-themes",
    ]


@dataclass
class PiAgentSpec:
    pi_bin: str
    provider: str
    model: str
    thinking_level: str
    allowed_tools: list[str]
    skill_path: str
    task_timeout_s: float  # Effective wall clock: time-mode limit or step-mode backstop.
    max_turns: int | None = None  # step limit (step mode); None = time mode
    capture_stderr: bool = False
    extra_env: dict[str, str] = field(default_factory=dict)


class PiProvider:
    """Drives one pi task: spawn → prompt → agent_end → refresh state → abort/close."""

    name = "pi"

    def __init__(self, spec: PiAgentSpec) -> None:
        self.spec = spec

    async def run(
        self,
        *,
        task_id: str,
        prompt: str,
        cwd: str | Path,
        env: dict[str, str],
        on_event: EventCallback = None,
        on_session_file: SessionFileCallback = None,
        stderr_path: str | Path | None = None,
        stop_event: asyncio.Event | None = None,
    ) -> PiRunResult:
        spec = self.spec
        argv = build_agent_argv(
            pi_bin=spec.pi_bin,
            provider=spec.provider,
            model=spec.model,
            thinking_level=spec.thinking_level,
            allowed_tools=spec.allowed_tools,
            skill_path=spec.skill_path,
        )
        result = PiRunResult(task_id=task_id, started_at=_now_iso())
        session = PiRpcSession(
            argv,
            cwd=cwd,
            env=env,
            on_event=on_event,
            stderr_path=stderr_path if spec.capture_stderr else None,
        )
        try:
            await session.start()
            await session.set_auto_retry(True)
            await asyncio.wait_for(
                self._consume(
                    session,
                    prompt,
                    result,
                    on_session_file=on_session_file,
                    stop_event=stop_event,
                ),
                timeout=spec.task_timeout_s,
            )
        except asyncio.TimeoutError:
            result.error = f"task timeout after {spec.task_timeout_s}s"
            await self._best_effort_state(session, result)
            session.kill()
        except asyncio.CancelledError:
            result.error = "cancelled"
            session.kill()
            raise
        except PiRpcError as exc:
            result.error = str(exc)
            await self._best_effort_state(session, result)
        except Exception as exc:  # noqa: BLE001
            result.error = f"provider error: {exc}"
            await self._best_effort_state(session, result)
        finally:
            await session.shutdown()
            result.ended_at = _now_iso()
        return result

    async def _consume(
        self,
        session: PiRpcSession,
        prompt: str,
        result: PiRunResult,
        on_session_file: SessionFileCallback = None,
        stop_event: asyncio.Event | None = None,
    ) -> None:
        # First get_state secures sessionFile even if the task later hangs.
        await self._best_effort_state(session, result)
        if on_session_file is not None and result.session_file:
            try:
                on_session_file(result.session_file)
            except Exception:  # noqa: BLE001
                pass  # The observer must not block the agent path.
        if stop_event is None:
            await session.run_prompt(prompt)
        else:
            await self._run_prompt_with_stop(session, prompt, result, stop_event)
        await self._best_effort_state(session, result)
        await session.abort()

    async def _run_prompt_with_stop(
        self,
        session: PiRpcSession,
        prompt: str,
        result: PiRunResult,
        stop_event: asyncio.Event,
    ) -> None:
        """Race run_prompt against the runtime's stop signal in step mode.

        The runtime sets ``stop_event`` once its on-disk turns poll reaches max_turns.
        On that signal we abort pi cleanly and mark ``step_limit_hit`` — no error set,
        so the runtime short-circuits the retry path and judges the partial session.
        """
        prompt_task = asyncio.create_task(session.run_prompt(prompt))
        stop_task = asyncio.create_task(stop_event.wait())
        done, _ = await asyncio.wait(
            {prompt_task, stop_task}, return_when=asyncio.FIRST_COMPLETED
        )
        if prompt_task in done:
            stop_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await stop_task
            await prompt_task  # surface any PiRpcError raised by run_prompt
            return
        # step limit reached: stop the agent cleanly, then drop run_prompt
        result.step_limit_hit = True
        await session.abort()
        prompt_task.cancel()
        # CancelledError derives from BaseException (not Exception) on 3.8+; list it
        # explicitly alongside Exception so the cancelled prompt is fully swallowed.
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await prompt_task

    async def _best_effort_state(self, session: PiRpcSession, result: PiRunResult) -> None:
        try:
            # bounded: a hung pi must not let the post-timeout refresh stall the run
            state = await asyncio.wait_for(session.get_state(), timeout=5.0)
            if state.get("sessionId"):
                result.session_id = state["sessionId"]
            if state.get("sessionFile"):
                result.session_file = state["sessionFile"]
        except Exception:  # noqa: BLE001
            pass
