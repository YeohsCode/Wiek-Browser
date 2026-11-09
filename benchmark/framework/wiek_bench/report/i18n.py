"""Locale contract and message catalogs for the single-run report."""

from __future__ import annotations

from typing import Literal, TypeAlias

ReportLocale: TypeAlias = Literal["zh", "en"]
DEFAULT_REPORT_LOCALE: ReportLocale = "en"

_ZH_MESSAGES = {
    "report_title": "单 run 评测报告",
    "expand": "展开",
    "collapse": "收起",
    "abstract_label": "摘要 · Abstract",
    "section_metadata": "运行元信息",
    "section_metadata_secondary": "Run Metadata",
    "section_aggregate": "整体指标",
    "section_aggregate_secondary": "Aggregate Metrics",
    "aggregate_description": (
        "单一样本池（mode = single），不做 baseline / test 配对。duration 拆「均值 / 中位 p50 / "
        "p90 / 离散度 / 总计」，cost 拆「均值 / 离散度 / 总计」；样本标准差取 n−1，"
        "分位数线性插值（同 numpy.percentile 默认）。"
    ),
    "table_1": "表 1",
    "aggregate_caption": "整体聚合指标",
    "table_2": "表 2",
    "latency_caption": "耗时构成与分位统计（单位 s）",
    "latency_description": (
        "口径：duration = session 首尾 entry 时间戳之差；llm = Σ(assistant entry − 前一 "
        "entry)，模型请求完整往返（think 可测前含 thinking，可测后为不含 think 口径）；"
        "think = 推理耗时（预留：pi session 当前无 thinking 计时，缺失时本行隐藏）；env = "
        "Σ(toolResult entry − 前一 entry)，工具执行区间（页面加载、元素等待、bash 等）；"
        "overhead = duration − think − llm − env（session 内未归类间隙）。各行分位数独立"
        "计算，p50/p90 列不可按行相加。"
    ),
    "figure_1": "图 1",
    "latency_figure_caption": "总耗时构成占比（按 total 口径堆叠）",
    "section_iteration": "各轮均值",
    "section_iteration_secondary": "Per-iteration Means",
    "iteration_description": (
        "按重排后的 display_iter 分桶聚合（iterations ≥ 2 时渲染），用于观察跨轮变化趋势。"
    ),
    "figure_2": "图 2",
    "iteration_figure_caption": "各轮 duration / cost / tool-calls 均值",
    "section_per_task": "各 base_task 均值",
    "section_per_task_secondary": "Per-task Means",
    "per_task_description": "每个 base_task_id 自身池（跨 iteration）聚合；条长按本列最大值归一。",
    "table_3": "表 3",
    "per_task_caption": "base_task 池均值与条形对照",
    "figure_3": "图 3",
    "per_task_figure_caption": "各 base_task 三指标铅印条形（嵌于表 3）",
    "section_samples": "逐条样本",
    "section_samples_secondary": "Sample Records",
    "samples_description": (
        "task_id 链接指向 ../<source_run>/sessions_html/<task_id>.html；有轨迹截图时其旁 📷 "
        "角标新标签打开 ../<source_run>/screenshots_html/<task_id>.html。工具链取前 12 个，"
        "命令分布取前 5 个，final_text 截断 320 字。报表不内嵌截图。odysseys 样本（通过 / "
        "失败均）展开 rubric 审计：R{n} 链接到 ../<source_run>/judge_sessions_html/"
        "<task_id>/R{n}.html（新标签打开），reasoning 完整不截断。"
    ),
    "section_detail": "数值明细表",
    "section_detail_secondary": "Numeric Detail",
    "detail_description": (
        "每样本一行全部原始数值列（含 think_s / llm_s / env_s / turns / tokens 拆分），"
        "等宽数字，便于导出 Excel 或二次分析。"
    ),
    "table_4": "表 4",
    "detail_caption": "全样本原始数值明细",
    "generated_at": "生成于",
    "abstract_intro": (
        "本报告为单 run 模式（mode = <span class=\"num\">single</span>）评测产物：在 "
        "<span class=\"num\">{benchmark}</span> 基准上，以 <span class=\"num\">{provider} / "
        "{model}</span> 驱动 <span class=\"num\">{label}</span>（browser_tool "
        "<span class=\"num\">{browser_tool}</span>），覆盖 <span class=\"num\">{task_count}"
        "</span> 个 base_task{iteration_clause}，计划样本 <span class=\"num\">{planned}</span> "
        "条，有效样本 <span class=\"num\">{kept}</span> 条（丢弃 <span class=\"num\">"
        "{dropped}</span> 条，见运行元信息）。"
    ),
    "abstract_iterations": " × <span class=\"num\">{count}</span> 轮迭代",
    "abstract_metrics": (
        "池内耗时均值 <span class=\"num\">{duration_avg} s</span>{median_clause}"
        "（CV <span class=\"num\">{duration_cv}</span>）{timing_clause}。平均每样本 "
        "<span class=\"num\">{turns_avg}</span> turns、<span class=\"num\">{tokens_avg}</span> "
        "tokens（合计 <span class=\"num\">{tokens_total}</span>），{cost_clause}，工具调用合计 "
        "<span class=\"num\">{tools}</span> 次（失败 <span class=\"num\">{tool_failures}</span> "
        "次）{judge_clause}。"
    ),
    "abstract_median": (
        "，中位 <span class=\"num\">{duration_p50} s</span>，p90 "
        "<span class=\"num\">{duration_p90} s</span>"
    ),
    "abstract_timing_with_think": (
        "；其中推理（think）占 <span class=\"num\">{think_share}</span>、模型生成占 "
        "<span class=\"num\">{llm_share}</span>、环境等待占 "
        "<span class=\"num\">{env_share}</span>（表 2）"
    ),
    "abstract_timing_without_think": (
        "；其中模型请求占 <span class=\"num\">{llm_share}</span>、环境等待占 "
        "<span class=\"num\">{env_share}</span>（表 2）"
    ),
    "abstract_cost_estimated": "API 等价估算平均成本 <span class=\"num\">{cost_avg}</span>",
    "abstract_cost_measured": "平均成本 <span class=\"num\">{cost_avg}</span>",
    "abstract_cost_unavailable": "成本不可估价",
    "abstract_judge": (
        "<span class=\"judge-only\">，judge 成功率 <span class=\"num\">{success_rate}</span></span>"
    ),
    "abstract_empty": "池内无有效样本。",
    "abstract_no_comparison": "本模式无 baseline / test 对照，不含 Δ 列。",
    "meta_base_task_count": "base_task 数",
    "meta_common": "（common = {count}）",
    "latest_job": "latest job",
    "latest_jobs_sum": "latest jobs sum",
    "dropped_summary": "dropped 明细 · {count} 条（error / keyword / manual 剔除）",
    "sample_mean": "样本均值 · n={count}",
    "median": "中位数",
    "percentile_90": "90 分位",
    "reasoning_estimated_suffix": "（估）",
    "priced_samples": "{priced}/{total} 样本",
    "sample_total": "{count} 样本合计",
    "latency_duration": "duration · 总耗时",
    "latency_think": "think · 推理耗时",
    "latency_llm_without_think": "llm · 模型耗时（不含 think）",
    "latency_llm_with_think": "llm · 模型耗时（含 think，未拆分）",
    "latency_env": "env · 环境等待",
    "latency_overhead": "overhead · 残差",
    "latency_component": "分项",
    "screenshot_gallery_title": "轨迹截图 gallery",
    "open_rubric_session": "打开该 rubric 的 judge session",
    "rubric_audit": "rubric 审计",
    "audit_items": "{count} 项",
    "audit_unmet": " · ✗ {count} 项未达标",
    "audit_all_passed": " · 全部通过",
    "expand_full": "展开全文",
    "ody_section": "Odysseys 专项指标",
    "ody_section_secondary": "Odysseys Metrics · dataset module",
    "ody_table_o1": "表 O1",
    "ody_primary_caption": "主指标",
    "ody_table_o2": "表 O2",
    "ody_breakdown_caption": "按难度 / 类别分解",
    "ody_breakdown_description": (
        "按 task 的 category（odysseys 家族即难度 easy / medium / hard）分桶；各列口径同表 "
        "O1，「总体」行与表 O1 一致。"
    ),
    "ody_description": (
        "本模块仅对 odysseys 家族数据集（odysseys / real-world-bench）"
        "渲染，对齐论文 Table 口径。<b>Rubric Avg</b>＝Σ(通过 rubric) / Σ(总 rubric)×100"
        "（rubric 级 micro 平均，rubric 多的任务权重更大；judge_error 任务不计）；"
        "<b>Perfect</b>＝全部 rubric 通过的任务占比（与 success rate 同口径）；"
        "<b>Avg. Steps</b>＝计入任务的平均步数（num_turns）；"
        "<b>Traj. Eff.</b>＝(1/N)Σ(score / 步数)×100。"
    ),
    "ody_rerun_required": "需重判以落 rubric 明细",
    "ody_micro_tasks": "micro · {count} 任务",
    "ody_all_pass": "{passed} / {total} 全 pass",
    "ody_tasks_included": "{count} 任务计入",
    "ody_efficiency_unit": "score / 步 ×100",
    "ody_difficulty_category": "难度 / 类别",
    "ody_overall": "总体 · overall",
}

