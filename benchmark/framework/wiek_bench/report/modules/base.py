"""Report module contract.

A report module is a **dataset-specific, pluggable** add-on to the single-run
report. The generic engine (``compare.py``) and template (``template_single.py``)
stay dataset-agnostic; each module ships its own compute + presentation in one
file under ``modules/`` and registers itself in ``modules/__init__.py``.

Runtime stays self-contained, zero-dependency HTML: modules are
**composed at render time** (string splice), not loaded dynamically. ``render_js``
runs inside the report's main IIFE, so it shares the page helpers (``$`` / ``esc``
/ ``fS`` / ``PAYLOAD`` / ``M`` / ``I`` / ``tr`` …) — wrap each body in its own
``{ }`` block to keep locals from colliding across modules. Visible module text
must come from the shared report locale catalog.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class ReportModule:
    """One pluggable dataset module.

    - ``key``        — payload key under ``payload["modules"]`` and the binding the
                       ``render_js`` reads; also the DOM section id is the module's own concern.
    - ``matches``    — ``benchmark -> bool``; the module is active for that run.
    - ``compute``    — ``(samples) -> dict | None``; the payload block for one pool.
                       ``None`` means "render nothing" (e.g. no samples).
    - ``section_html`` — the ``<section>`` markup, hidden by default; ``render_js`` unhides it.
    - ``render_js``  — JS body spliced into the report IIFE (reads ``PAYLOAD.modules[key]``).
    """

    key: str
    matches: Callable[[str | None], bool]
    compute: Callable[..., dict | None]
    section_html: str
    render_js: str
