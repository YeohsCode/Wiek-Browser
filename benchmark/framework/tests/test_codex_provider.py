from __future__ import annotations

import asyncio
import json
import shutil
import tomllib
from pathlib import Path
from typing import Any

import pytest
from openai_codex import TextInput

import wiek_bench.providers.codex_sdk as codex_sdk
import run_eval
from wiek_bench.config import HarnessConfig, load_config
from wiek_bench.providers.codex_sdk import (
    CODEX_BASE_URL_ENV,
    CODEX_PROJECT_MARKER,
    CodexAgentSpec,
    CodexProvider,
    _unwrap_shell_command,
    build_codex_config_overrides,
    prepare_codex_home,
    resolve_codex_runtime,
    validate_codex_reasoning_effort,
    verify_codex_context_isolation,
)


def _write_skill(root: Path, name: str) -> Path:
    skill_dir = root / name
    skill_dir.mkdir(parents=True)
    skill_file = skill_dir / "SKILL.md"
    skill_file.write_text(
        f"---\nname: {name}\ndescription: Test skill\n---\n\n# {name}\n",
        encoding="utf-8",
    )
    return skill_file


def test_prepare_codex_home_keeps_only_selected_skill(tmp_path: Path) -> None:
    home = tmp_path / ".codex"
    home.mkdir()
    source_config = Path(__file__).parents[1] / "agent-home" / ".codex" / "config.toml"
    shutil.copy2(source_config, home / "config.toml")
    skills = tmp_path / "source-skills"
    first = _write_skill(skills, "first")
    second = _write_skill(skills, "second")

    prepare_codex_home(home, first)
    installed = prepare_codex_home(home, second)

    assert installed == home / "skills" / "second" / "SKILL.md"
    assert [path.name for path in (home / "skills").iterdir()] == ["second"]


def test_codex_config_uses_effective_web_search_disable() -> None:
    overrides = build_codex_config_overrides("/tmp/real-home")

    assert 'web_search="disabled"' in overrides
    assert "features.web_search=false" not in overrides


def test_codex_base_url_override_is_opt_in(monkeypatch: pytest.MonkeyPatch) -> None:
    """A public checkout keeps the default endpoint; .env opts into a gateway."""
    monkeypatch.delenv(CODEX_BASE_URL_ENV, raising=False)
    assert not [entry for entry in build_codex_config_overrides("/tmp/h") if "base_url" in entry]

    monkeypatch.setenv(CODEX_BASE_URL_ENV, "https://gateway.example.com/v1")
    overrides = build_codex_config_overrides("/tmp/h")

    assert 'openai_base_url="https://gateway.example.com/v1"' in overrides


def test_codex_home_pins_isolation_policy_without_local_state() -> None:
    """The tracked Codex home carries policy only — no endpoint, no trust entries."""
    config_path = Path(__file__).parents[1] / "agent-home" / ".codex" / "config.toml"
    config = tomllib.loads(config_path.read_text(encoding="utf-8"))

    assert config["project_doc_max_bytes"] == 0
    assert config["web_search"] == "disabled"
    assert "openai_base_url" not in config
    assert "projects" not in config


def test_codex_provider_code_and_repository_defaults() -> None:
    assert HarnessConfig().providers.codex.model == "gpt-5.5"
    config_path = Path(__file__).parents[1] / "config.yaml"
    assert load_config(config_path).providers.codex.model == "gpt-5.6-sol"


def test_resolve_codex_runtime_defaults_to_sdk_bundle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundled = tmp_path / "bundled-codex"
    bundled.write_text("binary", encoding="utf-8")
    monkeypatch.setattr(codex_sdk, "bundled_codex_path", lambda: bundled)
    monkeypatch.setattr(codex_sdk.shutil, "which", lambda _name: None)

    runtime = resolve_codex_runtime(None)

    assert runtime.sdk_bin is None
    assert runtime.executable == str(bundled.resolve())


def test_resolve_codex_runtime_prefers_path_codex_to_sdk_bundle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path_codex = tmp_path / "path-codex"
    path_codex.write_text("binary", encoding="utf-8")
    bundled = tmp_path / "bundled-codex"
    bundled.write_text("binary", encoding="utf-8")
    monkeypatch.setattr(codex_sdk, "bundled_codex_path", lambda: bundled)
    monkeypatch.setattr(
        codex_sdk.shutil,
        "which",
        lambda name: str(path_codex) if name == "codex" else None,
    )

    runtime = resolve_codex_runtime(None)

    effective = str(path_codex.resolve())
    assert runtime.sdk_bin == effective
    assert runtime.executable == effective


