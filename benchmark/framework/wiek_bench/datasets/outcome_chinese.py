"""Real-world-bench adapter.

``real_world_bench.json`` adopts the Odysseys schema (task_id / confirmed_task /
website / level / reference_length / categories / rubrics, plus site_mode /
site_count / note). It reuses the Odysseys parse rules: ``category = level``,
``start_url = entry.website``, and rubrics stay in metadata for the per-rubric
odysseys judge.
"""

from __future__ import annotations

from .odysseys import OdysseysAdapter


class RealWorldBenchAdapter(OdysseysAdapter):
    name = "real-world-bench"
    _source_file = "real_world_bench.json"
