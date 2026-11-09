from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from wiek_bench.config import (
    HarnessConfig,
    LimitsConfig,
    load_config,
    resolve_tools,
)


def test_resolve_tools_returns_independent_profile_copy() -> None:
    first = resolve_tools("readonly", None)
    first.append("bash")

    assert resolve_tools("readonly", None) == ["read", "grep", "find", "ls"]


def test_resolve_tools_prefers_explicit_override() -> None:
    override = ["read", "bash"]

    resolved = resolve_tools("unknown-profile", override)
    override.append("write")

    assert resolved == ["read", "bash"]


def test_resolve_tools_rejects_unknown_profile() -> None:
    with pytest.raises(ValueError, match="unknown tool_profile"):
        resolve_tools("unknown-profile", None)


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"mode": "time", "task_timeout_seconds": 0}, "task_timeout_seconds"),
        ({"mode": "steps", "max_turns": 0}, "max_turns"),
        ({"mode": "steps", "step_mode_backstop_seconds": 0}, "step_mode_backstop_seconds"),
    ],
)
def test_limits_reject_non_positive_active_values(payload: dict[str, object], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        LimitsConfig.model_validate(payload)


def test_inactive_limit_may_remain_non_positive() -> None:
    limits = LimitsConfig(mode="time", task_timeout_seconds=10, max_turns=0)

    assert limits.max_turns == 0


def test_load_config_deep_merges_partial_sections(tmp_path: Path) -> None:
    path = tmp_path / "config.yaml"
    path.write_text(
        "\n".join(
            [
                "run:",
                "  concurrency: 3",
                "providers:",
                "  pi:",
                "    model: test-model",
            ]
        ),
        encoding="utf-8",
    )

    config = load_config(path)

    assert config.run.concurrency == 3
    assert config.run.browser_tool == HarnessConfig().run.browser_tool
    assert config.providers.pi.model == "test-model"
    assert config.providers.pi.rpc.startup_timeout_s == HarnessConfig().providers.pi.rpc.startup_timeout_s


def test_load_config_rejects_non_mapping_root(tmp_path: Path) -> None:
    path = tmp_path / "config.yaml"
    path.write_text("- not\n- a\n- mapping\n", encoding="utf-8")

    with pytest.raises(ValueError, match="must be a YAML mapping"):
        load_config(path)


def test_browser_tool_lookup_fails_loudly() -> None:
    with pytest.raises(ValueError, match="unknown browser_tool"):
        HarnessConfig().browser_tool_cfg("missing")


@pytest.mark.parametrize("field", ["concurrency", "image_concurrency"])
def test_judge_concurrency_rejects_zero(tmp_path: Path, field: str) -> None:
    """0 built an asyncio.Semaphore nothing could ever release, hanging Stage B for good.
    A config error at load time beats a run that looks alive and never finishes."""
    path = tmp_path / "config.yaml"
    path.write_text(f"judge:\n  {field}: 0\n", encoding="utf-8")

    with pytest.raises(ValidationError, match="greater than or equal to 1"):
        load_config(path)
