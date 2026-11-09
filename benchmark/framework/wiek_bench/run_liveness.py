"""Cross-process liveness for a run's executing process.

``run_eval`` drops ``runs/<run_id>/run.pid`` once the run directory exists. Anything
that needs to know whether a run is still executing reads it back and probes the OS —
the WebUI uses this for runs it did not spawn itself (CLI-started runs, and its own
runs after a restart dropped the in-memory handle).

The file is deliberately **not** removed on exit. Liveness is decided by probing the
pid, never by the file's existence, so a stale file after a crash or a `kill -9` is
harmless. Probing is two-stage: a cheap ``os.kill(pid, 0)`` first, and only for pids
that still exist a ``ps`` command-line check, so a recycled pid belonging to an
unrelated process is not mistaken for a live run. Historical runs whose pid is long
gone cost exactly one syscall.
"""

from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PID_FILENAME = "run.pid"
EVENT_LOG_FILENAME = "progress.ndjson"

# Set by the WebUI when it spawns run_eval; absent for a plain CLI invocation. Frozen
# into run_metadata.origin so the provenance survives even when the pid file does not.
ORIGIN_ENV = "WIEK_BENCH_RUN_ORIGIN"
ORIGIN_WEBUI = "webui"
ORIGIN_CLI = "cli"

# Any live run_eval process carries this in its command line; used to reject pid reuse.
_PROCESS_MARKER = "run_eval"


def run_origin() -> str:
    """Who started this process — ``webui`` when spawned by the console, else ``cli``."""
    return ORIGIN_WEBUI if os.environ.get(ORIGIN_ENV) == ORIGIN_WEBUI else ORIGIN_CLI


def write_pid_file(run_dir: Path, *, origin: str | None = None) -> None:
    """Record the executing pid for this run. Best effort: never fails a run."""
    payload = {
        "pid": os.getpid(),
        "origin": origin or run_origin(),
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        (run_dir / PID_FILENAME).write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )
    except OSError:
        pass


def read_pid_file(run_dir: Path) -> dict[str, Any] | None:
    path = run_dir / PID_FILENAME
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("pid"), int) else None


def _cmdline(pid: int) -> str:
    try:
        proc = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return proc.stdout.strip()


def pid_is_alive(pid: int) -> bool:
    """True when `pid` is a live run_eval process (not merely a live pid)."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Alive but owned by another user — not a run of ours; treat as dead so the
        # queue never waits forever on a foreign process.
        return False
    except OSError:
        return False
    return _PROCESS_MARKER in _cmdline(pid)


def external_pid(run_dir: Path) -> int | None:
    """The live pid executing this run, or None when nothing is running."""
    data = read_pid_file(run_dir)
    if data is None:
        return None
    pid = int(data["pid"])
    return pid if pid_is_alive(pid) else None


def is_alive(run_dir: Path) -> bool:
    return external_pid(run_dir) is not None