def test_resolve_codex_runtime_preserves_explicit_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    override = tmp_path / "external-codex"
    override.write_text("binary", encoding="utf-8")
    path_codex = tmp_path / "path-codex"
    path_codex.write_text("binary", encoding="utf-8")
    monkeypatch.setattr(
        codex_sdk.shutil,
        "which",
        lambda name: (
            str(override)
            if name == str(override)
            else str(path_codex) if name == "codex" else None
        ),
    )

    runtime = resolve_codex_runtime(str(override))

    assert runtime.sdk_bin == str(override.resolve())
    assert runtime.executable == str(override.resolve())


def test_validate_codex_reasoning_effort_uses_installed_sdk_enum() -> None:
    validate_codex_reasoning_effort("medium")

    with pytest.raises(ValueError, match="Unsupported Codex reasoning effort 'medum'"):
        validate_codex_reasoning_effort("medum")


@pytest.mark.parametrize("web_search_line", ("", 'web_search = "cached"'))
def test_prepare_codex_home_rejects_non_disabled_web_search(
    tmp_path: Path, web_search_line: str
) -> None:
    home = tmp_path / ".codex"
    home.mkdir()
    source_config = Path(__file__).parents[1] / "agent-home" / ".codex" / "config.toml"
    config_text = source_config.read_text(encoding="utf-8").replace(
        'web_search = "disabled"', web_search_line, 1
    )
    (home / "config.toml").write_text(config_text, encoding="utf-8")
    skill = _write_skill(tmp_path / "source-skills", "only-skill")

    with pytest.raises(ValueError, match='web_search="disabled"'):
        prepare_codex_home(home, skill)


def test_codex_prompt_contains_only_managed_skill(tmp_path: Path) -> None:
    codex_bin = resolve_codex_runtime(None).executable
    home = tmp_path / ".codex"
    home.mkdir()
    source_config = Path(__file__).parents[1] / "agent-home" / ".codex" / "config.toml"
    shutil.copy2(source_config, home / "config.toml")
    skill = _write_skill(tmp_path / "source-skills", "only-skill")
    prepare_codex_home(home, skill)
    workdir = home / "workspace"
    (workdir / CODEX_PROJECT_MARKER).write_text("managed root\n", encoding="utf-8")

    verify_codex_context_isolation(
        codex_bin=codex_bin,
        codex_home=home,
        workdir=workdir,
        real_home=str(Path.home()),
        expected_skill_name="only-skill",
    )


@pytest.mark.parametrize("path_available", [False, True])
def test_prepare_provider_uses_one_resolved_runtime_for_sdk_probe_and_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, path_available: bool
) -> None:
    monkeypatch.delenv("CODEX_BIN", raising=False)
    path_codex = tmp_path / "path-codex"
    path_codex.write_text("binary", encoding="utf-8")
    bundled = tmp_path / "bundled-codex"
    bundled.write_text("binary", encoding="utf-8")
    monkeypatch.setattr(codex_sdk, "bundled_codex_path", lambda: bundled)
    monkeypatch.setattr(
        codex_sdk.shutil,
        "which",
        lambda name: str(path_codex) if path_available and name == "codex" else None,
    )
    cfg = HarnessConfig()
    cfg.run.provider = "codex"
    cfg.run.browser_tool_mode = "off"
    home = tmp_path / ".codex"
    home.mkdir()
    source_config = Path(__file__).parents[1] / "agent-home" / ".codex" / "config.toml"
    shutil.copy2(source_config, home / "config.toml")
    cfg.providers.codex.codex_home = str(home)
    cfg.providers.codex.bin_default = None
    skill = _write_skill(tmp_path / "source-skills", "only-skill")
    probed: dict[str, Any] = {}

    def capture_probe(**kwargs: Any) -> None:
        probed.update(kwargs)

    monkeypatch.setattr(run_eval, "verify_codex_context_isolation", capture_probe)
    setup = run_eval._prepare_provider(
        cfg,
        pi_bin="pi",
        pi_agent_dir=tmp_path / "pi-agent",
        skill_path=skill,
        python_exe="python3",
    )
    runtime = resolve_codex_runtime(None)

    assert isinstance(setup.provider, CodexProvider)
    assert setup.provider.spec.codex_bin == runtime.sdk_bin
    assert probed["codex_bin"] == runtime.executable
    assert setup.codex_bin == runtime.executable


