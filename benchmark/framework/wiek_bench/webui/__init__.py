"""WebUI control console (FastAPI). Optional: the CLI works without it."""

from __future__ import annotations

from .app import create_app

__all__ = ["create_app"]
