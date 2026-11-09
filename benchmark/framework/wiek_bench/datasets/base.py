"""Dataset abstraction: BenchmarkTask + DatasetAdapter Protocol + shared rules.

Task selection (explicit ``task_ids``, else the whole dataset) is implemented
once in ``sample_tasks`` so every benchmark behaves identically. There is no
random sampling: a run's task set is always fully determined by its config.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

_URL_RE = re.compile(r"https?://\S+")
_TRAILING_PUNCT = "，。、,.;:)）]】 \t\n\r\"'>"


@dataclass(frozen=True)
class BenchmarkTask:
    """A single benchmark task, normalised across all source datasets."""

    task_id: str
    benchmark: str
    instruction: str
    category: str | None = None
    answer: str | None = None
    start_url: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class DatasetAdapter(Protocol):
    name: str
    judge_name: str

    def load(self) -> list[BenchmarkTask]: ...

    def sample(self, *, task_ids: list[str] | None = None) -> list[BenchmarkTask]: ...


def extract_first_url(text: str) -> str | None:
    """First http(s) URL in ``text`` with trailing punctuation stripped."""
    match = _URL_RE.search(text or "")
    if not match:
        return None
    return match.group(0).rstrip(_TRAILING_PUNCT) or None


def sample_tasks(
    tasks: list[BenchmarkTask],
    *,
    task_ids: list[str] | None = None,
) -> list[BenchmarkTask]:
    """Select ``task_ids`` in the requested order, or the whole dataset.

    fail-loud on missing ids.
    """
    if not task_ids:
        return list(tasks)
    index = {t.task_id: t for t in tasks}
    out: list[BenchmarkTask] = []
    seen: set[str] = set()
    for tid in task_ids:
        tid = str(tid)
        if tid in seen:
            continue
        if tid not in index:
            raise KeyError(f"task_id not found in dataset: {tid}")
        seen.add(tid)
        out.append(index[tid])
    return out


class JsonFileAdapter:
    """Concrete base for JSON-array datasets.

    Subclasses set ``name`` / ``judge_name`` / ``_source_file`` and implement
    ``parse_entry``. Sampling and loading are shared.
    """

    name: str = ""
    judge_name: str = ""
    _source_file: str = ""

    def __init__(self, data_dir: str | Path = "data") -> None:
        self.data_dir = Path(data_dir)

    @property
    def source_path(self) -> Path:
        return self.data_dir / self._source_file

    def parse_entry(self, entry: dict[str, Any]) -> BenchmarkTask:  # pragma: no cover - overridden
        raise NotImplementedError

    def load(self) -> list[BenchmarkTask]:
        raw = json.loads(self.source_path.read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            raise ValueError(f"{self.source_path} must be a JSON array")
        return [self.parse_entry(entry) for entry in raw]

    def sample(self, *, task_ids: list[str] | None = None) -> list[BenchmarkTask]:
        return sample_tasks(self.load(), task_ids=task_ids)
