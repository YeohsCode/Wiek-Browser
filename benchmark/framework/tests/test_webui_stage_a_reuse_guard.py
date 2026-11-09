"""Re-executing Stage A (rerun / resume) must put the wiek-browser runtime question to the
user before spawning — refusing its own request when the active runtime is no longer the one
the run was recorded against, and passing the acceptance on when they confirm. A subprocess
that dies anyway must not read as "done"."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from wiek_bench.webui import runner as runner_mod
from wiek_bench.webui.runner import RunHandle, RunManager, RuntimeMismatchError

PREVIOUS_SHA = "sha-of-the-runtime-this-run-used"
CURRENT_SHA = "sha-of-the-runtime-installed-now"


@pytest.fixture
def manager(tmp_path: Path) -> RunManager:
    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    config = tmp_path / "config.yaml"
    config.write_text(f"run:\n  output_dir: {runs_dir}\n", encoding="utf-8")
    return RunManager(config_path=str(config))


def _seed_run(manager: RunManager, run_id: str = "fixture-run") -> Path:
    """A finished wiek-browser run with one task on disk."""
    run_dir = manager.output_dir() / run_id
    run_dir.mkdir(parents=True)
    (run_dir / "run_metadata.json").write_text(
        json.dumps(
            {
                "run_id": run_id,
                "benchmark": "real-world-bench",
                "browser_tool": "wiek-browser",
                "provider": "pi",
                "model": "fixture-model",
                "completed_at": "2026-07-26T06:14:48+00:00",
                "wiek_browser_release": {"index_js_sha256": PREVIOUS_SHA},
            }
        ),
        encoding="utf-8",
    )
    (run_dir / "tasks.jsonl").write_text(
        json.dumps({"task_id": "task-1", "base_task_id": "task-1", "error": None}) + "\n",
        encoding="utf-8",
    )
    return run_dir


def _pin_active_runtime(monkeypatch: pytest.MonkeyPatch, sha: str) -> None:
    monkeypatch.setattr(
        runner_mod.wiek_release,
        "run_metadata_entry",
        lambda _cfg: {"index_js_sha256": sha},
    )


def test_reuse_check_reports_the_changed_runtime(
    manager: RunManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    _pin_active_runtime(monkeypatch, CURRENT_SHA)
    meta = json.loads((_seed_run(manager) / "run_metadata.json").read_text(encoding="utf-8"))

    with pytest.raises(RuntimeMismatchError) as exc:
        manager._assert_wiek_runtime_reusable(meta, accepted=False)

    assert PREVIOUS_SHA in str(exc.value) and CURRENT_SHA in str(exc.value)


def test_reuse_check_passes_when_accepted_or_irrelevant(
    manager: RunManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    _pin_active_runtime(monkeypatch, PREVIOUS_SHA)
    meta = json.loads((_seed_run(manager) / "run_metadata.json").read_text(encoding="utf-8"))

    manager._assert_wiek_runtime_reusable(meta, accepted=False)

    _pin_active_runtime(monkeypatch, CURRENT_SHA)
    # The user's answer, and a run driven by another tool, both settle it.
    manager._assert_wiek_runtime_reusable(meta, accepted=True)
    manager._assert_wiek_runtime_reusable({**meta, "browser_tool": "playwright"}, accepted=False)


def test_rerun_asks_before_spawning_on_a_changed_runtime(
    manager: RunManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_run(manager)
    _pin_active_runtime(monkeypatch, CURRENT_SHA)
    spawned: list[Any] = []
    monkeypatch.setattr(manager, "_spawn_action", lambda *a, **k: spawned.append(k))

    with pytest.raises(RuntimeMismatchError, match="sha256 differs"):
        manager.rerun("fixture-run", task_ids=["task-1"], errors=False, new_run=False)

    assert spawned == [], "the request must fail before anything is launched"


def test_rerun_asks_for_a_derived_run_too(
    manager: RunManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    """_derive_copy carries the base metadata over, so deriving is pinned to the same
    original runtime — it is not an escape hatch from the question."""
    _seed_run(manager)
    _pin_active_runtime(monkeypatch, CURRENT_SHA)
    monkeypatch.setattr(manager, "_spawn_action", lambda *a, **k: "derived")

    with pytest.raises(RuntimeMismatchError, match="sha256 differs"):
        manager.rerun("fixture-run", task_ids=["task-1"], errors=False, new_run=True)


def test_rerun_passes_an_accepted_mismatch_to_the_subprocess(
    manager: RunManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Accepting in the console is only half of it: run_eval enforces the same rule, so it
    has to be told, or the spawned run dies in its own preflight exactly as before."""
    _seed_run(manager)
    _pin_active_runtime(monkeypatch, CURRENT_SHA)
    spawned: list[dict[str, Any]] = []
    monkeypatch.setattr(
        manager, "_spawn_action", lambda *a, **k: spawned.append(k) or "fixture-run"
    )

    manager.rerun(
        "fixture-run",
        task_ids=["task-1"],
        errors=False,
        new_run=False,
        allow_runtime_mismatch=True,
    )

    assert "--allow-runtime-mismatch" in spawned[0]["argv_action"]


def test_progress_reports_a_dead_subprocess_over_a_stale_completed_at(
    manager: RunManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A rerun that dies in its own preflight never rewrites run_metadata, so the previous
    leg's completed_at is still on disk. The exit code has to win."""
    run_dir = _seed_run(manager)

    class DeadProc:
        def poll(self) -> int:
            return 2

    manager.handles["fixture-run"] = RunHandle(
        run_id="fixture-run",
        proc=DeadProc(),  # type: ignore[arg-type]
        log_path=run_dir / "spawn.log",
        run_dir=run_dir,
        config_path=run_dir / "config.yaml",
    )

    assert manager.progress("fixture-run")["status"] == "error"
