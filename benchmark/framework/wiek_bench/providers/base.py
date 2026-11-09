"""Common Stage A provider contract.

Providers own their transport and session lifecycle. The runtime only consumes
session locators plus control-flow state; all derived metrics stay session-driven.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

AgentEventCallback = Callable[[dict[str, Any]], None] | None
SessionFileCallback = Callable[[str], None] | None


@dataclass
class AgentRunResult:
    task_id: str
    session_id: str | None = None
    session_file: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    error: str | None = None
    step_limit_hit: bool = False


class AgentProvider(Protocol):
    name: str

    async def run(
        self,
        *,
        task_id: str,
        prompt: str,
        cwd: str | Path,
        env: dict[str, str],
        on_event: AgentEventCallback = None,
        on_session_file: SessionFileCallback = None,
        stderr_path: str | Path | None = None,
        stop_event: asyncio.Event | None = None,
    ) -> AgentRunResult: ...
