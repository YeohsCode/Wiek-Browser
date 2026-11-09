"""Shared pi RPC client (core-level reusable unit).

A minimal async JSONL (LF-framed) RPC client for a single pi ``--mode rpc``
subprocess, plus the live-process registry used for Ctrl+C / crash cleanup. Both
the Stage A agent driver (``providers/pi_coding_agent``) and the Stage B judge
(``judges/pi_judge``) import this unit directly, so ``judges/`` never depends on
``providers/``. This module has no internal wiek_bench dependencies.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
from pathlib import Path
from typing import Any, Callable

from loguru import logger

# Module-level registry of live pi process groups for Ctrl+C / crash cleanup.
_LIVE_PI_PROCESSES: set[int] = set()

EventCallback = Callable[[dict[str, Any]], None] | None

_LF = b"\n"


def kill_all_pi_processes() -> int:
    """SIGKILL every registered pi process group. Returns how many were signalled."""
    killed = 0
    for pgid in list(_LIVE_PI_PROCESSES):
        try:
            os.killpg(pgid, signal.SIGKILL)
            killed += 1
        except ProcessLookupError:
            pass
        except Exception as exc:  # noqa: BLE001
            logger.warning("killpg {} failed: {}", pgid, exc)
    return killed


class PiRpcError(RuntimeError):
    pass


class PiRpcSession:
    """Minimal async JSONL RPC client for a single pi subprocess."""

    def __init__(
        self,
        argv: list[str],
        *,
        cwd: str | Path,
        env: dict[str, str],
        on_event: EventCallback = None,
        stderr_path: str | Path | None = None,
    ) -> None:
        self.argv = argv
        self.cwd = str(cwd)
        self.env = env
        self.on_event = on_event
        self.stderr_path = stderr_path
        self.proc: asyncio.subprocess.Process | None = None
        self.pgid: int | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_file = None
        self._next_id = 0
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._agent_end = asyncio.Event()
        self._closed = False

    async def start(self) -> None:
        stderr_target: Any = asyncio.subprocess.DEVNULL
        if self.stderr_path is not None:
            self._stderr_file = open(self.stderr_path, "wb")  # noqa: SIM115
            stderr_target = self._stderr_file
        self.proc = await asyncio.create_subprocess_exec(
            *self.argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr_target,
            cwd=self.cwd,
            env=self.env,
            start_new_session=True,
        )
        # start_new_session=True makes the child its own process-group leader: pgid == pid.
        # Use pid directly so the process is always registered/killable (getpgid could race).
        self.pgid = self.proc.pid
        _LIVE_PI_PROCESSES.add(self.pgid)
        self._reader_task = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        buffer = b""
        try:
            while True:
                chunk = await self.proc.stdout.read(65536)
                if not chunk:
                    break
                buffer += chunk
                while True:
                    idx = buffer.find(_LF)
                    if idx < 0:
                        break
                    line = buffer[:idx]
                    buffer = buffer[idx + 1 :]
                    self._handle_line(line)
        except Exception as exc:  # noqa: BLE001
            logger.debug("pi read loop ended: {}", exc)
        finally:
            # On EOF, fail any pending futures so callers don't hang.
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(PiRpcError("pi stdout closed before response"))
            self._pending.clear()
            self._agent_end.set()

    def _handle_line(self, raw: bytes) -> None:
        if not raw.strip():
            return
        try:
            event = json.loads(raw.decode("utf-8"))
        except Exception:  # noqa: BLE001
            return
        etype = event.get("type")
        if etype == "response":
            rid = event.get("id")
            fut = self._pending.pop(rid, None) if rid is not None else None
            if fut is not None and not fut.done():
                fut.set_result(event)
            return
        if etype == "agent_end":
            self._agent_end.set()
        if self.on_event is not None:
            try:
                self.on_event(event)
            except Exception:  # noqa: BLE001
                pass

    async def _send(self, command: dict[str, Any], *, expect_response: bool = True) -> dict[str, Any]:
        assert self.proc is not None and self.proc.stdin is not None
        if expect_response:
            self._next_id += 1
            rid = f"req-{self._next_id}"
            command = {**command, "id": rid}
            fut: asyncio.Future[dict[str, Any]] = asyncio.get_event_loop().create_future()
            self._pending[rid] = fut
        payload = (json.dumps(command, ensure_ascii=False) + "\n").encode("utf-8")
        self.proc.stdin.write(payload)
        await self.proc.stdin.drain()
        if not expect_response:
            return {}
        return await fut

    async def get_state(self) -> dict[str, Any]:
        resp = await self._send({"type": "get_state"})
        return resp.get("data") or {}

    async def export_html(self, output_path: str) -> dict[str, Any]:
        resp = await self._send({"type": "export_html", "outputPath": output_path})
        if not resp.get("success"):
            raise PiRpcError(resp.get("error") or "export_html failed")
        return resp.get("data") or {}

    async def set_auto_retry(self, enabled: bool) -> None:
        try:
            await self._send({"type": "set_auto_retry", "enabled": enabled})
        except PiRpcError:
            pass

    async def run_prompt(
        self, message: str, images: list[dict[str, Any]] | None = None
    ) -> None:
        """Send a prompt and wait for the resulting agent_end."""
        self._agent_end.clear()
        cmd: dict[str, Any] = {"type": "prompt", "message": message}
        if images:
            cmd["images"] = images
        resp = await self._send(cmd)
        if not resp.get("success"):
            # pi reports pre-acceptance failures (auth/missing key) only via response.
            raise PiRpcError(resp.get("error") or "prompt rejected")
        await self._agent_end.wait()

    async def abort(self) -> None:
        try:
            await self._send({"type": "abort"}, expect_response=False)
        except Exception:  # noqa: BLE001
            pass

    def kill(self) -> None:
        if self.pgid is not None:
            try:
                os.killpg(self.pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except Exception as exc:  # noqa: BLE001
                logger.debug("kill pgid {} failed: {}", self.pgid, exc)

    async def shutdown(self, *, grace_s: float = 5.0) -> None:
        if self._closed:
            return
        self._closed = True
        if self.proc is not None:
            try:
                if self.proc.stdin and not self.proc.stdin.is_closing():
                    self.proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=grace_s)
            except (asyncio.TimeoutError, Exception):  # noqa: BLE001
                self.kill()
                try:
                    await self.proc.wait()
                except Exception:  # noqa: BLE001
                    pass
        if self._reader_task is not None:
            self._reader_task.cancel()
        if self._stderr_file is not None:
            try:
                self._stderr_file.close()
            except Exception:  # noqa: BLE001
                pass
        if self.pgid is not None:
            _LIVE_PI_PROCESSES.discard(self.pgid)
