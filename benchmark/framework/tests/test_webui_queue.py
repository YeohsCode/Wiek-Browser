"""Serial run queue + external (CLI) run adoption in the WebUI runner."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from wiek_bench import run_liveness
from wiek_bench.webui.runner import RunManager


@pytest.fixture
def manager(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> RunManager:
    """A RunManager whose runs live in tmp and whose launches are recorded, not spawned."""
    runs_dir = tmp_path / "runs"
    runs_dir.mkdir()
    config = tmp_path / "config.yaml"
    config.write_text(f"run:\n  output_dir: {runs_dir}\n", encoding="utf-8")

    mgr = RunManager(config_path=str(config))
    mgr.spawned: list[str] = []  # type: ignore[attr-defined]
    mgr.purges = 0  # type: ignore[attr-defined]

    def fake_spawn(merged: dict[str, Any], run_id: str) -> None:
        mgr.spawned.append(run_id)  # type: ignore[attr-defined]
        (runs_dir / run_id).mkdir(parents=True, exist_ok=True)

    def fake_purge() -> dict[str, Any]:
        mgr.purges += 1  # type: ignore[attr-defined]
        return {"ok": True, "total": 0, "closed": [], "kept": [], "failed": []}

    monkeypatch.setattr(mgr, "_spawn_run", fake_spawn)
    monkeypatch.setattr(mgr, "_preflight_spaces", fake_purge)
    return mgr


def _overrides(benchmark: str = "real-world-bench") -> dict[str, Any]:
    return {"run": {"benchmark": benchmark, "browser_tool": "wiek-browser", "provider": "pi"}}


def test_first_submission_starts_immediately(manager: RunManager) -> None:
    result = manager.start_run(_overrides())

    assert result["queued"] is False
    assert manager.spawned == [result["run_id"]]  # type: ignore[attr-defined]


def test_second_submission_queues_even_for_a_different_dataset(
    manager: RunManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Queueing is unconditional: every run drives the same browser, so a different
    benchmark is not a reason to run two at once."""
    first = manager.start_run(_overrides("real-world-bench"))
    monkeypatch.setattr(manager, "executing_run_ids", lambda: [first["run_id"]])

    second = manager.start_run(_overrides("odysseys"))

    assert second["queued"] is True
    assert second["position"] == 1
    assert manager.spawned == [first["run_id"]]  # type: ignore[attr-defined]


