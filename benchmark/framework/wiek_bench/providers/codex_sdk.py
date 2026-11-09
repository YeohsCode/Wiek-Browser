"""Codex Python SDK Stage A provider."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import shlex
import shutil
import subprocess
import tomllib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from codex_cli_bin import bundled_codex_path
from loguru import logger
from openai_codex import (
    ApprovalMode,
    AsyncCodex,
    CodexConfig,
    Sandbox,
    TextInput,
)
from openai_codex.types import ReasoningEffort

from wiek_bench.browser_tools import get_browser_tool
from wiek_bench.codex_context import write_codex_context_audit
from wiek_bench.providers.base import (
    AgentEventCallback,
    AgentRunResult,
    SessionFileCallback,
)

_REQUIRED_DISABLED_FEATURES = (
    "apps",
    "browser_use",
    "computer_use",
    "connectors",
    "enable_mcp_apps",
    "goals",
    "hooks",
    "image_generation",
    "in_app_browser",
    "memories",
    "memory_tool",
    "multi_agent",
    "plugin_sharing",
    "plugins",
    "remote_plugin",
    "tool_suggest",
    "workspace_dependencies",
)
_REQUIRED_WEB_SEARCH_MODE = "disabled"
CODEX_PROJECT_MARKER = ".wiek-bench-codex-root"
# Optional machine-local gateway, read from .env so the tracked Codex home stays
# free of endpoints that only resolve on one network. Unset means the default
# OpenAI endpoint.
CODEX_BASE_URL_ENV = "CODEX_OPENAI_BASE_URL"
_SUPPORTED_REASONING_EFFORTS = frozenset(effort.value for effort in ReasoningEffort)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_codex_config_overrides(real_home: str) -> tuple[str, ...]:
    """Session-layer invariants that win over any lower Codex config layer."""
    overrides = [
        "project_doc_max_bytes=0",
        f'project_root_markers=["{CODEX_PROJECT_MARKER}"]',
        "include_apps_instructions=false",
        "include_collaboration_mode_instructions=false",
        "skills.bundled.enabled=false",
        "skills.include_instructions=true",
        f'web_search="{_REQUIRED_WEB_SEARCH_MODE}"',
    ]
    overrides.extend(f"features.{name}=false" for name in _REQUIRED_DISABLED_FEATURES)
    overrides.extend(
        (
            "features.unified_exec=true",
            f"shell_environment_policy.set.HOME={json.dumps(real_home)}",
        )
    )
    base_url = os.environ.get(CODEX_BASE_URL_ENV, "").strip()
    if base_url:
        overrides.append(f"openai_base_url={json.dumps(base_url)}")
    return tuple(overrides)


@dataclass(frozen=True)
class CodexRuntime:
    sdk_bin: str | None
    executable: str


def resolve_codex_runtime(bin_override: str | None) -> CodexRuntime:
    """Resolve explicit override, then PATH ``codex``, then the SDK bundle."""
    if bin_override is not None:
        found = shutil.which(bin_override)
        candidate = Path(found) if found is not None else Path(bin_override).expanduser()
        label = f"Codex binary {bin_override!r}"
        sdk_bin = str(candidate.resolve())
    else:
        path_codex = shutil.which("codex")
        if path_codex is not None:
            candidate = Path(path_codex)
            label = "Codex binary found on PATH"
            sdk_bin = str(candidate.resolve())
        else:
            candidate = Path(bundled_codex_path())
            label = "SDK bundled Codex binary"
            sdk_bin = None

    if not candidate.is_file():
        raise FileNotFoundError(f"{label} not found: {candidate}")
    return CodexRuntime(sdk_bin=sdk_bin, executable=str(candidate.resolve()))


def validate_codex_reasoning_effort(value: str) -> None:
    """Fail before task setup when the installed SDK does not support an effort."""
    if value not in _SUPPORTED_REASONING_EFFORTS:
        supported = ", ".join(sorted(_SUPPORTED_REASONING_EFFORTS))
        raise ValueError(
            f"Unsupported Codex reasoning effort {value!r}; expected one of: {supported}"
        )


def validate_codex_home(codex_home: str | Path) -> Path:
    """Validate the managed home without changing its runtime contents."""
    home = Path(codex_home).resolve()
    config_path = home / "config.toml"
    if not config_path.is_file():
        raise FileNotFoundError(f"Codex config not found: {config_path}")
    config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    if config.get("mcp_servers"):
        raise ValueError(f"Codex home must not configure MCP servers: {config_path}")
    if config.get("project_doc_max_bytes") != 0:
        raise ValueError(f"Codex home must set project_doc_max_bytes=0: {config_path}")
    if config.get("web_search") != _REQUIRED_WEB_SEARCH_MODE:
        raise ValueError(
            f'Codex home must set web_search="{_REQUIRED_WEB_SEARCH_MODE}": {config_path}'
        )
    features = config.get("features") or {}
    enabled = [name for name in _REQUIRED_DISABLED_FEATURES if features.get(name) is not False]
    if enabled:
        raise ValueError(f"Codex isolation features must be false: {', '.join(enabled)}")
    skills_cfg = config.get("skills") or {}
    if (skills_cfg.get("bundled") or {}).get("enabled") is not False:
        raise ValueError(f"Codex bundled skills must be disabled: {config_path}")
    return home


def prepare_codex_home(codex_home: str | Path, source_skill_path: str | Path) -> Path:
    """Validate the managed home and install exactly the selected browser skill."""
    home = validate_codex_home(codex_home)

    source_md = Path(source_skill_path).resolve()
    if not source_md.is_file():
        raise FileNotFoundError(f"selected skill not found: {source_md}")
    skills_dir = home / "skills"
    if skills_dir.exists():
        shutil.rmtree(skills_dir)
    skills_dir.mkdir(parents=True)
    target_dir = skills_dir / source_md.parent.name
    shutil.copytree(source_md.parent, target_dir)
    (home / "isolated-home").mkdir(parents=True, exist_ok=True)
    (home / "workspace").mkdir(parents=True, exist_ok=True)
    return target_dir / "SKILL.md"


def verify_codex_context_isolation(
    *,
    codex_bin: str,
    codex_home: str | Path,
    workdir: str | Path,
    real_home: str,
    expected_skill_name: str,
) -> None:
    """Fail before a measured run if Codex's model-visible prompt is contaminated."""
    home = Path(codex_home).resolve()
    isolated_home = home / "isolated-home"
    command = [codex_bin, "-C", str(Path(workdir).resolve())]
    for override in build_codex_config_overrides(real_home):
        command.extend(["--config", override])
    command.extend(["debug", "prompt-input", "context isolation probe"])
    completed = subprocess.run(
        command,
        cwd=workdir,
        env={
            **dict(os.environ),
            "CODEX_HOME": str(home),
            "HOME": str(isolated_home),
        },
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"Codex context probe failed: {detail}")
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Codex context probe returned invalid JSON") from exc

    strings: list[str] = []

    def _collect(value: Any) -> None:
        if isinstance(value, str):
            strings.append(value)
        elif isinstance(value, list):
            for child in value:
                _collect(child)
        elif isinstance(value, dict):
            for child in value.values():
                _collect(child)

    _collect(payload)
    prompt = "\n".join(strings)
    skill_blocks = [value for value in strings if "<skills_instructions>" in value]
    if len(skill_blocks) != 1:
        raise RuntimeError(f"Codex context probe found {len(skill_blocks)} skills blocks")
    found = re.findall(r"(?m)^- ([^:\n]+): .*?\(file: ([^)]+)\)$", skill_blocks[0])
    names = [name for name, _path in found]
    if names != [expected_skill_name]:
        raise RuntimeError(f"Codex context probe expected [{expected_skill_name}], found {names}")
    skill_root = (home / "skills").resolve()
    aliases: dict[str, Path] = {}
    for alias, directory in re.findall(r"(?m)^- `(r[0-9]+)` = `([^`]+)`$", skill_blocks[0]):
        if alias in aliases or not Path(directory).is_absolute():
            raise RuntimeError("Codex context probe has invalid skill root aliases")
        aliases[alias] = Path(directory).resolve()
    for _name, value in found:
        path = Path(value)
        if not path.is_absolute():
            if not path.parts or path.parts[0] not in aliases:
                raise RuntimeError("Codex context probe has an unknown skill root alias")
            path = aliases[path.parts[0]].joinpath(*path.parts[1:])
        path = path.resolve()
        if not path.is_relative_to(skill_root):
            raise RuntimeError(f"Codex context probe exposed skill outside managed home: {path}")
    forbidden = (
        str(Path(real_home) / ".agents" / "skills"),
        "AGENTS.md instructions",
        "<INSTRUCTIONS>",
        "<apps_instructions>",
        "<memory_instructions>",
        "<recommended_plugins>",
    )
    leaked = [marker for marker in forbidden if marker in prompt]
    if leaked:
        raise RuntimeError(f"Codex context probe found forbidden context: {leaked}")


