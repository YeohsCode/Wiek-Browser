"""Guards for task attachments and locally hosted benchmark sites.

The rules these lower into checks: a dataset declares resources by name and
never by path or host, every declared resource exists, and the port the Python
side expects is the port ``benchmark_sites`` actually binds.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from wiek_bench import task_resources
from wiek_bench.datasets import get_adapter
from wiek_bench.datasets.base import BenchmarkTask
from wiek_bench.datasets.odysseys import parse_odysseys_entry

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data"
BENCHMARK_SITES = REPO_ROOT / "benchmark_sites"

# A dataset that spells out a filesystem path sends the agent looking for a file
# relative to a working directory the path was never written against. Matching
# requires a file extension or the pool directory itself, so ordinary prose that
# happens to contain a slash ("two data/dashboard tabs") is not an offender.
DATA_PATH_RE = re.compile(
    rf"\bdata/(?:[\w.-]+/)*[\w-]+\.\w{{2,5}}\b|\bdata/{task_resources.ATTACHMENTS_DIRNAME}\b"
)
LOCALHOST_RE = re.compile(r"https?://(?:127\.0\.0\.1|localhost|0\.0\.0\.0)")


def _dataset_files() -> list[Path]:
    return sorted(p for p in DATA_DIR.glob("*.json"))


def _task(**kwargs: object) -> BenchmarkTask:
    base = {"task_id": "t1", "benchmark": "b", "instruction": "do it"}
    return BenchmarkTask(**{**base, **kwargs})  # type: ignore[arg-type]


# --- Dataset declarations --------------------------------------------------


def test_every_declared_attachment_exists() -> None:
    missing: list[str] = []
    for path in _dataset_files():
        entries = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            for name in entry.get("attachments") or []:
                if not (task_resources.attachments_dir(DATA_DIR) / str(name)).is_file():
                    missing.append(f"{path.name}:{entry.get('task_id')} -> {name}")
    assert not missing, f"declared attachments with no file: {missing}"


def test_datasets_declare_resources_by_name_not_by_path_or_host() -> None:
    offenders: list[str] = []
    for path in _dataset_files():
        text = path.read_text(encoding="utf-8")
        for match in DATA_PATH_RE.findall(text):
            offenders.append(f"{path.name}: filesystem path {match!r}")
        for match in LOCALHOST_RE.findall(text):
            offenders.append(f"{path.name}: hardcoded host {match!r}")
    assert not offenders, (
        "datasets must use the attachments / local_site fields instead: " + str(offenders)
    )


def test_every_declared_local_site_has_a_source_directory() -> None:
    missing: list[str] = []
    for path in _dataset_files():
        entries = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if isinstance(entry, dict) and (slug := entry.get("local_site")):
                if not task_resources.site_source_dir(str(slug), repo_root=REPO_ROOT).is_dir():
                    missing.append(f"{path.name}:{entry.get('task_id')} -> {slug}")
    assert not missing, f"local_site slugs with no benchmark_sites/app directory: {missing}"


def test_local_site_resolves_to_the_site_host_origin() -> None:
    task = next(
        t
        for t in get_adapter("real-world-bench", DATA_DIR).load()
        if task_resources.declared_site(t)
    )
    assert task.start_url == task_resources.site_url(task.metadata["local_site"])


def test_entry_cannot_declare_both_website_and_local_site() -> None:
    with pytest.raises(ValueError, match="not both"):
        parse_odysseys_entry(
            {
                "task_id": "t1",
                "confirmed_task": "x",
                "website": "https://example.com",
                "local_site": "ticket-rush",
            },
            benchmark="b",
        )


# --- Site origin -----------------------------------------------------------


def test_python_site_port_matches_what_benchmark_sites_binds() -> None:
    """The origin default lives on the Python side but the port is bound on the
    JS side; nothing but this check keeps the two in step."""
    port = task_resources.site_origin().rsplit(":", 1)[-1]
    vite_config = (BENCHMARK_SITES / "vite.config.ts").read_text(encoding="utf-8")
    package_json = (BENCHMARK_SITES / "package.json").read_text(encoding="utf-8")
    assert re.search(rf"port:\s*{port}\b", vite_config), (
        f"benchmark_sites/vite.config.ts does not bind port {port}"
    )
    assert f"-p {port}" in package_json, (
        f"benchmark_sites/package.json harness scripts do not bind port {port}"
    )


def test_site_origin_env_override_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(task_resources.SITE_ORIGIN_ENV, "http://127.0.0.1:9999/")
    assert task_resources.site_url("ticket-rush") == "http://127.0.0.1:9999/ticket-rush"


# --- Staging ---------------------------------------------------------------


def test_stage_attachments_links_into_a_per_task_directory(tmp_path: Path) -> None:
    source = tmp_path / "pool" / "resume.pdf"
    source.parent.mkdir()
    source.write_text("resume", encoding="utf-8")
    workdir = tmp_path / "work"

    staged = task_resources.stage_attachments([source], workdir=workdir, task_id="task-a")

    assert [p.name for p in staged] == ["resume.pdf"]
    assert staged[0].parent == workdir / task_resources.STAGED_DIRNAME / "task-a"
    assert staged[0].is_symlink()
    assert staged[0].resolve() == source.resolve()
    assert staged[0].read_text(encoding="utf-8") == "resume"


def test_stage_attachments_isolates_tasks_sharing_one_workdir(tmp_path: Path) -> None:
    """The agent workdir is built once per run and shared by every task in it."""
    pool = tmp_path / "pool"
    pool.mkdir()
    (a_src := pool / "a.pdf").write_text("a", encoding="utf-8")
    (b_src := pool / "b.pdf").write_text("b", encoding="utf-8")
    workdir = tmp_path / "work"

    a_staged = task_resources.stage_attachments([a_src], workdir=workdir, task_id="task-a")
    task_resources.stage_attachments([b_src], workdir=workdir, task_id="task-b")

    assert [p.name for p in a_staged[0].parent.iterdir()] == ["a.pdf"]


def test_stage_attachments_rebuilds_on_retry(tmp_path: Path) -> None:
    pool = tmp_path / "pool"
    pool.mkdir()
    (src := pool / "a.pdf").write_text("a", encoding="utf-8")
    workdir = tmp_path / "work"

    first = task_resources.stage_attachments([src], workdir=workdir, task_id="task-a")
    (first[0].parent / "agent-scratch.txt").write_text("left over", encoding="utf-8")
    second = task_resources.stage_attachments([src], workdir=workdir, task_id="task-a")

    assert [p.name for p in second[0].parent.iterdir()] == ["a.pdf"]


def test_stage_attachments_creates_nothing_without_attachments(tmp_path: Path) -> None:
    workdir = tmp_path / "work"
    assert task_resources.stage_attachments([], workdir=workdir, task_id="task-a") == []
    assert not (workdir / task_resources.STAGED_DIRNAME).exists()


# --- Preflight -------------------------------------------------------------


def test_preflight_reports_every_missing_attachment_at_once(tmp_path: Path) -> None:
    (tmp_path / task_resources.ATTACHMENTS_DIRNAME).mkdir()
    tasks = [
        _task(task_id="t1", metadata={"attachments": ["one.pdf"]}),
        _task(task_id="t2", metadata={"attachments": ["two.pdf"]}),
    ]
    error = task_resources.preflight(tasks, data_dir=tmp_path, repo_root=tmp_path)
    assert error is not None
    assert "one.pdf" in error and "two.pdf" in error


def test_preflight_rejects_a_local_site_with_no_source_directory(tmp_path: Path) -> None:
    error = task_resources.preflight(
        [_task(metadata={"local_site": "nope"})], data_dir=tmp_path, repo_root=tmp_path
    )
    assert error is not None and "nope" in error


def test_preflight_passes_when_nothing_is_declared(tmp_path: Path) -> None:
    assert task_resources.preflight([_task()], data_dir=tmp_path, repo_root=tmp_path) is None


def test_preflight_names_the_command_that_fixes_an_unreachable_site(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / task_resources.SITE_APP_SUBDIR / "ticket-rush").mkdir(parents=True)
    monkeypatch.setattr(task_resources, "probe_site", lambda url, **_: (False, "refused"))
    error = task_resources.preflight(
        [_task(metadata={"local_site": "ticket-rush"})], data_dir=tmp_path, repo_root=tmp_path
    )
    assert error is not None
    assert "make benchmark-sites-serve" in error
    assert task_resources.SITE_ORIGIN_ENV in error


def test_preflight_probe_can_be_skipped(tmp_path: Path) -> None:
    (tmp_path / task_resources.SITE_APP_SUBDIR / "ticket-rush").mkdir(parents=True)
    error = task_resources.preflight(
        [_task(metadata={"local_site": "ticket-rush"})],
        data_dir=tmp_path,
        repo_root=tmp_path,
        probe=False,
    )
    assert error is None