def test_queue_holds_while_stage_a_runs_then_releases(
    manager: RunManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = manager.start_run(_overrides())
    monkeypatch.setattr(manager, "executing_run_ids", lambda: [first["run_id"]])
    queued = manager.start_run(_overrides())

    assert manager._scheduler_tick() is None, "must not release while Stage A occupies the slot"

    # Stage A finished (completed_at landed); judging may still be running in the same
    # process, but it no longer touches the browser and must not hold the queue.
    monkeypatch.setattr(manager, "executing_run_ids", lambda: [])

    assert manager._scheduler_tick() == queued["run_id"]
    assert manager.purges == 1, "taskspace purge runs before the queued run launches"  # type: ignore[attr-defined]
    assert manager.spawned == [first["run_id"], queued["run_id"]]  # type: ignore[attr-defined]
    assert manager.queue_state()["queue"] == []


def test_stage_a_slot_is_released_by_completed_at(
    manager: RunManager, tmp_path: Path
) -> None:
    """`completed_at` — not process exit — is what frees the slot."""
    run_dir = tmp_path / "runs" / "some-run"
    run_dir.mkdir(parents=True)
    meta = run_dir / "run_metadata.json"

    meta.write_text(json.dumps({"run_id": "some-run"}), encoding="utf-8")
    assert manager._stage_a_finished(run_dir) is False

    meta.write_text(
        json.dumps({"run_id": "some-run", "completed_at": "2026-07-26T00:00:00Z"}),
        encoding="utf-8",
    )
    assert manager._stage_a_finished(run_dir) is True


def test_external_cli_run_occupies_the_slot(
    manager: RunManager, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A run started from the CLI holds the queue exactly like one we spawned."""
    run_dir = tmp_path / "runs" / "cli-run"
    run_dir.mkdir(parents=True)
    (run_dir / "run_metadata.json").write_text(json.dumps({"run_id": "cli-run"}), encoding="utf-8")
    run_liveness.write_pid_file(run_dir, origin=run_liveness.ORIGIN_CLI)
    monkeypatch.setattr(run_liveness, "is_alive", lambda d: d.name == "cli-run")

    assert manager.executing_run_ids() == ["cli-run"]

    result = manager.start_run(_overrides())
    assert result["queued"] is True
    assert manager.spawned == []  # type: ignore[attr-defined]


def test_start_now_jumps_the_queue(manager: RunManager, monkeypatch: pytest.MonkeyPatch) -> None:
    first = manager.start_run(_overrides())
    monkeypatch.setattr(manager, "executing_run_ids", lambda: [first["run_id"]])
    a = manager.start_run(_overrides())
    b = manager.start_run(_overrides())

    started = manager.queue_start_now(b["run_id"])

    assert started == b["run_id"]
    assert manager.purges == 1, "jumping the queue still purges taskspaces"  # type: ignore[attr-defined]
    assert [item["run_id"] for item in manager.queue_state()["queue"]] == [a["run_id"]]


def test_move_and_cancel_reorder_the_queue(
    manager: RunManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = manager.start_run(_overrides())
    monkeypatch.setattr(manager, "executing_run_ids", lambda: [first["run_id"]])
    a = manager.start_run(_overrides())
    b = manager.start_run(_overrides())
    c = manager.start_run(_overrides())

    assert manager.queue_move(c["run_id"], to_top=True) == 1
    assert [i["run_id"] for i in manager.queue_state()["queue"]] == [
        c["run_id"], a["run_id"], b["run_id"]
    ]

    assert manager.queue_cancel(a["run_id"]) is True
    assert [i["run_id"] for i in manager.queue_state()["queue"]] == [c["run_id"], b["run_id"]]
    assert manager.queue_cancel("never-queued") is False


def test_paused_queue_does_not_release(
    manager: RunManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = manager.start_run(_overrides())
    monkeypatch.setattr(manager, "executing_run_ids", lambda: [first["run_id"]])
    manager.start_run(_overrides())
    manager.queue_set_paused(True)
    monkeypatch.setattr(manager, "executing_run_ids", lambda: [])

    assert manager._scheduler_tick() is None
    assert len(manager.queue_state()["queue"]) == 1

    manager.queue_set_paused(False)
    assert manager._scheduler_tick() is not None


def test_start_now_works_while_the_queue_is_paused(
    manager: RunManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pausing holds automatic releases; an explicit "start now" is the user overriding
    that, not a request the pause should silently swallow."""
    first = manager.start_run(_overrides())
    monkeypatch.setattr(manager, "executing_run_ids", lambda: [first["run_id"]])
    queued = manager.start_run(_overrides())
    manager.queue_set_paused(True)

    assert manager.queue_start_now(queued["run_id"]) == queued["run_id"]
    assert manager.spawned == [first["run_id"], queued["run_id"]]  # type: ignore[attr-defined]


def test_pausing_during_the_preflight_cancels_an_automatic_release(
    manager: RunManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The purge is a subprocess round-trip; a pause landing inside that window must
    still stop the launch, not be overtaken by it."""
    first = manager.start_run(_overrides())
    monkeypatch.setattr(manager, "executing_run_ids", lambda: [first["run_id"]])
    manager.start_run(_overrides())

    def purge_then_pause() -> dict[str, Any]:
        manager.queue_set_paused(True)
        return {"ok": True}

    monkeypatch.setattr(manager, "_preflight_spaces", purge_then_pause)
    monkeypatch.setattr(manager, "executing_run_ids", lambda: [])

    assert manager._release_next() is None
    assert len(manager.queue_state()["queue"]) == 1, "the run must stay queued"
    assert manager.spawned == [first["run_id"]]  # type: ignore[attr-defined]


def test_queue_survives_a_console_restart(
    manager: RunManager, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = manager.start_run(_overrides())
    monkeypatch.setattr(manager, "executing_run_ids", lambda: [first["run_id"]])
    queued = manager.start_run(_overrides())

    revived = RunManager(config_path=manager.config_path)

    assert [i["run_id"] for i in revived.queue_state()["queue"]] == [queued["run_id"]]
    assert revived._queue[0].merged["run"]["benchmark"] == "real-world-bench"


def test_queued_ids_are_reserved_against_each_other(
    manager: RunManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two submissions in the same second must not collide: a queued run has no
    directory yet, so the run_dir existence check alone cannot separate them."""
    first = manager.start_run(_overrides())
    monkeypatch.setattr(manager, "executing_run_ids", lambda: [first["run_id"]])
    ids = {manager.start_run(_overrides())["run_id"] for _ in range(3)}

    assert len(ids) == 3
