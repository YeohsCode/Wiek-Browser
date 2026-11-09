"""Stage C single-run report: one or more runs merged into one pool → self-contained HTML.

Uses the unified session_parser.SessionStats without an inline parser fork.
Multiple run dirs merge into one pool; every kept sample renders without pairing.
"""

from __future__ import annotations

import html
import json
import statistics
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from wiek_bench.captcha import is_blocked
from wiek_bench.datasets import get_adapter
from wiek_bench.metrics import judge_job_wall_clock_s, judge_payload_timing
from wiek_bench.report.i18n import (
    DEFAULT_REPORT_LOCALE,
    ReportLocale,
    report_messages,
)
from wiek_bench.report.modules import active_modules, module_render_js, module_sections_html
from wiek_bench.report.template_single import TEMPLATE as _SINGLE_TEMPLATE
from wiek_bench.results import latest_by_task_id
from wiek_bench.screenshotter import MANIFEST_NAME
from wiek_bench.session_parser import safe_parse

DEFAULT_TERMINATION_KEYWORDS = [
    "任务终止",
    "任务已终止",
    "终止任务",
    "task terminated",
    "task aborted",
    "aborted task",
    "terminate task",
    "terminating task",
]

_LF = b"\n"


@dataclass
class Sample:
    task_id: str
    base_task_id: str
    iteration_index: int
    display_iter: int
    category: str | None
    duration_s: float
    think_time_s: float | None
    llm_time_s: float | None
    env_time_s: float | None
    time_to_first_token_s: float | None
    turns: int
    tokens_in: int
    tokens_out: int
    reasoning_tokens: int | None
    reasoning_tokens_is_estimate: bool
    cost_usd: float | None
    cost_is_estimate: bool
    cost_source: str | None
    tools: int
    tool_failures: int
    chain: list[str]
    cmds: dict[str, int]
    final_text: str
    verdict: bool | None
    score: float | None  # [0,1] partial credit under the odysseys judge
    num_rubrics: int | None  # odysseys per-rubric counts (None otherwise); consumed by report modules
    num_rubrics_passed: int | None
    failure_reason: str | None
    impossible_task: bool | None
    reached_captcha: bool | None
    error: str | None
    judge_duration_s: float | None
    judge_rubric_count: int
    source_run: str
    # Full structured Odysseys rubric results loaded from judges/<task>_judge.json.
    # This is None for other judges and when the artifact is unavailable.
    rubric_results: list[dict[str, Any]] | None = None
    # Whether a trajectory gallery manifest exists without reading its frames.
    has_screenshots: bool = False
    # Stage A interception. The sample is real — its timing and cost count toward the
    # aggregates — it just carries no verdict, which the report badges rather than hides.
    blocked_by_captcha: bool = False
    captcha_detail: str | None = None


@dataclass
class Group:
    label: str
    samples: list[Sample]
    run_ids: list[str] = field(default_factory=list)
    dirs: list[str] = field(default_factory=list)
    concurrency: int | None = None
    wall: float = 0.0
    judge_model: str | None = None
    judge_wall_s: float | None = None
    dropped: list[dict[str, Any]] = field(default_factory=list)
    benchmark: str | None = None
    provider: str | None = None
    model: str | None = None
    browser_tool: str | None = None
    planned_count: int | None = None


def _ordered_chain(session_file: str | None) -> list[str]:
    if not session_file or not Path(session_file).exists():
        return []
    chain: list[str] = []
    try:
        raw = Path(session_file).read_bytes()
    except Exception:  # noqa: BLE001
        return []
    for line in raw.split(_LF):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        if entry.get("type") != "message":
            continue
        msg = entry.get("message") or {}
        if msg.get("role") != "assistant":
            continue
        for block in msg.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "toolCall":
                name = block.get("name") or "?"
                if name == "bash":
                    cmd = (block.get("arguments") or {}).get("command") or ""
                    head = cmd.strip().split()[0] if cmd.strip() else "bash"
                    chain.append(head)
                else:
                    chain.append(name)
    return chain


