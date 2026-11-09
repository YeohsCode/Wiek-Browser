"""HarnessConfig: the single pydantic model for harness behaviour.

Precedence is **CLI args > config.yaml > code defaults**. ``load_config``
merges ``config.yaml`` over the model defaults; CLI entrypoints mutate fields
afterwards (models are mutable). Every field has a code default so the harness
runs without a config.yaml.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field, model_validator

from wiek_bench.adhoc import adhoc_rubric_mode, normalize_adhoc_node

ThinkingLevel = Literal["off", "minimal", "low", "medium", "high", "xhigh", "max"]
# Codex publishes this model-by-model through ``AsyncCodex.models()``. Keep the
# persisted config forward-compatible; the installed SDK remains the runtime validator.
ReasoningEffort = str
BrowserToolMode = Literal["strict", "loose", "off"]
ToolProfile = Literal["full", "readonly", "readonly_bash"]

# A named tool profile expands to a --tools list in one place instead of listing
# tool names for every run. ``allowed_tools`` remains a per-item escape hatch.
# ``full`` drives the browser and reads/writes local files; ``readonly``
# is read-only inspection with no bash (cannot drive a browser CLI); ``readonly_bash``
# is the agent-mode judge profile — read-only inspection + bash (run jq/python over the
# session JSONL) but no write/edit, so it still cannot drive a browser CLI.
TOOL_PROFILES: dict[str, list[str]] = {
    "full": ["read", "write", "edit", "bash"],
    "readonly": ["read", "grep", "find", "ls"],
    "readonly_bash": ["read", "grep", "find", "ls", "bash"],
}


def resolve_tools(profile: str, allowed_tools: list[str] | None) -> list[str]:
    """Resolve the effective --tools list: explicit override wins, else the profile."""
    if allowed_tools is not None:
        return list(allowed_tools)
    if profile not in TOOL_PROFILES:
        raise ValueError(f"unknown tool_profile: {profile}. known: {', '.join(TOOL_PROFILES)}")
    return list(TOOL_PROFILES[profile])


class RunConfig(BaseModel):
    benchmark: str = "real-world-bench"
    provider: Literal["pi", "codex"] = "pi"
    browser_tool: str = "wiek-browser"
    browser_tool_mode: BrowserToolMode = "strict"
    output_dir: str = "runs"
    # ge=1: concurrency<1 has no meaning — 0/negative would silently fall to the serial
    # path (`concurrency >= 2` false) instead of erroring; fail-loud at config validation.
    concurrency: int = Field(default=1, ge=1)
    concurrency_max_safe: int = 10
    iterations: int = 1
    resume: bool = True
    # Retry errors or empty final output, for at most three attempts per task.
    retry_count: int = 2
    show_progress: bool = True
    auto_judge: bool = True
    auto_export_sessions: bool = True


class SamplingConfig(BaseModel):
    task_ids: list[str] | None = None


class AdhocConfig(BaseModel):
    """Dataset-less ad-hoc bypass.

    ``tasks`` is the canonical Odysseys-shaped batch snapshot. ``task`` remains a
    read-only compatibility input for old configs and run metadata; validation
    normalises it to one rubric-less entry.
    """

    tasks: list[dict[str, Any]] | None = None
    task: str | None = None


class LimitsConfig(BaseModel):
    """Choose exactly one per-task limit with ``mode``.

    - ``mode="time"`` (default): ``task_timeout_seconds`` is the wall-clock
      limit; a timeout is a retryable failure.
    - ``mode="steps"``: ``max_turns`` stops the agent cleanly at the turn
      boundary without retrying, then sends the attempt to the judge.
      ``step_mode_backstop_seconds`` prevents an indefinitely stuck agent that
      has stopped producing turns.

    An explicit mode is safer than mutually exclusive ``None`` values because
    ``load_config`` merges YAML over defaults. A YAML file that specifies only
    one limit would otherwise appear to have configured both. The inactive
    field may retain its default without taking effect.
    """

    mode: Literal["time", "steps"] = "time"
    task_timeout_seconds: float = 600.0
    max_turns: int = 100
    step_mode_backstop_seconds: float = 3600.0

    @model_validator(mode="after")
    def _active_limit_positive(self) -> "LimitsConfig":
        if self.mode == "time" and self.task_timeout_seconds <= 0:
            raise ValueError("limits: mode=time 下 task_timeout_seconds 必须 > 0")
        if self.mode == "steps":
            if self.max_turns < 1:
                raise ValueError("limits: mode=steps 下 max_turns 必须 >= 1")
            if self.step_mode_backstop_seconds <= 0:
                raise ValueError("limits: step_mode_backstop_seconds 必须 > 0")
        return self


class JudgeRpcConfig(BaseModel):
    timeout_s: float = 180.0
    # Agent-mode judges need a larger budget for multiple read/bash turns.
    agent_timeout_s: float = 900.0
    startup_timeout_s: float = 60.0


class JudgeConfig(BaseModel):
    provider: Literal["pi"] = "pi"
    model: str = "openai-codex/gpt-5.4"  # pi provider/id form; must be multimodal
    thinking_level: ThinkingLevel = "low"
    # ``single`` is one tool-free turn. ``agent`` is the default agentic path
    # with readonly+bash tools and the wiek-bench-judge skill. Judges whose
    # ``supports_agent_mode`` is false fall back to ``single``.
    mode: Literal["single", "agent"] = "agent"
    # Agent-mode tool set. ``allowed_tools`` overrides the declared profile.
    tool_profile: ToolProfile = "readonly_bash"
    allowed_tools: list[str] | None = None
    # Agent mode loads exactly this judge skill.
    skill_name: str = "wiek-bench-judge"
    # ge=1 for the same reason as RunConfig.concurrency, with a worse failure mode:
    # judge_run builds asyncio.Semaphore(concurrency), and 0 hangs Stage B forever
    # because no coroutine can ever release the permit it never got.
    concurrency: int = Field(default=8, ge=1)
    image_concurrency: int = Field(default=4, ge=1)
    retry_max: int = 3
    rejudge: bool = False
    # Maximum screenshots visible to the judge; ``None`` means all. Storage is
    # independent: frames always retain every deduplicated screenshot.
    max_screenshots: int | None = None
    score_threshold: int = 3
    rpc: JudgeRpcConfig = Field(default_factory=JudgeRpcConfig)

    def resolved_agent_tools(self) -> list[str]:
        return resolve_tools(self.tool_profile, self.allowed_tools)


class PiDebugConfig(BaseModel):
    capture_stderr: bool = False
    dump_event: bool = False


class PiRpcConfig(BaseModel):
    startup_timeout_s: float = 60.0


class PiProviderConfig(BaseModel):
    home_env: str = "PI_HOME"
    default_home: str = "./agent-home"
    bin_env: str = "PI_BIN"
    bin_default: str = "pi"
    provider: str = "openai-codex"  # pi-internal provider name
    model: str = "gpt-5.5"
    thinking_level: ThinkingLevel = "medium"
    # Named tool profile. ``allowed_tools`` is the per-item override.
    tool_profile: ToolProfile = "full"
    allowed_tools: list[str] | None = None
    rpc: PiRpcConfig = Field(default_factory=PiRpcConfig)
    debug: PiDebugConfig = Field(default_factory=PiDebugConfig)

    def resolved_tools(self) -> list[str]:
        return resolve_tools(self.tool_profile, self.allowed_tools)

    def resolved_home(self) -> Path:
        """Resolve PI_HOME: ``home_env`` env var wins, else ``default_home``."""
        home = os.environ.get(self.home_env) or self.default_home
        return Path(home).resolve()


class CodexProviderConfig(BaseModel):
    codex_home: str = "agent-home/.codex"
    bin_env: str = "CODEX_BIN"
    # None resolves PATH "codex" first, then falls back to the SDK-pinned bundle.
    bin_default: str | None = None
    model: str = "gpt-5.5"
    reasoning_effort: ReasoningEffort = "medium"
    service_tier: str | None = None

    def resolved_home(self) -> Path:
        return Path(self.codex_home).resolve()


class ProvidersConfig(BaseModel):
    pi: PiProviderConfig = Field(default_factory=PiProviderConfig)
    codex: CodexProviderConfig = Field(default_factory=CodexProviderConfig)


class BrowserToolConfig(BaseModel):
    bin_env: str
    bin_default: str
    skill_name: str


def _default_browser_tools() -> dict[str, BrowserToolConfig]:
    """Built-in browser tools. Integrating another one adds an entry here plus a
    matching implementation registered in ``wiek_bench.browser_tools``."""
    return {
        "wiek-browser": BrowserToolConfig(
            bin_env="WIEK_BROWSER_BIN", bin_default="wiek-browser", skill_name="wiek-browser"
        ),
    }


class SkillsConfig(BaseModel):
    dir: str | None = None


class ScreenshotsConfig(BaseModel):
    # Captures are deduplicated incrementally into frames/ without a raw staging
    # directory. All unique frames remain on disk; judge visibility is capped
    # separately by ``judge.max_screenshots``.
    dedup_method: str = "sha256"
    capture_mode: str = "cdp"
    command_timeout_seconds: float = 20.0


class WebuiConfig(BaseModel):
    enabled: bool = True
    host: str = "127.0.0.1"
    port: int = 8365
    downloads_dir: str | None = None
    frontend_dist: str | None = None


class WiekBrowserConfig(BaseModel):
    """wiek-browser release management.

    The measured surface is the in-browser ``index.js`` runtime loaded by wiek
    lite through the debug override symlink. It is independent of the
    ``wiek-browser`` CLI on PATH. Every field has a default, so normal operation
    requires no additional configuration.
    """

    repo: str = "YeohsCode/Wiek-Browser"
    cache_dir: str = "wiek-browser-releases"
    debug_symlink: str = "~/Library/Application Support/Wiek Browser/runtime/index.js"
    # The agent skill symlink is atomically relinked with index.js to the
    # sibling wiek-browser/ directory shared by release and development builds.
    skill_symlink: str = "agent-home/.pi/agent/skills/wiek-browser"
    releases_limit: int = 6  # Latest plus the five most recent releases.


class PromptsConfig(BaseModel):
    # jinja2 template name → prompts/task/<name>.j2 (default ships with the package),
    # or an absolute/relative .j2 path override.
    task_template: str = "default"


class HarnessConfig(BaseModel):
    run: RunConfig = Field(default_factory=RunConfig)
    sampling: SamplingConfig = Field(default_factory=SamplingConfig)
    adhoc: AdhocConfig = Field(default_factory=AdhocConfig)
    limits: LimitsConfig = Field(default_factory=LimitsConfig)
    judge: JudgeConfig = Field(default_factory=JudgeConfig)
    providers: ProvidersConfig = Field(default_factory=ProvidersConfig)
    browser_tools: dict[str, BrowserToolConfig] = Field(default_factory=_default_browser_tools)
    skills: SkillsConfig = Field(default_factory=SkillsConfig)
    screenshots: ScreenshotsConfig = Field(default_factory=ScreenshotsConfig)
    webui: WebuiConfig = Field(default_factory=WebuiConfig)
    wiek_browser: WiekBrowserConfig = Field(default_factory=WiekBrowserConfig)
    prompts: PromptsConfig = Field(default_factory=PromptsConfig)

    @model_validator(mode="after")
    def _normalise_adhoc_contract(self) -> "HarnessConfig":
        entries = normalize_adhoc_node(self.adhoc.model_dump())
        if not entries:
            return self

        # The dataset default remains on. Ad-hoc is deliberately opt-in: direct
        # model construction without an explicit run.auto_judge gets the mode default.
        if "auto_judge" not in self.run.model_fields_set:
            self.run.auto_judge = False
        if self.run.auto_judge and adhoc_rubric_mode(entries) != "all":
            raise ValueError(
                "adhoc Judge requires every task to have non-empty rubrics; "
                "text and rubric-less batches must keep run.auto_judge=false"
            )

        # One canonical internal representation: legacy input is accepted only at
        # the boundary and never propagated into new snapshots.
        self.adhoc.tasks = entries
        self.adhoc.task = None
        return self

    def browser_tool_cfg(self, name: str) -> BrowserToolConfig:
        if name not in self.browser_tools:
            raise ValueError(f"unknown browser_tool: {name}")
        return self.browser_tools[name]


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in override.items():
        if key in out and isinstance(out[key], dict) and isinstance(value, dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def load_config(path: str | os.PathLike[str] | None = None) -> HarnessConfig:
    """Load config.yaml (if present) merged over code defaults.

    ``path=None`` looks for ``config.yaml`` in the current working directory.
    """
    config_path = Path(path) if path is not None else Path("config.yaml")
    if not config_path.exists():
        return HarnessConfig()
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict):
        raise ValueError(f"config file {config_path} must be a YAML mapping")
    # ``RunConfig.auto_judge`` defaults on for datasets. A config-selected ad-hoc
    # source gets its own default before the full-default merge makes every field
    # look explicit to pydantic. An explicit YAML value is never overwritten.
    raw_adhoc = raw.get("adhoc")
    if isinstance(raw_adhoc, dict):
        raw_tasks = raw_adhoc.get("tasks")
        raw_task = raw_adhoc.get("task")
        has_adhoc = raw_tasks is not None or (
            isinstance(raw_task, str) and bool(raw_task.strip())
        )
        if has_adhoc:
            raw_run = raw.get("run")
            if isinstance(raw_run, dict) and "auto_judge" in raw_run:
                pass
            else:
                raw = dict(raw)
                raw["run"] = {
                    **(raw_run if isinstance(raw_run, dict) else {}),
                    "auto_judge": False,
                }
    # Merge file over the default-model dump so partial files keep defaults.
    merged = _deep_merge(HarnessConfig().model_dump(), raw)
    return HarnessConfig.model_validate(merged)
