"""TaskRecord and tasks.jsonl I/O (core product layer).

Stage A appends one TaskRecord line per task; Stage B rewrites the file to
backfill judge fields. Writes are atomic (temp file + os.replace).
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from wiek_bench.judges.base import JudgeResult

TASKS_FILENAME = "tasks.jsonl"
ATTEMPTS_DIRNAME = "attempts"


@dataclass(frozen=True)
class TaskAttemptRecord:
    """One provider lifecycle inside a task retry loop.

    This is control-flow provenance, not derived session metrics. Consumers resolve
    ``session_file`` through ``session_parser`` for turns/tokens/timing/cost.
    """

    task_id: str
    attempt_index: int
    session_id: str | None = None
    session_file: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    provider_error: str | None = None
    failure_reason: str | None = None
    step_limit_hit: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class TaskRecord:
    task_id: str
    benchmark: str
    provider: str
    browser_tool: str
    skill_name: str
    category: str | None = None
    skill_file_hash_at_task_start: str | None = None
    base_task_id: str | None = None
    iteration_index: int = 1
    session_id: str | None = None
    session_file: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    attempt_count: int = 1
    concurrency_slot: int | None = None
    close_executed_by: str | None = None
    close_returncode: int | None = None
    screenshot_capture_mode: str | None = None
    screenshot_dedup_method: str | None = None
    # Screenshot limit visible to the judge; frames/ retains every unique frame.
    screenshot_max_judge: int | None = None
    screenshot_paths: list[str] = field(default_factory=list)  # All deduplicated frames/NNN.webp files.
    screenshot_manifest: str | None = None  # Command-to-frame/tree mapping in frames/manifest.jsonl.
    screenshot_errors: str | None = None
    screenshot_trees_dir: str | None = None  # Optional frames/trees AX evidence directory.
    pi_stderr_path: str | None = None
    error: str | None = None
    # Agent self-reported an unpassable human-verification wall. Deliberately NOT folded
    # into ``error``: the run itself was valid, so resume treats the task as done, the
    # error counts stay clean, and the sample keeps its real timing/cost for the report.
    # Consumers read it through ``wiek_bench.captcha.is_blocked``.
    blocked_by_captcha: bool = False
    captcha_detail: str | None = None
    # Stage B backfill:
    score: float | None = None  # 0/1 binary judges; [0,1] partial credit (odysseys)
    verdict: bool | None = None
    # Odysseys-family per-rubric counts (None for binary judges / no-rubric runs).
    # Persisted so the report's odysseys module can compute the paper's rubric-micro
    # average (Σ passed / Σ total) without rereading judge sessions.
    num_rubrics: int | None = None
    num_rubrics_passed: int | None = None
    failure_reason: str | None = None
    impossible_task: bool | None = None
    reached_captcha: bool | None = None
    judge_reasoning: str | None = None
    judge_model: str | None = None
    judge_error: str | None = None
    judged_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def tasks_path(run_dir: str | Path) -> Path:
    return Path(run_dir) / TASKS_FILENAME


def attempts_path(run_dir: str | Path, task_id: str) -> Path:
    return Path(run_dir) / ATTEMPTS_DIRNAME / f"{task_id}.json"


def write_task_attempt_records(
    run_dir: str | Path,
    task_id: str,
    records: list[TaskAttemptRecord],
) -> Path:
    """Atomically replace one task's retry provenance.

    A per-task file avoids cross-worker write contention. Replaying or force-rerunning
    the task replaces the old lifecycle instead of mixing two attempt sequences.
    """
    path = attempts_path(run_dir, task_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "task_id": task_id,
        "attempts": [record.to_dict() for record in records],
    }
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return path


def read_task_attempt_records(run_dir: str | Path, task_id: str) -> list[dict[str, Any]]:
    """Read one task's ordered attempt provenance; missing files mean legacy data."""
    path = attempts_path(run_dir, task_id)
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise ValueError(f"unsupported attempt provenance schema: {path}")
    attempts = payload.get("attempts")
    if not isinstance(attempts, list) or not all(isinstance(row, dict) for row in attempts):
        raise ValueError(f"invalid attempt provenance payload: {path}")
    return attempts


