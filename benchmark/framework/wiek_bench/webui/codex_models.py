"""Codex SDK model catalog for the WebUI provider controls."""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import Any

from loguru import logger
from openai_codex import AsyncCodex, CodexConfig
from pydantic import ValidationError

from wiek_bench.providers.codex_sdk import (
    build_codex_config_overrides,
    resolve_codex_runtime,
)

_CACHE_TTL_S = 300.0
_cache: dict[tuple[str, str, str], tuple[float, dict[str, Any]]] = {}
_inflight: dict[tuple[str, str, str], asyncio.Task[dict[str, Any]]] = {}


def _clear_inflight(
    key: tuple[str, str, str], task: asyncio.Task[dict[str, Any]]
) -> None:
    if _inflight.get(key) is task:
        _inflight.pop(key, None)


def _enum_value(value: Any) -> str:
    raw = getattr(value, "value", value)
    return str(raw)


def _serialize_model(model: Any) -> dict[str, Any]:
    return {
        "id": str(model.id),
        "model": str(model.model),
        "display_name": str(model.display_name),
        "description": str(model.description),
        "is_default": bool(model.is_default),
        "default_reasoning_effort": _enum_value(model.default_reasoning_effort),
        "supported_reasoning_efforts": [
            {
                "reasoning_effort": _enum_value(option.reasoning_effort),
                "description": str(option.description),
            }
            for option in model.supported_reasoning_efforts
        ],
        "service_tiers": [
            {
                "id": str(tier.id),
                "name": str(tier.name),
                "description": str(tier.description),
            }
            for tier in (model.service_tiers or [])
        ],
        "default_service_tier": getattr(model, "default_service_tier", None),
    }


def _failure(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, ValidationError):
        error = (
            "openai-codex SDK cannot parse this Codex CLI model/list response "
            "(schema mismatch)"
        )
    else:
        detail = " ".join(str(exc).split())[:400]
        error = f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__
    logger.warning("Codex model discovery failed: {}", exc)
    return {"models": [], "error": error}


async def _fetch(
    *,
    codex_bin: str | None,
    codex_home: Path,
    real_home: str,
) -> dict[str, Any]:
    isolated_home = codex_home / "isolated-home"
    workspace = codex_home / "workspace"
    isolated_home.mkdir(parents=True, exist_ok=True)
    workspace.mkdir(parents=True, exist_ok=True)
    config = CodexConfig(
        codex_bin=codex_bin,
        cwd=str(workspace),
        env={"CODEX_HOME": str(codex_home), "HOME": str(isolated_home)},
        config_overrides=build_codex_config_overrides(real_home),
    )
    try:
        async with AsyncCodex(config) as codex:
            response = await codex.models(include_hidden=False)
        models = [_serialize_model(model) for model in response.data]
    except Exception as exc:  # noqa: BLE001 - discovery failures degrade to free input
        return _failure(exc)
    return {"models": models, "error": None}


async def list_codex_models(
    codex_bin: str | None,
    codex_home: str | Path,
    *,
    real_home: str | None = None,
) -> dict[str, Any]:
    """Return the isolated Codex model catalog; only successful results are cached
    process-locally for 300s, so a transient failure self-heals on the next request."""
    home = Path(codex_home).resolve()
    host_home = real_home or os.environ.get("HOME") or str(Path.home())
    try:
        runtime = resolve_codex_runtime(codex_bin)
    except FileNotFoundError as exc:
        result = {"models": [], "error": str(exc)}
        logger.warning("{}", result["error"])
        return result
    key = (runtime.executable, str(home), host_home)
    now = time.monotonic()
    cached = _cache.get(key)
    if cached is not None and now - cached[0] < _CACHE_TTL_S:
        return cached[1]

    if not (home / "config.toml").is_file():
        result = {"models": [], "error": f"Codex config not found: {home / 'config.toml'}"}
        logger.warning("{}", result["error"])
        return result

    task = _inflight.get(key)
    if task is None:
        task = asyncio.create_task(
            _fetch(codex_bin=runtime.sdk_bin, codex_home=home, real_home=host_home)
        )
        _inflight[key] = task
        task.add_done_callback(
            lambda completed, cache_key=key: _clear_inflight(cache_key, completed)
        )
    result = await asyncio.shield(task)
    # Cache successful catalogs only: a transient failure ({"error": ...}) is a
    # transport status, not a projection of the catalog, so pinning it for the full
    # TTL would keep the dropdown broken for 5 min after the fault clears.
    if result.get("error") is None:
        _cache[key] = (now, result)
    return result
