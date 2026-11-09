"""Odysseys-family report module.

Per-rubric metrics aligned to the Odysseys paper Table: Rubric Avg (rubric-micro),
Perfect %, Avg. Steps, Trajectory Efficiency, plus a by-level (difficulty) split.
Active for ``judge_name == "odysseys"`` runs (odysseys / real-world-bench).
All four are judge-derived.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from wiek_bench.datasets import get_adapter
from wiek_bench.report.modules.base import ReportModule

if TYPE_CHECKING:
    from wiek_bench.report.compare import Sample

KEY = "odysseys_metrics"


def _matches(benchmark: str | None) -> bool:
    if not benchmark:
        return False
    try:
        return getattr(get_adapter(benchmark), "judge_name", None) == "odysseys"
    except Exception:  # noqa: BLE001
        return False


def _trajectory_efficiency(terms: list[tuple[float, int]]) -> dict[str, Any]:
    """Odysseys Trajectory Efficiency = (1/N) Σ s_i/n_i, mirroring upstream
    ``run_full_trajectory_per_rubric.py`` with ``num_turns`` as the step count.

    ``terms`` = ``[(s_i, n_i), ...]`` where ``s_i`` is the task rubric-mean score
    ∈[0,1] and ``n_i`` is ``num_turns``. Tasks with ``n_i<=0`` are dropped (no
    step count → no term). Lives here, not in metrics.py: the report module is the
    sole consumer — Trajectory Efficiency is no longer written to summary.json."""
    valid = [(s, n) for s, n in terms if n > 0]
    if not valid:
        return {"trajectory_efficiency_x100": 0.0, "avg_steps": 0.0, "efficiency_task_count": 0}
    eff = sum(s / n for s, n in valid) / len(valid)
    steps = sum(n for _, n in valid) / len(valid)
    return {
        "trajectory_efficiency_x100": round(eff * 100, 4),
        "avg_steps": round(steps, 4),
        "efficiency_task_count": len(valid),
    }


def _group(samples: "list[Sample]") -> dict[str, Any] | None:
    """Metrics over one pool. The ``perfect`` denominator is the full pool;
    rubric-micro, steps, and efficiency exclude judge_error tasks
    (score is None) — the harness's null-not-zero rule."""
    n = len(samples)
    if n == 0:
        return None
    perfect = sum(1 for s in samples if s.verdict)
    scored = [s for s in samples if s.score is not None]
    # Rubric-micro average: sum(passed) / sum(total) over scored
    # tasks that carry per-rubric counts (pre-change runs lack them → rubric_avg=None).
    micro = [s for s in scored if s.num_rubrics]
    total_rubrics = sum(int(s.num_rubrics) for s in micro)  # type: ignore[arg-type]
    passed_rubrics = sum(int(s.num_rubrics_passed or 0) for s in micro)
    eff = _trajectory_efficiency([(float(s.score), s.turns) for s in scored])  # type: ignore[arg-type]
    return {
        "count": n,
        "scored_count": len(scored),
        "rubric_avg": round(passed_rubrics / total_rubrics * 100, 2) if total_rubrics else None,
        "rubric_task_count": len(micro),
        "perfect_pct": round(perfect / n * 100, 2),
        "perfect_count": perfect,
        "avg_steps": eff["avg_steps"],
        "traj_eff_x100": eff["trajectory_efficiency_x100"],
        "eff_task_count": eff["efficiency_task_count"],
    }


def _compute(samples: "list[Sample]") -> dict[str, Any] | None:
    overall = _group(samples)
    if overall is None:
        return None
    buckets: dict[str, list[Sample]] = {}
    for s in samples:
        buckets.setdefault(s.category or "unknown", []).append(s)
    by_level = {lv: _group(g) for lv, g in sorted(buckets.items())}
    return {"overall": overall, "by_level": by_level}