def test_prepare_provider_applies_explicit_runtime_to_sdk_probe_and_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    override = tmp_path / "codex-override"
    override.write_text("binary", encoding="utf-8")
    monkeypatch.setenv("CODEX_BIN", str(override))
    cfg = HarnessConfig()
    cfg.run.provider = "codex"
    cfg.run.browser_tool_mode = "off"
    home = tmp_path / ".codex"
    home.mkdir()
    source_config = Path(__file__).parents[1] / "agent-home" / ".codex" / "config.toml"
    shutil.copy2(source_config, home / "config.toml")
    cfg.providers.codex.codex_home = str(home)
    skill = _write_skill(tmp_path / "source-skills", "only-skill")
    probed: dict[str, Any] = {}
    monkeypatch.setattr(
        run_eval,
        "verify_codex_context_isolation",
        lambda **kwargs: probed.update(kwargs),
    )

    setup = run_eval._prepare_provider(
        cfg,
        pi_bin="pi",
        pi_agent_dir=tmp_path / "pi-agent",
        skill_path=skill,
        python_exe="python3",
    )
    effective = str(override.resolve())

    assert isinstance(setup.provider, CodexProvider)
    assert setup.provider.spec.codex_bin == effective
    assert probed["codex_bin"] == effective
    assert setup.codex_bin == effective


@pytest.mark.parametrize("mode", ["strict", "loose"])
def test_prepare_provider_rejects_guard_modes_before_home_setup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: str
) -> None:
    cfg = HarnessConfig()
    cfg.run.provider = "codex"
    cfg.run.browser_tool_mode = mode
    monkeypatch.setattr(
        run_eval,
        "prepare_codex_home",
        lambda *_args, **_kwargs: pytest.fail("home setup must not run"),
    )

    with pytest.raises(ValueError, match='browser_tool_mode="off"'):
        run_eval._prepare_provider(
            cfg,
            pi_bin="pi",
            pi_agent_dir=tmp_path / "pi-agent",
            skill_path=tmp_path / "missing-skill.md",
            python_exe="python3",
        )


def test_prepare_provider_rejects_invalid_effort_before_home_setup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = HarnessConfig()
    cfg.run.provider = "codex"
    cfg.run.browser_tool_mode = "off"
    cfg.providers.codex.reasoning_effort = "medum"
    monkeypatch.setattr(
        run_eval,
        "prepare_codex_home",
        lambda *_args, **_kwargs: pytest.fail("home setup must not run"),
    )

    with pytest.raises(ValueError, match="Unsupported Codex reasoning effort 'medum'"):
        run_eval._prepare_provider(
            cfg,
            pi_bin="pi",
            pi_agent_dir=tmp_path / "pi-agent",
            skill_path=tmp_path / "missing-skill.md",
            python_exe="python3",
        )


def test_unwrap_shell_command_exposes_codex_script_body() -> None:
    wrapped = (
        "/bin/zsh -lc \"wiek-browser --taskspace=task-1 nodejs <<'EOF'\n"
        "console.log('ok')\nEOF\""
    )

    assert _unwrap_shell_command(wrapped) == (
        "wiek-browser --taskspace=task-1 nodejs <<'EOF'\nconsole.log('ok')\nEOF"
    )
    assert _unwrap_shell_command("printf ok") == "printf ok"


def test_codex_provider_writes_context_audit_in_finally(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = tmp_path / "rollout.jsonl"
    entries = [
        {
            "type": "session_meta",
            "payload": {
                "id": "thread-1",
                "cwd": "/tmp/work",
                "base_instructions": {"text": "BASE"},
            },
        },
        {
            "type": "turn_context",
            "payload": {
                "cwd": "/tmp/work",
                "model": "gpt-5.4",
                "approval_policy": "never",
                "sandbox_policy": {"type": "danger-full-access"},
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "developer",
                "content": [
                    {
                        "type": "input_text",
                        "text": "- only-skill: Test (file: /tmp/only-skill/SKILL.md)",
                    }
                ],
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "task prompt"}],
            },
        },
        {"type": "event_msg", "payload": {"type": "task_complete"}},
    ]
    session.write_text(
        "".join(json.dumps(entry) + "\n" for entry in entries), encoding="utf-8"
    )
    audit_path = tmp_path / "system_prompt" / "task-1.json"
    spec = CodexAgentSpec(
        codex_bin="codex",
        codex_home=str(tmp_path / ".codex"),
        model="gpt-5.4",
        reasoning_effort="medium",
        skill_name="only-skill",
        skill_path="/tmp/only-skill/SKILL.md",
        task_timeout_s=1.0,
        python_exe="python3",
        real_home="/tmp/home",
    )
    provider = CodexProvider(spec)

    async def fake_execute(**kwargs: Any) -> None:
        result = kwargs["result"]
        result.session_id = "thread-1"
        result.session_file = str(session)

    monkeypatch.setattr(provider, "_execute", fake_execute)
    result = asyncio.run(
        provider.run(
            task_id="task-1",
            prompt="task prompt",
            cwd=tmp_path,
            env={"WIEK_BENCH_SYSPROMPT_PATH": str(audit_path)},
        )
    )

    payload = json.loads(audit_path.read_text(encoding="utf-8"))
    assert result.error is None
    assert payload["systemPrompt"] == "BASE"
    assert payload["isolation"]["status"] == "passed"
    assert payload["loadedSkills"] == []
    assert payload["skillDelivery"]["mode"] == "progressive_disclosure"
    assert payload["skillDelivery"]["preloaded"] is False
    assert payload["launchConfiguration"]["clientSandbox"] == "full_access"
    assert payload["launchConfiguration"]["webSearchMode"] == "disabled"


