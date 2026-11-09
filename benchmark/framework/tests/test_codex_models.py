from __future__ import annotations

import asyncio
import sys
from enum import Enum
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Literal

from pydantic import BaseModel, ValidationError

import wiek_bench.providers.codex_sdk as codex_sdk
from wiek_bench.providers.codex_sdk import (
    build_codex_config_overrides,
    resolve_codex_runtime,
)
from wiek_bench.webui import codex_models


class _Effort(Enum):
    low = "low"
    high = "high"


def _catalog_response() -> SimpleNamespace:
    model = SimpleNamespace(
        id="preset-gpt-5.4",
        model="gpt-5.4",
        display_name="GPT-5.4",
        description="Strong model",
        is_default=True,
        default_reasoning_effort=_Effort.low,
        supported_reasoning_efforts=[
            SimpleNamespace(reasoning_effort=_Effort.low, description="Fast"),
            SimpleNamespace(reasoning_effort=_Effort.high, description="Deep"),
        ],
        service_tiers=[
            SimpleNamespace(id="priority", name="Fast", description="1.5x speed")
        ],
        default_service_tier=None,
    )
    return SimpleNamespace(data=[model])


def test_list_codex_models_uses_isolated_public_sdk_and_cache(
    monkeypatch: Any, tmp_path: Path
) -> None:
    codex_models._cache.clear()
    codex_models._inflight.clear()
    captured: dict[str, Any] = {"calls": 0}

    class FakeAsyncCodex:
        def __init__(self, config: Any) -> None:
            captured["config"] = config

        async def __aenter__(self) -> "FakeAsyncCodex":
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def models(self, *, include_hidden: bool = False) -> SimpleNamespace:
            captured["calls"] += 1
            captured["include_hidden"] = include_hidden
            await asyncio.sleep(0.01)
            return _catalog_response()

    monkeypatch.setattr(codex_models, "AsyncCodex", FakeAsyncCodex)
    path_codex = tmp_path / "path-codex"
    path_codex.write_text("binary", encoding="utf-8")
    monkeypatch.setattr(
        codex_sdk.shutil,
        "which",
        lambda name: str(path_codex) if name == "codex" else None,
    )
    home = tmp_path / ".codex"
    home.mkdir()
    (home / "config.toml").write_text("", encoding="utf-8")

    async def load_models() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        first, second = await asyncio.gather(
            codex_models.list_codex_models(
                None, home, real_home="/Users/test"
            ),
            codex_models.list_codex_models(
                None, home, real_home="/Users/test"
            ),
        )
        cached = await codex_models.list_codex_models(
            None, home, real_home="/Users/test"
        )
        return first, second, cached

    first, second, cached = asyncio.run(load_models())

    assert first == second
    assert second == cached
    assert first["error"] is None
    assert first["models"][0]["model"] == "gpt-5.4"
    assert first["models"][0]["service_tiers"][0]["id"] == "priority"
    assert captured["calls"] == 1
    assert captured["include_hidden"] is False
    config = captured["config"]
    assert config.codex_bin == str(path_codex.resolve())
    assert next(iter(codex_models._cache))[0] == resolve_codex_runtime(None).executable
    assert config.cwd == str(home.resolve() / "workspace")
    assert config.env == {
        "CODEX_HOME": str(home.resolve()),
        "HOME": str(home.resolve() / "isolated-home"),
    }
    assert config.config_overrides == build_codex_config_overrides("/Users/test")


def test_list_codex_models_degrades_on_sdk_schema_mismatch(
    monkeypatch: Any, tmp_path: Path
) -> None:
    codex_models._cache.clear()
    codex_models._inflight.clear()

    class _TypedEffort(BaseModel):
        effort: Literal["low"]

    try:
        _TypedEffort.model_validate({"effort": "ultra"})
    except ValidationError as exc:
        validation_error = exc
    else:  # pragma: no cover - pydantic must reject the invalid literal
        raise AssertionError("expected a validation error")

    class FailingAsyncCodex:
        def __init__(self, _config: Any) -> None:
            pass

        async def __aenter__(self) -> "FailingAsyncCodex":
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def models(self, *, include_hidden: bool = False) -> SimpleNamespace:
            del include_hidden
            raise validation_error

    monkeypatch.setattr(codex_models, "AsyncCodex", FailingAsyncCodex)
    home = tmp_path / ".codex"
    home.mkdir()
    (home / "config.toml").write_text("", encoding="utf-8")
    result = asyncio.run(
        codex_models.list_codex_models(
            sys.executable,
            home,
            real_home="/Users/test",
        )
    )

    assert result["models"] == []
    assert result["error"] is not None
    assert "schema mismatch" in result["error"]