def resolve_run_dir(spec: str, output_dir: str = "runs") -> Path:
    """Resolve a run spec to its dir: a literal path if it exists, else <output_dir>/<spec>."""
    p = Path(spec)
    if p.exists():
        return p
    cand = Path(output_dir) / spec
    if cand.exists():
        return cand
    raise FileNotFoundError(f"run dir not found: {spec}")


def append_task_record(
    run_dir: str | Path, record: TaskRecord, *, force_overwrite: bool = False
) -> None:
    """Append a record; prior rows with the same task_id may be replaced via atomic
    rewrite so a retried/resumed/rerun task never leaves duplicate ids.

    - default: only prior *error* rows are replaced; successful rows are left
      untouched (plain append) for resume/retry semantics.
    - ``force_overwrite=True``: **all** prior rows with this task_id are replaced
      (successful rows included) for a selective force-rerun."""
    path = tasks_path(run_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = read_records(run_dir)
    if force_overwrite:
        kept = [row for row in rows if str(row.get("task_id")) != record.task_id]
    else:
        kept = [
            row
            for row in rows
            if not (str(row.get("task_id")) == record.task_id and row.get("error"))
        ]
    if len(kept) != len(rows):
        kept.append(record.to_dict())
        _write_all_rows(run_dir, kept)
        return
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record.to_dict(), ensure_ascii=False) + "\n")


def read_records(run_dir: str | Path) -> list[dict[str, Any]]:
    """All rows in file order (duplicates kept)."""
    path = tasks_path(run_dir)
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def latest_by_task_id(run_dir: str | Path) -> dict[str, dict[str, Any]]:
    """task_id -> last row (Stage B default: last write wins)."""
    out: dict[str, dict[str, Any]] = {}
    for row in read_records(run_dir):
        tid = row.get("task_id")
        if tid is not None:
            out[str(tid)] = row
    return out


def task_already_done(run_dir: str | Path, task_id: str) -> bool:
    """A task counts as done iff a row with that id exists and has no error."""
    for row in read_records(run_dir):
        if str(row.get("task_id")) == str(task_id) and not row.get("error"):
            return True
    return False


def _write_all_rows(run_dir: str | Path, rows: list[dict[str, Any]]) -> None:
    path = tasks_path(run_dir)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


def merge_judge_into_record(
    run_dir: str | Path, task_id: str, result: "JudgeResult"
) -> None:
    """Backfill judge fields onto the matching task_id rows; atomic rewrite."""
    rows = read_records(run_dir)
    # Odysseys judge carries per-rubric counts in metadata; binary judges leave it
    # empty → both stay None. rubric_scores values are 0/1, so sum == passed count.
    # Gated on no-error like `score` below: a judge_error leaves a PARTIAL rubric_scores
    # (only the rubrics scored before the break) against the FULL num_rubrics, so persisting
    # the pair would assert a misleading "k of N passed" for a task never fully judged
    # Undetermined results leave both null, matching the score invariant.
    jmeta = result.metadata if (result.metadata and not result.error) else {}
    rubric_scores = jmeta.get("rubric_scores")
    num_rubrics = jmeta.get("num_rubrics")
    patch = {
        # judge_error == undetermined: no score exists. Persist null (not the 0
        # placeholder judges return on error) so average_score never counts a
        # failed judging as a 0. _judge.json keeps the raw score for audit.
        "score": None if result.error else result.score,
        "verdict": result.verdict,
        "num_rubrics": num_rubrics,
        "num_rubrics_passed": sum(rubric_scores.values()) if isinstance(rubric_scores, dict) else None,
        "failure_reason": result.failure_reason,
        "impossible_task": result.impossible_task,
        "reached_captcha": result.reached_captcha,
        "judge_reasoning": result.reasoning,
        "judge_model": result.judge_model,
        "judge_error": result.error,
        "judged_at": _now_iso(),
    }
    for row in rows:
        if str(row.get("task_id")) == str(task_id):
            row.update(patch)
    _write_all_rows(run_dir, rows)