def test_codex_provider_sends_only_task_text_to_turn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    turn_inputs: list[Any] = []
    configs: list[Any] = []
    state = {"turn_started": False}
    session = tmp_path / "session-after-turn.jsonl"
    observed: list[str] = []

    class FakeTurn:
        async def stream(self) -> Any:
            if False:
                yield None

    class FakeThread:
        id = "thread-1"

        async def turn(self, inputs: list[Any], **kwargs: Any) -> FakeTurn:
            del kwargs
            state["turn_started"] = True
            turn_inputs.extend(inputs)
            return FakeTurn()

    class FakeCodex:
        async def thread_start(self, **kwargs: Any) -> FakeThread:
            del kwargs
            return FakeThread()

    class FakeAsyncCodex:
        def __init__(self, config: Any) -> None:
            configs.append(config)

        async def __aenter__(self) -> FakeCodex:
            return FakeCodex()

        async def __aexit__(self, *args: Any) -> None:
            del args

    async def find_session_after_turn(
        codex_home: Path, thread_id: str, timeout_s: float = 5.0
    ) -> Path | None:
        del codex_home, thread_id, timeout_s
        return session if state["turn_started"] else None

    monkeypatch.setattr(codex_sdk, "AsyncCodex", FakeAsyncCodex)
    monkeypatch.setattr(codex_sdk, "_wait_for_session_file", find_session_after_turn)
    spec = CodexAgentSpec(
        codex_bin=None,
        codex_home=str(tmp_path / ".codex"),
        model="gpt-5.4",
        reasoning_effort="medium",
        skill_name="only-skill",
        skill_path="/tmp/only-skill/SKILL.md",
        task_timeout_s=1.0,
        python_exe="python3",
        real_home="/tmp/home",
    )
    provider = CodexProvider(spec)

    result = asyncio.run(
        provider.run(
            task_id="task-1",
            prompt="task prompt",
            cwd=tmp_path,
            env={},
            on_session_file=observed.append,
        )
    )

    assert result.error is None
    assert len(turn_inputs) == 1
    assert isinstance(turn_inputs[0], TextInput)
    assert turn_inputs[0].text == "task prompt"
    assert configs[0].codex_bin is None
    assert result.session_file == str(session)
    assert observed == [str(session)]


@pytest.mark.parametrize("location, root_kind, succeeds", [
    ("r0/only-skill/SKILL.md", "managed", True),
    ("r0/only-skill/SKILL.md", "outside", False),
    ("r0/../escaped/SKILL.md", "managed", False),
    ("r9/only-skill/SKILL.md", "managed", False),
])
def test_context_skill_aliases_preserve_managed_home_boundary(tmp_path, monkeypatch, location, root_kind, succeeds):
    from types import SimpleNamespace
    home = tmp_path / "managed-home"
    root = home / "skills" if root_kind == "managed" else tmp_path / "outside"
    block = (
        "<skills_instructions>\n### Skill roots\n"
        f"- `r0` = `{root}`\n### Available skills\n"
        f"- only-skill: Test skill (file: {location})\n</skills_instructions>"
    )
    monkeypatch.setattr(codex_sdk.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout=json.dumps({"instructions": block}), stderr=""))
    def verify():
        verify_codex_context_isolation(codex_bin="fixture", codex_home=home, workdir=tmp_path, real_home=str(tmp_path / "real-home"), expected_skill_name="only-skill")
    if succeeds:
        verify()
    else:
        with pytest.raises(RuntimeError, match="outside managed home|unknown skill root"):
            verify()
