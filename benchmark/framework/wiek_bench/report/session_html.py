"""Per-task rich session HTML for Pi sessions and Codex rollouts.

Pi sessions use RPC ``export_html`` with their original startup params. Codex
rollouts use the local static renderer because the Python SDK has no equivalent.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from loguru import logger

from wiek_bench.codex_context import codex_context_audit_is_current, write_codex_context_audit
from wiek_bench.judges.pi_judge import judge_channel_flags
from wiek_bench.pi_rpc import PiRpcSession
from wiek_bench.report.codex_session_html import (
    is_codex_session_file,
    render_codex_session_html,
)
from wiek_bench.results import latest_by_task_id


def _build_pi_argv(meta: dict, session_file: str) -> list[str]:
    pi_bin = meta.get("pi_bin") or "pi"
    provider = meta.get("pi_provider") or "openai"
    model = meta.get("model") or "gpt-5.5"
    thinking = meta.get("thinking_level") or "medium"
    allowed = (meta.get("providers") or {}).get("pi", {}).get("allowed_tools") or ["bash"]
    argv = [
        pi_bin,
        "--mode",
        "rpc",
        "--provider",
        provider,
        "--model",
        model,
        "--thinking",
        thinking,
        "--tools",
        ",".join(allowed),
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--no-themes",
    ]
    skill = meta.get("skill_source_path")
    if skill and Path(skill).exists():
        argv += ["--skill", skill]
    argv += ["--session", session_file]
    return argv


def _export_env(meta: dict) -> dict[str, str]:
    env = {**os.environ}
    if meta.get("pi_agent_dir"):
        env["PI_CODING_AGENT_DIR"] = meta["pi_agent_dir"]
    if meta.get("agent_home"):
        env["PI_HOME"] = meta["agent_home"]
    return env


def _codex_audit_skill(meta: dict) -> tuple[str | None, Path | None]:
    """Expected managed skill from run configuration, never from observed rollout data."""
    skill_name = meta.get("skill_name")
    codex_home = meta.get("codex_home") or (meta.get("providers") or {}).get("codex", {}).get(
        "codex_home"
    )
    if not isinstance(skill_name, str) or not skill_name:
        return None, None
    if not isinstance(codex_home, str) or not codex_home:
        return skill_name, None
    return skill_name, Path(codex_home).resolve() / "skills" / skill_name / "SKILL.md"


def _build_judge_pi_argv(
    meta: dict,
    judge_model: str,
    session_file: str,
    *,
    judge_mode: str | None = None,
    judge_tools: list[str] | None = None,
    judge_skill_path: str | None = None,
) -> list[str]:
    """Reopen a judge session for export_html in the judge channel's exact shape (shared
    ``judge_channel_flags`` from ``wiek_bench.judges.pi_judge``), per the channel the judge
    ACTUALLY ran in — single (no tools/skills) or agent (readonly+bash + judge skill +
    --no-extensions). The channel is read PER judge payload (passed in here), not from the
    global run_metadata: ``run_judge --judge-mode`` / a judge that fell back to single can
    differ from the Stage A default, so a per-payload value keeps the export in lockstep
    Falls back to run metadata, then single mode, for older payloads missing these fields.

    The session file already carries its own model / provider / thinking_level (restored on
    load), so we pass the recorded judge_model for a matching shape but omit --thinking.
    """
    pi_bin = meta.get("pi_bin") or "pi"
    provider, model_id = judge_model.split("/", 1) if "/" in (judge_model or "") else ("", judge_model)
    argv = [pi_bin, "--mode", "rpc"]
    if provider:
        argv += ["--provider", provider]
    if model_id:
        argv += ["--model", model_id]
    argv += judge_channel_flags(
        mode=judge_mode or meta.get("judge_mode") or "single",
        tools=judge_tools if judge_tools is not None else (meta.get("judge_tools") or []),
        skill_path=judge_skill_path or meta.get("judge_skill_path"),
    )
    argv += ["--session", session_file]
    return argv


async def _export_one(
    meta: dict,
    session_file: str,
    out_path: Path,
    cwd: str,
    argv: list[str] | None = None,
    context_audit_path: Path | None = None,
) -> bool:
    if is_codex_session_file(session_file):
        try:
            expected_skill_name, expected_skill_path = _codex_audit_skill(meta)
            if context_audit_path is not None and not codex_context_audit_is_current(
                context_audit_path, session_file
            ):
                await asyncio.to_thread(
                    write_codex_context_audit,
                    context_audit_path,
                    session_file,
                    expected_skill_name=expected_skill_name,
                    expected_skill_path=expected_skill_path,
                )
            await asyncio.to_thread(
                render_codex_session_html,
                session_file,
                out_path,
                task_id=out_path.stem,
                context_audit_path=context_audit_path,
            )
            return out_path.exists()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Codex session HTML failed for {}: {}", out_path.name, exc)
            return False
    argv = argv if argv is not None else _build_pi_argv(meta, session_file)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    session = PiRpcSession(argv, cwd=cwd, env=_export_env(meta))
    try:
        await session.start()
        await asyncio.sleep(0.2)  # let session load
        await asyncio.wait_for(session.export_html(str(out_path)), timeout=60.0)
        await session.abort()
        return out_path.exists()
    except Exception as exc:  # noqa: BLE001
        logger.warning("export_html failed for {}: {}", out_path.name, exc)
        return False
    finally:
        await session.shutdown()


async def export_session_snapshot(
    run_dir: str | Path, task_id: str, session_file: str
) -> Path | None:
    """Render a live snapshot of one possibly still-running session.

    Renders via the same pi export_html path as export_run_sessions, into
    ``sessions_live/<task_id>.html`` (overwritten per call — debug artifact,
    excluded from Artifacts/exports). Returns the path, or None on failure.
    """
    run_dir = Path(run_dir).resolve()
    meta_path = run_dir / "run_metadata.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    out_dir = run_dir / "sessions_live"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{task_id}.html"
    ok = await _export_one(
        meta,
        session_file,
        out_path,
        cwd=str(run_dir),
        context_audit_path=run_dir / "system_prompt" / f"{task_id}.json",
    )
    return out_path if ok else None


async def export_run_sessions_async(run_dir: str | Path, *, concurrency: int = 2) -> list[Path]:
    run_dir = Path(run_dir).resolve()
    meta_path = run_dir / "run_metadata.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    out_dir = run_dir / "sessions_html"
    out_dir.mkdir(parents=True, exist_ok=True)

    records = latest_by_task_id(run_dir)
    sem = asyncio.Semaphore(concurrency)
    results: list[Path] = []

    async def _one(task_id: str, rec: dict) -> None:
        session_file = rec.get("session_file")
        if not session_file or not Path(session_file).exists():
            return
        out_path = out_dir / f"{task_id}.html"
        async with sem:
            ok = await _export_one(
                meta,
                session_file,
                out_path,
                cwd=str(run_dir),
                context_audit_path=run_dir / "system_prompt" / f"{task_id}.json",
            )
        if ok:
            results.append(out_path)

    await asyncio.gather(*(_one(tid, rec) for tid, rec in records.items()))
    logger.info("exported {} session HTML files → {}", len(results), out_dir)
    return results


def export_run_sessions(run_dir: str | Path) -> list[Path]:
    return asyncio.run(export_run_sessions_async(run_dir))


async def export_run_judge_sessions_async(
    run_dir: str | Path, *, concurrency: int = 2
) -> list[Path]:
    """Export judge pi sessions into a separate judge_sessions_html tree.

    Reads each canonical ``judges/<task_id>_judge.json`` (alt-model files end in
    ``_<model>.json`` and are skipped by the glob):
      - odysseys (per-rubric, ``judge_sessions`` present): one HTML per rubric at
        ``judge_sessions_html/<task_id>/<rubric_id>.html``;
      - single-call judges (only ``judge_session_file``): ``judge_sessions_html/<task_id>.html``.
    Sessions are rendered with the judge's startup params (no-tools/no-skills), not the
    agent's. Best-effort: a missing session file is skipped.
    """
    run_dir = Path(run_dir).resolve()
    meta_path = run_dir / "run_metadata.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    judges_dir = run_dir / "judges"
    if not judges_dir.is_dir():
        return []
    out_root = run_dir / "judge_sessions_html"

    jobs: list[tuple[str, str, Path, dict]] = []  # (judge_model, session_file, out_path, channel)
    for jf in sorted(judges_dir.glob("*_judge.json")):
        try:
            payload = json.loads(jf.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        # task_id field is preferred; fall back to the filename for pre-existing
        # judge payloads written before the field was added.
        task_id = payload.get("task_id") or jf.name[: -len("_judge.json")]
        judge_model = payload.get("judge_model") or meta.get("judge_model") or ""
        # Per-payload channel (mode/tools/skill) — the channel this judge actually ran in,
        # which can differ from the global run_metadata after run_judge --judge-mode.
        channel = {
            "judge_mode": payload.get("judge_mode"),
            "judge_tools": payload.get("judge_tools"),
            "judge_skill_path": payload.get("judge_skill_path"),
        }
        sessions = payload.get("judge_sessions")
        if isinstance(sessions, list) and sessions:
            for s in sessions:
                sf = (s or {}).get("session_file")
                rid = (s or {}).get("rubric_id")
                if sf and rid and Path(sf).exists():
                    jobs.append((judge_model, sf, out_root / task_id / f"{rid}.html", channel))
        else:
            sf = payload.get("judge_session_file")
            if sf and Path(sf).exists():
                jobs.append((judge_model, sf, out_root / f"{task_id}.html", channel))

    if not jobs:
        return []
    sem = asyncio.Semaphore(concurrency)
    results: list[Path] = []

    async def _one(judge_model: str, session_file: str, out_path: Path, channel: dict) -> None:
        argv = _build_judge_pi_argv(meta, judge_model, session_file, **channel)
        async with sem:
            ok = await _export_one(meta, session_file, out_path, cwd=str(run_dir), argv=argv)
        if ok:
            results.append(out_path)

    await asyncio.gather(*(_one(jm, sf, op, ch) for jm, sf, op, ch in jobs))
    logger.info("exported {} judge session HTML files → {}", len(results), out_root)
    return results


def export_run_judge_sessions(run_dir: str | Path) -> list[Path]:
    return asyncio.run(export_run_judge_sessions_async(run_dir))
