"""Dataset registry. ``get_adapter(name)`` returns a constructed adapter."""

from __future__ import annotations

from pathlib import Path

from .base import BenchmarkTask, DatasetAdapter, sample_tasks
from .bu_bench import BUBenchAdapter
from .odysseys import OdysseysAdapter
from .online_mind2web import OnlineMind2WebAdapter
from .outcome_chinese import RealWorldBenchAdapter
from .stealth_bench import StealthBenchAdapter

_ADAPTERS: dict[str, type] = {
    BUBenchAdapter.name: BUBenchAdapter,
    StealthBenchAdapter.name: StealthBenchAdapter,
    OnlineMind2WebAdapter.name: OnlineMind2WebAdapter,
    OdysseysAdapter.name: OdysseysAdapter,
    RealWorldBenchAdapter.name: RealWorldBenchAdapter,
}


def list_datasets() -> list[str]:
    return list(_ADAPTERS.keys())


def get_adapter(name: str, data_dir: str | Path = "data") -> DatasetAdapter:
    if name not in _ADAPTERS:
        raise ValueError(f"unknown benchmark: {name}. known: {', '.join(_ADAPTERS)}")
    return _ADAPTERS[name](data_dir=data_dir)


__all__ = [
    "BenchmarkTask",
    "DatasetAdapter",
    "get_adapter",
    "list_datasets",
    "sample_tasks",
]
