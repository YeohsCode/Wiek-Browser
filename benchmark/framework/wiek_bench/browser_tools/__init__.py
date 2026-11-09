"""Browser-tool registry.

``wiek-browser`` is the only tool shipped in the box. Integrating a different
browser framework does not require editing this package: implement the
``BrowserTool`` protocol from ``.base`` and call ``register_browser_tool`` before
a run starts, then add a matching ``browser_tools`` entry in ``config.yaml`` so
the harness can resolve its binary and skill.
"""

from __future__ import annotations

from typing import Callable

from .base import (
    AgentSurface,
    BrowserTool,
    CdpScreenshotParams,
    CloseResult,
    EngineControl,
    InvocationContext,
    is_task_management_subcommand,
    register_task_management_subcommands,
    split_pipeline_segments,
)
from .wiek_browser import WiekBrowserTool

CDP_SCREENSHOT_PARAMS = CdpScreenshotParams()

_TOOLS: dict[str, type] = {
    WiekBrowserTool.name: WiekBrowserTool,
}


def register_browser_tool(tool_cls: type) -> None:
    """Add a ``BrowserTool`` implementation to the registry.

    The class is instantiated per lookup, so it must be constructible with no
    arguments. Registering an existing name replaces it, which is how a fork
    swaps the built-in implementation without patching this module.
    """
    name = getattr(tool_cls, "name", None)
    if not name:
        raise ValueError(f"browser tool {tool_cls!r} must define a non-empty 'name'")
    _TOOLS[name] = tool_cls


def get_browser_tool(name: str) -> BrowserTool:
    if name not in _TOOLS:
        raise ValueError(f"unknown browser_tool: {name}. known: {', '.join(_TOOLS)}")
    return _TOOLS[name]()  # type: ignore[return-value]


def list_browser_tools() -> list[str]:
    return list(_TOOLS.keys())


def make_cmd_classifier(tool_name: str) -> Callable[[str], str | None]:
    """Build a command → subcommand-key classifier for a browser tool.

    Dependency-injection entry for the analytics layer: the harness
    adapter passes this closure into ``aggregate_summary`` so the pure analytics code
    never imports ``browser_tools``. A command maps to its ``&&``-joined subcommands
    (e.g. ``"open && screenshot"``), or ``None`` when it invokes no known subcommand.
    Unknown tool name → a classifier that always returns ``None``.
    """
    try:
        tool = get_browser_tool(tool_name)
    except ValueError:
        return lambda command: None

    def classify(command: str) -> str | None:
        subs: list[str] = []
        for seg in split_pipeline_segments(command):
            ctx = tool.detect_invocation(seg)
            if ctx is not None and ctx.subcommand:
                subs.append(ctx.subcommand)
        return " && ".join(subs) if subs else None

    return classify


__all__ = [
    "AgentSurface",
    "BrowserTool",
    "CDP_SCREENSHOT_PARAMS",
    "CdpScreenshotParams",
    "CloseResult",
    "EngineControl",
    "InvocationContext",
    "get_browser_tool",
    "is_task_management_subcommand",
    "list_browser_tools",
    "make_cmd_classifier",
    "register_browser_tool",
    "register_task_management_subcommands",
    "split_pipeline_segments",
]
