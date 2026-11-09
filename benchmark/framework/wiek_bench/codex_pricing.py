"""Codex API-equivalent pricing snapshots and pure rollout cost calculation."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any
from urllib.request import Request, urlopen

from loguru import logger

MODELS_DEV_API_URL = "https://models.dev/api.json"
OPENAI_PRIORITY_PRICING_URL = "https://openai.com/api/pricing/"

# OpenAI publishes priority prices per model. Keep this explicit: applying a guessed
# multiplier to a newly released model would turn an unavailable estimate into a false one.
_PRIORITY_MULTIPLIERS: dict[str, float] = {
    "gpt-5.4": 2.0,
    "gpt-5.5": 2.5,
    "gpt-5.6-sol": 2.0,
    "gpt-5.6-terra": 2.0,
    "gpt-5.6-luna": 2.0,
}
_BASE_SERVICE_TIERS = {"", "auto", "default"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _unavailable_snapshot(
    model: str,
    service_tier: str | None,
    error: str,
    *,
    fetched_at: str | None = None,
) -> dict[str, Any]:
    return {
        "status": "unavailable",
        "kind": "estimated_api_equivalent",
        "model": model,
        "service_tier": service_tier or "default",
        "currency": "USD",
        "unit": "per_million_tokens",
        "source": {
            "name": "models.dev",
            "url": MODELS_DEV_API_URL,
            "etag": None,
            "sha256": None,
            "fetched_at": fetched_at or _now_iso(),
        },
        "error": error,
    }


def _rate(value: Any, *, field: str) -> float:
    if not isinstance(value, (int, float)) or value < 0:
        raise ValueError(f"models.dev missing numeric {field}")
    return float(value)


def fetch_codex_pricing_snapshot(
    model: str,
    service_tier: str | None,
    *,
    timeout_s: float = 15.0,
) -> dict[str, Any]:
    """Fetch and normalize the selected OpenAI model's pricing for run metadata.

    Network and schema failures are data-unavailability, not run failures. The returned
    snapshot is always JSON-serializable and records the reason when unavailable.
    """
    fetched_at = _now_iso()
    request = Request(
        MODELS_DEV_API_URL,
        headers={"Accept": "application/json", "User-Agent": "wiek-benchmark-harness"},
    )
    try:
        with urlopen(request, timeout=timeout_s) as response:  # noqa: S310 - fixed HTTPS URL
            raw = response.read()
            etag = response.headers.get("ETag")
        payload = json.loads(raw)
        provider = payload.get("openai") if isinstance(payload, dict) else None
        models = provider.get("models") if isinstance(provider, dict) else None
        model_node = models.get(model) if isinstance(models, dict) else None
        if not isinstance(model_node, dict):
            raise ValueError(f"model not found in models.dev: {model}")
        cost = model_node.get("cost")
        if not isinstance(cost, dict):
            raise ValueError(f"models.dev has no cost object for {model}")

        rates = {
            "input": _rate(cost.get("input"), field="cost.input"),
            "cache_read": _rate(cost.get("cache_read"), field="cost.cache_read"),
            "output": _rate(cost.get("output"), field="cost.output"),
        }
        context_tiers: list[dict[str, float | int]] = []
        for item in cost.get("tiers") or []:
            if not isinstance(item, dict):
                continue
            tier = item.get("tier")
            if not isinstance(tier, dict) or tier.get("type") != "context":
                continue
            size = tier.get("size")
            if not isinstance(size, int) or size < 0:
                continue
            context_tiers.append(
                {
                    "above_input_tokens": size,
                    "input": _rate(item.get("input"), field="cost.tiers.input"),
                    "cache_read": _rate(
                        item.get("cache_read"), field="cost.tiers.cache_read"
                    ),
                    "output": _rate(item.get("output"), field="cost.tiers.output"),
                }
            )
        context_tiers.sort(key=lambda item: int(item["above_input_tokens"]))

        normalized_tier = (service_tier or "default").strip().lower()
        if normalized_tier in _BASE_SERVICE_TIERS:
            multiplier = 1.0
            tier_source: dict[str, Any] | None = None
        elif normalized_tier == "priority":
            multiplier = _PRIORITY_MULTIPLIERS.get(model)
            if multiplier is None:
                raise ValueError(f"priority pricing unavailable for {model}")
            tier_source = {
                "name": "OpenAI API pricing",
                "url": OPENAI_PRIORITY_PRICING_URL,
                "multiplier": multiplier,
            }
        else:
            raise ValueError(f"unsupported service tier for pricing: {normalized_tier}")

        return {
            "status": "available",
            "kind": "estimated_api_equivalent",
            "model": model,
            "service_tier": normalized_tier,
            "currency": "USD",
            "unit": "per_million_tokens",
            "rates": rates,
            "context_tiers": context_tiers,
            "service_tier_multiplier": multiplier,
            "service_tier_source": tier_source,
            "source": {
                "name": "models.dev",
                "url": MODELS_DEV_API_URL,
                "etag": etag,
                "sha256": hashlib.sha256(raw).hexdigest(),
                "fetched_at": fetched_at,
            },
            "error": None,
        }
    except Exception as exc:  # noqa: BLE001 - pricing outage must not block a benchmark run
        logger.warning("Codex pricing unavailable for {}/{}: {}", model, service_tier, exc)
        return _unavailable_snapshot(model, service_tier, str(exc), fetched_at=fetched_at)


def calculate_codex_cost_usd(
    model: str | None,
    token_usages: list[dict[str, int]],
    pricing_snapshot: dict[str, Any] | None,
) -> float | None:
    """Pure estimated USD calculation from per-turn usage and a frozen snapshot."""
    if (
        model is None
        or not token_usages
        or not isinstance(pricing_snapshot, dict)
        or pricing_snapshot.get("status") != "available"
        or pricing_snapshot.get("model") != model
    ):
        return None
    rates = pricing_snapshot.get("rates")
    if not isinstance(rates, dict):
        return None
    multiplier = pricing_snapshot.get("service_tier_multiplier")
    if not isinstance(multiplier, (int, float)) or multiplier < 0:
        return None

    context_tiers = pricing_snapshot.get("context_tiers")
    tiers = context_tiers if isinstance(context_tiers, list) else []
    total = 0.0
    for usage in token_usages:
        input_tokens = max(0, int(usage.get("input_tokens", 0)))
        cached_tokens = min(
            input_tokens,
            max(0, int(usage.get("cached_input_tokens", 0))),
        )
        output_tokens = max(0, int(usage.get("output_tokens", 0)))
        selected_rates = rates
        for tier in tiers:
            if not isinstance(tier, dict):
                continue
            threshold = tier.get("above_input_tokens")
            if isinstance(threshold, int) and input_tokens > threshold:
                selected_rates = tier
        try:
            input_rate = float(selected_rates["input"])
            cache_rate = float(selected_rates["cache_read"])
            output_rate = float(selected_rates["output"])
        except (KeyError, TypeError, ValueError):
            return None
        uncached_tokens = input_tokens - cached_tokens
        total += (
            uncached_tokens * input_rate
            + cached_tokens * cache_rate
            + output_tokens * output_rate
        ) * float(multiplier) / 1_000_000
    return total
