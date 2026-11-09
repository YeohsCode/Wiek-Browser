"""Run orchestration for the WebUI: spawn Stage A/B/C scripts, track lightweight progress.

The WebUI is a thin orchestration layer — it spawns run_eval.py and reads on-disk
products + subprocess stdout. It never parses sessions or writes tasks.jsonl.

run_id is pre-generated here and injected via ``run_eval.py --run-id``, so a
handle keys the real run_id from the start without stdout reconciliation or a
``pending_*`` placeholder.

Two facilities sit on top of that thin layer:

- **Serial queue** — at most one run executes Stage A at a time; further submissions
  wait in a FIFO queue and are released when the running one finishes Stage A (its
  ``completed_at`` lands), not when its judging finishes. Before each release the
  leftover wiek-browser taskspaces are purged. See ``_scheduler_tick``.
- **External runs** — runs started from the CLI (no handle in this process) are
  first-class: liveness comes from ``runs/<id>/run.pid`` and progress from
  ``runs/<id>/progress.ndjson``, so they can be watched, stopped and resumed here.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from wiek_bench import wiek_release, run_liveness
from wiek_bench.adhoc import adhoc_is_active, adhoc_rubric_mode, normalize_adhoc_node
from wiek_bench.browser_tools.wiek_browser import purge_agent_task_spaces
from wiek_bench.captcha import is_blocked
from wiek_bench.config import TOOL_PROFILES, HarnessConfig, _deep_merge, load_config
from wiek_bench.results import latest_by_task_id, read_records

_STATUS_BY_EVENT = {"start": "running", "done": "done", "fail": "error", "skip": "skip"}

# How often the scheduler re-checks whether the Stage-A slot freed up.
_SCHEDULER_INTERVAL_S = 2.0
# Queue file lives beside the runs, so a console restart resumes the same queue.
# Leading dot keeps it out of the run listing, which only walks directories.
_QUEUE_FILENAME = ".queue.json"


def _metadata_to_overrides(meta: dict[str, Any]) -> dict[str, Any]:
    """Map a run_metadata.json config snapshot back to the config-form override shape
    while emitting only fields present in the snapshot. The frontend
    merges them over current defaults, so removed/renamed fields fall back cleanly.
    Selective reruns also use this function to reconstruct the frozen configuration.
    """
    pi_meta = (meta.get("providers") or {}).get("pi") or {}
    codex_meta = (meta.get("providers") or {}).get("codex") or {}
    adhoc_meta = meta.get("adhoc") or {}
    adhoc_tasks = normalize_adhoc_node(adhoc_meta)
    is_adhoc = bool(adhoc_tasks)

    run: dict[str, Any] = {}
    # auto_judge / auto_export_sessions are restored too — both have real side-effects
    # (judge cost/time; per-task session-HTML export). Without them, reusing or resuming
    # a run that turned either off would silently fall back to the enabled default.
    for key in (
        "benchmark", "provider", "browser_tool", "browser_tool_mode", "concurrency",
        "iterations", "auto_judge", "auto_export_sessions",
    ):
        # benchmark="adhoc" is not a selectable dataset; the frontend switches to
        # adhoc mode from the adhoc node instead, so do not emit it.
        if key == "benchmark" and is_adhoc:
            continue
        if meta.get(key) is not None:
            run[key] = meta[key]
    if is_adhoc and adhoc_rubric_mode(adhoc_tasks) != "all":
        # Old BU-era snapshots may say auto_judge=true despite having no rubrics.
        # Reuse/resume must restore the task, but never revive that retired route.
        run["auto_judge"] = False
    providers_pi: dict[str, Any] = {}
    if meta.get("pi_provider") is not None:
        providers_pi["provider"] = meta["pi_provider"]
    if meta.get("model") is not None:
        providers_pi["model"] = meta["model"]
    if meta.get("thinking_level") is not None:
        providers_pi["thinking_level"] = meta["thinking_level"]
    # Drop stale/unknown tool_profile (old bash_only/coding) so it falls back to the
    # current default rather than failing validation on rerun.
    if pi_meta.get("tool_profile") in TOOL_PROFILES:
        providers_pi["tool_profile"] = pi_meta["tool_profile"]
    if pi_meta.get("allowed_tools") is not None:
        providers_pi["allowed_tools"] = pi_meta["allowed_tools"]
    providers_codex: dict[str, Any] = {}
    if meta.get("model") is not None:
        providers_codex["model"] = meta["model"]
    if codex_meta.get("reasoning_effort") is not None:
        providers_codex["reasoning_effort"] = codex_meta["reasoning_effort"]
    if codex_meta.get("codex_home") is not None:
        providers_codex["codex_home"] = codex_meta["codex_home"]
    if codex_meta.get("service_tier") is not None:
        providers_codex["service_tier"] = codex_meta["service_tier"]
    sampling: dict[str, Any] = {}
    if not is_adhoc:
        # Restore the run's task selection so resume and reuse-config reproduce its exact
        # task set — else they fall back to the current config and pull in tasks outside
        # the original run. Use `in meta` (not `is not None`): a recorded null means "the
        # whole benchmark" and must override a non-null current config; absent (pre-fix
        # snapshots) falls back to config.
        if "task_ids" in meta:
            sampling["task_ids"] = meta["task_ids"]
    judge: dict[str, Any] = {}
    if meta.get("judge_model") is not None:
        judge["model"] = meta["judge_model"]
    if meta.get("judge_mode") is not None:
        judge["mode"] = meta["judge_mode"]
    # Restore the limit mode and values, including the step-mode wall-clock
    # backstop, so reuse and rerun retain the original limits. Older snapshots
    # without limits fall back to current defaults.
    limits: dict[str, Any] = {}
    meta_limits = meta.get("limits") or {}
    for key in ("mode", "task_timeout_seconds", "max_turns", "step_mode_backstop_seconds"):
        if meta_limits.get(key) is not None:
            limits[key] = meta_limits[key]
    out: dict[str, Any] = {}
    if limits:
        out["limits"] = limits
    if run:
        out["run"] = run
    selected_provider = meta.get("provider") or "pi"
    if selected_provider == "codex" and providers_codex:
        out["providers"] = {"codex": providers_codex}
    elif providers_pi:
        out["providers"] = {"pi": providers_pi}
    if sampling:
        out["sampling"] = sampling
    if judge:
        out["judge"] = judge
    if is_adhoc:
        out["adhoc"] = {"tasks": adhoc_tasks}
    # The snapshot stores skill_name at top level;
    # map it back under the run's browser_tool so the form's Skill dropdown reuses it.
    bt = meta.get("browser_tool")
    if bt and meta.get("skill_name") is not None:
        out["browser_tools"] = {bt: {"skill_name": meta["skill_name"]}}
    return out


class RuntimeMismatchError(RuntimeError):
    """Rerun/resume would re-execute Stage A on a different wiek-browser runtime than the
    one the run was recorded against.

    A RuntimeError so every existing ``except RuntimeError`` → 409 path keeps working, but
    its own type because this one is recoverable: the caller may accept the mixed pool and
    retry with ``allow_runtime_mismatch=True``. Carries only the technical reason; the
    console supplies the localized explanation around it."""


@dataclass
class RunHandle:
    run_id: str
    proc: subprocess.Popen
    log_path: Path
    run_dir: Path
    config_path: Path
    requested_stop: bool = False


@dataclass
class QueuedRun:
    """A submitted-but-not-yet-started run.

    The merged config travels inside the queue entry rather than in a temp file so a
    console restart can rebuild everything from ``.queue.json`` alone. No run directory
    exists yet: ``run_eval`` refuses to start into a non-empty run_dir, and the id is
    reserved by ``_gen_run_id`` against both the runs directory and this queue.
    """

    run_id: str
    merged: dict[str, Any]
    queued_at: str
    # Display fields, so the Runs list can render a queued row without a run_dir.
    benchmark: str | None = None
    browser_tool: str | None = None
    provider: str | None = None
    model: str | None = None
    task_count_planned: int | None = None
    # Last pre-launch taskspace purge audit; surfaced on the row when it failed.
    preflight: dict[str, Any] | None = None
    error: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "merged": self.merged,
            "queued_at": self.queued_at,
            "benchmark": self.benchmark,
            "browser_tool": self.browser_tool,
            "provider": self.provider,
            "model": self.model,
            "task_count_planned": self.task_count_planned,
            "preflight": self.preflight,
            "error": self.error,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "QueuedRun | None":
        if not isinstance(data, dict) or not data.get("run_id") or not isinstance(
            data.get("merged"), dict
        ):
            return None
        return cls(
            run_id=str(data["run_id"]),
            merged=data["merged"],
            queued_at=str(data.get("queued_at") or ""),
            benchmark=data.get("benchmark"),
            browser_tool=data.get("browser_tool"),
            provider=data.get("provider"),
            model=data.get("model"),
            task_count_planned=data.get("task_count_planned"),
            preflight=data.get("preflight"),
            error=data.get("error"),
        )


class RunManager:
    def __init__(self, config_path: str = "config.yaml") -> None:
        self.config_path = config_path
        self.handles: dict[str, RunHandle] = {}
        # Keep judge-only re-judge handles separate from `handles`: a
        # rejudge spawns run_judge on an already-terminal run; storing it in
        # `handles` would make progress()'s proc.poll() flip the whole run back to
        # "running". Separate map → run status stays "done", only judge.status runs.
        self.judge_handles: dict[str, RunHandle] = {}
        # Serializes the check-then-spawn / check-then-delete critical section across
        # rerun, rejudge, and delete. FastAPI sync endpoints run on a thread pool,
        # so without this the is_running/is_judging guard and the handle store are not
        # atomic: two concurrent requests both pass the guard, then both spawn onto the
        # same run_dir. The lock makes "at most one writer transitions a run_dir" hold.
        self._lock = threading.Lock()
        self._tmp_root = Path(tempfile.gettempdir()) / "wiek_bench_webui"
        self._tmp_root.mkdir(parents=True, exist_ok=True)
        # Queue state. Guarded by its own lock: the scheduler thread holds it while
        # deciding what to release, and must not contend with the run_dir critical
        # section that `_lock` protects.
        self._queue: list[QueuedRun] = []
        self._queue_lock = threading.RLock()
        self._queue_paused = False
        self._load_queue()
        self._scheduler = threading.Thread(
            target=self._scheduler_loop, name="wiek-bench-queue", daemon=True
        )
        self._scheduler.start()

    def base_config(self) -> HarnessConfig:
        return load_config(self.config_path)

    def output_dir(self) -> Path:
        return Path(self.base_config().run.output_dir)

    def _gen_run_id(self, merged: dict[str, Any], output_dir: Path) -> str:
        """Replicate run_eval's run_id rule, regenerating until the directory is free.

        Queued ids are reserved too: their run_dir does not exist yet, so the directory
        check alone would happily hand the same id to two submissions in one second."""
        run = merged.get("run", {}) or {}
        label = (
            "adhoc"
            if adhoc_is_active(merged.get("adhoc") or {})
            else run.get("benchmark", "bench")
        )
        tool = run.get("browser_tool", "browser")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        provider = run.get("provider", "pi")
        base = f"{label}_{provider}_{tool}_{stamp}"
        with self._queue_lock:
            reserved = {entry.run_id for entry in self._queue}
        run_id = base
        n = 2
        while (output_dir / run_id).exists() or run_id in reserved:
            run_id = f"{base}_{n}"
            n += 1
        return run_id

    def _write_config(self, merged: dict[str, Any], run_id: str) -> Path:
        path = self._tmp_root / f"config_{run_id}.yaml"
        path.write_text(yaml.safe_dump(merged, allow_unicode=True), encoding="utf-8")
        return path

    # --- queue -----------------------------------------------------------------

    def _queue_path(self) -> Path:
        return self.output_dir() / _QUEUE_FILENAME

    def _load_queue(self) -> None:
        """Restore the queue after a console restart. Entries are self-contained, so
        nothing outside this file is needed to launch them later."""
        path = self._queue_path()
        if not path.exists():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        entries = data.get("queue") if isinstance(data, dict) else None
        restored = [QueuedRun.from_json(item) for item in entries or []]
        with self._queue_lock:
            self._queue = [entry for entry in restored if entry is not None]
            self._queue_paused = bool(isinstance(data, dict) and data.get("paused"))

    def _save_queue_locked(self) -> None:
        """Persist queue + pause flag. Caller holds ``_queue_lock``."""
        path = self._queue_path()
        payload = {
            "paused": self._queue_paused,
            "queue": [entry.to_json() for entry in self._queue],
        }
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(path)
        except OSError:
            # A queue that cannot be persisted still works for this process lifetime.
            pass

    @staticmethod
    def _stage_a_finished(run_dir: Path) -> bool:
        """True once run_eval wrote ``completed_at`` — the authoritative "Stage A is
        over" signal (same one the progress view uses). Judging continues afterwards
        in the same process but no longer touches the browser, so it frees the slot."""
        meta_path = run_dir / "run_metadata.json"
        if not meta_path.exists():
            return False
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        return bool(meta.get("completed_at"))

    def executing_run_ids(self) -> list[str]:
        """Runs currently holding the Stage-A slot — process alive AND Stage A not yet
        finished. Covers both runs spawned here and external (CLI) ones, because both
        drive the same browser."""
        busy: list[str] = []
        for run_id, handle in list(self.handles.items()):
            if handle.proc.poll() is None and not self._stage_a_finished(handle.run_dir):
                busy.append(run_id)
        output_dir = self.output_dir()
        if not output_dir.exists():
            return busy
        for run_dir in output_dir.iterdir():
            if not run_dir.is_dir() or run_dir.name in busy:
                continue
            # Cheap gate first: only runs that ever published a pid can be executing.
            if not (run_dir / run_liveness.PID_FILENAME).exists():
                continue
            if self._stage_a_finished(run_dir):
                continue
            if run_liveness.is_alive(run_dir):
                busy.append(run_dir.name)
        return busy

    def queue_state(self) -> dict[str, Any]:
        with self._queue_lock:
            queue = [
                {
                    "run_id": entry.run_id,
                    "position": idx + 1,
                    "queued_at": entry.queued_at,
                    "benchmark": entry.benchmark,
                    "browser_tool": entry.browser_tool,
                    "provider": entry.provider,
                    "model": entry.model,
                    "task_count_planned": entry.task_count_planned,
                    "preflight": entry.preflight,
                    "error": entry.error,
                }
                for idx, entry in enumerate(self._queue)
            ]
            paused = self._queue_paused
        return {"paused": paused, "queue": queue, "executing": self.executing_run_ids()}

    def _preflight_spaces(self) -> dict[str, Any]:
        """Close agent-owned wiek-browser taskspaces left behind by the previous run.

        Pinned to the same runtime the runs use when that is resolvable; a failure is
        reported on the queue entry but never blocks the launch — a stuck purge must not
        wedge the queue."""
        sdk_path = None
        try:
            snapshot = wiek_release.run_metadata_entry(self.base_config().wiek_browser)
            sdk_path = snapshot.get("index_js_realpath")
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"wiek-browser runtime unavailable: {exc}"}
        try:
            return purge_agent_task_spaces(sdk_path=sdk_path)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"taskspace purge crashed: {exc}"}

    def _spawn_run(self, merged: dict[str, Any], run_id: str) -> RunHandle:
        """Write the frozen config and spawn run_eval for a fresh run."""
        output_dir = Path(merged["run"]["output_dir"])
        output_dir.mkdir(parents=True, exist_ok=True)
        config_file = self._write_config(merged, run_id)
        run_dir = output_dir / run_id
        log_path = self._tmp_root / f"run_{run_id}.log"
        log_fh = open(log_path, "wb")  # noqa: SIM115
        env = {
            **os.environ,
            "PYTHONUNBUFFERED": "1",
            run_liveness.ORIGIN_ENV: run_liveness.ORIGIN_WEBUI,
        }
        proc = subprocess.Popen(
            [sys.executable, "-u", "run_eval.py", "--config", str(config_file),
             "--run-id", run_id],
            stdout=log_fh,
            stderr=subprocess.STDOUT,
            env=env,
            start_new_session=True,
            cwd=str(Path.cwd()),
        )
        handle = RunHandle(
            run_id=run_id, proc=proc, log_path=log_path, run_dir=run_dir, config_path=config_file
        )
        self.handles[run_id] = handle
        return handle

    def _release_next(self, *, force: bool = False) -> str | None:
        """Purge leftover taskspaces and start the head of the queue. Returns its id.

        ``force`` is the explicit "start now" path: the user asked for this run to go,
        so a paused queue does not apply to it. The purge always runs — it is what makes
        a launch safe, not what makes it wait."""
        with self._queue_lock:
            if (self._queue_paused and not force) or not self._queue:
                return None
            entry = self._queue[0]
        preflight = self._preflight_spaces()
        with self._queue_lock:
            # Re-check under the lock: the purge is a subprocess round-trip, and during
            # it the entry may have been cancelled or reordered — and the queue may have
            # been paused, which must still cancel an automatic release.
            if self._queue_paused and not force:
                return None
            if not self._queue or self._queue[0].run_id != entry.run_id:
                return None
            entry = self._queue.pop(0)
            entry.preflight = preflight
            self._save_queue_locked()
        try:
            self._spawn_run(entry.merged, entry.run_id)
        except Exception as exc:  # noqa: BLE001
            # Put it back at the head, flagged, rather than silently dropping the run.
            with self._queue_lock:
                entry.error = f"launch failed: {exc}"
                self._queue.insert(0, entry)
                self._queue_paused = True
                self._save_queue_locked()
            return None
        return entry.run_id

    def _scheduler_tick(self) -> str | None:
        with self._queue_lock:
            if self._queue_paused or not self._queue:
                return None
        if self.executing_run_ids():
            return None
        return self._release_next()

    def _scheduler_loop(self) -> None:
        while True:
            try:
                self._scheduler_tick()
            except Exception:  # noqa: BLE001
                # The scheduler thread must outlive any single bad tick.
                pass
            time.sleep(_SCHEDULER_INTERVAL_S)

    def enqueue_position(self, run_id: str) -> int | None:
        with self._queue_lock:
            for idx, entry in enumerate(self._queue):
                if entry.run_id == run_id:
                    return idx + 1
        return None

    def queue_move(self, run_id: str, *, to_top: bool = False, to: int | None = None) -> int:
        """Reorder a queued run. ``to`` is 1-based; out-of-range clamps to the ends."""
        with self._queue_lock:
            idx = next((i for i, e in enumerate(self._queue) if e.run_id == run_id), None)
            if idx is None:
                raise KeyError(run_id)
            entry = self._queue.pop(idx)
            target = 0 if to_top else max(0, min((to or 1) - 1, len(self._queue)))
            self._queue.insert(target, entry)
            self._save_queue_locked()
            return target + 1

    def queue_cancel(self, run_id: str) -> bool:
        """Drop a queued run. No run_dir exists yet, so nothing else to clean up."""
        with self._queue_lock:
            idx = next((i for i, e in enumerate(self._queue) if e.run_id == run_id), None)
            if idx is None:
                return False
            self._queue.pop(idx)
            self._save_queue_locked()
            return True

    def queue_set_paused(self, paused: bool) -> bool:
        with self._queue_lock:
            self._queue_paused = paused
            self._save_queue_locked()
            return self._queue_paused

    def queue_start_now(self, run_id: str) -> str:
        """Launch a queued run immediately, ahead of the queue and regardless of what
        is executing. The taskspace purge still runs — it is what makes a launch safe,
        not what makes it wait."""
        with self._queue_lock:
            idx = next((i for i, e in enumerate(self._queue) if e.run_id == run_id), None)
            if idx is None:
                raise KeyError(run_id)
            self._queue.insert(0, self._queue.pop(idx))
            self._save_queue_locked()
        released = self._release_next(force=True)
        if released is None:
            raise RuntimeError("could not start the queued run; check the queue state")
        return released

    # Names not copied when deriving a new run. screenshots/ is the heavy one and is
    # referenced by absolute path in tasks.jsonl (re-run/re-judged tasks regenerate it in the new
    # dir); sessions_live/pi_stderr/browser_state/close_done are transient/debug. report_*.html is
    # a STALE aggregate report named after the BASE run — inheriting it would show base's metrics
    # under the derived run's Artifacts; the derived run must Build report fresh
    # (sessions_html/<task_id>.html is kept — per-task, still valid for copied tasks).
    # run.pid identifies the process executing the BASE run; copying it into a derived
    # run would point that run's liveness at a foreign pid. progress.ndjson is kept on
    # purpose: a derived rejudge does not re-run Stage A, so the base's event stream is
    # still the correct Stage-A history for it (a derived rerun truncates it anyway).
    _DERIVE_IGNORE = (
        "screenshots", "sessions_live", "pi_stderr", "browser_state", "close_done",
        "report_*.html", "run.pid",
    )

    def _derived_id(self, base_run_id: str, kind: str, target: str) -> str:
        """Derived run_id ``<base>_<kind>_<target>`` (e.g. ..._rerun_selected), regenerating
        with a numeric suffix until the directory is free. The readable prefix is not a
        machine contract: derived rejudge hierarchy is carried by run_metadata.derived_from."""
        base = f"{base_run_id}_{kind}_{target}"
        output_dir = self.output_dir()
        run_id = base
        n = 2
        while (output_dir / run_id).exists():
            run_id = f"{base}_{n}"
            n += 1
        return run_id

    def _derive_copy(self, base_run_dir: Path, new_run_id: str) -> Path:
        """Copy base run_dir to output_dir/<new_run_id>, excluding _DERIVE_IGNORE.
        Caller holds the lock and has verified the base is quiescent (no live writer), so the
        copy is a consistent snapshot."""
        target = self.output_dir() / new_run_id
        shutil.copytree(
            base_run_dir, target, ignore=shutil.ignore_patterns(*self._DERIVE_IGNORE)
        )
        return target

    def _patch_derived_meta(
        self,
        target_dir: Path,
        new_run_id: str,
        base_run_id: str,
        *,
        judge_model: str | None = None,
        judge_mode: str | None = None,
    ) -> None:
        """Patch copied run metadata for a derived run: point run_id at
        the new dir, record derived_from (best-effort provenance — survives rejudge; a derived
        rerun's run_eval rewrite drops it, but the run_id suffix still carries it), clear
        cancelled (a derived run is a fresh terminal run, not a stopped one — no resume), and
        for a derived rejudge with a model/mode override set judge_model/judge_mode (run_judge
        only refreshes summary, not metadata, so this keeps the Run-config display consistent)."""
        meta_path = target_dir / "run_metadata.json"
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return
        meta["run_id"] = new_run_id
        meta["derived_from"] = base_run_id
        meta["cancelled"] = False
        if judge_model is not None:
            meta["judge_model"] = judge_model
        if judge_mode is not None:
            meta["judge_mode"] = judge_mode
        tmp_path = meta_path.with_suffix(meta_path.suffix + ".tmp")
        tmp_path.write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.replace(tmp_path, meta_path)

    def _assert_wiek_runtime_reusable(self, meta: dict[str, Any], *, accepted: bool) -> None:
        """Raise RuntimeMismatchError if re-executing this run's Stage A would use a
        different wiek-browser runtime than the one it was recorded against.

        run_eval enforces the same rule, but only after it has already forked and written
        run.pid — from the WebUI that reads as "rerun started" followed by nothing at all.
        Checked here so the action can put the question to the user before anything is
        launched, and so ``accepted=True`` (their answer) is what unblocks it. Applies to a
        derived run too: _derive_copy carries the base run_metadata over, so the derived
        Stage A is pinned to the same original runtime. An unreadable runtime is NOT decided
        here — that failure belongs to the subprocess, which reports it against the actual run."""
        if accepted or meta.get("browser_tool") != "wiek-browser":
            return
        # Local import for the same reason as resume_run's: run_eval imports this package.
        from run_eval import historical_runtime_mismatch

        try:
            current = wiek_release.run_metadata_entry(self.base_config().wiek_browser)
        except Exception:  # noqa: BLE001
            return
        mismatch = historical_runtime_mismatch(meta, current)
        if mismatch is not None:
            raise RuntimeMismatchError(mismatch)

    def _build_action_config(
        self,
        meta: dict[str, Any],
        *,
        kind: str,
        concurrency: int | None,
        model: str | None,
        judge_mode: str | None = None,
        new_run: bool,
    ) -> dict[str, Any]:
        """Assemble the merged config for a rerun/rejudge action from the run's frozen snapshot
        while allowing concurrency overrides in both destinations. Concurrency controls
        scheduling and does not alter task semantics. Rerun's agent model remains new-run-only;
        rejudge model/mode are overridable in BOTH destinations. An in-place rejudge may therefore
        mix judge configurations across tasks; the UI marks that explicit destructive tradeoff.
        rerun forces the full post-run chain on."""
        overrides = _metadata_to_overrides(meta)
        adhoc_entries = (
            normalize_adhoc_node(overrides["adhoc"])
            if adhoc_is_active(overrides.get("adhoc") or {})
            else []
        )
        if kind == "rerun":
            overrides.setdefault("run", {})
            if adhoc_entries:
                overrides["run"]["auto_judge"] = bool(
                    overrides["run"].get("auto_judge")
                ) and adhoc_rubric_mode(adhoc_entries) == "all"
            else:
                overrides["run"]["auto_judge"] = True
            overrides["run"]["auto_export_sessions"] = True
            if concurrency is not None:
                overrides["run"]["concurrency"] = concurrency
            if new_run and model:
                provider = (overrides.get("run") or {}).get("provider", "pi")
                overrides.setdefault("providers", {}).setdefault(provider, {})["model"] = model
        else:  # rejudge
            if adhoc_entries and adhoc_rubric_mode(adhoc_entries) != "all":
                raise ValueError(
                    "adhoc re-judge requires non-empty rubrics for every task"
                )
            if concurrency is not None:
                overrides.setdefault("judge", {})["concurrency"] = concurrency
            if model:
                overrides.setdefault("judge", {})["model"] = model
            if judge_mode:
                overrides.setdefault("judge", {})["mode"] = judge_mode
        merged = _deep_merge(self.base_config().model_dump(), overrides)
        HarnessConfig.model_validate(merged)  # validate before spawning
        return merged

    def _patch_in_place_rejudge_meta(
        self,
        run_dir: Path,
        *,
        judge_model: str | None,
        judge_mode: str | None,
    ) -> None:
        """Persist accepted in-place judge overrides as the run's next default.

        Individual judge files remain the per-task provenance source. Updating the run snapshot
        keeps the config panel and later re-judge defaults aligned with the latest chosen channel.
        """
        if judge_model is None and judge_mode is None:
            return
        meta_path = run_dir / "run_metadata.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if judge_model is not None:
            meta["judge_model"] = judge_model
        if judge_mode is not None:
            meta["judge_mode"] = judge_mode
        meta_path.write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _spawn_action(
        self,
        base_run_id: str,
        base_run_dir: Path,
        merged: dict[str, Any],
        *,
        kind: str,
        target_label: str,
        argv_action: list[str],
        new_run: bool,
        model: str | None,
        judge_mode: str | None = None,
    ) -> str:
        """Atomically guard, optionally derive, spawn, and register under the shared lock.

        In-place (new_run=false): refuse if THIS run is running / re-judging, spawn into its
        own run_dir (same id). Derive (new_run=true): refuse if the BASE is running / re-judging
        (copying a mutating dir yields a torn snapshot), copy base → a fresh derived dir, patch
        its metadata, spawn there. rerun → run_eval (--run-id <id>); rejudge → run_judge
        (--run-id <dir>). Returns the spawn run_id (base for in-place, derived for new_run)."""
        with self._lock:
            if new_run:
                if self.is_running(base_run_id) or self.is_judging(base_run_id):
                    raise RuntimeError(
                        "base run is busy (running or re-judging); wait before deriving a new run"
                    )
                spawn_id = self._derived_id(base_run_id, kind, target_label)
                spawn_dir = self._derive_copy(base_run_dir, spawn_id)
                self._patch_derived_meta(
                    spawn_dir,
                    spawn_id,
                    base_run_id,
                    judge_model=model if kind == "rejudge" else None,
                    judge_mode=judge_mode if kind == "rejudge" else None,
                )
            else:
                if self.is_running(base_run_id):
                    raise RuntimeError("run is still running; stop it before this action")
                if self.is_judging(base_run_id):
                    raise RuntimeError("a re-judge is still running; wait for it before this action")
                spawn_id, spawn_dir = base_run_id, base_run_dir

            if kind == "rerun":
                config_file = self._write_config(merged, spawn_id)
                log_path = self._tmp_root / f"run_{spawn_id}.log"
                argv = [
                    sys.executable, "-u", "run_eval.py", "--config", str(config_file),
                    "--run-id", spawn_id, *argv_action,
                ]
            else:
                config_file = self._write_config(merged, f"judge_{spawn_id}")
                log_path = self._tmp_root / f"judge_{spawn_id}.log"
                argv = [
                    sys.executable, "-u", "run_judge.py", "--config", str(config_file),
                    "--run-id", str(spawn_dir), *argv_action,
                ]
            log_fh = open(log_path, "wb")  # noqa: SIM115
            env = {
                **os.environ,
                "PYTHONUNBUFFERED": "1",
                # Same provenance stamp _spawn_run writes: without it a WebUI-started
                # rerun/resume publishes run.pid as origin="cli".
                run_liveness.ORIGIN_ENV: run_liveness.ORIGIN_WEBUI,
            }
            proc = subprocess.Popen(
                argv,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                env=env,
                start_new_session=True,
                cwd=str(Path.cwd()),
            )
            handle = RunHandle(
                run_id=spawn_id, proc=proc, log_path=log_path,
                run_dir=spawn_dir, config_path=config_file,
            )
            # rerun is a real Stage-A run → handles[]; rejudge only judges → judge_handles[]
            # The run stays terminal while only judge status advances.
            if kind == "rerun":
                self.handles[spawn_id] = handle
            else:
                self.judge_handles[spawn_id] = handle
                if not new_run:
                    self._patch_in_place_rejudge_meta(
                        spawn_dir, judge_model=model, judge_mode=judge_mode
                    )
        return spawn_id

    def start_run(self, overrides: dict[str, Any]) -> dict[str, Any]:
        """Submit a run: start it now when the Stage-A slot is free, else queue it.

        Returns ``{run_id, queued, position}``. Queueing is unconditional — it does not
        depend on the two runs sharing a dataset — because every run drives the same
        browser, and two concurrent runs on one site is exactly what trips bot walls."""
        base = self.base_config().model_dump()
        effective_overrides = deepcopy(overrides or {})
        if adhoc_is_active(effective_overrides.get("adhoc") or {}):
            run_override = effective_overrides.setdefault("run", {})
            if "auto_judge" not in run_override:
                run_override["auto_judge"] = False
        merged = _deep_merge(base, effective_overrides)
        HarnessConfig.model_validate(merged)  # validate before spawning
        output_dir = Path(merged["run"]["output_dir"])
        output_dir.mkdir(parents=True, exist_ok=True)

        run_cfg = merged.get("run", {}) or {}
        is_adhoc = adhoc_is_active(merged.get("adhoc") or {})
        with self._queue_lock:
            run_id = self._gen_run_id(merged, output_dir)
            # Start immediately only when nothing is executing AND nothing is waiting —
            # a free slot with a non-empty queue belongs to the head of that queue.
            if not self._queue and not self._queue_paused and not self.executing_run_ids():
                self._spawn_run(merged, run_id)
                return {"run_id": run_id, "queued": False, "position": 0}
            entry = QueuedRun(
                run_id=run_id,
                merged=merged,
                queued_at=datetime.now(timezone.utc).isoformat(),
                benchmark="adhoc" if is_adhoc else run_cfg.get("benchmark"),
                browser_tool=run_cfg.get("browser_tool"),
                provider=run_cfg.get("provider"),
                model=(merged.get("providers", {}).get(run_cfg.get("provider") or "pi", {}) or {})
                .get("model"),
                task_count_planned=self._planned_task_count(merged, is_adhoc=is_adhoc),
            )
            self._queue.append(entry)
            self._save_queue_locked()
            return {"run_id": run_id, "queued": True, "position": len(self._queue)}

    @staticmethod
    def _planned_task_count(merged: dict[str, Any], *, is_adhoc: bool) -> int | None:
        """Best-effort task count for a queued row. Exact when the caller pinned explicit
        task_ids (or ad-hoc tasks); a whole-benchmark run would need the dataset loaded,
        which a queue row deliberately avoids."""
        if is_adhoc:
            tasks = (merged.get("adhoc") or {}).get("tasks")
            return len(tasks) if isinstance(tasks, list) else None
        task_ids = (merged.get("sampling") or {}).get("task_ids")
        if isinstance(task_ids, list) and task_ids:
            iterations = int((merged.get("run") or {}).get("iterations") or 1)
            return len(task_ids) * max(1, iterations)
        return None

    def _parse_progress_log(self, log_path: Path) -> tuple[dict[str, dict[str, Any]], int | None]:
        """NDJSON progress events → (task_id -> {status, started_ts, turns}, run_start total).

        stdout/stderr are merged into the log file; non-JSON lines (human logs on
        stderr) are skipped silently. ``started_ts`` comes from the start
        event (running elapsed); ``turns`` from progress (live) and done/fail
        (final) events; ``session_file`` from the session event — backend-only,
        never exposed to the frontend."""
        tasks: dict[str, dict[str, Any]] = {}
        total: int | None = None
        if not log_path.exists():
            return tasks, total
        try:
            text = log_path.read_text(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            return tasks, total
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            kind = ev.get("event")
            if kind == "run_start":
                total = ev.get("total")
                continue
            tid = ev.get("task_id")
            if not tid:
                continue
            # session/progress refresh fields on a running task without
            # touching its status.
            if kind in ("session", "progress", "attempt"):
                entry = tasks.setdefault(str(tid), {})
                if ev.get("session_file"):
                    entry["session_file"] = ev.get("session_file")
                if ev.get("turns") is not None:
                    entry["turns"] = ev.get("turns")
                if ev.get("attempt") is not None:
                    entry["attempts"] = ev.get("attempt")
                continue
            status = _STATUS_BY_EVENT.get(kind)
            if not status:
                continue
            entry = tasks.setdefault(str(tid), {})
            entry["status"] = status
            if kind == "start":
                entry["started_ts"] = ev.get("ts")
            if ev.get("turns") is not None:
                entry["turns"] = ev.get("turns")
        return tasks, total

    @staticmethod
    def _iso_seconds(start: str | None, end: str | None) -> float | None:
        if not start or not end:
            return None
        try:
            s = datetime.fromisoformat(start)
            e = datetime.fromisoformat(end)
            return max(0.0, (e - s).total_seconds())
        except (ValueError, TypeError):
            return None

    def progress(self, run_id: str) -> dict[str, Any]:
        handle = self.handles.get(run_id)
        run_dir = handle.run_dir if handle else self.output_dir() / run_id
        # Prefer the run's own event log: it is written regardless of who started the
        # run, so a CLI run gets the same live task rows as a console-spawned one, and
        # our own runs keep theirs after a restart drops the handle. Fall back to the
        # spawn log for runs produced before run_eval mirrored events to disk.
        event_log = run_dir / run_liveness.EVENT_LOG_FILENAME
        log_source = event_log if event_log.exists() else (handle.log_path if handle else None)
        task_info, total_from_log = (
            self._parse_progress_log(log_source) if log_source else ({}, None)
        )

        meta_path = run_dir / "run_metadata.json"
        completed = False
        total_planned = None
        # auto_export and cancelled drive the post-Stage-A "exporting" pill below:
        # only an auto_export run has a session-HTML export stage, and a cancelled run skips
        # it. auto_export defaults true (matches config + pre-field runs); cancelled false.
        # judging_started_at is merge-written by run_eval right before the wrap-up auto-judge
        # (never present in the start/final full-rewrite metadata, so a rerun's start
        # write clears it) — it drives the judged=0 placeholder judge block below.
        auto_export = True
        cancelled = False
        judging_started = False
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                completed = bool(meta.get("completed_at"))
                total_planned = meta.get("task_count_planned")
                auto_export = bool(meta.get("auto_export_sessions", True))
                cancelled = bool(meta.get("cancelled"))
                judging_started = bool(meta.get("judging_started_at"))
            except Exception:  # noqa: BLE001
                pass

        # reconcile with on-disk task records (authoritative for done/fail).
        # the [skip] event is authoritative for resume-skips: a skipped task has a
        # prior no-error record on disk, so don't let it be reclassified as "done".
        for rec in read_records(run_dir):
            tid = str(rec.get("task_id"))
            entry = task_info.setdefault(tid, {})
            # judge verdict backfilled by merge_judge_into_record (default-model auto-judge);
            # last write wins, same as status. Captured before the skip/running guard so a
            # resume-skipped task (judged in a prior run) still carries its verdict. Whether a
            # task counts as judged is decided below by the on-disk judge FILE, not judged_at:
            # a rerun purges the file but leaves the stale row's judged_at until the task
            # completes, so a queued/in-flight rerun task would otherwise leak its old verdict.
            entry["verdict"] = rec.get("verdict")
            entry["judge_error"] = rec.get("judge_error")
            # the [skip] event is authoritative for resume-skips; "running" protects a
            # task the live log says is in-flight from being reclassified by a stale disk
            # row — matters for rerun, where the prior (pre-overwrite) row still exists
            # while the task is being re-executed.
            if entry.get("status") in ("skip", "running"):
                continue
            # "captcha" is a third terminal outcome, not a flavour of error and not a
            # plain success: the run was clean but no result was delivered, so it must not
            # fall through to "done". Amber rather than red in the UI.
            if is_blocked(rec):
                entry["status"] = "captcha"
            else:
                entry["status"] = "error" if rec.get("error") else "done"
            dur = self._iso_seconds(rec.get("started_at"), rec.get("ended_at"))
            if dur is not None:
                entry["duration_s"] = dur
            if rec.get("attempt_count") is not None:
                entry["attempts"] = rec.get("attempt_count")

        # Running-task elapsed time starts at the start-event timestamp.
        now = datetime.now(timezone.utc)
        for entry in task_info.values():
            if entry.get("status") == "running" and entry.get("started_ts"):
                dur = self._iso_seconds(entry["started_ts"], now.isoformat())
                if dur is not None:
                    entry["duration_s"] = dur

        statuses = {tid: e.get("status", "running") for tid, e in task_info.items()}
        done = sum(1 for v in statuses.values() if v == "done")
        fail = sum(1 for v in statuses.values() if v == "error")
        skip = sum(1 for v in statuses.values() if v == "skip")
        active = sum(1 for v in statuses.values() if v == "running")
        captcha_blocked = sum(1 for v in statuses.values() if v == "captcha")

        # Use the same liveness criteria as the /api/runs `running` flag. Without a
        # handle the run may still be executing under another process (CLI-started, or
        # ours from before a restart), so probe its pid file before concluding it died:
        # only a handle-less run with no live pid and no completed_at is "error".
        if handle is not None:
            rc = handle.proc.poll()
            if rc is None:
                status = "running"
            elif handle.requested_stop:
                status = "stopped"
            elif rc not in (0, 130):
                # The exit code outranks completed_at. A rerun/resume that dies in its own
                # preflight never reaches the metadata write, so the PREVIOUS leg's
                # completed_at is still on disk — reading it first reported a failed action
                # as "done" and left the user with no signal at all.
                status = "error"
            else:
                status = "done"
        elif run_liveness.is_alive(run_dir):
            status = "running"
        elif cancelled:
            # An external run that took a stop signal writes cancelled=true on its way
            # out; without a handle that flag is the only record of the interruption.
            status = "stopped"
        else:
            status = "done" if completed else "error"

        # Stage B judge progress writes one artifact after each task resolves and
        # judges/<task_id>_judge.json per task and backfilling verdict/judge_error into tasks.jsonl.
        # The authoritative "currently judged" signal is the on-disk judge FILE, NOT the row's
        # judged_at: a selective rerun purges judges/<id>_judge.json
        # but leaves the stale row's judged_at until the task completes — so a queued or in-flight
        # rerun task must be read from the file's absence, else its pre-rerun verdict leaks in.
        # glob *_judge.json matches only default-model files (alt-model is *_judge_<model>.json).
        # Counting only resolved tasks (and total = resolved) keeps judged ≤ total — no impossible
        # "judged 30 / 29" readout. Surfaced only once judging has begun; null otherwise.
        judges_dir = run_dir / "judges"
        judged_ids = (
            {p.name[: -len("_judge.json")] for p in judges_dir.glob("*_judge.json")}
            if judges_dir.is_dir()
            else set()
        )
        resolved_judged = [
            e
            for tid, e in task_info.items()
            if tid in judged_ids and e.get("status") in ("done", "error", "skip")
        ]
        # A judge-only re-judge runs on a terminal run, so its liveness — not the
        # run's status — drives judge.status here: while it's alive, judging is in flight
        # even though the run itself is "done". This lets the frontend keep polling so
        # the err count ticks down as failed verdicts get overwritten in place.
        rejudging = self.is_judging(run_id)
        # Batch auto-judge starts only after Stage A finishes,
        # after Stage A finishes, which run_eval marks by writing run_metadata.completed_at
        # (cleared at a rerun's start write, set again only after the rerun's task loop). So
        # `completed` is the authoritative "Stage A done" signal. Do NOT gate on active == 0:
        # through a rerun's queued / startup / tail windows no task is "running" (queued reran
        # tasks still carry the prior run's stale `done`), so active == 0 while Stage A is very
        # much not done — and the un-purged subset's judge files left on disk would then flip the
        # hero pill to "judging" over a still-running Stage A. Gate the whole readout on this so
        # judge stays null until judging truly begins. A re-judge runs on a terminal run
        # (completed set), so rejudging still counts as begun.
        judging_begun = rejudging or status != "running" or completed
        # Once judging_started_at lands on a live
        # run, build the judge block with judged=0 even though judges/ is still empty — the
        # Judge view lights "judging 0/N" immediately, and `exporting` below (gated on
        # `judge is None`) flips off at Stage B start instead of at the first verdict file
        # (measured: export is ~5s; the first agent-mode judge can take minutes and used to
        # be mislabeled "exporting"). Live-run-only: a terminal run whose auto-judge died
        # before any file falls back to the on-disk file criterion — no dangling "judging".
        judging_active = judging_started and status == "running"
        judge: dict[str, Any] | None = None
        if (resolved_judged or judging_active) and judging_begun:
            judged = len(resolved_judged)
            jpass = sum(1 for e in resolved_judged if not e.get("judge_error") and e.get("verdict"))
            jerr = sum(1 for e in resolved_judged if e.get("judge_error"))
            jfail = judged - jpass - jerr
            resolved = done + fail + skip  # judge covers every resolved task
            jdone = not rejudging and (status != "running" or judged >= resolved)
            judge = {
                "status": "done" if jdone else "running",
                "total": resolved,
                "judged": judged,
                "pass": jpass,
                "fail": jfail,
                "err": jerr,
            }

        # run_judge writes current-job target and completion progress to
        # judges/_job.json, a
        # dimension the full-run file count above can't express (a subset re-judge leaves
        # judged ≈ total ≈ 100%). The manifest is DATA, process liveness is the GATE:
        # surfaced only while judging is live (same door as the Judge-view hero pill —
        # judge.status==running ∪ top-level judging), so a stale manifest left by a crash
        # or a prior job never dangles as live progress.
        job: dict[str, Any] | None = None
        judge_live = rejudging or (judge is not None and judge.get("status") == "running")
        if judge_live:
            job_file = judges_dir / "_job.json"
            if job_file.exists():
                try:
                    jdata = json.loads(job_file.read_text(encoding="utf-8")) or {}
                except Exception:  # noqa: BLE001
                    jdata = {}
                if jdata and not jdata.get("finished"):
                    job = {
                        "total": jdata.get("total"),
                        "done": jdata.get("done"),
                        "done_ids": jdata.get("done_ids") or [],
                        "started_at": jdata.get("started_at"),
                        "targets": jdata.get("targets") or [],
                    }

        # The post-Stage-A exporting window runs between completed_at and auto-judge
        # start, run_eval is in export_run_sessions_async — one pi subprocess per task
        # rendering sessions_html/<id>.html — so Stage A is 100% done yet judging hasn't
        # begun. The run subprocess is alive so `status` stays "running"; a separate
        # `exporting` flag lets the hero pill read "exporting" instead of a bare "running"
        # (or a misleading "judging"). Gated on auto_export (only then is there an export
        # stage) and judge is None — the moment the judge readout exists, exporting →
        # judging. That happens at judging_started_at (judged=0 placeholder above, normal
        # path) or at the first judges/*.json landing (fallback: pre-field runs / marker
        # write failure). Cancelled runs and rerun windows (completed_at cleared,
        # judging_begun false, still Stage A) are excluded.
        exporting = (
            status == "running"
            and completed
            and not cancelled
            and auto_export
            and judge is None
        )

        # has_session reflects the on-disk fact: sessions_html/ is only written by
        # auto_export_sessions on a clean wrap-up (a SIGINT/cancelled run returns 130
        # before it). The frontend gates the per-task session link on this, never on
        # run/task status (which can't tell a cancelled-but-completed_at run apart).
        sessions_dir = run_dir / "sessions_html"
        slot = 0
        tasks_list = []
        for tid, entry in task_info.items():
            slot += 1
            dur = entry.get("duration_s")
            tasks_list.append(
                {
                    "task_id": tid,
                    "status": entry.get("status", "running"),
                    "slot": slot,
                    "has_session": (sessions_dir / f"{tid}.html").exists(),
                    "session_known": bool(entry.get("session_file"))
                    or entry.get("status") in ("done", "error", "captcha"),
                    "duration_s": round(dur, 1) if dur is not None else None,
                    "turns": entry.get("turns"),
                    "attempts": entry.get("attempts"),
                }
            )

        total = total_planned if total_planned is not None else total_from_log
        return {
            "run_id": run_id,
            "status": status,
            "total": total if total is not None else len(statuses),
            "done": done,
            "fail": fail,
            "skip": skip,
            "active": active,
            # Tasks stopped by an agent-reported anti-bot wall. Counted apart from `fail`
            # so the run's failure number stays "things that actually went wrong".
            "captcha": captcha_blocked,
            "judge": judge,
            # This is the authoritative signal that a judge
            # subprocess is alive on this run" signal — `is_judging(run_id)`, same source as
            # the runs-list `judging`. It stays separate from `judge` (the count block, built
            # only once judges/*.json exist): on a never-judged run (auto_judge=false) a
            # re-judge runs with judges/ still empty → `judge` is null, yet `judging` is true.
            # The frontend gates Stop + poll-keepalive on THIS, not on judge.status, so the
            # "no judge file yet" window can't strand a live re-judge as unstoppable.
            "judging": rejudging,
            # Job progress is null unless a live judge job's manifest is
            # on disk and unfinished — drives the "⟳ re-judging done/total" line + queued
            # row states in the Judge view.
            "job": job,
            "exporting": exporting,
            # Gate the resume button on a run stopped mid-flight:
            # run stopped mid-flight (run_eval wrote cancelled=true in its SIGINT finally),
            # robust across a "stopped" pill being lost after a WebUI restart.
            "cancelled": cancelled,
            "tasks": tasks_list,
        }

    def judge_progress(self, run_id: str) -> dict[str, Any]:
        """Return the ``progress`` judge aggregate plus a per-task breakdown:
        PER-TASK judge breakdown — verdict / duration / turns / cost / session link — that
        Progress deliberately omits (Progress is Stage-A only now). Reuses ``progress`` for
        the aggregate (judge counts / `judging` liveness / status / resolved task set), then
        reads ``judges/<task>_judge.json`` per task for the detail. Read-side only: pre-field
        runs lack ``judge_duration_s`` / ``judge_turns`` → null, surfaced as "—" by the UI.
        """
        prog = self.progress(run_id)
        handle = self.handles.get(run_id)
        run_dir = handle.run_dir if handle else self.output_dir() / run_id
        judges_dir = run_dir / "judges"
        jsessions_dir = run_dir / "judge_sessions_html"

        judge_tasks: list[dict[str, Any]] = []
        # Read rubric sidecars only while judging is live,
        # same "manifest is data, liveness is the gate" rule as the job readout above.
        judge_live = bool(prog.get("judging")) or (
            (prog.get("judge") or {}).get("status") == "running"
        )
        for t in prog.get("tasks", []):
            tid = str(t["task_id"])
            detail: dict[str, Any] = {
                "task_id": tid,
                "task_status": t.get("status"),
                # pass / fail / err / captcha / pending — pending = not-yet-judged (no judge
                # file). A CAPTCHA-intercepted task never gets one BY DESIGN, so it reads
                # "captcha" rather than dangling as pending forever.
                "judge_status": "captcha" if t.get("status") == "captcha" else "pending",
                "verdict": None,
                "judge_error": None,
                "duration_s": None,
                "turns": None,
                "cost_usd": None,
                "input_tokens": None,
                "output_tokens": None,
                "judge_mode": None,
                "judge_session_url": None,
                # For judged tasks, rubric state comes from pass/total counts in
                # metadata.rubric_results (binary judges → null); in-flight → the current
                # rubric from the progress sidecar.
                "rubric_pass": None,
                "rubric_total": None,
                "judging_rubric": None,
            }
            jf = judges_dir / f"{tid}_judge.json"
            if jf.exists():
                try:
                    data = json.loads(jf.read_text(encoding="utf-8"))
                except Exception:  # noqa: BLE001
                    data = {}
                verdict = data.get("verdict")
                jerr = data.get("judge_error")
                detail.update(
                    {
                        "verdict": verdict,
                        "judge_error": jerr,
                        "judge_status": "err" if jerr else ("pass" if verdict else "fail"),
                        "duration_s": data.get("judge_duration_s"),
                        "turns": data.get("judge_turns"),
                        "cost_usd": data.get("judge_cost_usd"),
                        "input_tokens": data.get("judge_input_tokens"),
                        "output_tokens": data.get("judge_output_tokens"),
                        "judge_mode": data.get("judge_mode"),
                    }
                )
                rres = (data.get("metadata") or {}).get("rubric_results") or []
                if isinstance(rres, list) and rres:
                    detail["rubric_total"] = len(rres)
                    detail["rubric_pass"] = sum(
                        1 for r in rres if isinstance(r, dict) and r.get("satisfied")
                    )
                # Judge-session HTML uses <task>.html for single-call judges and
                # → <task>/<rubric>.html (no index) → link the first rubric page so "open" still
                # works. Only a judged task can have one, so this stays under the jf guard —
                # skips the stat/glob for every unjudged task on each poll.
                single = jsessions_dir / f"{tid}.html"
                if single.exists():
                    detail["judge_session_url"] = f"/runs/{run_dir.name}/judge_sessions_html/{tid}.html"
                else:
                    rubric_dir = jsessions_dir / tid
                    if rubric_dir.is_dir():
                        pages = sorted(rubric_dir.glob("*.html"))
                        if pages:
                            detail["judge_session_url"] = (
                                f"/runs/{run_dir.name}/judge_sessions_html/{tid}/{pages[0].name}"
                            )
            if judge_live:
                # in-flight rubric readout (⟳R3 2/6): the odysseys judge rewrites this
                # sidecar at each rubric boundary; run_judge removes it when the task's
                # judging wraps, so its presence while live means "being judged now".
                sc = judges_dir / f"{tid}_judge.progress.json"
                if sc.exists():
                    try:
                        pdata = json.loads(sc.read_text(encoding="utf-8")) or {}
                    except Exception:  # noqa: BLE001
                        pdata = {}
                    if pdata:
                        detail["judging_rubric"] = {
                            "rubric_id": pdata.get("rubric_id"),
                            "done": pdata.get("done"),
                            "total": pdata.get("total"),
                        }
            judge_tasks.append(detail)

        return {
            "run_id": run_id,
            "status": prog.get("status"),
            "judge": prog.get("judge"),
            "judging": prog.get("judging", False),
            # The current job's total, done, and
            # targets of the CURRENT job, null unless a live unfinished manifest exists.
            "job": prog.get("job"),
            "exporting": prog.get("exporting", False),
            "cancelled": prog.get("cancelled", False),
            "total": prog.get("total", 0),
            # judge covers every resolved (done/fail/skip) task; lets the Judge view show
            # "waiting for Stage A" before judging begins, and a pending count after.
            "resolved": prog.get("done", 0) + prog.get("fail", 0) + prog.get("skip", 0),
            "tasks": judge_tasks,
        }

    @staticmethod
    def read_note(run_dir: Path) -> str:
        """Read runs/<id>/note.md or return an empty string. It stays in its own
        file so run_eval's run_metadata rewrites (rerun / resume / wrap-up) never clobber it."""
        note_path = run_dir / "note.md"
        if note_path.exists():
            try:
                return note_path.read_text(encoding="utf-8")
            except Exception:  # noqa: BLE001
                return ""
        return ""

    @staticmethod
    def write_note(run_dir: Path, note: str) -> str:
        """Persist a run note, removing the file for blank or whitespace-only input."""
        note_path = run_dir / "note.md"
        text = note.strip()
        if text:
            note_path.write_text(note, encoding="utf-8")
        elif note_path.exists():
            note_path.unlink()
        return note if text else ""

    def session_file_for(self, run_id: str, task_id: str) -> str | None:
        """Return the session file for a live snapshot: running tasks use the
        session progress event, finished tasks from tasks.jsonl."""
        handle = self.handles.get(run_id)
        if handle is not None:
            info, _ = self._parse_progress_log(handle.log_path)
            session_file = info.get(task_id, {}).get("session_file")
            if session_file:
                return str(session_file)
        run_dir = handle.run_dir if handle else self.output_dir() / run_id
        rec = latest_by_task_id(run_dir).get(task_id)
        return rec.get("session_file") if rec else None

    def stop_run(self, run_id: str) -> bool:
        """SIGINT the live subprocess for this run — Stage A (``handles``) OR a judge-only
        re-judge (``judge_handles``). Mutual exclusion keeps at most one
        live per run_id, so signal whichever is alive: prefer a live Stage-A handle, else the
        live judge handle. A dead Stage-A handle from the original run may still sit in
        ``handles`` alongside a live in-place re-judge — skip it (poll() not None) and fall
        through to the judge handle. Returns False when neither is live (already finished /
        never ran). Same one-shot Ctrl+C path for both scripts (run_eval / run_judge finally)."""
        for store in (self.handles, self.judge_handles):
            handle = store.get(run_id)
            if handle is None or handle.proc.poll() is not None:
                continue
            handle.requested_stop = True
            try:
                os.killpg(os.getpgid(handle.proc.pid), signal.SIGINT)
                return True
            except ProcessLookupError:
                return False
        # No live handle: the run may be executing outside this process. Signal the pid
        # itself, never its process group — an external run shares its group with the
        # shell that launched it, and killpg would take that down too. run_eval's own
        # SIGINT path still tears down its children.
        pid = run_liveness.external_pid(self.output_dir() / run_id)
        if pid is None:
            return False
        try:
            os.kill(pid, signal.SIGINT)
            return True
        except OSError:
            return False

    def rerun(
        self,
        run_id: str,
        *,
        task_ids: list[str] | None,
        errors: bool,
        concurrency: int | None = None,
        model: str | None = None,
        new_run: bool = False,
        allow_runtime_mismatch: bool = False,
    ) -> str:
        """Force-rerun the run's error or selected tasks.
        Overwrite (new_run=false): reuse the frozen config (+ optional concurrency), spawn
        ``run_eval --rerun-task-ids`` into the same run_dir in place. Derive
        (new_run=true): copy base → a new run_dir, optionally with a new agent model +
        concurrency, rerun the chosen tasks there; the original run is untouched. Returns the
        spawn run_id (same for overwrite, the derived id for new_run).
        ``allow_runtime_mismatch`` is the user's answer to the wiek-browser runtime question
        below, and travels to the subprocess so its own guard honours the same answer."""
        run_dir = self.output_dir() / run_id
        meta_path = run_dir / "run_metadata.json"
        if not meta_path.exists():
            raise FileNotFoundError(f"run not found or never ran: {run_id}")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))

        latest = latest_by_task_id(run_dir)
        ids = {t.strip() for t in (task_ids or []) if t and t.strip()}
        if errors:
            ids |= {tid for tid, rec in latest.items() if rec.get("error")}
        # the run's own task set is the boundary: reject ids not in this run rather
        # than letting a foreign task get written into its run directory.
        unknown = ids - set(latest)
        if unknown:
            raise ValueError(f"task ids not in run {run_id}: {sorted(unknown)}")
        if not ids:
            raise ValueError("no task ids to rerun (pass task_ids, or errors=true with failed tasks)")
        # Same reason as resume_run's preflight: ask on THIS request rather than returning
        # 200 + run_id and having run_eval die in its wiek-browser preflight, where nothing
        # but the spawn log records it.
        self._assert_wiek_runtime_reusable(meta, accepted=allow_runtime_mismatch)

        merged = self._build_action_config(
            meta, kind="rerun", concurrency=concurrency, model=model, new_run=new_run
        )
        target_label = "errors" if (errors and not task_ids) else "selected"
        argv_action = ["--rerun-task-ids", ",".join(sorted(ids))]
        if allow_runtime_mismatch:
            argv_action.append("--allow-runtime-mismatch")
        return self._spawn_action(
            run_id, run_dir, merged,
            kind="rerun", target_label=target_label,
            argv_action=argv_action,
            new_run=new_run, model=model,
        )

    def resume_run(
        self,
        run_id: str,
        *,
        concurrency: int | None = None,
        allow_runtime_mismatch: bool = False,
    ) -> str:
        """Resume a stopped or cancelled run in place using the frozen
        config, force ``resume=true``, and spawn ``run_eval --run-id <id>`` into the SAME
        run_dir without ``--rerun-task-ids``. Native resume skips
        done tasks (rows with no error) and runs the rest, including never-started tasks
        and in-flight tasks dropped at stop (CancelledError fires before their record
        append, so they are rerun rather than marked as errors). A fresh handle replaces the stale
        stopped one in ``handles[run_id]``: clears the old ``requested_stop`` (status no
        longer pinned to "stopped") and re-feeds progress NDJSON so the progress view goes
        live again. ``concurrency`` is the ONLY accepted override — an execution-scheduling
        knob that doesn't bias task semantics (unlike benchmark/limits/model, which would
        make the two halves of one run incomparable). ``allow_runtime_mismatch`` overrides
        nothing — it is the user's answer to the wiek-browser runtime question below. It
        refuses a still-running or re-judging run."""
        run_dir = self.output_dir() / run_id
        meta_path = run_dir / "run_metadata.json"
        if not meta_path.exists():
            raise FileNotFoundError(f"run not found or never ran: {run_id}")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))

        # The frozen config keeps benchmark, limits, model, and judge identical to the
        # original run; force resume=true; allow ONLY a concurrency override.
        overrides = _metadata_to_overrides(meta)
        overrides.setdefault("run", {})
        overrides["run"]["resume"] = True
        if concurrency is not None:
            overrides["run"]["concurrency"] = concurrency
        merged = _deep_merge(self.base_config().model_dump(), overrides)
        cfg_obj = HarnessConfig.model_validate(merged)  # validate before spawning
        # Preflight (drift guard) BEFORE spawning so a sampling-drift resume fails THIS request
        # (→ 409) instead of returning 200 + run_id and dying invisibly in the subprocess —
        # which would leave cancelled=true and make the button reappear into a silent retry loop
        # Drift is deterministic for a frozen config and dataset, so this is safe outside the
        # lock; the has-gap check runs UNDER the lock below (atomic with the spawn). run_eval keeps
        # its own in-subprocess guard as the CLI safety net.
        from run_eval import resume_no_gap, resume_preflight

        preflight_err, resume_tasks = resume_preflight(cfg_obj, run_dir)
        if preflight_err is not None:
            raise RuntimeError(preflight_err)
        # Resume re-executes Stage A too, so it is pinned to the original runtime exactly
        # like rerun is — and fails just as invisibly without this.
        self._assert_wiek_runtime_reusable(meta, accepted=allow_runtime_mismatch)
        config_file = self._write_config(merged, run_id)
        # "wb" truncates the prior (stopped) run's progress log — same as rerun; done/fail
        # counts come from the on-disk records, and resume re-emits skip events for the
        # already-done tasks; turns for those degrade to "—".
        log_path = self._tmp_root / f"run_{run_id}.log"

        # Atomically guard, spawn, and register in the rerun/rejudge critical section.
        with self._lock:
            if self.is_running(run_id):
                raise RuntimeError("run is still running; stop it before resuming")
            if self.is_judging(run_id):
                raise RuntimeError("a re-judge is still running; wait for it before resuming")
            # has-gap, ATOMIC: with is_running/is_judging false there is no live writer, so
            # tasks.jsonl is quiescent and this read matches what the spawned proc will see —
            # closes the stale-read window that would otherwise spawn a no-op resume (re-renders
            # all session HTML and bumps completed_at for zero work).
            if resume_no_gap(run_dir, resume_tasks):
                raise RuntimeError("resume: all tasks already complete — nothing to resume")
            log_fh = open(log_path, "wb")  # noqa: SIM115
            env = {
                **os.environ,
                "PYTHONUNBUFFERED": "1",
                # Same provenance stamp _spawn_run writes: without it a WebUI-started
                # rerun/resume publishes run.pid as origin="cli".
                run_liveness.ORIGIN_ENV: run_liveness.ORIGIN_WEBUI,
            }
            argv = [sys.executable, "-u", "run_eval.py", "--config", str(config_file),
                    "--run-id", run_id]
            if allow_runtime_mismatch:
                argv.append("--allow-runtime-mismatch")
            proc = subprocess.Popen(
                argv,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                env=env,
                start_new_session=True,
                cwd=str(Path.cwd()),
            )
            self.handles[run_id] = RunHandle(
                run_id=run_id, proc=proc, log_path=log_path, run_dir=run_dir, config_path=config_file
            )
        return run_id

    def _validate_rubric_subset(self, run_dir: Path, tid: str, rids: list[str]) -> None:
        """Validate a rubric subset synchronously against the task's prior judge.

        The subset must be contained in the prior rubric ids; binary judges have no
        rubrics → whole-task only. Raises ValueError so the endpoint maps it before spawn —
        a bad selector must fail synchronously, not silently err inside the subprocess."""
        jf = run_dir / "judges" / f"{tid}_judge.json"
        if not jf.exists():
            raise ValueError(f"task {tid} has no prior judge; use a whole-task re-judge")
        try:
            jmeta = (json.loads(jf.read_text(encoding="utf-8")) or {}).get("metadata") or {}
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"unreadable prior judge for {tid}: {exc}") from exc
        valid = {
            str(r.get("rubric_id"))
            for r in (jmeta.get("rubric_results") or [])
            if isinstance(r, dict)
        }
        if not valid:
            raise ValueError(f"task {tid} has no rubrics; whole-task re-judge only")
        unknown = set(rids) - valid
        if unknown:
            raise ValueError(f"rubric ids not in task {tid}: {sorted(unknown)}")

    def _normalize_rejudge_targets(
        self, run_dir: Path, run_id: str, targets: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Validate and normalize cart entries: every task_id must be in this
        run, no duplicates, rubric subsets must match the prior judge. Returns the spec
        entries run_judge consumes via --rejudge-spec ({task_id, rubric_ids|null})."""
        known = set(latest_by_task_id(run_dir))
        norm: list[dict[str, Any]] = []
        seen: set[str] = set()
        for entry in targets:
            tid = str(entry.get("task_id") or "").strip()
            if not tid:
                raise ValueError("re-judge target with empty task_id")
            if tid not in known:
                raise ValueError(f"task id not in run {run_id}: {tid}")
            if tid in seen:
                raise ValueError(f"duplicate re-judge target: {tid}")
            seen.add(tid)
            rids = [str(r).strip() for r in (entry.get("rubric_ids") or []) if str(r).strip()]
            if rids:
                self._validate_rubric_subset(run_dir, tid, rids)
            norm.append({"task_id": tid, "rubric_ids": rids or None})
        return norm

    def rejudge(
        self,
        run_id: str,
        *,
        targets: list[dict[str, Any]] | None = None,
        errors: bool = False,
        concurrency: int | None = None,
        model: str | None = None,
        judge_mode: str | None = None,
        new_run: bool = False,
    ) -> str:
        """Re-run Stage B without re-executing
        Stage A. ``errors=true`` → ``--rejudge-errors`` (only judge_error tasks — transient RPC
        failures, NEVER verdict=false negatives, which are correctly judged). ``targets`` →
        ``--rejudge-spec`` (the cart submit: multi task × rubric subset; rubric_ids absent =
        whole task). Both overwrite and derive accept judge model/mode/concurrency overrides;
        overwrite replaces canonical results in place and persists the chosen judge channel as
        the run's next default, while derive copies base → a new run_dir.
        Tracked in a SEPARATE judge handle (run status stays terminal). Returns the spawn
        run_id (same for overwrite, derived id for new_run)."""
        run_dir = self.output_dir() / run_id
        meta_path = run_dir / "run_metadata.json"
        if not meta_path.exists():
            raise FileNotFoundError(f"run not found or never ran: {run_id}")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))

        spec = self._normalize_rejudge_targets(run_dir, run_id, targets or [])
        if spec:
            # One job per run at a time (the guard in _spawn_action), so a per-run spec
            # file can't race a concurrent writer. Derive mode reuses the same spec: task
            # ids are identical in the copied run_dir.
            spec_path = self._tmp_root / f"rejudge_spec_{run_id}.json"
            spec_path.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")
            argv_action = ["--rejudge-spec", str(spec_path)]
            target_label = "selected"
        elif errors:
            argv_action = ["--rejudge-errors"]
            target_label = "errors"
        else:
            raise ValueError("no re-judge targets (pass targets, or errors=true)")

        merged = self._build_action_config(
            meta, kind="rejudge", concurrency=concurrency, model=model,
            judge_mode=judge_mode, new_run=new_run,
        )
        return self._spawn_action(
            run_id, run_dir, merged,
            kind="rejudge", target_label=target_label,
            argv_action=argv_action, new_run=new_run, model=model, judge_mode=judge_mode,
        )

    def is_running(self, run_id: str) -> bool:
        """Return whether this run is still executing — as our subprocess, or as an
        external process (CLI-started, or ours from before a restart) identified by
        its pid file."""
        handle = self.handles.get(run_id)
        if handle is not None:
            return handle.proc.poll() is None
        return run_liveness.is_alive(self.output_dir() / run_id)

    def is_judging(self, run_id: str) -> bool:
        """Return whether a spawned judge-only subprocess is still alive."""
        handle = self.judge_handles.get(run_id)
        return handle is not None and handle.proc.poll() is None

    def delete_run(self, run_dir: Path, run_id: str) -> None:
        """Remove the run directory and forget its handles. Guards is_running /
        is_judging under the shared lock so the check and the rmtree are atomic
        against a concurrent rerun/rejudge spawn — raises RuntimeError if either is live."""
        with self._lock:
            if self.is_running(run_id):
                raise RuntimeError("run is still running; stop it first")
            if self.is_judging(run_id):
                raise RuntimeError("a re-judge is still running; wait for it first")
            shutil.rmtree(run_dir, ignore_errors=True)
            self.handles.pop(run_id, None)
            self.judge_handles.pop(run_id, None)