def test_cancelled_catalog_waiter_does_not_cancel_shared_fetch(
    monkeypatch: Any, tmp_path: Path
) -> None:
    codex_models._cache.clear()
    codex_models._inflight.clear()
    calls = 0

    class SlowAsyncCodex:
        def __init__(self, _config: Any) -> None:
            pass

        async def __aenter__(self) -> "SlowAsyncCodex":
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def models(self, *, include_hidden: bool = False) -> SimpleNamespace:
            nonlocal calls
            del include_hidden
            calls += 1
            await asyncio.sleep(0.05)
            return _catalog_response()

    monkeypatch.setattr(codex_models, "AsyncCodex", SlowAsyncCodex)
    home = tmp_path / ".codex"
    home.mkdir()
    (home / "config.toml").write_text("", encoding="utf-8")

    async def load_with_cancel() -> dict[str, Any]:
        first = asyncio.create_task(
            codex_models.list_codex_models(
                sys.executable, home, real_home="/Users/test"
            )
        )
        second = asyncio.create_task(
            codex_models.list_codex_models(
                sys.executable, home, real_home="/Users/test"
            )
        )
        await asyncio.sleep(0.01)
        first.cancel()
        try:
            await first
        except asyncio.CancelledError:
            pass
        return await second

    result = asyncio.run(load_with_cancel())

    assert result["error"] is None
    assert calls == 1
    assert codex_models._inflight == {}
    assert len(codex_models._cache) == 1


def test_list_codex_models_does_not_cache_failures(
    monkeypatch: Any, tmp_path: Path
) -> None:
    codex_models._cache.clear()
    codex_models._inflight.clear()
    calls = {"n": 0}

    class FlakyAsyncCodex:
        def __init__(self, _config: Any) -> None:
            pass

        async def __aenter__(self) -> "FlakyAsyncCodex":
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def models(self, *, include_hidden: bool = False) -> SimpleNamespace:
            del include_hidden
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("transient app-server hiccup")
            await asyncio.sleep(0.01)
            return _catalog_response()

    monkeypatch.setattr(codex_models, "AsyncCodex", FlakyAsyncCodex)
    home = tmp_path / ".codex"
    home.mkdir()
    (home / "config.toml").write_text("", encoding="utf-8")

    async def run() -> tuple[dict[str, Any], int, dict[str, Any], int, dict[str, Any]]:
        failed = await codex_models.list_codex_models(None, home, real_home="/Users/test")
        cache_after_failure = len(codex_models._cache)
        # The failure is not cached, so the very next request re-fetches and heals.
        healed = await codex_models.list_codex_models(None, home, real_home="/Users/test")
        cache_after_heal = len(codex_models._cache)
        # The healed catalog IS cached, so a third request within TTL serves from cache.
        cached = await codex_models.list_codex_models(None, home, real_home="/Users/test")
        return failed, cache_after_failure, healed, cache_after_heal, cached

    failed, cache_after_failure, healed, cache_after_heal, cached = asyncio.run(run())

    assert failed["error"] is not None
    assert failed["models"] == []
    assert cache_after_failure == 0  # planted violation: caching the failure fails here
    assert healed["error"] is None
    assert healed["models"][0]["model"] == "gpt-5.4"
    assert cache_after_heal == 1
    assert cached == healed
    # 1 failed + 1 healed fetch; the third call is served from cache, not re-fetched.
    assert calls["n"] == 2


def test_missing_codex_config_does_not_create_home(tmp_path: Path) -> None:
    codex_models._cache.clear()
    codex_models._inflight.clear()
    home = tmp_path / "partial-home"

    result = asyncio.run(
        codex_models.list_codex_models(
            sys.executable,
            home,
            real_home="/Users/test",
        )
    )

    assert result["models"] == []
    assert "config not found" in str(result["error"])
    assert not home.exists()
