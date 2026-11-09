"""Lightweight progress reporting.

Line mode (no TTY / show_progress=False / --no-progress) emits NDJSON progress
events to stdout — ``run_start`` / ``start`` / ``done`` / ``fail`` / ``skip`` /
``run_end`` — one per line, UTF-8, flushed, so the WebUI backend can tail and
``json.loads`` them. In line mode stdout carries only these
events; human logs go to stderr. On a TTY a tqdm bar is shown on stderr instead
(no NDJSON); concurrent runs still log a short per-task line to stderr for replay.
No per-tool text / thinking stream.

``event_log`` mirrors the same NDJSON stream into ``runs/<id>/progress.ndjson``
**independently of line mode**, so a CLI run started on a TTY (tqdm, no stdout
NDJSON) still leaves a machine-readable progress trail. That file is what lets
the WebUI show live progress for runs it did not spawn, and what lets it recover
progress for its own runs after a restart drops the in-memory handle.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _ts() -> str:
    return datetime.now(timezone.utc).isoformat()


class ProgressReporter:
    def __init__(
        self,
        total: int,
        *,
        run_id: str,
        concurrent: bool,
        show_progress: bool = True,
        event_log: Path | None = None,
    ) -> None:
        self.total = total
        self.run_id = run_id
        self.concurrent = concurrent
        self.show_progress = show_progress
        self.done = 0
        self.fail = 0
        self.skip = 0
        self.active = 0
        self._bar = None
        if show_progress and sys.stderr.isatty():
            try:
                from tqdm import tqdm

                self._bar = tqdm(total=total, unit="task", file=sys.stderr)
            except Exception:  # noqa: BLE001
                self._bar = None
        # NDJSON line mode iff there is no tqdm bar — the sole WebUI stdout source.
        self._line_mode = self._bar is None
        self._event_log = event_log
        if event_log is not None:
            # Truncate per invocation: a fresh run, a resume and a selective rerun each
            # start their own event stream, matching the WebUI tmp log's "wb" open. An
            # appended stream would let a rerun target's stale `done` event outlive the
            # artifact purge and resurrect the pre-rerun status.
            try:
                event_log.parent.mkdir(parents=True, exist_ok=True)
                event_log.write_text("", encoding="utf-8")
            except OSError:
                # Progress mirroring is observability, never a reason to fail a run.
                self._event_log = None
        self._emit_event("run_start", run_id=self.run_id, total=self.total)

    @property
    def line_mode(self) -> bool:
        """True when NDJSON events reach stdout."""
        return self._line_mode

    @property
    def emits_events(self) -> bool:
        """True when live events reach any consumer (stdout or the run's event log);
        gates the turns disk-poll, which exists only to feed those events."""
        return self._line_mode or self._event_log is not None

    def _emit_event(self, event: str, **fields: Any) -> None:
        """Emit one NDJSON progress line: stdout in line mode, and the run's event
        log whenever one is configured (both, neither, or either)."""
        if not self._line_mode and self._event_log is None:
            return
        record = {"event": event, **fields, "ts": _ts()}
        line = json.dumps(record, ensure_ascii=False) + "\n"
        if self._line_mode:
            sys.stdout.write(line)
            sys.stdout.flush()
        if self._event_log is not None:
            try:
                with self._event_log.open("a", encoding="utf-8") as fh:
                    fh.write(line)
            except OSError:
                self._event_log = None

    def _stderr_log(self, msg: str) -> None:
        print(msg, file=sys.stderr, flush=True)

    def start_task(self, task_id: str, slot: int | None = None) -> None:
        self.active += 1
        self._emit_event("start", task_id=task_id)
        self._refresh()

    def session_known(self, task_id: str, session_file: str) -> None:
        """One-shot running-task → session-file mapping; consumed by the WebUI
        live snapshot and absent from tasks.jsonl until the task ends."""
        self._emit_event("session", task_id=task_id, session_file=session_file)

    def task_progress(self, task_id: str, *, turns: int) -> None:
        """Live turns refresh for a running task from the disk poll.
        Emit-not-store; the done/fail turns value remains authoritative."""
        self._emit_event("progress", task_id=task_id, turns=turns)

    def task_attempt(self, task_id: str, *, attempt: int) -> None:
        """Live retry-count refresh: emitted before starting attempt N (N>=2) of a
        task's retry loop. ``attempt`` is the current attempt number;
        the WebUI shows retries = attempt - 1. Emit-not-store — the authoritative
        total is tasks.jsonl ``attempt_count`` after the task ends."""
        self._emit_event("attempt", task_id=task_id, attempt=attempt)

    def finish_task(
        self,
        task_id: str,
        *,
        error: str | None = None,
        skipped: bool = False,
        turns: int | None = None,
    ) -> None:
        """``turns`` (session num_turns) rides the done/fail event for WebUI display
        only — emit-not-store, tasks.jsonl stays free of derived metrics."""
        if not skipped:
            self.active = max(0, self.active - 1)
        extra: dict[str, Any] = {} if turns is None else {"turns": turns}
        if skipped:
            self.skip += 1
            self._emit_event("skip", task_id=task_id)
            status = "skip"
        elif error:
            self.fail += 1
            self._emit_event("fail", task_id=task_id, error=error[:160], **extra)
            status = "fail"
        else:
            self.done += 1
            self._emit_event("done", task_id=task_id, **extra)
            status = "done"
        if self._bar is not None:
            self._bar.update(1)
            # Even with the bar (TTY), concurrent runs log a short replayable line.
            if self.concurrent:
                self._stderr_log(f"[{status}] task={task_id}")
        self._refresh()

    def _refresh(self) -> None:
        if self._bar is not None:
            postfix = {"done": self.done, "fail": self.fail}
            if self.skip:
                postfix["skip"] = self.skip
            if self.concurrent:
                postfix["active"] = self.active
            try:
                self._bar.set_postfix(postfix)
            except Exception:  # noqa: BLE001
                pass

    def on_event(self, event: dict[str, Any]) -> None:  # backward-compat no-op
        return None

    def close(self) -> None:
        if self._bar is not None:
            try:
                self._bar.close()
            except Exception:  # noqa: BLE001
                pass
        self._emit_event(
            "run_end", run_id=self.run_id, done=self.done, fail=self.fail, skip=self.skip
        )
        self._stderr_log(
            f"[summary] total={self.total} done={self.done} fail={self.fail} skip={self.skip}"
        )
