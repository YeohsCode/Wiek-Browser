#!/usr/bin/env python3
"""Determine whether a Claude Code session has finished for scheduled monitoring.

An unmatched tool call means the session may still be executing a long operation.
Otherwise the time since the last JSONL write determines whether it is idle past
``IDLE_THRESHOLD_MIN``. The final line is always ``VERDICT=FINISHED`` or
``VERDICT=RUNNING``.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

IDLE_THRESHOLD_MIN: float = 1.0
# Treat a pending tool call beyond this idle threshold as a stalled process.
STALLED_THRESHOLD_MIN: float = 60.0

# Claude Code stores per-project sessions under a slugified absolute path.
SESSION_DIR = Path.home() / ".claude" / "projects" / str(Path.cwd()).replace("/", "-")


def has_pending_tool_call(path: Path) -> bool:
    """Return whether a tool_use remains unmatched by a tool_result."""
    tool_use_ids: set[str] = set()
    tool_result_ids: set[str] = set()
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            content = (rec.get("message") or {}).get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "tool_use" and block.get("id"):
                    tool_use_ids.add(block["id"])
                elif btype == "tool_result" and block.get("tool_use_id"):
                    tool_result_ids.add(block["tool_use_id"])
    return bool(tool_use_ids - tool_result_ids)


def main() -> None:
    session_id: str = sys.argv[1] if len(sys.argv) > 1 else ""
    if not session_id:
        print("ERROR: missing session id arg")
        print("VERDICT=RUNNING")  # Insufficient evidence should not trigger review.
        return

    path = SESSION_DIR / f"{session_id}.jsonl"
    if not path.exists():
        # A missing session may never have started or may already be cleaned up.
        print(f"session file not found: {path}")
        print("VERDICT=FINISHED")
        return

    idle_min: float = (time.time() - path.stat().st_mtime) / 60.0
    pending: bool = has_pending_tool_call(path)

    print(f"session   = {session_id}")
    print(f"idle_min  = {idle_min:.1f}  (threshold {IDLE_THRESHOLD_MIN:.0f}m)")
    print(f"pending_tool_call = {pending}")

    if pending and idle_min < STALLED_THRESHOLD_MIN:
        print("reason    = 正卡在未完成的 tool 调用中（长操作进行中），继续等待")
        print("VERDICT=RUNNING")
        return

    if pending and idle_min >= STALLED_THRESHOLD_MIN:
        print(f"reason    = 未完成 tool 调用但已静默 {idle_min:.0f} 分钟，疑似卡死/进程退出，按结束处理")
        print("VERDICT=FINISHED")
        return

    if idle_min >= IDLE_THRESHOLD_MIN:
        print(f"reason    = 已静默 {idle_min:.1f} 分钟且无未完成 tool 调用，判定结束")
        print("VERDICT=FINISHED")
        return

    print(f"reason    = 最近 {idle_min:.1f} 分钟内仍有写入，仍在运行")
    print("VERDICT=RUNNING")


if __name__ == "__main__":
    main()