SECTION_HTML = r"""
  <!-- Odysseys metrics: a dynamic module for the Odysseys dataset family. -->
  <section id="sec-odysseys" class="judge-only" hidden>
    <h2>
      <span class="sec-no">＋</span><span data-i18n="ody_section"></span>
      <span class="en" data-i18n="ody_section_secondary"></span>
    </h2>
    <p class="sec-desc" id="ody-desc"></p>
    <div class="tabcap">
      <b data-i18n="ody_table_o1"></b> <span data-i18n="ody_primary_caption"></span>
      (n = <span id="ody-n"></span>)
    </div>
    <div class="stat-band" id="ody-band"></div>
    <div class="tabcap" style="margin-top:28px">
      <b data-i18n="ody_table_o2"></b> <span data-i18n="ody_breakdown_caption"></span>
      <span class="en" style="margin-left:8px">by_level</span>
    </div>
    <p class="sec-desc" data-i18n="ody_breakdown_description"></p>
    <div class="detail-wrap"><table class="three-line" id="ody-level-tbl"></table></div>
  </section>
"""

# Runs inside the report IIFE — shares $, esc, fS, PAYLOAD, M. Block-scoped to
# avoid colliding with other modules / the main render body.
RENDER_JS = r"""
  /* Show the dynamic Odysseys metrics module only when its payload exists. */
  {
    const ROOT = (PAYLOAD.modules || {})["odysseys_metrics"];
    const ODY = ROOT && ROOT.base && ROOT.base.overall;
    if (ODY) {
      $("sec-odysseys").hidden = false;
      $("ody-n").textContent = ODY.count || 0;
      $("ody-desc").innerHTML = I.ody_description;
      const band = [
        { k: "Rubric Avg", v: fS(ODY.rubric_avg, 2), u: "", accent: true,
          sub: ODY.rubric_avg == null
            ? I.ody_rerun_required
            : tr("ody_micro_tasks", { count: ODY.rubric_task_count }) },
        { k: "Perfect", v: fS(ODY.perfect_pct, 1), u: "%",
          sub: tr("ody_all_pass", { passed: ODY.perfect_count, total: ODY.count }) },
        { k: "Avg. Steps", v: fS(ODY.avg_steps, 2), u: "",
          sub: tr("ody_tasks_included", { count: ODY.eff_task_count }) },
        { k: "Traj. Eff.", v: fS(ODY.traj_eff_x100, 2), u: "", accent: true,
          sub: I.ody_efficiency_unit },
      ];
      $("ody-band").innerHTML = band.map(s =>
        '<div class="stat' + (s.accent ? " accent" : "") + '">' +
        '<span class="k">' + esc(s.k) + '</span>' +
        '<span class="v">' + esc(s.v) + (s.u ? "<small>" + s.u + "</small>" : "") + '</span>' +
        '<span class="sub">' + esc(s.sub) + "</span></div>").join("");

      const row = (label, g, cls) => !g ? "" :
        "<tr" + (cls ? ' class="' + cls + '"' : "") + "><td>" + esc(label) + '</td>' +
        '<td class="dim">' + g.count + "</td><td>" + fS(g.rubric_avg, 2) + "</td><td>" + fS(g.perfect_pct, 1) +
        "</td><td>" + fS(g.avg_steps, 2) + "</td><td>" + fS(g.traj_eff_x100, 2) + "</td></tr>";
      const lv = ROOT.base.by_level || {};
      $("ody-level-tbl").innerHTML =
        "<thead><tr><th>" + esc(I.ody_difficulty_category) +
        "</th><th>n</th><th>Rubric Avg</th><th>Perfect %</th><th>Avg. Steps</th><th>Traj. Eff.</th></tr></thead><tbody>" +
        Object.keys(lv).map(k => row(k, lv[k])).join("") +
        row(I.ody_overall, ODY, "dim") +
        "</tbody>";
    }
  }
"""

MODULE = ReportModule(
    key=KEY,
    matches=_matches,
    compute=_compute,
    section_html=SECTION_HTML,
    render_js=RENDER_JS,
)
