from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from wiek_bench.judges.odysseys_judge import OdysseysJudge
from wiek_bench.prompts import render_judge_prompt


PROBE = (
    Path(__file__).parents[1]
    / "agent-home/.pi/agent/skills/wiek-bench-judge/scripts/probe.py"
)


def _run_probe(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(PROBE), *args],
        capture_output=True,
        text=True,
        check=check,
    )


def _write_ax_tree(tmp_path: Path, payload: dict[str, object]) -> Path:
    tree = tmp_path / "tree.json"
    tree.write_text(json.dumps(payload), encoding="utf-8")
    return tree


def test_legacy_judge_session_missing_file_keeps_zero_cost(tmp_path: Path) -> None:
    judge = object.__new__(OdysseysJudge)

    usage = judge._usage_from_sessions([{"session_file": str(tmp_path / "missing.jsonl")}])

    assert usage.cost_usd == 0.0


def test_probe_reads_codex_rollout(tmp_path: Path) -> None:
    session = tmp_path / "rollout.jsonl"
    entries = [
        {"type": "session_meta", "payload": {"id": "session-1"}},
        {
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "call_id": "call-1",
                "arguments": json.dumps({"cmd": "printf ok"}),
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": "call-1",
                "output": json.dumps({"output": "ok", "exit_code": 0}),
            },
        },
        {"type": "event_msg", "payload": {"type": "token_count"}},
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "done"}],
            },
        },
    ]
    session.write_text(
        "".join(json.dumps(entry) + "\n" for entry in entries),
        encoding="utf-8",
    )

    summary = subprocess.run(
        [sys.executable, str(PROBE), "summary", str(session)],
        capture_output=True,
        text=True,
        check=True,
    )
    payload = json.loads(summary.stdout)
    assert payload == {
        "assistant_turns": 1,
        "tool_calls": 1,
        "tool_call_dist": {"exec_command": 1},
        "tool_errors": 0,
        "last_assistant_text": "done",
    }

    calls = subprocess.run(
        [sys.executable, str(PROBE), "calls", str(session), "--name", "exec_command"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "$ [exec_command] printf ok" in calls.stdout
    assert "ok" in calls.stdout


def test_axtree_repeatable_grep_uses_or_and_regex_is_explicit(tmp_path: Path) -> None:
    tree = _write_ax_tree(
        tmp_path,
        {
            "nodes": [
                {"role": "button", "name": "Alpha action"},
                {"role": "link", "name": "Beta destination"},
                {"role": "text", "name": "Gamma note"},
            ]
        },
    )

    literal = _run_probe(
        "axtree",
        str(tree),
        "--grep",
        "alpha",
        "--grep",
        "BETA",
    )
    assert '[button] "Alpha action"' in literal.stdout
    assert '[link] "Beta destination"' in literal.stdout
    assert "Gamma note" not in literal.stdout

    regex = _run_probe(
        "axtree",
        str(tree),
        "--grep",
        "^Alpha|destination$",
        "--regex",
    )
    assert '[button] "Alpha action"' in regex.stdout
    assert '[link] "Beta destination"' in regex.stdout
    assert "Gamma note" not in regex.stdout


def test_axtree_literal_pipe_and_invalid_regex_fail_loud(tmp_path: Path) -> None:
    tree = _write_ax_tree(tmp_path, {"nodes": [{"role": "text", "name": "Alpha"}]})

    literal = _run_probe(
        "axtree",
        str(tree),
        "--grep",
        "Alpha|Beta",
        check=False,
    )
    assert literal.returncode != 0
    assert "use --regex" in literal.stderr
    assert "repeat --grep" in literal.stderr

    regex = _run_probe(
        "axtree",
        str(tree),
        "--grep",
        "[",
        "--regex",
        check=False,
    )
    assert regex.returncode != 0
    assert "invalid --grep regex" in regex.stderr


def test_axtree_properties_are_opt_in_for_search_and_output(tmp_path: Path) -> None:
    tree = _write_ax_tree(
        tmp_path,
        {
            "nodes": [
                {
                    "role": "link",
                    "name": "Open destination",
                    "properties": {
                        "url": "https://example.com/post/1",
                        "focusable": True,
                    },
                }
            ]
        },
    )

    without_properties = _run_probe("axtree", str(tree), "--grep", "example.com")
    assert "(no matching nodes)" in without_properties.stdout
    assert "properties=" not in without_properties.stdout

    with_properties = _run_probe(
        "axtree",
        str(tree),
        "--grep",
        "example.com",
        "--properties",
    )
    assert '[link] "Open destination"' in with_properties.stdout
    assert 'properties={"focusable":true,"url":"https://example.com/post/1"}' in with_properties.stdout


def test_axtree_schema_v2_shows_summary_and_ancestor_chain(tmp_path: Path) -> None:
    tree = _write_ax_tree(
        tmp_path,
        {
            "schema_version": 2,
            "nodes": [
                {"role": "RootWebArea", "name": "Example", "parent_index": None},
                {"role": "article", "name": "Outer post", "parent_index": 0},
                {"role": "link", "name": "Quoted reply", "parent_index": 1},
            ],
        },
    )

    result = _run_probe(
        "axtree",
        str(tree),
        "--grep",
        "Quoted reply",
        "--show-ancestors",
    )
    summary = json.loads(result.stdout.split("\n---\n", 1)[0])
    assert summary["schema_version"] == 2
    assert summary["has_hierarchy"] is True
    assert '[link] "Quoted reply" depth=2' in result.stdout
    assert 'ancestors=[RootWebArea] "Example" > [article] "Outer post"' in result.stdout


def test_axtree_schema_v1_reports_unavailable_hierarchy_but_still_queries(
    tmp_path: Path,
) -> None:
    tree = _write_ax_tree(
        tmp_path,
        {"nodes": [{"role": "article", "name": "Legacy post"}]},
    )

    result = _run_probe(
        "axtree",
        str(tree),
        "--grep",
        "Legacy post",
        "--show-ancestors",
    )
    summary = json.loads(result.stdout.split("\n---\n", 1)[0])
    assert summary["schema_version"] == 1
    assert summary["has_hierarchy"] is False
    assert "hierarchy unavailable: AX tree schema v1" in result.stdout
    assert '[article] "Legacy post"' in result.stdout
    assert " depth=" not in result.stdout


def test_agent_judge_prompts_require_raw_evidence_without_forcing_a_pass() -> None:
    context: dict[str, object] = {
        "mode": "agent",
        "task": "Inspect the outer post.",
        "answer": None,
        "final_result": "",
        "trajectory": "",
        "provider_error": None,
        "session_file": "/tmp/session.jsonl",
        "screenshots_dir": "/tmp/frames",
        "probe_script": "/tmp/probe.py",
        "manifest_path": "/tmp/manifest.jsonl",
        "trees_dir": "/tmp/trees",
        "image_count": 1,
        "total_frames": 1,
        "scoped_frames": ["001.webp"],
        "rubric_id": "R2",
        "requirement": "Exclude replies.",
        "verification": "Use the outer post's own label.",
    }

    for template in ("bu_bench", "stealth", "odysseys_rubric_agent"):
        rendered = render_judge_prompt(template, **context)
        assert "The derived field or conflict alone cannot prove failure" in rendered
        assert "independent raw evidence" in rendered
        assert "do not mark the rubric unsatisfied" not in rendered
        assert "do not return a failing verdict" not in rendered
