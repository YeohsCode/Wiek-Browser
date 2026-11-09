from __future__ import annotations

import json
import tomllib
from pathlib import Path

from wiek_bench import __version__
from wiek_bench.webui.app import create_app


ROOT = Path(__file__).resolve().parents[1]
PYTHON_BETA_VERSION = "0.1.0b1"
SEMVER_BETA_VERSION = "0.1.0-beta.1"


def test_public_beta_version_is_consistent_across_release_surfaces() -> None:
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    frontend = json.loads((ROOT / "frontend/package.json").read_text(encoding="utf-8"))

    assert project["project"]["version"] == PYTHON_BETA_VERSION
    assert __version__ == PYTHON_BETA_VERSION
    assert create_app().version == PYTHON_BETA_VERSION
    assert frontend["version"] == SEMVER_BETA_VERSION

    for readme in ("README.md", "README.zh-CN.md"):
        text = (ROOT / readme).read_text(encoding="utf-8")
        assert f"Framework version: {SEMVER_BETA_VERSION}" in text
        assert "https://github.com/YeohsCode/Wiek-Browser" in text