def _sample_from_record(
    rec: dict[str, Any],
    run_id: str,
    pricing_snapshot: dict[str, Any] | None,
) -> Sample:
    stats = (
        safe_parse(rec.get("session_file"), pricing_snapshot=pricing_snapshot)
        if rec.get("session_file")
        else None
    )
    duration = 0.0
    think_time: float | None = None
    llm_time: float | None = None
    env_time: float | None = None
    time_to_first_token: float | None = None
    turns = 0
    tokens_in = 0
    tokens_out = 0
    reasoning_tokens: int | None = None
    reasoning_is_estimate = False
    cost: float | None = None
    cost_is_estimate = False
    cost_source: str | None = None
    tools = 0
    tool_failures = 0
    cmds: dict[str, int] = {}
    final_text = ""
    if stats is not None:
        duration = stats.duration_s or 0.0
        think_time = stats.think_time_s
        llm_time = stats.llm_time_s
        env_time = stats.env_time_s
        time_to_first_token = stats.time_to_first_token_s
        turns = stats.num_turns
        tokens_in = stats.input_tokens
        tokens_out = stats.output_tokens
        reasoning_tokens = stats.reasoning_tokens
        reasoning_is_estimate = stats.reasoning_tokens_is_estimate
        cost = stats.cost_usd
        cost_is_estimate = stats.cost_is_estimate
        cost_source = stats.cost_source
        tools = stats.tool_calls
        tool_failures = stats.tool_failures
        final_text = stats.final_output
        cmds = dict(stats.bash_cmd_dist)
        for tool, count in stats.tool_call_dist.items():
            if tool != "bash":
                cmds[tool] = cmds.get(tool, 0) + count
    # fall back to tasks.jsonl timestamps when session has no duration
    if not duration and rec.get("started_at") and rec.get("ended_at"):
        try:
            s = datetime.fromisoformat(rec["started_at"])
            e = datetime.fromisoformat(rec["ended_at"])
            duration = max(0.0, (e - s).total_seconds())
        except Exception:  # noqa: BLE001
            pass
    return Sample(
        task_id=str(rec.get("task_id")),
        base_task_id=str(rec.get("base_task_id") or rec.get("task_id")),
        iteration_index=int(rec.get("iteration_index") or 1),
        display_iter=int(rec.get("iteration_index") or 1),
        category=rec.get("category"),
        duration_s=duration,
        think_time_s=think_time,
        llm_time_s=llm_time,
        env_time_s=env_time,
        time_to_first_token_s=time_to_first_token,
        turns=turns,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        reasoning_tokens=reasoning_tokens,
        reasoning_tokens_is_estimate=reasoning_is_estimate,
        cost_usd=cost,
        cost_is_estimate=cost_is_estimate,
        cost_source=cost_source,
        tools=tools,
        tool_failures=tool_failures,
        chain=_ordered_chain(rec.get("session_file")),
        cmds=cmds,
        final_text=final_text,
        verdict=rec.get("verdict"),
        score=rec.get("score"),
        num_rubrics=rec.get("num_rubrics"),
        num_rubrics_passed=rec.get("num_rubrics_passed"),
        failure_reason=rec.get("failure_reason"),
        impossible_task=rec.get("impossible_task"),
        reached_captcha=rec.get("reached_captcha"),
        error=rec.get("error"),
        blocked_by_captcha=is_blocked(rec),
        captcha_detail=rec.get("captcha_detail"),
        judge_duration_s=None,
        judge_rubric_count=0,
        source_run=run_id,
    )


