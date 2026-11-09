"""Convert ``pi --list-models`` into structured entries for WebUI dropdowns.

pi has no machine-readable list output, so we parse its aligned text table.
Rows are whitespace-tokenized (provider / model / context / max-out / thinking /
images — none of the values contain spaces), which survives column-width drift;
a header mismatch means real format drift and degrades to an error. All failure
modes return ``{"models": [], "error": ...}`` so the form falls back to free-text
input and run creation is never blocked.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

_EXPECTED_HEADER = ["provider", "model", "context", "max-out", "thinking", "images"]
_CACHE_TTL_S = 300.0
_cache: dict[str, Any] = {"at": 0.0, "key": None, "result": None}


def _parse_table(text: str) -> tuple[list[dict[str, Any]], str | None]:
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return [], "empty output"
    header = lines[0].split()
    if header != _EXPECTED_HEADER:
        return [], f"unexpected header: {lines[0].strip()[:120]}"
    models: list[dict[str, Any]] = []
    for ln in lines[1:]:
        fields = ln.split()
        if len(fields) != len(_EXPECTED_HEADER):
            continue  # malformed row — skip, don't fail the whole list
        provider, model, context, max_out, thinking, images = fields
        models.append(
            {
                "provider": provider,
                "model": model,
                "context": context,
                "max_out": max_out,
                "thinking": thinking.lower() == "yes",
                "images": images.lower() == "yes",
            }
        )
    if not models:
        return [], "no model rows parsed"
    return models, None


def _fetch(pi_bin: str, pi_agent_dir: Path) -> dict[str, Any]:
    if shutil.which(pi_bin) is None:
        return {"models": [], "error": f"pi binary not found: {pi_bin}"}
    try:
        env = {**os.environ, "PI_CODING_AGENT_DIR": str(pi_agent_dir)}
        proc = subprocess.run(
            [pi_bin, "--list-models"],
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return {"models": [], "error": "pi --list-models timed out (30s)"}
    if proc.returncode != 0:
        return {
            "models": [],
            "error": f"pi --list-models exited {proc.returncode}: {proc.stderr.strip()[:200]}",
        }
    models, err = _parse_table(proc.stdout)
    return {"models": models, "error": err}


def list_pi_models(pi_bin: str, pi_agent_dir: Path) -> dict[str, Any]:
    """Cached model list (process-local, TTL ~300s); errors are cached too so a
    missing pi binary doesn't spawn a subprocess on every poll."""
    now = time.monotonic()
    key = (pi_bin, str(pi_agent_dir))
    if (
        _cache["key"] == key
        and _cache["result"] is not None
        and now - _cache["at"] < _CACHE_TTL_S
    ):
        return _cache["result"]
    result = _fetch(pi_bin, pi_agent_dir)
    _cache["at"] = now
    _cache["key"] = key
    _cache["result"] = result
    return result
