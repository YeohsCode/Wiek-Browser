"""Stealth Bench adapter. category = site-protection type; URL from <website> tag."""

from __future__ import annotations

import re
from typing import Any

from .base import BenchmarkTask, JsonFileAdapter, extract_first_url

_WEBSITE_TAG_RE = re.compile(r"<website>(.*?)</website>", re.IGNORECASE | re.DOTALL)


class StealthBenchAdapter(JsonFileAdapter):
    name = "stealth-bench"
    judge_name = "stealth-bench"
    _source_file = "Stealth_Bench_V1.json"

    def parse_entry(self, entry: dict[str, Any]) -> BenchmarkTask:
        instruction = str(entry["confirmed_task"])
        start_url: str | None = None
        tag = _WEBSITE_TAG_RE.search(instruction)
        if tag:
            start_url = extract_first_url(tag.group(1))
        if not start_url:
            website = entry.get("website")
            if website:
                website = str(website)
                start_url = website if website.startswith("http") else f"https://{website}"
        metadata = {
            k: v
            for k, v in entry.items()
            if k not in {"task_id", "confirmed_task", "category", "answer"}
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
