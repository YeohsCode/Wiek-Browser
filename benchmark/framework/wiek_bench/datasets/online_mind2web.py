"""Online-Mind2Web adapter. category = level; start_url = entry.website; no answer."""

from __future__ import annotations

from typing import Any

from .base import BenchmarkTask, JsonFileAdapter


class OnlineMind2WebAdapter(JsonFileAdapter):
    name = "online-mind2web"
    judge_name = "online-mind2web"
    _source_file = "Online_Mind2Web.json"

    def parse_entry(self, entry: dict[str, Any]) -> BenchmarkTask:
        website = entry.get("website")
        metadata = {
            k: v
            for k, v in entry.items()
            if k not in {"task_id", "confirmed_task", "level", "website"}
        }
        metadata["source_file"] = self._source_file
        if website is not None:
            metadata["website"] = website
        return BenchmarkTask(
            task_id=str(entry["task_id"]),
            benchmark=self.name,
            instruction=str(entry["confirmed_task"]),
            category=entry.get("level"),
            answer=None,
            start_url=str(website) if website else None,
            metadata=metadata,
        )
