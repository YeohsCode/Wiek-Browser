"""Odysseys adapter for the upstream 200-task long-horizon set.

category = level; start_url = entry.website; rubrics stay in metadata for the
per-rubric odysseys judge.

An entry aimed at a harness-hosted site declares ``local_site: <slug>`` instead
of ``website``; the slug resolves against the local site host's origin so no
dataset carries a host and port of its own.
"""

from __future__ import annotations

from typing import Any

from wiek_bench.task_resources import site_url

from .base import BenchmarkTask, JsonFileAdapter


def parse_odysseys_entry(
    entry: dict[str, Any],
    *,
    benchmark: str,
    source_file: str | None = None,
) -> BenchmarkTask:
    """Map one already-validated Odysseys entry to the shared task model."""
    website = entry.get("website")
    local_site = entry.get("local_site")
    if local_site:
        if website:
            raise ValueError(
                f"{entry.get('task_id')}: set either website or local_site, not both"
            )
        website = site_url(str(local_site))
    metadata = {
        k: v
        for k, v in entry.items()
        if k not in {"task_id", "confirmed_task", "level", "website"}
    }
    if source_file is not None:
        metadata["source_file"] = source_file
    if website is not None:
        metadata["website"] = website
    return BenchmarkTask(
        task_id=str(entry["task_id"]),
        benchmark=benchmark,
        instruction=str(entry["confirmed_task"]),
        category=entry.get("level"),
        answer=None,
        start_url=str(website) if website else None,
        metadata=metadata,
    )


class OdysseysAdapter(JsonFileAdapter):
    name = "odysseys"
    judge_name = "odysseys"
    _source_file = "odysseys.json"

    def parse_entry(self, entry: dict[str, Any]) -> BenchmarkTask:
        return parse_odysseys_entry(
            entry,
            benchmark=self.name,
            source_file=self._source_file,
        )
