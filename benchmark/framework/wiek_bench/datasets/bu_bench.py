"""BU Bench adapter. start_url from a trailing ``website: <url>`` line."""

from __future__ import annotations

import re
from typing import Any

from .base import BenchmarkTask, JsonFileAdapter, extract_first_url

_WEBSITE_LINE_RE = re.compile(r"website\s*:\s*(\S+)", re.IGNORECASE)


class BUBenchAdapter(JsonFileAdapter):
    name = "bu-bench"
    judge_name = "bu-bench"
    _source_file = "BU_Bench_V1.json"

    def parse_entry(self, entry: dict[str, Any]) -> BenchmarkTask:
        instruction = str(entry["confirmed_task"])
        match = _WEBSITE_LINE_RE.search(instruction)
        start_url = match.group(1).rstrip("，。,.;:)）]") if match else extract_first_url(instruction)
        metadata = {
            k: v for k, v in entry.items() if k not in {"task_id", "confirmed_task", "category"}
        }
        metadata["source_file"] = self._source_file
        return BenchmarkTask(
            task_id=str(entry["task_id"]),
            benchmark=self.name,
            instruction=instruction,
            category=entry.get("category"),
            answer=entry.get("answer"),
            start_url=start_url,
            metadata=metadata,
        )