_EN_MESSAGES = {
    "report_title": "Single-run Evaluation Report",
    "expand": "Expand",
    "collapse": "Collapse",
    "abstract_label": "Abstract",
    "section_metadata": "Run Metadata",
    "section_metadata_secondary": "",
    "section_aggregate": "Aggregate Metrics",
    "section_aggregate_secondary": "",
    "aggregate_description": (
        "This is a single sample pool (mode = single) with no baseline/test pairing. Duration "
        "is summarized by mean, median (p50), p90, dispersion, and total; cost is summarized "
        "by mean, dispersion, and total. Sample standard deviation uses n−1, and percentiles "
        "use linear interpolation (the numpy.percentile default)."
    ),
    "table_1": "Table 1",
    "aggregate_caption": "Aggregate metrics",
    "table_2": "Table 2",
    "latency_caption": "Latency components and percentiles (seconds)",
    "latency_description": (
        "Definitions: duration is the interval between the first and last session entries; "
        "llm is Σ(assistant entry − preceding entry), the full model-request round trip "
        "(including thinking when think is unavailable, excluding it when measured); think "
        "is reasoning time (reserved because current pi sessions do not expose thinking "
        "timing, so this row is hidden when absent); env is Σ(toolResult entry − preceding "
        "entry), including page loads, element waits, bash, and other tool execution; overhead "
        "is duration − think − llm − env. Percentiles are computed independently per row, so "
        "p50/p90 columns must not be summed."
    ),
    "figure_1": "Figure 1",
    "latency_figure_caption": "Share of total duration by component",
    "section_iteration": "Per-iteration Means",
    "section_iteration_secondary": "",
    "iteration_description": (
        "Samples are grouped by reassigned display_iter (rendered when iterations ≥ 2) to "
        "show changes across iterations."
    ),
    "figure_2": "Figure 2",
    "iteration_figure_caption": "Mean duration, cost, and tool calls by iteration",
    "section_per_task": "Per-task Means",
    "section_per_task_secondary": "",
    "per_task_description": (
        "Each base_task_id is aggregated across iterations; bars are normalized to the "
        "maximum value in each metric column."
    ),
    "table_3": "Table 3",
    "per_task_caption": "Base-task pool means and relative bars",
    "figure_3": "Figure 3",
    "per_task_figure_caption": "Three-metric bars by base task (embedded in Table 3)",
    "section_samples": "Sample Records",
    "section_samples_secondary": "",
    "samples_description": (
        "Each task_id links to ../<source_run>/sessions_html/<task_id>.html. When trajectory "
        "screenshots exist, the adjacent 📷 badge opens ../<source_run>/screenshots_html/"
        "<task_id>.html in a new tab. Tool chains show the first 12 entries, command "
        "distributions show the first 5, and final_text is truncated to 320 characters. "
        "Screenshots are not embedded. For every judged Odysseys sample, the rubric audit "
        "links R{n} to ../<source_run>/judge_sessions_html/<task_id>/R{n}.html in a new tab "
        "and preserves the complete reasoning."
    ),
    "section_detail": "Numeric Detail",
    "section_detail_secondary": "",
    "detail_description": (
        "One row per sample with every raw numeric field, including think_s, llm_s, env_s, "
        "turns, and token splits. Monospaced values make the table suitable for Excel export "
        "or further analysis."
    ),
    "table_4": "Table 4",
    "detail_caption": "Raw numeric detail for all samples",
    "generated_at": "generated at",
    "abstract_intro": (
        "This report is a single-run evaluation artifact (mode = <span class=\"num\">single"
        "</span>). On the <span class=\"num\">{benchmark}</span> benchmark, "
        "<span class=\"num\">{provider} / {model}</span> drove <span class=\"num\">{label}"
        "</span> with browser_tool <span class=\"num\">{browser_tool}</span>, covering "
        "<span class=\"num\">{task_count}</span> base tasks{iteration_clause}. The plan "
        "contained <span class=\"num\">{planned}</span> samples; <span class=\"num\">{kept}"
        "</span> were retained and <span class=\"num\">{dropped}</span> were dropped (see Run "
        "Metadata)."
    ),
    "abstract_iterations": " across <span class=\"num\">{count}</span> iterations",
    "abstract_metrics": (
        "The pool's mean duration was <span class=\"num\">{duration_avg} s</span>{median_clause}"
        " (CV <span class=\"num\">{duration_cv}</span>){timing_clause}. Each sample averaged "
        "<span class=\"num\">{turns_avg}</span> turns and <span class=\"num\">{tokens_avg}"
        "</span> tokens (<span class=\"num\">{tokens_total}</span> total); {cost_clause}. "
        "There were <span class=\"num\">{tools}</span> tool calls, including "
        "<span class=\"num\">{tool_failures}</span> failures{judge_clause}."
    ),
    "abstract_median": (
        ", with a <span class=\"num\">{duration_p50} s</span> median and "
        "<span class=\"num\">{duration_p90} s</span> p90"
    ),
    "abstract_timing_with_think": (
        "; reasoning (think) accounted for <span class=\"num\">{think_share}</span>, model "
        "generation for <span class=\"num\">{llm_share}</span>, and environment waits for "
        "<span class=\"num\">{env_share}</span> of total duration (Table 2)"
    ),
    "abstract_timing_without_think": (
        "; model requests accounted for <span class=\"num\">{llm_share}</span> and "
        "environment waits for <span class=\"num\">{env_share}</span> of total duration "
        "(Table 2)"
    ),
    "abstract_cost_estimated": (
        "the estimated API-equivalent average cost was <span class=\"num\">{cost_avg}</span>"
    ),
    "abstract_cost_measured": "the average cost was <span class=\"num\">{cost_avg}</span>",
    "abstract_cost_unavailable": "cost could not be priced",
    "abstract_judge": (
        "<span class=\"judge-only\">; the judge success rate was "
        "<span class=\"num\">{success_rate}</span></span>"
    ),
    "abstract_empty": "The pool contained no valid samples.",
    "abstract_no_comparison": (
        "This mode has no baseline/test comparison and therefore no Δ column."
    ),
    "meta_base_task_count": "base_task count",
    "meta_common": "(common = {count})",
    "latest_job": "latest job",
    "latest_jobs_sum": "latest jobs sum",
    "dropped_summary": (
        "Dropped samples · {count} (excluded by error, keyword, or manual selection)"
    ),
    "sample_mean": "sample mean · n={count}",
    "median": "median",
    "percentile_90": "90th percentile",
    "reasoning_estimated_suffix": " (est.)",
    "priced_samples": "{priced}/{total} samples",
    "sample_total": "{count} samples total",
    "latency_duration": "duration · total elapsed",
    "latency_think": "think · reasoning",
    "latency_llm_without_think": "llm · model time (excluding think)",
    "latency_llm_with_think": "llm · model time (including unseparated think)",
    "latency_env": "env · environment waits",
    "latency_overhead": "overhead · residual",
    "latency_component": "component",
    "screenshot_gallery_title": "Trajectory screenshot gallery",
    "open_rubric_session": "Open this rubric's judge session",
    "rubric_audit": "rubric audit",
    "audit_items": "{count} items",
    "audit_unmet": " · ✗ {count} unmet",
    "audit_all_passed": " · all passed",
    "expand_full": "Expand full text",
    "ody_section": "Odysseys Metrics",
    "ody_section_secondary": "dataset module",
    "ody_table_o1": "Table O1",
    "ody_primary_caption": "Primary metrics",
    "ody_table_o2": "Table O2",
    "ody_breakdown_caption": "Breakdown by difficulty/category",
    "ody_breakdown_description": (
        "Tasks are grouped by category (easy, medium, or hard for the Odysseys family). "
        "Every column follows Table O1, and the Overall row matches Table O1."
    ),
    "ody_description": (
        "This module is rendered only for the Odysseys dataset family (odysseys and "
        "real-world-bench) and follows the paper's table definitions. "
        "<b>Rubric Avg</b> = Σ(passed rubrics) / Σ(total rubrics) × 100, a rubric-level "
        "micro-average that gives tasks with more rubrics more weight and excludes judge_error "
        "tasks; <b>Perfect</b> is the share of tasks that pass every rubric (the same "
        "definition as success rate); <b>Avg. Steps</b> is the mean num_turns for included "
        "tasks; <b>Traj. Eff.</b> = (1/N)Σ(score / steps) × 100."
    ),
    "ody_rerun_required": "rejudge required for rubric details",
    "ody_micro_tasks": "micro · {count} tasks",
    "ody_all_pass": "{passed} / {total} passed all rubrics",
    "ody_tasks_included": "{count} tasks included",
    "ody_efficiency_unit": "score / step ×100",
    "ody_difficulty_category": "difficulty / category",
    "ody_overall": "Overall",
}

REPORT_MESSAGES: dict[ReportLocale, dict[str, str]] = {
    "zh": _ZH_MESSAGES,
    "en": _EN_MESSAGES,
}


def report_messages(locale: ReportLocale) -> dict[str, str]:
    """Return the selected single-run report catalog."""
    return REPORT_MESSAGES[locale]
