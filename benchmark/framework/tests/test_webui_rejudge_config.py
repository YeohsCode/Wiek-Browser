from __future__ import annotations

import json
from pathlib import Path

from wiek_bench.webui.runner import RunManager


def test_in_place_rejudge_accepts_model_and_mode_overrides(tmp_path: Path) -> None:
    manager = RunManager(config_path=str(tmp_path / "missing.yaml"))
    merged = manager._build_action_config(
        {"judge_model": "provider/old", "judge_mode": "agent"},
        kind="rejudge",
        concurrency=3,
        model="provider/new",
        judge_mode="single",
        new_run=False,
    )

    assert merged["judge"]["model"] == "provider/new"
    assert merged["judge"]["mode"] == "single"
    assert merged["judge"]["concurrency"] == 3


def test_in_place_rerun_keeps_agent_model_frozen(tmp_path: Path) -> None:
    manager = RunManager(config_path=str(tmp_path / "missing.yaml"))
    merged = manager._build_action_config(
        {"model": "old-agent"},
        kind="rerun",
        concurrency=None,
        model="new-agent",
        new_run=False,
    )

    assert merged["providers"]["pi"]["model"] == "old-agent"


def test_in_place_rejudge_persists_latest_default(tmp_path: Path) -> None:
    manager = RunManager(config_path=str(tmp_path / "missing.yaml"))
    meta_path = tmp_path / "run_metadata.json"
    meta_path.write_text(
        json.dumps({"run_id": "sample", "judge_model": "provider/old", "judge_mode": "agent"}),
        encoding="utf-8",
    )

    manager._patch_in_place_rejudge_meta(
        tmp_path, judge_model="provider/new", judge_mode="single"
    )

    updated = json.loads(meta_path.read_text(encoding="utf-8"))
    assert updated == {
        "run_id": "sample",
        "judge_model": "provider/new",
        "judge_mode": "single",
    }
