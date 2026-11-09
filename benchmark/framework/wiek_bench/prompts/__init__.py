"""Prompt rendering — task prompts and judge prompts both go through jinja2.

The package dir is the template root with two sub-dirs: ``task/`` (agent task
prompts) and ``judge/`` (per-judge evaluation prompts). Templates render the
dataset task / judge context only; the per-tool instance-constraint + cleanup
fragment is injected at runtime by the pi extension, not here.
"""

from __future__ import annotations

from pathlib import Path
from typing import Sequence

from jinja2 import Environment, FileSystemLoader

from wiek_bench import captcha
from wiek_bench.datasets.base import BenchmarkTask

_TEMPLATE_ROOT = Path(__file__).parent

# Undefined renders to "" for a bare ``{{ var }}`` (jinja2 default); trim/lstrip keep
# ``{% if %}`` blocks from leaving stray blank lines in the rendered prompt.
_env = Environment(
    loader=FileSystemLoader(str(_TEMPLATE_ROOT)),
    trim_blocks=True,
    lstrip_blocks=True,
    keep_trailing_newline=True,
    autoescape=False,
)


def render_task_prompt(
    task: BenchmarkTask,
    *,
    browser_tool: str,
    template: str = "default",
    attachments: Sequence[str] = (),
) -> str:
    """Render the agent task prompt.

    ``template`` is a name resolved to ``task/<name>.j2`` (default ``default``),
    or an absolute/relative path ending in ``.j2`` used verbatim.

    ``attachments`` are the staged paths from the runspace. Datasets declare
    attachments by file name and never spell out a path, so the only path the
    agent ever sees is one the harness just created for it.
    """
    instruction = task.instruction
    if task.start_url and task.start_url not in instruction:
        instruction = f"Open {task.start_url}\n\n{instruction}"
    ctx = {
        "instruction": instruction,
        "browser_tool": browser_tool,
        "attachments": list(attachments),
        # Empty for benchmarks the harness does not intercept, so the prompt never
        # asks for a marker Stage A would ignore. See wiek_bench.captcha.
        "captcha_sentinel": (
            captcha.SENTINEL if captcha.intercepts(task.benchmark) else ""
        ),
    }
    path = Path(template)
    if template.endswith(".j2") and path.exists():
        tmpl = _env.from_string(path.read_text(encoding="utf-8"))
    else:
        tmpl = _env.get_template(f"task/{template}.j2")
    return tmpl.render(**ctx)


def render_judge_prompt(name: str, /, **context: object) -> str:
    """Render a judge prompt template from ``prompts/judge/<name>.j2``."""
    return _env.get_template(f"judge/{name}.j2").render(**context)
