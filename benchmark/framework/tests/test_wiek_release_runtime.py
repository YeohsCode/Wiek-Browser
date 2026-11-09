from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest

import run_eval
from wiek_bench import wiek_release
from wiek_bench.config import WiekBrowserConfig
from run_eval import historical_runtime_mismatch


def _config(tmp_path: Path) -> WiekBrowserConfig:
    return WiekBrowserConfig(
        cache_dir=str(tmp_path / "cache"),
        debug_symlink=str(tmp_path / "Citro Labs" / "debug" / "index.js"),
        skill_symlink=str(tmp_path / "agent-home" / "skills" / "wiek-browser"),
    )


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_stage_a_shared_lease_blocks_activate(tmp_path: Path) -> None:
    cfg = _config(tmp_path)

    with wiek_release.stage_a_runtime_lease(cfg):
        with wiek_release.stage_a_runtime_lease(cfg):
            pass
        with pytest.raises(RuntimeError, match="runtime 正被另一个进程占用"):
            wiek_release.activate(cfg, "v1")
        with pytest.raises(RuntimeError, match="runtime 正被另一个进程占用"):
            wiek_release.activate_external(cfg, tmp_path / "dev" / "index.js")


def test_status_payload_lists_five_cached_versions_in_descending_order(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    tags = [
        "1.2",
        "v1.2.1-beta.1",
        "v1.2.3-beta.5",
        "v1.2.5-beta.1",
        "v1.2.5",
        "v1.10.0",
    ]
    cache = Path(cfg.cache_dir)
    for tag in tags:
        release_dir = cache / tag
        release_dir.mkdir(parents=True)
        (release_dir / "index.js").write_text(tag, encoding="utf-8")

    active_tag = "v1.2.3-beta.5"
    link = Path(cfg.debug_symlink)
    link.parent.mkdir(parents=True)
    os.symlink(cache / active_tag / "index.js", link)

    payload = wiek_release.status_payload(cfg)

    assert [item["tag"] for item in payload["cached_releases"]] == [
        "v1.10.0",
        "v1.2.5",
        "v1.2.5-beta.1",
        "v1.2.3-beta.5",
        "v1.2.1-beta.1",
    ]
    assert payload["active"]["active_tag"] == active_tag
    assert [item["tag"] for item in payload["cached_releases"] if item["active"]] == [active_tag]


def test_status_payload_reports_external_dev_path(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    dev_index = tmp_path / "wiek-browser" / "dist" / "out" / "index.js"
    dev_index.parent.mkdir(parents=True)
    dev_index.write_text("dev", encoding="utf-8")
    link = Path(cfg.debug_symlink)
    link.parent.mkdir(parents=True)
    os.symlink(dev_index, link)

    payload = wiek_release.status_payload(cfg)

    assert payload["active"]["source"] == "external"
    assert payload["active"]["external_target"] == str(dev_index.resolve())
    assert payload["cached_releases"] == []


def test_activate_external_relinks_runtime_and_paired_skill(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    dev_out = tmp_path / "wiek-browser" / "dist" / "out"
    dev_out.mkdir(parents=True)
    dev_index = dev_out / "index.js"
    dev_index.write_text("dev", encoding="utf-8")
    dev_skill = dev_out / "wiek-browser"
    dev_skill.mkdir()
    (dev_skill / "SKILL.md").write_text("---\nname: wiek-browser\n---\n", encoding="utf-8")
    Path(cfg.debug_symlink).parent.parent.mkdir(parents=True)

    active = wiek_release.activate_external(cfg, dev_index)

    runtime_link = Path(cfg.debug_symlink)
    skill_link = Path(cfg.skill_symlink)
    assert runtime_link.is_symlink()
    assert runtime_link.resolve() == dev_index.resolve()
    assert skill_link.is_symlink()
    assert skill_link.resolve() == dev_skill.resolve()
    assert active["source"] == "external"
    assert active["external_target"] == str(dev_index.resolve())
    assert (Path(cfg.cache_dir) / ".external_origin").read_text(encoding="utf-8") == str(
        dev_index.resolve()
    )


def test_runtime_snapshot_detects_content_and_realpath_drift(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    first = tmp_path / "first" / "index.js"
    first.parent.mkdir(parents=True)
    first.write_text("first", encoding="utf-8")
    link = Path(cfg.debug_symlink)
    link.parent.mkdir(parents=True)
    os.symlink(first, link)
    snapshot = {
        "index_js_realpath": str(first.resolve()),
        "index_js_sha256": _sha256(first),
    }

    wiek_release.assert_runtime_snapshot(cfg, snapshot)

    first.write_text("changed", encoding="utf-8")
    with pytest.raises(wiek_release.RuntimeDriftError, match="sha256 drifted"):
        wiek_release.assert_runtime_snapshot(cfg, snapshot)

    first.write_text("first", encoding="utf-8")
    second = tmp_path / "second" / "index.js"
    second.parent.mkdir(parents=True)
    second.write_text("first", encoding="utf-8")
    link.unlink()
    os.symlink(second, link)
    with pytest.raises(wiek_release.RuntimeDriftError, match="realpath drifted"):
        wiek_release.assert_runtime_snapshot(cfg, snapshot)


def test_historical_runtime_match_accepts_old_metadata_and_rejects_drift() -> None:
    current = {
        "index_js_sha256": "same-sha",
        "runtime_contract": "legacy-flat-v1",
    }

    assert (
        historical_runtime_mismatch(
            {"wiek_browser_release": {"index_js_sha256": "same-sha"}},
            current,
        )
        is None
    )
    assert "sha256 differs" in (
        historical_runtime_mismatch(
            {"wiek_browser_release": {"index_js_sha256": "other-sha"}},
            current,
        )
        or ""
    )
    assert "contract differs" in (
        historical_runtime_mismatch(
            {
                "wiek_browser_release": {
                    "index_js_sha256": "same-sha",
                    "runtime_contract": "taskspaces-facade-v1",
                }
            },
            current,
        )
        or ""
    )


def test_runtime_mismatch_is_opt_in_and_refused_by_default() -> None:
    """A mismatch stops Stage A unless the caller has already answered for it — the WebUI
    forwards the user's confirmation as this flag."""
    parser = run_eval.build_parser()

    assert parser.parse_args([]).allow_runtime_mismatch is False
    assert parser.parse_args(["--allow-runtime-mismatch"]).allow_runtime_mismatch is True


def test_historical_runtime_match_skips_contract_when_current_is_unprobed() -> None:
    """The WebUI preflight compares an un-probed snapshot, which carries no contract.
    A known previous contract must not be read as drift against that unknown."""
    unprobed = {"index_js_sha256": "same-sha"}

    assert (
        historical_runtime_mismatch(
            {
                "wiek_browser_release": {
                    "index_js_sha256": "same-sha",
                    "runtime_contract": "taskspaces-facade-v1",
                }
            },
            unprobed,
        )
        is None
    )
