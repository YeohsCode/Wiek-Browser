from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

from fastapi import FastAPI

import wiek_bench.webui.app as webui_app


RunListEndpoint = Callable[[], list[dict[str, Any]]]


def _endpoint(app: FastAPI, path: str) -> RunListEndpoint:
    for route in app.routes:
        if getattr(route, "path", None) == path:
            return cast(RunListEndpoint, route.endpoint)
    raise AssertionError(f"route not found: {path}")


def _write_run(
    output_dir: Path,
    run_id: str,
    *,
    derived_from: str | None = None,
    started_at: str = "2026-07-16T00:00:00+00:00",
) -> Path:
    run_dir = output_dir / run_id
    run_dir.mkdir(parents=True)
    metadata: dict[str, Any] = {
        "run_id": run_id,
        "benchmark": "fixture",
        "started_at": started_at,
        "completed_at": "2026-07-16T00:00:00+00:00",
    }
    if derived_from is not None:
        metadata["derived_from"] = derived_from
    (run_dir / "run_metadata.json").write_text(
        json.dumps(metadata),
        encoding="utf-8",
    )
    sessions_dir = run_dir / "sessions_html"
    sessions_dir.mkdir()
    artifact = sessions_dir / "task.html"
    artifact.write_text("<html></html>", encoding="utf-8")
    return artifact


def test_run_and_artifact_endpoints_expose_persisted_parent_relation(tmp_path: Path) -> None:
    output_dir = tmp_path / "runs"
    parent_id = "20260716_parent"
    child_id = f"{parent_id}_rejudge_selected"
    orphan_id = "20260716_orphan_rejudge_selected"
    _write_run(output_dir, parent_id)
    _write_run(output_dir, child_id, derived_from=parent_id)
    _write_run(output_dir, orphan_id, derived_from="deleted_parent")

    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps({"run": {"output_dir": str(output_dir)}}),
        encoding="utf-8",
    )
    app = webui_app.create_app(str(config_path))

    for path in ("/api/runs", "/api/artifacts"):
        by_id = {item["run_id"]: item for item in _endpoint(app, path)()}
        assert by_id[parent_id]["derived_from"] is None
        assert by_id[child_id]["derived_from"] == parent_id
        assert by_id[orphan_id]["derived_from"] == "deleted_parent"


def test_run_and_artifact_endpoints_share_manual_note(tmp_path: Path) -> None:
    output_dir = tmp_path / "runs"
    artifact = _write_run(output_dir, "noted-run")
    (artifact.parent.parent / "note.md").write_text("same note", encoding="utf-8")

    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps({"run": {"output_dir": str(output_dir)}}),
        encoding="utf-8",
    )
    app = webui_app.create_app(str(config_path))

    for path in ("/api/runs", "/api/artifacts"):
        [item] = _endpoint(app, path)()
        assert item["note"] == "same note"


def test_artifacts_sort_by_run_start_not_latest_artifact_mtime(tmp_path: Path) -> None:
    output_dir = tmp_path / "runs"
    older_artifact = _write_run(
        output_dir,
        "older-run",
        started_at="2026-07-15T00:00:00+00:00",
    )
    newer_artifact = _write_run(
        output_dir,
        "newer-run",
        started_at="2026-07-16T00:00:00+00:00",
    )
    os.utime(older_artifact, (2_000_000_000, 2_000_000_000))
    os.utime(newer_artifact, (1_000_000_000, 1_000_000_000))

    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps({"run": {"output_dir": str(output_dir)}}),
        encoding="utf-8",
    )
    app = webui_app.create_app(str(config_path))

    artifacts = _endpoint(app, "/api/artifacts")()
    assert [item["run_id"] for item in artifacts] == ["newer-run", "older-run"]
