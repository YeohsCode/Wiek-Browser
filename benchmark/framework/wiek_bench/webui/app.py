"""FastAPI control console (thin orchestration layer).

Assembles config overrides, spawns the three Stage scripts, reads on-disk products,
and serves static HTML. It does not parse sessions, write tasks.jsonl, or recompute
metrics.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import os

from wiek_bench import __version__, wiek_release
from wiek_bench.captcha import is_blocked
from wiek_bench.config import load_config
from wiek_bench.datasets import get_adapter, list_datasets
from wiek_bench.report.i18n import DEFAULT_REPORT_LOCALE, ReportLocale
from wiek_bench.report.session_html import export_session_snapshot
from wiek_bench.results import read_records
from wiek_bench.skills import list_available_skills
from wiek_bench.webui.codex_models import list_codex_models
from wiek_bench.webui.pi_models import list_pi_models
from wiek_bench.webui.exporter import (
    build_single_report,
    export_sessions_bundle,
    export_single_bundle,
    resolve_downloads_dir,
)
from wiek_bench.webui.runner import RunManager, RuntimeMismatchError, _metadata_to_overrides


class StartRunBody(BaseModel):
    overrides: dict[str, Any] = {}


class SingleExportOptions(BaseModel):
    exclude: list[str] = Field(default_factory=list)
    locale: ReportLocale = DEFAULT_REPORT_LOCALE


class SingleExportBody(BaseModel):
    runs: list[str]
    options: SingleExportOptions = Field(default_factory=SingleExportOptions)


class SessionsExportBody(BaseModel):
    runs: list[str]


class WiekActivateBody(BaseModel):
    tag: str


RUNTIME_MISMATCH_CODE = "wiek_runtime_mismatch"


def _runtime_mismatch_409(exc: RuntimeMismatchError) -> HTTPException:
    """409 with a machine-readable code instead of bare prose.

    This is the one refusal the console is expected to argue with: it explains the mixed
    runtime pool in the user's language and re-sends with allow_runtime_mismatch=true if
    they accept. Every other 409 on these endpoints stays a plain string."""
    return HTTPException(
        status_code=409, detail={"code": RUNTIME_MISMATCH_CODE, "message": str(exc)}
    )


class RerunBody(BaseModel):
    # Rerun errors or selected tasks. Concurrency is overridable in both modes;
    # model only when new_run=true (in-place keeps the frozen model). ge=1 rejects 0/negative
    # at parse time (else it reaches the spawned config and silently degrades to serial).
    task_ids: list[str] = []
    errors: bool = False
    concurrency: int | None = Field(default=None, ge=1)
    model: str | None = None
    new_run: bool = False
    # The user's confirmation that a mixed wiek-browser runtime pool is acceptable; only
    # ever sent after the request was refused once with RUNTIME_MISMATCH_CODE.
    allow_runtime_mismatch: bool = False


class RejudgeTarget(BaseModel):
    # One cart entry: empty rubric_ids selects the whole task; otherwise only those
    # rubrics (odysseys). Validated against the run / prior judge before spawn (422).
    task_id: str
    rubric_ids: list[str] = []


class RejudgeBody(BaseModel):
    # errors maps to --rejudge-errors; targets maps to --rejudge-spec (the cart
    # submit: multi task × rubric subset); one required. concurrency/model/judge_mode/new_run
    # as in RerunBody (model = judge model). Rejudge model/mode apply to either overwrite or
    # derived mode; Literal rejects an invalid judge_mode at parse time (422).
    targets: list[RejudgeTarget] = []
    errors: bool = False
    concurrency: int | None = Field(default=None, ge=1)
    model: str | None = None
    judge_mode: Literal["single", "agent"] | None = None
    new_run: bool = False


class ResumeBody(BaseModel):
    # ge=1: reject concurrency<1 at request parsing (422) — without it 0/negative reaches
    # the spawned config and silently degrades to the serial path.
    concurrency: int | None = Field(default=None, ge=1)
    # Same confirmation channel as RerunBody's: resume re-executes Stage A too.
    allow_runtime_mismatch: bool = False


class QueuePauseBody(BaseModel):
    # Pausing holds the queue without touching what is already executing.
    paused: bool = True


class QueueMoveBody(BaseModel):
    # `top` is the common case (jump the queue); `to` is a 1-based target slot,
    # clamped to the queue's ends rather than rejected.
    top: bool = False
    to: int | None = Field(default=None, ge=1)


class NoteBody(BaseModel):
    # A blank free-text run note clears note.md. No length cap: it is a local
    # human memo, not user-facing input crossing a trust boundary.
    note: str = ""


def _exclude_ids(options: SingleExportOptions) -> set[str]:
    """Convert options.exclude to the same id set accepted by CLI --exclude.

    Each value is a full task_id or base_task_id. Unmatched values are allowed and
    remain visible in report metadata.
    """
    return {str(spec).strip() for spec in options.exclude if str(spec).strip()}


def _resolve_run_dir(output_dir: Path, run_id: str) -> Path:
    p = Path(run_id)
    if p.exists():
        return p
    cand = output_dir / run_id
    if cand.exists():
        return cand
    raise HTTPException(status_code=404, detail=f"run not found: {run_id}")


def create_app(config_path: str = "config.yaml") -> FastAPI:
    app = FastAPI(title="wiek-browser-benchmark-framework console", version=__version__)
    manager = RunManager(config_path=config_path)

    @app.get("/api/datasets")
    def datasets() -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for name in list_datasets():
            try:
                tasks = get_adapter(name).load()
                cats: dict[str, int] = {}
                task_list: list[dict[str, Any]] = []
                for t in tasks:
                    key = str(t.category) if t.category is not None else "unknown"
                    cats[key] = cats.get(key, 0) + 1
                    # Feed task id and category to the frontend selector from the loaded adapter.
                    task_list.append({"task_id": t.task_id, "category": key})
                out.append(
                    {"name": name, "count": len(tasks), "categories": cats, "tasks": task_list}
                )
            except Exception as exc:  # noqa: BLE001
                out.append({"name": name, "count": None, "error": str(exc)})
        return out

    @app.get("/api/config")
    def config() -> dict[str, Any]:
        return load_config(config_path).model_dump()

    @app.get("/api/skills")
    def skills() -> dict[str, Any]:
        """Return selectable skill names under the pi skills directory.

        Same roots / discovery rule as ``resolve_skill_path`` — directory scan, no pi
        subprocess. Returns ``{skills: [name...], diagnostics: [...]}``.
        """
        cfg = load_config(config_path)
        pi_home = cfg.providers.pi.resolved_home()
        return list_available_skills(pi_home, cfg.skills.dir)

    @app.get("/api/pi/models")
    def pi_models() -> dict[str, Any]:
        """Return cached provider/model entries parsed from ``pi --list-models``.

        Failures return ``{models: [], error}`` so the frontend can use free-form input.
        """
        cfg = load_config(config_path)
        pi_bin = os.environ.get(cfg.providers.pi.bin_env) or cfg.providers.pi.bin_default
        pi_agent_dir = cfg.providers.pi.resolved_home() / ".pi" / "agent"
        return list_pi_models(pi_bin, pi_agent_dir)

    @app.get("/api/codex/models")
    async def codex_models(codex_home: str | None = None) -> dict[str, Any]:
        """Codex SDK model catalog from the same isolated home used by measured runs."""
        cfg = load_config(config_path)
        codex_cfg = cfg.providers.codex
        codex_bin_override = os.environ.get(codex_cfg.bin_env) or codex_cfg.bin_default
        home = Path(codex_home).resolve() if codex_home else codex_cfg.resolved_home()
        return await list_codex_models(codex_bin_override, home)

    @app.get("/api/wiek-browser/releases")
    def wiek_browser_releases() -> dict[str, Any]:
        """Return wiek-browser releases and the active version.

        This thin endpoint delegates to ``wiek_release``. Network and rate-limit
        failures return an ``error`` field instead of raising a 500 response.
        """
        return wiek_release.releases_payload(load_config(config_path).wiek_browser)

    @app.get("/api/wiek-browser/status")
    def wiek_browser_status() -> dict[str, Any]:
        """Return the active version and local cache without accessing GitHub."""
        return wiek_release.status_payload(load_config(config_path).wiek_browser)

    @app.post("/api/wiek-browser/activate")
    def wiek_browser_activate(body: WiekActivateBody) -> dict[str, Any]:
        """Download when needed and rebuild the Wiek Browser debug symlink."""
        cfg = load_config(config_path).wiek_browser
        try:
            return wiek_release.activate(cfg, body.tag)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/wiek-browser/restore-external")
    def wiek_browser_restore() -> dict[str, Any]:
        """Restore the external or development-build symlink, or return 400."""
        cfg = load_config(config_path).wiek_browser
        try:
            return wiek_release.restore_external(cfg)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/artifacts")
    def artifacts() -> list[dict[str, Any]]:
        """List generated artifacts by run without producing new artifacts."""
        output_dir = manager.output_dir()
        if not output_dir.exists():
            return []
        groups: list[tuple[str, dict[str, Any]]] = []
        for run_dir in sorted(output_dir.glob("*")):
            if not run_dir.is_dir():
                continue

            def _files(pattern: str) -> list[dict[str, Any]]:
                out = []
                for p in sorted(run_dir.glob(pattern)):
                    st = p.stat()
                    out.append({"name": p.name, "mtime": st.st_mtime, "size": st.st_size})
                return out

            reports = _files("report_*.html")
            sessions_dir = run_dir / "sessions_html"
            sessions = list(sessions_dir.glob("*.html")) if sessions_dir.is_dir() else []
            if not reports and not sessions:
                continue
            mtimes = [f["mtime"] for f in reports]
            mtimes += [p.stat().st_mtime for p in sessions]
            # Surface which models ran this run: agent model (e.g. "gpt-5.5") +
            # judge model (e.g. "openai-codex/gpt-5.4"), straight from the metadata snapshot.
            meta = {}
            meta_path = run_dir / "run_metadata.json"
            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                except Exception:  # noqa: BLE001
                    meta = {}
            started_at = meta.get("started_at")
            groups.append(
                (
                    started_at if isinstance(started_at, str) else "",
                    {
                        "run_id": run_dir.name,
                        "derived_from": meta.get("derived_from"),
                        "reports": reports,
                        "sessions_count": len(sessions),
                        "latest_mtime": max(mtimes, default=0.0),
                        # dataset (benchmark) for the Artifacts category grouping/filter.
                        "benchmark": meta.get("benchmark"),
                        "model": meta.get("model"),
                        "provider": meta.get("provider")
                        or ("pi" if meta.get("pi_provider") else None),
                        "model_provider": meta.get("model_provider")
                        or meta.get("pi_provider"),
                        # agent provider, so the task model renders provider/model like the
                        # judge does (e.g. "openai-codex/gpt-5.5").
                        "pi_provider": meta.get("pi_provider"),
                        "judge_model": meta.get("judge_model"),
                        "judge_mode": meta.get("judge_mode"),
                        # Manual run note (runs/<id>/note.md), shared by Runs and Artifacts.
                        "note": RunManager.read_note(run_dir),
                    },
                )
            )
        # Run history order comes from the run snapshot, not from derived product mtimes:
        # rebuilding report_*.html must not move an old run to the front. Metadata-less
        # legacy groups sort last; run_id is a deterministic tie-breaker.
        groups.sort(key=lambda row: (row[0], row[1]["run_id"]), reverse=True)
        return [group for _, group in groups]

    @app.get("/api/runs")
    def list_runs() -> list[dict[str, Any]]:
        output_dir = manager.output_dir()
        # Queued runs have no run_dir yet, so they cannot come from the directory walk.
        # They are prepended as rows of the same shape with `queued: true`, which is what
        # lets the Runs table render the queue as a group at the top of the same list.
        queue_state = manager.queue_state()
        runs: list[dict[str, Any]] = [
            {
                "run_id": item["run_id"],
                "derived_from": None,
                "benchmark": item.get("benchmark"),
                "browser_tool": item.get("browser_tool"),
                "model": item.get("model"),
                "provider": item.get("provider"),
                "completed_at": None,
                "cancelled": None,
                "concurrency": None,
                "running": False,
                "judging": False,
                "queued": True,
                "queue_position": item.get("position"),
                "queued_at": item.get("queued_at"),
                "queue_paused": queue_state["paused"],
                "preflight": item.get("preflight"),
                "queue_error": item.get("error"),
                "origin": "webui",
                "stage": None,
                "task_count_planned": item.get("task_count_planned"),
                "done": 0,
                "fail": 0,
                "captcha": 0,
                "has_summary": False,
                "note": "",
            }
            for item in queue_state["queue"]
        ]
        if not output_dir.exists():
            return runs
        executing = set(queue_state["executing"])
        for run_dir in sorted(output_dir.glob("*"), reverse=True):
            if not run_dir.is_dir():
                continue
            meta_path = run_dir / "run_metadata.json"
            meta = {}
            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                except Exception:  # noqa: BLE001
                    meta = {}
            records = read_records(run_dir)
            # Three-way split, same as the per-task status in RunManager.progress. An
            # intercepted task carries no error, so it must be excluded from `done`
            # explicitly or it would silently count as a success here.
            captcha_blocked = sum(1 for r in records if is_blocked(r))
            fail = sum(1 for r in records if r.get("error"))
            done = sum(1 for r in records if not r.get("error") and not is_blocked(r))
            runs.append(
                {
                    "run_id": run_dir.name,
                    "derived_from": meta.get("derived_from"),
                    "benchmark": meta.get("benchmark"),
                    "browser_tool": meta.get("browser_tool"),
                    "model": meta.get("model"),
                    "provider": meta.get("provider") or ("pi" if meta.get("pi_provider") else None),
                    "completed_at": meta.get("completed_at"),
                    # cancelled gates the resume button; concurrency prefills its
                    # input (default = original). Both read straight from the snapshot.
                    "cancelled": meta.get("cancelled"),
                    "concurrency": meta.get("concurrency"),
                    # Real process liveness (same source as the DELETE 409 guard), NOT
                    # derived from completed_at — a crashed run missing completed_at is
                    # not "running" and must stay deletable.
                    "running": manager.is_running(run_dir.name),
                    # Keep an in-flight judge-only re-judge separate from regular run state
                    # from `running` so the run stays "done" + deletable-after, but the
                    # list can still surface "judging" and keep polling after a refresh
                    # so it remains visible after a refresh.
                    "judging": manager.is_judging(run_dir.name),
                    "queued": False,
                    "queue_position": None,
                    # Who launched it. Absent on runs written before the field existed;
                    # the frontend simply shows no provenance badge for those.
                    "origin": meta.get("origin"),
                    # Which stage owns the run right now, and therefore whether it still
                    # holds the queue's execution slot: "A" occupies it, "B" (exporting /
                    # judging, after completed_at) has already released it.
                    "stage": (
                        ("A" if run_dir.name in executing else "B")
                        if manager.is_running(run_dir.name)
                        else None
                    ),
                    "task_count_planned": meta.get("task_count_planned"),
                    "done": done,
                    "fail": fail,
                    "captcha": captcha_blocked,
                    "has_summary": (run_dir / "summary.json").exists(),
                    # Same manual note surfaced by /api/artifacts; both views edit note.md.
                    "note": RunManager.read_note(run_dir),
                }
            )
        return runs

    @app.post("/api/runs")
    def start_run(body: StartRunBody) -> dict[str, Any]:
        """Submit a run. Starts immediately when the Stage-A slot is free, otherwise
        queues it; the response says which happened (``queued`` + 1-based ``position``)."""
        try:
            return manager.start_run(body.overrides)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/queue")
    def get_queue() -> dict[str, Any]:
        return manager.queue_state()

    @app.post("/api/queue/pause")
    def pause_queue(body: QueuePauseBody) -> dict[str, Any]:
        return {"paused": manager.queue_set_paused(body.paused)}

    @app.post("/api/queue/{run_id}/start-now")
    def queue_start_now(run_id: str) -> dict[str, str]:
        """Launch a queued run ahead of its turn. The taskspace purge still runs."""
        try:
            return {"run_id": manager.queue_start_now(run_id)}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"not queued: {run_id}") from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/queue/{run_id}/move")
    def queue_move(run_id: str, body: QueueMoveBody) -> dict[str, int]:
        try:
            return {"position": manager.queue_move(run_id, to_top=body.top, to=body.to)}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"not queued: {run_id}") from exc

    @app.get("/api/runs/{run_id}/progress")
    def run_progress(run_id: str) -> dict[str, Any]:
        return manager.progress(run_id)

    @app.get("/api/runs/{run_id}/judge-progress")
    def run_judge_progress(run_id: str) -> dict[str, Any]:
        """Return judge aggregates, per-task verdict/time/turns/cost, and
        judge-session links. Separate from /progress so the Progress view's poll stays Stage-A
        lean and only the Judge view pays the per-task judge-file reads."""
        return manager.judge_progress(run_id)

    def _note_dir(run_id: str) -> Path:
        """Resolve a run dir for the note.md read/write sink, refusing any run_id that
        escapes output_dir (e.g. ``..`` → one level up) — same containment guard delete_run
        uses for its destructive op, applied here because note.md is a write/delete sink."""
        output_dir = manager.output_dir()
        run_dir = _resolve_run_dir(output_dir, run_id)
        if output_dir.resolve() not in run_dir.resolve().parents:
            raise HTTPException(status_code=400, detail="run_id escapes output_dir")
        return run_dir

    @app.get("/api/runs/{run_id}/note")
    def get_note(run_id: str) -> dict[str, str]:
        """Return the free-text runs/<id>/note.md value, or an empty string."""
        return {"note": manager.read_note(_note_dir(run_id))}

    @app.put("/api/runs/{run_id}/note")
    def put_note(run_id: str, body: NoteBody) -> dict[str, str]:
        """Persist a run note, or clear it when blank."""
        return {"note": manager.write_note(_note_dir(run_id), body.note)}

    @app.get("/api/runs/{run_id}/summary")
    def run_summary(run_id: str) -> dict[str, Any]:
        run_dir = _resolve_run_dir(manager.output_dir(), run_id)
        summary_path = run_dir / "summary.json"
        if not summary_path.exists():
            raise HTTPException(status_code=404, detail="summary.json not found (run not judged?)")
        return json.loads(summary_path.read_text(encoding="utf-8"))

    @app.get("/api/runs/{run_id}/config")
    def run_config(run_id: str) -> dict[str, Any]:
        """Convert a configuration snapshot to form overrides for reuse."""
        run_dir = _resolve_run_dir(manager.output_dir(), run_id)
        meta_path = run_dir / "run_metadata.json"
        if not meta_path.exists():
            raise HTTPException(status_code=404, detail="run_metadata.json not found")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        return _metadata_to_overrides(meta)

    @app.get("/api/runs/{run_id}/system-prompt")
    def run_system_prompt(run_id: str) -> dict[str, Any]:
        """Return the first task's dumped system prompt and tools for display.

        The endpoint normalizes the full dump structure
        back to the stable frontend shape {systemPrompt, tools:[{name, description}]},
        so the richer structure (systemPromptOptions / tool parameters / contextFiles /
        skills) stays debug-only and the frontend contract is decoupled from it.
        """
        run_dir = _resolve_run_dir(manager.output_dir(), run_id)
        records = read_records(run_dir)
        if not records:
            return {}
        first = str(records[0].get("task_id"))
        sp = run_dir / "system_prompt" / f"{first}.json"
        if not sp.exists():
            return {}
        try:
            data = json.loads(sp.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return {}
        tools = [
            {"name": t.get("name", ""), "description": t.get("description", "")}
            for t in (data.get("activeTools") or [])
            if isinstance(t, dict)
        ]
        return {"systemPrompt": data.get("systemPrompt", ""), "tools": tools}

    snapshot_locks: dict[str, asyncio.Lock] = {}

    @app.post("/api/runs/{run_id}/tasks/{task_id}/session-snapshot")
    async def session_snapshot(run_id: str, task_id: str) -> dict[str, str]:
        """Render a live conversation snapshot for a task by locating the session via
        the progress-event mapping (running) or tasks.jsonl (finished), render via
        pi export_html into sessions_live/, serve through the /runs mount.
        Per-task lock: concurrent clicks queue instead of piling up pi processes."""
        run_dir = _resolve_run_dir(manager.output_dir(), run_id)
        session_file = manager.session_file_for(run_id, task_id)
        if not session_file or not Path(session_file).exists():
            raise HTTPException(
                status_code=404, detail="session file not known yet for this task"
            )
        lock = snapshot_locks.setdefault(f"{run_id}/{task_id}", asyncio.Lock())
        async with lock:
            out = await export_session_snapshot(run_dir, task_id, session_file)
        if out is None:
            raise HTTPException(status_code=502, detail="snapshot export failed")
        return {"url": f"/runs/{run_dir.name}/sessions_live/{out.name}"}

    @app.post("/api/runs/{run_id}/rerun")
    def rerun_run(run_id: str, body: RerunBody) -> dict[str, str]:
        """Force-rerun this run's error or selected tasks.
        Overwrite (new_run=false): in-place, returns the same run_id. Derive (new_run=true):
        a new run with an optional new model + concurrency, returns the DERIVED run_id.
        409 if (base) running / re-judging; 422 if no tasks resolve; 404 if the run never ran.
        409 + detail.code=wiek_runtime_mismatch when the active wiek-browser runtime is not the
        one this run was recorded against — retry with allow_runtime_mismatch=true to accept."""
        _resolve_run_dir(manager.output_dir(), run_id)
        try:
            rid = manager.rerun(
                run_id,
                task_ids=body.task_ids,
                errors=body.errors,
                concurrency=body.concurrency,
                model=body.model,
                new_run=body.new_run,
                allow_runtime_mismatch=body.allow_runtime_mismatch,
            )
        except RuntimeMismatchError as exc:
            raise _runtime_mismatch_409(exc) from exc
        except RuntimeError as exc:  # still running / base busy on derive
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"run_id": rid}

    @app.post("/api/runs/{run_id}/rejudge")
    def rejudge_run(run_id: str, body: RejudgeBody) -> dict[str, str]:
        """Re-run only the judge without re-executing Stage A.
        errors=true → judge-errored tasks; targets → the cart submit (multi task × rubric
        subset, --rejudge-spec); one required. Overwrite returns the same run_id; derive
        (new_run) returns the DERIVED run_id. Both destinations accept judge model/mode. 409 if (base)
        running / re-judging; 422 if no/invalid targets; 404 if the run never ran."""
        _resolve_run_dir(manager.output_dir(), run_id)
        try:
            rid = manager.rejudge(
                run_id,
                targets=[t.model_dump() for t in body.targets],
                errors=body.errors,
                concurrency=body.concurrency,
                model=body.model,
                judge_mode=body.judge_mode,
                new_run=body.new_run,
            )
        except RuntimeError as exc:  # still running / already re-judging / base busy on derive
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"run_id": rid}

    @app.get("/api/runs/{run_id}/tasks/{task_id}/judge")
    def task_judge(run_id: str, task_id: str) -> dict[str, Any]:
        """Return a per-task judge snapshot for the cart's rubric picker: verdict and
        per-rubric breakdown, read straight from judges/<task_id>_judge.json. Binary
        judges have no rubric_results → has_rubrics=false. 404 if the task isn't judged."""
        run_dir = _resolve_run_dir(manager.output_dir(), run_id)
        jf = run_dir / "judges" / f"{task_id}_judge.json"
        if not jf.exists():
            raise HTTPException(status_code=404, detail="task not judged yet (no _judge.json)")
        try:
            data = json.loads(jf.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"unreadable judge file: {exc}") from exc
        meta = data.get("metadata") or {}
        rubrics = [
            {
                "rubric_id": r.get("rubric_id"),
                "requirement": r.get("requirement"),
                "verification": r.get("verification"),
                "satisfied": r.get("satisfied"),
                "confidence": r.get("confidence"),
                "reasoning": r.get("reasoning"),
            }
            for r in (meta.get("rubric_results") or [])
            if isinstance(r, dict)
        ]
        return {
            "task_id": task_id,
            "verdict": data.get("verdict"),
            "score": data.get("score"),
            "judge_error": data.get("judge_error"),
            "judge_model": data.get("judge_model"),
            "judge_mode": data.get("judge_mode"),
            "has_rubrics": bool(rubrics),
            "rubrics": rubrics,
        }

    @app.post("/api/runs/{run_id}/stop")
    def stop_run(run_id: str) -> dict[str, bool]:
        return {"stopped": manager.stop_run(run_id)}

    @app.post("/api/runs/{run_id}/resume")
    def resume_run(run_id: str, body: ResumeBody) -> dict[str, str]:
        """Resume a stopped or cancelled run in place by spawning run_eval in the same
        run_dir with the frozen config + resume=true (no --rerun-task-ids), so only the
        unfinished tasks run; in-flight tasks dropped at stop are re-run from scratch.
        Optional concurrency override. Returns the same run_id. 409 if still running /
        re-judging or the preflight rejects it (sampling drift / no unfinished tasks); 404 if
        the run never ran. Same wiek_runtime_mismatch confirmation channel as rerun."""
        _resolve_run_dir(manager.output_dir(), run_id)
        try:
            rid = manager.resume_run(
                run_id,
                concurrency=body.concurrency,
                allow_runtime_mismatch=body.allow_runtime_mismatch,
            )
        except RuntimeMismatchError as exc:
            raise _runtime_mismatch_409(exc) from exc
        except RuntimeError as exc:  # still running / re-judging / preflight drift / no-gap
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"run_id": rid}

    @app.delete("/api/runs/{run_id}")
    def delete_run(run_id: str) -> dict[str, bool]:
        """Delete a run directory unless it is still running.

        A queued run has no directory yet, so deleting it means dropping it from the
        queue — same button, same expectation ("this run goes away")."""
        if manager.queue_cancel(run_id):
            return {"deleted": True}
        output_dir = manager.output_dir()
        run_dir = _resolve_run_dir(output_dir, run_id)
        # Destructive op: never rmtree outside output_dir, whatever run_id resolved to.
        if output_dir.resolve() not in run_dir.resolve().parents:
            raise HTTPException(status_code=400, detail="run_id escapes output_dir")
        # delete_run guards is_running and is_judging under the shared lock, so the
        # check and the rmtree are atomic against a concurrent rerun/rejudge spawn — a
        # separate pre-check here would reintroduce the TOCTOU race.
        try:
            manager.delete_run(run_dir, run_id)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"deleted": True}

    @app.post("/api/export/single")
    async def export_single(body: SingleExportBody) -> dict[str, str]:
        output_dir = manager.output_dir()
        run_dirs = [_resolve_run_dir(output_dir, r) for r in body.runs]
        downloads = resolve_downloads_dir(load_config(config_path).webui.downloads_dir)
        path = await asyncio.to_thread(
            export_single_bundle,
            run_dirs,
            downloads,
            exclude_ids=_exclude_ids(body.options),
            locale=body.options.locale,
        )
        return {"path": str(path)}

    @app.post("/api/report/single")
    async def report_single(body: SingleExportBody) -> dict[str, str]:
        """Render single-run report HTML into the run directory without a zip."""
        output_dir = manager.output_dir()
        run_dirs = [_resolve_run_dir(output_dir, r) for r in body.runs]
        path = await asyncio.to_thread(
            build_single_report,
            run_dirs,
            exclude_ids=_exclude_ids(body.options),
            locale=body.options.locale,
        )
        return {"path": str(path)}

    @app.post("/api/export/sessions")
    async def export_sessions(body: SessionsExportBody) -> dict[str, str]:
        output_dir = manager.output_dir()
        run_dirs = [_resolve_run_dir(output_dir, r) for r in body.runs]
        downloads = resolve_downloads_dir(load_config(config_path).webui.downloads_dir)
        path = await asyncio.to_thread(export_sessions_bundle, run_dirs, downloads)
        return {"path": str(path)}

    # static products (report_*.html / sessions_html), browsed in new tabs
    output_dir = manager.output_dir()
    output_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/runs", StaticFiles(directory=str(output_dir)), name="runs")

    # SPA dist (production); index fallback when present
    cfg = load_config(config_path)
    dist = Path(cfg.webui.frontend_dist or "frontend/dist")

    @app.get("/")
    def index() -> Any:
        index_html = dist / "index.html"
        if index_html.exists():
            return FileResponse(str(index_html))
        return JSONResponse(
            {
                "service": "wiek-browser-benchmark-framework console",
                "frontend": f"not built ({dist}). run: cd frontend && pnpm install && pnpm build",
                "api": ["/api/datasets", "/api/config", "/api/runs"],
            }
        )

    if dist.exists():
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="spa")

    return app
