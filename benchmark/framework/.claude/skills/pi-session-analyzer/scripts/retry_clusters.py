#!/usr/bin/env python3
"""Identify consecutive similar tool calls and emit likely retry clusters."""
from __future__ import annotations

import argparse
import json
import sys
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pi_session_lib import (  # noqa: E402
    call_fingerprint,
    call_signature,
    iter_tool_pairs,
)


def _similarity(left: dict[str, Any], right: dict[str, Any]) -> float:
    if left["tool_name"] != right["tool_name"]:
        return 0.0
    a = call_signature(left["tool_name"], left["arguments"])
    b = call_signature(right["tool_name"], right["arguments"])
    return SequenceMatcher(None, a, b, autojunk=False).ratio()


def find_retry_clusters(path: Path, threshold: float = 0.82) -> list[dict[str, Any]]:
    calls = list(iter_tool_pairs(path))
    clusters: list[list[tuple[dict[str, Any], float | None]]] = []
    current: list[tuple[dict[str, Any], float | None]] = []
    for call in calls:
        if not current:
            current = [(call, None)]
            continue
        similarity = _similarity(current[-1][0], call)
        if similarity >= threshold:
            current.append((call, similarity))
            continue
        if len(current) >= 2:
            clusters.append(current)
        current = [(call, None)]
    if len(current) >= 2:
        clusters.append(current)

    out: list[dict[str, Any]] = []
    for cluster_index, cluster in enumerate(clusters, 1):
        out.append(
            {
                "cluster": cluster_index,
                "tool_name": cluster[0][0]["tool_name"],
                "count": len(cluster),
                "calls": [
                    {
                        "call_line": call["call_line"],
                        "result_line": call["result_line"],
                        "turn": call["call_turn_index"],
                        "fingerprint": call_fingerprint(call["tool_name"], call["arguments"]),
                        "similarity_to_previous": similarity,
                        "status": (
                            "missing"
                            if call["is_error"] is None
                            else ("error" if call["is_error"] else "ok")
                        ),
                    }
                    for call, similarity in cluster
                ],
            }
        )
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument("--threshold", type=float, default=0.82)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if not args.session.is_file():
        print(f"error: file not found: {args.session}", file=sys.stderr)
        return 2
    if not 0.0 <= args.threshold <= 1.0:
        print("error: --threshold must be between 0 and 1", file=sys.stderr)
        return 2
    clusters = find_retry_clusters(args.session, args.threshold)
    if args.json:
        print(json.dumps(clusters, ensure_ascii=False, indent=2))
        return 0
    if not clusters:
        print("(no similar consecutive retries)")
        return 0
    for cluster in clusters:
        print(
            f"cluster {cluster['cluster']} tool={cluster['tool_name']} count={cluster['count']}"
        )
        for call in cluster["calls"]:
            similarity = call["similarity_to_previous"]
            sim_text = "-" if similarity is None else f"{similarity:.3f}"
            print(
                f"  line={call['call_line']} turn={call['turn']} status={call['status']} "
                f"fp={call['fingerprint']} similarity={sim_text}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
