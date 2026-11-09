"""Report module registry.

Add a dataset module: create ``modules/<name>.py`` exporting a ``ReportModule``,
then append it to ``MODULES`` here. The generic engine/template need no change.
"""

from __future__ import annotations

from wiek_bench.report.modules.base import ReportModule
from wiek_bench.report.modules.odysseys import MODULE as _ODYSSEYS

# Order = render order of the spliced sections.
MODULES: list[ReportModule] = [_ODYSSEYS]


def active_modules(benchmark: str | None) -> list[ReportModule]:
    """Modules whose ``matches`` accepts this run's benchmark."""
    return [m for m in MODULES if m.matches(benchmark)]


def module_sections_html() -> str:
    """All modules' ``<section>`` markup (every section hidden until its JS shows
    it); injected once into the single-run template, dataset-agnostic."""
    return "".join(m.section_html for m in MODULES)


def module_render_js() -> str:
    """All modules' render JS, spliced into the report IIFE."""
    return "\n".join(m.render_js for m in MODULES)
