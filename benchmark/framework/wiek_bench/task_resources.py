"""Task resources: the non-text things a task needs before it can run.

Two kinds, both declared on the dataset entry and resolved here:

- ``attachments`` — file names under ``data/attachments/``, linked into the
  agent's per-task working directory so the prompt can name a path that
  actually resolves from the agent's cwd.
- ``local_site`` — the slug of a site served from ``benchmark_sites/app/<slug>/``,
  turned into a URL against the single origin that host listens on. Datasets
  never spell out a host and port, so the port stays changeable in one place.

Owns: declaration parsing, path and URL resolution, staging into the runspace,
and the pre-run availability check for both kinds.

Does not own: how benchmark sites are built or served (``benchmark_sites/`` and
the Makefile own that), dataset parsing (``wiek_bench/datasets``), or prompt
wording (``wiek_bench/prompts``).
"""

from __future__ import annotations

import os
import shutil
import urllib.error
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING, Sequence

if TYPE_CHECKING:  # Avoid a datasets <-> task_resources import cycle at runtime.
    from wiek_bench.datasets.base import BenchmarkTask

# Attachment pool, relative to the dataset directory.
ATTACHMENTS_DIRNAME = "attachments"
# Per-task staging directory, relative to the agent's working directory.
STAGED_DIRNAME = "task-files"

SITE_ORIGIN_ENV = "BENCHMARK_SITES_ORIGIN"
# The one place the local site host's address is written down on the Python side.
# benchmark_sites/vite.config.ts and the package.json harness scripts bind the
# same port; tests/test_task_resources.py fails if the two sides drift apart.
DEFAULT_SITE_ORIGIN = "http://127.0.0.1:4374"

# Site slugs map to route and source directory by convention, so adding a site is
# a directory plus a dataset field with nothing to register in between.
SITE_APP_SUBDIR = Path("benchmark_sites") / "app"

_PROBE_TIMEOUT_S = 3.0


# --- Declarations ----------------------------------------------------------


def declared_attachments(task: BenchmarkTask) -> list[str]:
    """Attachment file names declared by ``task``, in dataset order."""
    raw = task.metadata.get("attachments") or []
    if isinstance(raw, str):
        raw = [raw]
    return [str(name) for name in raw]


def declared_site(task: BenchmarkTask) -> str | None:
    """Local site slug declared by ``task``, or None for a live-web task."""
    slug = task.metadata.get("local_site")
    return str(slug) if slug else None


# --- Sites -----------------------------------------------------------------


def site_origin() -> str:
    """Origin the local benchmark-site host listens on; env override wins."""
    override = os.environ.get(SITE_ORIGIN_ENV, "").strip()
    return (override or DEFAULT_SITE_ORIGIN).rstrip("/")


def site_url(slug: str) -> str:
    """Full URL of the local site ``slug``."""
    return f"{site_origin()}/{slug.strip('/')}"


def site_source_dir(slug: str, *, repo_root: str | Path = ".") -> Path:
    """Directory the site ``slug`` is served from."""
    return Path(repo_root) / SITE_APP_SUBDIR / slug


def probe_site(url: str, *, timeout: float = _PROBE_TIMEOUT_S) -> tuple[bool, str]:
    """Return ``(reachable, detail)`` for ``url``. Any status under 400 is up."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return True, f"HTTP {response.status}"
    except urllib.error.HTTPError as exc:
        return exc.code < 400, f"HTTP {exc.code}"
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        return False, str(getattr(exc, "reason", None) or exc)


# --- Attachments -----------------------------------------------------------


def attachments_dir(data_dir: str | Path = "data") -> Path:
    return Path(data_dir) / ATTACHMENTS_DIRNAME


def resolve_attachments(
    task: BenchmarkTask, *, data_dir: str | Path = "data"
) -> list[Path]:
    """Absolute source paths for ``task``'s attachments. Existence is not checked
    here — ``preflight`` reports every missing file at once instead of failing on
    the first one mid-run."""
    pool = attachments_dir(data_dir)
    return [(pool / name).resolve() for name in declared_attachments(task)]


def stage_attachments(
    sources: Sequence[Path], *, workdir: str | Path, task_id: str
) -> list[Path]:
    """Link ``sources`` into ``<workdir>/task-files/<task_id>/`` and return the links.

    The agent's working directory is built once per run and shared by every task
    in it, so each task gets its own subdirectory rather than a shared pool one
    task could read another's files out of. The subdirectory is rebuilt on entry,
    which keeps a retry or a resumed task from inheriting a half-staged one.

    Links, not copies: a link keeps one file on disk as the single source. The
    agent can therefore write through to the dataset asset, which nothing here
    prevents — a benchmark asset that changes between runs silently changes what
    past scores meant, so treat an unexpected diff under ``data/attachments/`` as
    a corrupted run rather than a stale file.
    """
    if not sources:
        return []
    dest_dir = Path(workdir) / STAGED_DIRNAME / task_id
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    dest_dir.mkdir(parents=True)
    staged: list[Path] = []
    for source in sources:
        link = dest_dir / Path(source).name
        link.symlink_to(Path(source).resolve())
        staged.append(link)
    return staged


# --- Preflight -------------------------------------------------------------


def preflight(
    tasks: Sequence[BenchmarkTask],
    *,
    data_dir: str | Path = "data",
    repo_root: str | Path = ".",
    probe: bool = True,
) -> str | None:
    """Check every resource the sampled ``tasks`` declare; return an error or None.

    Called before the first model call. A missing attachment or a site host that
    is not running would otherwise reach the judge as an ordinary task failure,
    indistinguishable from the agent being unable to do the work — which is worse
    than not running at all, because it produces a plausible wrong number.
    """
    problems: list[str] = []

    missing_files = sorted(
        {
            str(path)
            for task in tasks
            for path in resolve_attachments(task, data_dir=data_dir)
            if not path.is_file()
        }
    )
    if missing_files:
        problems.append(
            "missing task attachments: " + ", ".join(missing_files)
        )

    slugs = sorted({slug for task in tasks if (slug := declared_site(task))})
    missing_sites = [
        slug for slug in slugs if not site_source_dir(slug, repo_root=repo_root).is_dir()
    ]
    if missing_sites:
        problems.append(
            "dataset declares local sites with no source directory under "
            f"{SITE_APP_SUBDIR}: {', '.join(missing_sites)}"
        )

    if slugs and probe and not missing_sites:
        for slug in slugs:
            url = site_url(slug)
            reachable, detail = probe_site(url)
            if not reachable:
                problems.append(
                    f"local site not reachable at {url} ({detail}) — start it with "
                    "`make benchmark-sites-serve`, or point "
                    f"{SITE_ORIGIN_ENV} at the host already serving it"
                )

    return "; ".join(problems) if problems else None