def _load_judge_payload(run_dir: Path, task_id: str) -> dict[str, Any] | None:
    """Load one canonical judge artifact for report projections."""
    jf = run_dir / "judges" / f"{task_id}_judge.json"
    if not jf.exists():
        return None
    try:
        return json.loads(jf.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def _rubric_results(payload: dict[str, Any] | None) -> list[dict[str, Any]] | None:
    """Extract full odysseys rubric reasoning; missing/binary payloads return None."""
    if payload is None:
        return None
    rr = (payload.get("metadata") or {}).get("rubric_results")
    return rr if isinstance(rr, list) and rr else None


def _rubric_payload(rr: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    """Project rubric results to the report fields without truncating reasoning."""
    if not rr:
        return None
    return [
        {
            "id": r.get("rubric_id"),
            "satisfied": bool(r.get("satisfied")),
            "requirement": r.get("requirement") or "",
            "reasoning": r.get("reasoning") or "",
            "confidence": r.get("confidence"),
        }
        for r in rr
    ]


def assign_display_iter(group: Group) -> None:
    """Renumber display_iter 1..N per base task, ordered by run and iteration."""
    order = {rid: i for i, rid in enumerate(group.run_ids)}
    by_base: dict[str, list[Sample]] = {}
    for s in group.samples:
        by_base.setdefault(s.base_task_id, []).append(s)
    for lst in by_base.values():
        lst.sort(key=lambda s: (order.get(s.source_run, 0), s.iteration_index))
        for i, s in enumerate(lst):
            s.display_iter = i + 1


def load_group(paths: list[str | Path], label: str) -> Group:
    samples: list[Sample] = []
    run_ids: list[str] = []
    dirs: list[str] = []
    concurrency: int | None = None
    wall = 0.0
    judge_walls: list[float] = []
    judge_model: str | None = None
    benchmark: str | None = None
    provider: str | None = None
    model: str | None = None
    browser_tool: str | None = None
    planned: int | None = None
    for p in paths:
        run_dir = Path(p)
        meta_path = run_dir / "run_metadata.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
        run_id = meta.get("run_id") or run_dir.name
        run_ids.append(run_id)
        dirs.append(run_dir.name)
        concurrency = meta.get("concurrency", concurrency)
        wall += float(meta.get("wall_clock_total_s") or 0.0)
        judge_wall = judge_job_wall_clock_s(run_dir)
        if judge_wall is not None:
            judge_walls.append(judge_wall)
        judge_model = meta.get("judge_model", judge_model)
        benchmark = meta.get("benchmark", benchmark)
        provider = meta.get("provider") or meta.get("pi_provider", provider)
        model = meta.get("model", model)
        browser_tool = meta.get("browser_tool", browser_tool)
        if meta.get("task_count_planned") is not None:
            planned = (planned or 0) + int(meta["task_count_planned"])
        for rec in latest_by_task_id(run_dir).values():
            s = _sample_from_record(rec, run_id, meta.get("codex_pricing"))
            judge_payload = _load_judge_payload(run_dir, str(rec.get("task_id")))
            s.rubric_results = _rubric_results(judge_payload)
            s.judge_duration_s, s.judge_rubric_count = judge_payload_timing(
                judge_payload or {}
            )
            s.has_screenshots = (
                run_dir / "screenshots" / str(rec.get("task_id")) / "frames" / MANIFEST_NAME
            ).exists()
            samples.append(s)
    group = Group(
        label=label,
        samples=samples,
        run_ids=run_ids,
        dirs=dirs,
        concurrency=concurrency,
        wall=round(wall, 2),
        judge_model=judge_model,
        judge_wall_s=round(sum(judge_walls), 2) if judge_walls else None,
        benchmark=benchmark,
        provider=provider,
        model=model,
        browser_tool=browser_tool,
        planned_count=planned,
    )
    assign_display_iter(group)
    return group


def filter_samples(
    samples: list[Sample],
    *,
    exclude_ids: set[str],
    drop_error: bool,
    keywords: list[str],
) -> tuple[list[Sample], list[dict[str, Any]]]:
    kept: list[Sample] = []
    dropped: list[dict[str, Any]] = []
    lowered = [k.lower() for k in keywords]
    for s in samples:
        if s.task_id in exclude_ids or s.base_task_id in exclude_ids:
            dropped.append({"task_id": s.task_id, "source_run": s.source_run, "reason": "manual:task_id"})
            continue
        # A CAPTCHA-blocked sample is deliberately NOT dropped here: it carries no error,
        # so drop_error leaves it in the main list with real timing/cost data and an amber
        # badge marking the missing verdict.
        if drop_error and s.error:
            dropped.append({"task_id": s.task_id, "source_run": s.source_run, "reason": f"error:{s.error[:40]}"})
            continue
        if drop_error and not s.final_text.strip():
            dropped.append({"task_id": s.task_id, "source_run": s.source_run, "reason": "empty_output"})
            continue
        ft = s.final_text
        hit = next((k for k in lowered if k in ft.lower()), None)
        if hit:
            dropped.append({"task_id": s.task_id, "source_run": s.source_run, "reason": f"keyword:{hit}"})
            continue
        kept.append(s)
    return kept, dropped


def _pctl(values: list[float], q: float) -> float:
    """Return a linearly interpolated percentile; a singleton returns itself."""
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    idx = q * (len(s) - 1)
    lo = int(idx)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (idx - lo)


def _time_block(prefix: str, values: list[float]) -> dict[str, Any]:
    """Return average, p50, p90, and total fields, or no fields for empty data."""
    if not values:
        return {}
    n = len(values)
    return {
        f"{prefix}_avg": round(sum(values) / n, 2),
        f"{prefix}_p50": round(_pctl(values, 0.5), 2),
        f"{prefix}_p90": round(_pctl(values, 0.9), 2),
        f"{prefix}_total": round(sum(values), 2),
    }


def _agg(samples: list[Sample]) -> dict[str, Any]:
    n = len(samples)
    if n == 0:
        return {"count": 0}
    durations = [s.duration_s for s in samples]
    costs = [s.cost_usd for s in samples if s.cost_usd is not None]
    tools = sum(s.tools for s in samples)
    tool_failures = sum(s.tool_failures for s in samples)
    turns = sum(s.turns for s in samples)
    tokens_in = sum(s.tokens_in for s in samples)
    tokens_out = sum(s.tokens_out for s in samples)
    d_avg = sum(durations) / n
    c_avg = sum(costs) / len(costs) if costs else None
    d_std = statistics.stdev(durations) if n > 1 else 0.0
    c_std = statistics.stdev(costs) if len(costs) > 1 else (0.0 if costs else None)
    out = {
        "count": n,
        "duration_avg": round(d_avg, 2),
        "duration_std": round(d_std, 2),
        "duration_cv": round(d_std / d_avg, 3) if d_avg else 0.0,
        "duration_total": round(sum(durations), 2),
        "duration_p50": round(_pctl(durations, 0.5), 2),
        "duration_p90": round(_pctl(durations, 0.9), 2),
        "cost_avg": round(c_avg, 5) if c_avg is not None else None,
        "cost_std": round(c_std, 5) if c_std is not None else None,
        "cost_cv": round(c_std / c_avg, 3) if c_avg and c_std is not None else None,
        "cost_total": round(sum(costs), 5) if costs else None,
        "cost_count": len(costs),
        "cost_is_estimate": any(s.cost_is_estimate for s in samples if s.cost_usd is not None),
        "cost_sources": sorted(
            {s.cost_source for s in samples if s.cost_usd is not None and s.cost_source}
        ),
        "tools": tools,
        "tool_failures": tool_failures,
        "tools_avg": round(tools / n, 2),
        "turns": turns,
        "turns_avg": round(turns / n, 2),
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "tokens_total": tokens_in + tokens_out,
        "tokens_avg": round((tokens_in + tokens_out) / n, 1),
    }
    # Sum reasoning tokens only for samples that expose them. If any included
    # value is estimated, the aggregate is also marked as estimated.
    reasoning_samples = [s for s in samples if s.reasoning_tokens is not None]
    if reasoning_samples:
        out["tokens_reasoning"] = sum(s.reasoning_tokens for s in reasoning_samples)
        out["tokens_reasoning_is_estimate"] = any(s.reasoning_tokens_is_estimate for s in reasoning_samples)
    # Aggregate timing components only when the session parser exposes them.
    # Omit think-time fields when legacy sessions cannot measure that interval.
    out.update(_time_block("think_time", [s.think_time_s for s in samples if s.think_time_s is not None]))
    out.update(_time_block("llm_time", [s.llm_time_s for s in samples if s.llm_time_s is not None]))
    out.update(_time_block("env_time", [s.env_time_s for s in samples if s.env_time_s is not None]))
    out.update(
        _time_block(
            "ttft",
            [
                s.time_to_first_token_s
                for s in samples
                if s.time_to_first_token_s is not None
            ],
        )
    )
    overheads = [
        max(0.0, s.duration_s - (s.think_time_s or 0.0) - s.llm_time_s - s.env_time_s)
        for s in samples
        if s.llm_time_s is not None and s.env_time_s is not None
    ]
    out.update(_time_block("overhead", overheads))
    # Success is verdict-only; a partial score between zero and one is not a success.
    success = sum(1 for s in samples if s.verdict)
    out["success_rate"] = round(success / n, 4)
    timed_judges = [
        s
        for s in samples
        if s.judge_duration_s is not None and s.judge_rubric_count > 0
    ]
    judge_rubric_count = sum(s.judge_rubric_count for s in timed_judges)
    if judge_rubric_count:
        judge_duration_total = sum(s.judge_duration_s or 0.0 for s in timed_judges)
        out["judge_total_duration_s"] = round(judge_duration_total, 2)
        out["judge_avg_duration_per_rubric_s"] = round(
            judge_duration_total / judge_rubric_count, 2
        )
        out["judge_rubric_count"] = judge_rubric_count
    return out


def _by_base(samples: list[Sample]) -> dict[str, list[Sample]]:
    out: dict[str, list[Sample]] = {}
    for s in samples:
        out.setdefault(s.base_task_id, []).append(s)
    return out


def _iter_buckets(base_pool: list[Sample]) -> dict[str, Any]:
    """Build per-display-iteration aggregates; the unused test side stays None."""
    iters = sorted({s.display_iter for s in base_pool})
    out: dict[str, Any] = {}
    for it in iters:
        b_agg = _agg([s for s in base_pool if s.display_iter == it])
        out[str(it)] = {"base": b_agg, "test": None}
    return out


def build_payload(
    base: Group,
    *,
    exclude_ids: set[str] | None = None,
    drop_error: bool = True,
    keywords: list[str] | None = None,
    dataset: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build the single-run report payload: one pool, no pairing, every kept sample
    renders. The ``test`` side of each node stays ``None``/empty — a vestigial slot the
    single template ignores because it only reads ``.base``. The slot is retained for
    payload compatibility.
    """
    exclude_ids = exclude_ids or set()
    keywords = list(DEFAULT_TERMINATION_KEYWORDS) + [
        k for k in (keywords or []) if k not in DEFAULT_TERMINATION_KEYWORDS
    ]
    base_kept, base_dropped = filter_samples(
        base.samples, exclude_ids=exclude_ids, drop_error=drop_error, keywords=keywords
    )

    base_by = _by_base(base_kept)

    base_pool: list[Sample] = []
    rows: list[dict[str, Any]] = []
    per_base: dict[str, Any] = {}
    base_run = base.run_ids[0] if base.run_ids else ""

    common = sorted(base_by)
    for bid in common:
        b_list = sorted(base_by[bid], key=lambda s: s.display_iter)
        base_pool += b_list
        per_base[bid] = {
            "count": len(b_list),
            "base_count": len(b_list),
            "test_count": 0,
            "iters": [s.display_iter for s in b_list],
            "base": _agg(b_list),
            "test": None,
        }
        for b in b_list:
            rows.append(
                {
                    "task_id": b.task_id,
                    "base_task_id": bid,
                    "iter": b.display_iter,
                    "category": b.category,
                    "base": _row_side(b, base_run),
                    "test": None,
                }
            )

    iter_node = _iter_buckets(base_pool)
    # render_html splices dataset-specific modules into _SINGLE_TEMPLATE.
    # This generic loop contains no dataset names; a None block makes the template
    # hides its section. Keyed under "modules" so adding a module needs no schema change.
    modules_out: dict[str, Any] = {}
    for mod in active_modules(base.benchmark):
        base_block = mod.compute(base_pool)
        if base_block is not None:
            modules_out[mod.key] = {"base": base_block, "test": None}
    return {
        "meta": {
            "mode": "single",
            "base_label": base.label,
            "test_label": "",
            "base_run": ",".join(base.run_ids),
            "test_run": "",
            "base_dirs": base.dirs,
            "test_dirs": [],
            "base_concurrency": base.concurrency,
            "test_concurrency": None,
            "base_wall": base.wall,
            "test_wall": 0.0,
            "common_count": len(common),
            "paired_count": len(base_by),
            "only_base": [],
            "only_test": [],
            "base_dropped": base_dropped,
            "test_dropped": [],
            # Optional metadata consumed defensively by the frontend.
            "benchmark": base.benchmark,
            "provider": base.provider,
            "model": base.model,
            "browser_tool": base.browser_tool,
            "base_run_count": len(base.run_ids),
            "test_run_count": 0,
            "base_judge": base.judge_model,
            "base_judge_wall_s": base.judge_wall_s,
            "test_judge": None,
            "planned_count": base.planned_count,
            "iterations": sorted({s.display_iter for s in base_pool}),
            "exclude_keywords": keywords,
        },
        "totals": {
            "base": _agg(base_pool),
            "test": None,
        },
        "iter": iter_node,
        "per_base": per_base,
        "rows": rows,
        "dataset": dataset or [],
        "modules": modules_out,
        "gen_at": datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z"),
    }


def _row_side(s: Sample, run_id: str) -> dict[str, Any]:
    return {
        "task_id": s.task_id,
        "source_run": s.source_run,
        "duration": round(s.duration_s, 2),
        "think_time": None if s.think_time_s is None else round(s.think_time_s, 2),
        "llm_time": None if s.llm_time_s is None else round(s.llm_time_s, 2),
        "env_time": None if s.env_time_s is None else round(s.env_time_s, 2),
        "time_to_first_token": (
            None
            if s.time_to_first_token_s is None
            else round(s.time_to_first_token_s, 2)
        ),
        "turns": s.turns,
        "tokens_in": s.tokens_in,
        "tokens_out": s.tokens_out,
        "cost": None if s.cost_usd is None else round(s.cost_usd, 5),
        "cost_is_estimate": s.cost_is_estimate,
        "cost_source": s.cost_source,
        "tools": s.tools,
        "tool_failures": s.tool_failures,
        "chain": s.chain[:12],
        "cmds": dict(sorted(s.cmds.items(), key=lambda kv: -kv[1])[:5]),
        "final_text": s.final_text[:320],
        "verdict": s.verdict,
        "score": s.score,
        # Stage A intercepted this task on an agent-reported anti-bot wall, so it carries
        # no verdict — the badge explains the missing one.
        "captcha_blocked": s.blocked_by_captcha,
        "captcha_detail": s.captcha_detail or "",
        # Judge OUTPUT flags. Only BUBenchJudge — the fallback judge, so bu-bench plus
        # real-world-bench — and StealthBenchJudge can set them; the odysseys and
        # online-mind2web judges leave them at the base default. None when no
        # judge ran, which reads as "no badge" in the template. Distinct from
        # captcha_blocked, which Stage A decides before any judge sees the task.
        "reached_captcha": s.reached_captcha,
        "impossible_task": s.impossible_task,
        # Keep full failure reasoning. The frontend prefers structured rubric
        # results and falls back to this field for other or missing judges.
        "failure_reason": s.failure_reason or "",
        # Full pass/fail Odysseys rubric results power per-rubric session links.
        "rubric_results": _rubric_payload(s.rubric_results),
        # The frontend links to the trajectory gallery when it exists.
        "has_screenshots": s.has_screenshots,
    }


def render_html(
    payload: dict[str, Any],
    *,
    locale: ReportLocale = DEFAULT_REPORT_LOCALE,
) -> str:
    """Render the single-run report template via token substitution.

    The payload JSON escapes ``</`` so embedded final_text can never break out of
    the ``<script type="application/json">`` carrier tag.
    """
    meta = payload["meta"]
    # Splice dataset modules into the single-run template. All registered module
    # sections and scripts are injected; each stays hidden unless payload["modules"][key]
    # is present — keeps assembly dataset-agnostic.
    template = (
        _SINGLE_TEMPLATE
        .replace("__MODULE_SECTIONS__", module_sections_html())
        .replace("__MODULE_JS__", module_render_js())
    )
    benchmark = meta.get("benchmark") or ""
    messages = report_messages(locale)
    doc_title = (
        f"{benchmark + ' · ' if benchmark else ''}{messages['report_title']} · "
        f"{meta['base_label']}"
    )
    payload_json = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    messages_json = json.dumps(messages, ensure_ascii=False).replace("</", "<\\/")
    return (
        template.replace("__DOC_TITLE__", html.escape(doc_title))
        .replace("__REPORT_LANG__", "zh-CN" if locale == "zh" else "en")
        .replace("__REPORT_MESSAGES__", messages_json)
        .replace("__PAYLOAD__", payload_json)
    )


def _load_dataset(dataset_path: str | Path | None, benchmark: str | None) -> list[dict[str, Any]]:
    """Load the report's task reference table.

    Explicit path wins; otherwise use the registered dataset adapter's source
    file. Missing or unreadable → ``[]`` (graceful degradation, e.g. adhoc runs
    have no dataset).
    """
    path: Path | None
    if dataset_path:
        path = Path(dataset_path)
    elif benchmark:
        try:
            source_path = getattr(get_adapter(benchmark), "source_path")
            path = Path(source_path)
        except Exception:  # noqa: BLE001
            path = Path("data") / f"{benchmark}.json"
    else:
        path = None
    if path is None or not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []
    return data if isinstance(data, list) else []


def render_single_report(
    run_dirs: list[str | Path],
    *,
    out_path: str | Path,
    locale: ReportLocale = DEFAULT_REPORT_LOCALE,
    label: str | None = None,
    exclude_ids: set[str] | None = None,
    drop_error: bool = True,
    keywords: list[str] | None = None,
    dataset_path: str | Path | None = None,
) -> Path:
    """Render one or more runs as a single pooled report without pairing."""
    group = load_group(run_dirs, label or "run")
    if label is None and group.dirs:
        group.label = group.dirs[0]
    payload = build_payload(
        group,
        exclude_ids=exclude_ids,
        drop_error=drop_error,
        keywords=keywords,
        dataset=_load_dataset(dataset_path, group.benchmark),
    )
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(render_html(payload, locale=locale), encoding="utf-8")
    return out_path