@dataclass
class CodexAgentSpec:
    codex_bin: str | None
    codex_home: str
    model: str
    reasoning_effort: str
    skill_name: str
    skill_path: str
    task_timeout_s: float
    python_exe: str
    real_home: str
    service_tier: str | None = None
    max_turns: int | None = None

    def __post_init__(self) -> None:
        validate_codex_reasoning_effort(self.reasoning_effort)


class CodexProvider:
    name = "codex"

    def __init__(self, spec: CodexAgentSpec) -> None:
        self.spec = spec

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
    ) -> AgentRunResult:
        del stderr_path  # The SDK drains app-server stderr internally.
        result = AgentRunResult(task_id=task_id, started_at=_now_iso())
        try:
            await asyncio.wait_for(
                self._execute(
                    task_id=task_id,
                    prompt=prompt,
                    cwd=Path(cwd),
                    env=env,
                    result=result,
                    on_event=on_event,
                    on_session_file=on_session_file,
                    stop_event=stop_event,
                ),
                timeout=self.spec.task_timeout_s,
            )
        except asyncio.TimeoutError:
            result.error = f"task timeout after {self.spec.task_timeout_s}s"
        except asyncio.CancelledError:
            result.error = "cancelled"
            raise
        except Exception as exc:  # noqa: BLE001
            result.error = f"provider error: {exc}"
        finally:
            if result.session_id and not result.session_file:
                session_file = _find_session_file(Path(self.spec.codex_home), result.session_id)
                if session_file is not None:
                    result.session_file = str(session_file)
            audit_path = env.get("WIEK_BENCH_SYSPROMPT_PATH")
            if audit_path:
                try:
                    if result.error == "cancelled":
                        lifecycle_status = "cancelled"
                    elif result.error and result.error.startswith("task timeout after"):
                        lifecycle_status = "timeout"
                    elif result.error:
                        lifecycle_status = "error"
                    elif result.step_limit_hit:
                        lifecycle_status = "interrupted"
                    else:
                        lifecycle_status = "completed"
                    write_codex_context_audit(
                        audit_path,
                        result.session_file,
                        task_prompt=prompt,
                        expected_skill_name=self.spec.skill_name,
                        expected_skill_path=self.spec.skill_path,
                        config_overrides=build_codex_config_overrides(self.spec.real_home),
                        lifecycle_status=lifecycle_status,
                        lifecycle_error=result.error,
                        launch_configuration={
                            "clientApprovalMode": "deny_all",
                            "clientSandbox": "full_access",
                            "clientModel": self.spec.model,
                            "clientReasoningEffort": self.spec.reasoning_effort,
                            "serviceTier": self.spec.service_tier,
                            "disabledFeatures": list(_REQUIRED_DISABLED_FEATURES),
                            "webSearchMode": _REQUIRED_WEB_SEARCH_MODE,
                            "mcpServersConfigured": False,
                        },
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Codex context audit failed for {}: {}", task_id, exc)
            result.ended_at = _now_iso()
        return result

    async def _execute(
        self,
        *,
        task_id: str,
        prompt: str,
        cwd: Path,
        env: dict[str, str],
        result: AgentRunResult,
        on_event: AgentEventCallback,
        on_session_file: SessionFileCallback,
        stop_event: asyncio.Event | None,
    ) -> None:
        spec = self.spec
        config = CodexConfig(
            codex_bin=spec.codex_bin,
            cwd=str(cwd),
            env=env,
            config_overrides=build_codex_config_overrides(spec.real_home),
        )
        turn: Any | None = None
        async with AsyncCodex(config) as codex:
            developer_instructions = _isolation_fragment(task_id, env)
            thread = await codex.thread_start(
                approval_mode=ApprovalMode.deny_all,
                cwd=str(cwd),
                developer_instructions=developer_instructions or None,
                ephemeral=False,
                model=spec.model,
                sandbox=Sandbox.full_access,
                service_tier=spec.service_tier,
            )
            result.session_id = thread.id
            turn = await thread.turn(
                [TextInput(text=prompt)],
                effort=spec.reasoning_effort,
                service_tier=spec.service_tier,
            )
            consume_task = asyncio.create_task(
                self._consume_turn(turn, env=env, on_event=on_event, result=result)
            )
            stop_task = asyncio.create_task(stop_event.wait()) if stop_event is not None else None
            try:
                # The rollout file is materialized by the started turn, not thread_start.
                # Consume concurrently so app-server events can flow while discovery polls.
                session_file = await _wait_for_session_file(Path(spec.codex_home), thread.id)
                if session_file is not None:
                    result.session_file = str(session_file)
                    _notify_session_file(on_session_file, result.session_file)
                if stop_task is None:
                    await consume_task
                    return
                done, _ = await asyncio.wait(
                    {consume_task, stop_task}, return_when=asyncio.FIRST_COMPLETED
                )
                if consume_task in done:
                    stop_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await stop_task
                    await consume_task
                    return
                result.step_limit_hit = True
                await turn.interrupt()
                with contextlib.suppress(asyncio.TimeoutError, RuntimeError):
                    await asyncio.wait_for(consume_task, timeout=10.0)
            except asyncio.CancelledError:
                if turn is not None:
                    with contextlib.suppress(Exception):
                        await turn.interrupt()
                consume_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await consume_task
                raise
            finally:
                if stop_task is not None and not stop_task.done():
                    stop_task.cancel()

    async def _consume_turn(
        self,
        turn: Any,
        *,
        env: dict[str, str],
        on_event: AgentEventCallback,
        result: AgentRunResult,
    ) -> None:
        async for event in turn.stream():
            if event.method == "item/completed":
                item = event.payload.item
                item = item.root if hasattr(item, "root") else item
                item_type = getattr(item, "type", None)
                if item_type == "commandExecution":
                    command = getattr(item, "command", "")
                    if command:
                        await _capture_after_command(
                            _unwrap_shell_command(command), env, self.spec.python_exe
                        )
                _emit(on_event, {"type": "item_end", "item_type": item_type})
            elif event.method == "thread/tokenUsage/updated":
                _emit(on_event, {"type": "turn_end"})
            elif event.method == "turn/completed":
                turn_payload = event.payload.turn
                status = getattr(turn_payload.status, "value", str(turn_payload.status))
                if status not in {"completed", "interrupted"} and not result.step_limit_hit:
                    error = getattr(turn_payload, "error", None)
                    message = getattr(error, "message", None) if error is not None else None
                    result.error = message or f"Codex turn ended with status {status}"


def _emit(callback: AgentEventCallback, event: dict[str, Any]) -> None:
    if callback is None:
        return
    try:
        callback(event)
    except Exception:  # noqa: BLE001
        pass


def _notify_session_file(callback: SessionFileCallback, path: str) -> None:
    if callback is None:
        return
    try:
        callback(path)
    except Exception:  # noqa: BLE001
        pass


def _isolation_fragment(task_id: str, env: dict[str, str]) -> str:
    mode = env.get("WIEK_BENCH_BROWSER_TOOL_MODE", "strict").lower()
    tool_name = env.get("WIEK_BENCH_BROWSER_TOOL")
    if mode == "off" or not tool_name:
        return ""
    return get_browser_tool(tool_name).inject_fragment(task_id, mode)


def _find_session_file(codex_home: Path, thread_id: str) -> Path | None:
    matches = sorted((codex_home / "sessions").glob(f"**/rollout-*-{thread_id}.jsonl"))
    return matches[-1].resolve() if matches else None


async def _wait_for_session_file(
    codex_home: Path, thread_id: str, timeout_s: float = 5.0
) -> Path | None:
    deadline = asyncio.get_running_loop().time() + timeout_s
    while True:
        path = _find_session_file(codex_home, thread_id)
        if path is not None:
            return path
        if asyncio.get_running_loop().time() >= deadline:
            return None
        await asyncio.sleep(0.05)


async def _capture_after_command(command: str, env: dict[str, str], python_exe: str) -> None:
    process = await asyncio.create_subprocess_exec(
        python_exe,
        "-m",
        "wiek_bench.hooks.pi_extension_helper",
        "screenshot",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        env=env,
    )
    try:
        await asyncio.wait_for(process.communicate(command.encode("utf-8")), timeout=30.0)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()


def _unwrap_shell_command(command: str) -> str:
    """Return the script body from Codex's ``shell -lc <script>`` wrapper."""
    try:
        parts = shlex.split(command)
    except ValueError:
        return command
    if not parts or Path(parts[0]).name not in {"bash", "sh", "zsh"}:
        return command
    for index, part in enumerate(parts[:-1]):
        if part in {"-c", "-ic", "-lc"}:
            return parts[index + 1]
    return command
