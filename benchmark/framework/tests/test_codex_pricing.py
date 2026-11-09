from __future__ import annotations

import json
from typing import Any

import pytest

from wiek_bench.codex_pricing import (
    calculate_codex_cost_usd,
    fetch_codex_pricing_snapshot,
)


def _snapshot(*, multiplier: float = 1.0) -> dict[str, Any]:
    return {
        "status": "available",
        "model": "gpt-5.4",
        "rates": {"input": 2.5, "cache_read": 0.25, "output": 15.0},
        "context_tiers": [
            {
                "above_input_tokens": 272_000,
                "input": 5.0,
                "cache_read": 0.5,
                "output": 22.5,
            }
        ],
        "service_tier_multiplier": multiplier,
    }


def test_codex_cost_is_pure_and_does_not_double_count_cache_or_reasoning() -> None:
    usages = [
        {
            "input_tokens": 100,
            "cached_input_tokens": 40,
            "output_tokens": 20,
            "reasoning_output_tokens": 5,
        }
    ]

    first = calculate_codex_cost_usd("gpt-5.4", usages, _snapshot())
    second = calculate_codex_cost_usd("gpt-5.4", usages, _snapshot())

    assert first == pytest.approx(0.00046)
    assert second == first
    assert calculate_codex_cost_usd("gpt-5.5", usages, _snapshot()) is None
    assert calculate_codex_cost_usd("gpt-5.4", [], _snapshot()) is None


def test_codex_cost_applies_context_tier_and_service_tier_multiplier() -> None:
    usages = [
        {
            "input_tokens": 300_000,
            "cached_input_tokens": 200_000,
            "output_tokens": 1_000,
        }
    ]

    cost = calculate_codex_cost_usd("gpt-5.4", usages, _snapshot(multiplier=2.0))

    assert cost == pytest.approx((100_000 * 5.0 + 200_000 * 0.5 + 1_000 * 22.5) * 2 / 1e6)


class _Response:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._raw = json.dumps(payload).encode("utf-8")
        self.headers = {"ETag": '"catalog-v1"'}

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return self._raw


def test_pricing_snapshot_records_source_and_priority_provenance(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = {
        "openai": {
            "models": {
                "gpt-5.4": {
                    "cost": {
                        "input": 2.5,
                        "cache_read": 0.25,
                        "output": 15,
                        "tiers": [
                            {
                                "input": 5,
                                "cache_read": 0.5,
                                "output": 22.5,
                                "tier": {"type": "context", "size": 272_000},
                            }
                        ],
                    }
                }
            }
        }
    }
    monkeypatch.setattr(
        "wiek_bench.codex_pricing.urlopen",
        lambda _request, timeout: _Response(payload),
    )

    snapshot = fetch_codex_pricing_snapshot("gpt-5.4", "priority")

    assert snapshot["status"] == "available"
    assert snapshot["service_tier_multiplier"] == 2.0
    assert snapshot["source"]["etag"] == '"catalog-v1"'
    assert snapshot["source"]["sha256"]
    assert snapshot["source"]["fetched_at"]
    assert snapshot["service_tier_source"]["name"] == "OpenAI API pricing"
