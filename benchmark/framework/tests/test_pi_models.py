from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

import wiek_bench.webui.app as webui_app
import wiek_bench.webui.pi_models as pi_models


def test_fetch_injects_isolated_pi_agent_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pi_agent_dir = tmp_path / "agent-home" / ".pi" / "agent"
    captured: dict[str, Any] = {}

    def fake_run(argv: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        captured["argv"] = argv
        captured["env"] = kwargs["env"]
        return subprocess.CompletedProcess(
            argv,
            0,
            stdout=(
                "provider model context max-out thinking images\n"
                "openai-codex gpt-5.6-sol 372K 128K yes yes\n"
            ),
            stderr="",
        )

    monkeypatch.setattr(pi_models.shutil, "which", lambda _binary: "/usr/bin/pi")
    monkeypatch.setattr(pi_models.subprocess, "run", fake_run)

    result = pi_models._fetch("pi", pi_agent_dir)

    assert captured["argv"] == ["pi", "--list-models"]
    assert captured["env"]["PI_CODING_AGENT_DIR"] == str(pi_agent_dir)
    assert result["models"][0]["provider"] == "openai-codex"


def test_pi_models_endpoint_uses_configured_pi_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pi_home = tmp_path / "isolated-home"
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "run": {"output_dir": str(tmp_path / "runs")},
                "providers": {"pi": {"default_home": str(pi_home)}},
            }
        ),
        encoding="utf-8",
    )
    captured: dict[str, Any] = {}

    def fake_list(pi_bin: str, pi_agent_dir: Path) -> dict[str, Any]:
        captured["pi_bin"] = pi_bin
        captured["pi_agent_dir"] = pi_agent_dir
        return {"models": [], "error": None}

    monkeypatch.delenv("PI_HOME", raising=False)
    monkeypatch.setattr(webui_app, "list_pi_models", fake_list)
    app = webui_app.create_app(str(config_path))
    endpoint = next(route.endpoint for route in app.routes if route.path == "/api/pi/models")

    result = endpoint()

    assert result == {"models": [], "error": None}
    assert captured == {
        "pi_bin": "pi",
        "pi_agent_dir": pi_home / ".pi" / "agent",
    }


def test_model_cache_is_scoped_to_pi_agent_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = tmp_path / "first" / ".pi" / "agent"
    second = tmp_path / "second" / ".pi" / "agent"
    calls: list[Path] = []

    def fake_fetch(pi_bin: str, pi_agent_dir: Path) -> dict[str, Any]:
        del pi_bin
        calls.append(pi_agent_dir)
        return {"models": [{"provider": pi_agent_dir.parent.parent.name}], "error": None}

    monkeypatch.setattr(pi_models, "_fetch", fake_fetch)
    pi_models._cache.update({"at": 0.0, "key": None, "result": None})

    first_result = pi_models.list_pi_models("pi", first)
    cached_result = pi_models.list_pi_models("pi", first)
    second_result = pi_models.list_pi_models("pi", second)

    assert first_result == cached_result
    assert first_result != second_result
    assert calls == [first, second]
