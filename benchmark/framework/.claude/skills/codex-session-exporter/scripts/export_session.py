#!/usr/bin/env python3
"""Resolve a Codex session path or ID and export its standalone HTML report."""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections.abc import Sequence
from pathlib import Path

from export_codex_session import export_session


SESSION_ID_PATTERN = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)


def _codex_homes(explicit_homes: Sequence[Path]) -> tuple[Path, ...]:
    candidates: list[Path] = []
    if explicit_homes:
        candidates.extend(path.expanduser().resolve() for path in explicit_homes)
    else:
        configured = os.environ.get("CODEX_HOME")
        if configured:
            candidates.append(Path(configured).expanduser().resolve())
        candidates.append((Path.home() / ".codex").resolve())

    unique: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        if candidate not in seen:
            seen.add(candidate)
            unique.append(candidate)
    return tuple(unique)


def _looks_like_path(value: str) -> bool:
    return any(separator in value for separator in ("/", "\\")) or value.endswith(".jsonl")


def _find_by_session_id(session_id: str, homes: Sequence[Path]) -> Path:
    matches: set[Path] = set()
    filename_pattern = f"*-{session_id.lower()}.jsonl"
    for home in homes:
        for directory in (home / "sessions", home / "archived_sessions"):
            if not directory.is_dir():
                continue
            matches.update(path.resolve() for path in directory.rglob(filename_pattern))

    ordered = sorted(matches)
    if not ordered:
        searched = ", ".join(str(home) for home in homes) or "no CODEX_HOME"
        raise ValueError(f"session ID not found: {session_id}; searched: {searched}")
    if len(ordered) > 1:
        paths = "\n".join(f"  - {path}" for path in ordered)
        raise ValueError(
            f"session ID matched multiple files; pass the exact path instead:\n{paths}"
        )
    return ordered[0]


def resolve_session(value: str, explicit_homes: Sequence[Path] = ()) -> Path:
    """Resolve an existing JSONL path or an exact Codex UUID session ID."""

    candidate = Path(value).expanduser()
    if candidate.is_file():
        return candidate.resolve()
    if _looks_like_path(value):
        raise ValueError(f"session file does not exist: {candidate.resolve()}")
    if SESSION_ID_PATTERN.fullmatch(value) is None:
        raise ValueError("input must be an existing JSONL path or a complete Codex session ID")
    return _find_by_session_id(value.lower(), _codex_homes(explicit_homes))


def _session_id_from_path(source: Path) -> str:
    match = SESSION_ID_PATTERN.search(source.name)
    return match.group(0).lower() if match else source.stem


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Resolve a Codex session path or ID and export a standalone HTML report.",
    )
    parser.add_argument("session", help="Existing rollout JSONL path or complete session ID")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Output HTML path; defaults to the current directory",
    )
    parser.add_argument(
        "--codex-home",
        type=Path,
        action="append",
        default=[],
        help="CODEX_HOME to search for an ID; repeat to search multiple homes",
    )
    parser.add_argument("--title", help="Optional report title")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the path/ID resolver and HTML exporter."""

    args = _parser().parse_args(argv)
    try:
        source = resolve_session(args.session, args.codex_home)
        output = (
            args.output.expanduser().resolve()
            if args.output is not None
            else (Path.cwd() / f"codex-session-{_session_id_from_path(source)}.html").resolve()
        )
        target = export_session(source, output, title=args.title)
    except (OSError, ValueError) as exc:
        print(f"Export failed: {exc}", file=sys.stderr)
        return 1

    print(f"Session source: {source}")
    print(f"HTML report exported: {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
