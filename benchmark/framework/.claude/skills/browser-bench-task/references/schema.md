# real_world_bench.json — schema

`real-world-bench` inherits `OdysseysAdapter`. The file is a JSON **array** of task objects.
This reference and the live adapter (`wiek_bench/datasets/outcome_chinese.py` →
`RealWorldBenchAdapter`) define the tracked schema. The adapter maps
`level`→`category`, `website`→`start_url`, and drops everything else (incl. `rubrics`) into
`metadata`. **`rubrics` is required** — a missing/empty `rubrics` makes the task fail-loud in
the per-rubric judge (Stage B).

## Fields

| field | type | meaning |
|---|---|---|
| `task_id` | str | stable id, kebab, prefix `rwb-`, e.g. `rwb-reddit-pf-indexfund-01` |
| `confirmed_task` | str | the task text the agent receives. Natural user voice (see `authoring.md`). May embed http(s) URLs. |
| `website` | str | start URL → `start_url`. For cross-site tasks, the FIRST site the agent opens. |
| `level` | str | `low` \| `medium` \| `high` → `category` (used for report bucketing and the WebUI dataset breakdown). Most real-world tasks are `high`. |
| `reference_length` | int | rough step count. Calibrates difficulty: medium ≈ 6–8, high ≈ ≥9 (multi-filter / form-fill / cross-site). |
| `site_mode` | str | `single` \| `multi` |
| `site_count` | int | number of distinct sites/apps the task touches (cross-site/cross-app → 2+) |
| `categories` | list[str] | one Odysseys-style label, `"Top > Sub"`, e.g. `"Finance > Finance - Other"` |
| `note` | str (optional) | **operator note, not shown to the agent, not graded.** Put calibration facts + risk-control caveats + "use old.reddit.com" rationale here — NOT in `confirmed_task`. |
| `rubrics` | object | `R1..Rn` (3–6), each `{requirement, verification}`. See `authoring.md`. |

## Worked example (aggregate pattern)

```json
{
  "task_id": "rwb-github-trending-py-01",
  "confirmed_task": "我想看看这周 GitHub 上最火的 Python 项目都有哪些。帮我打开 GitHub Trending 页面 https://github.com/trending ，把语言筛成 Python、时间范围选 This week（本周）。从本周的 trending 榜单上取排名前 8 的仓库，每个记下排名、仓库全名（owner/repo）、本周新增的 star 数（页面上写的 \"X stars this week\"）、总 Stars、总 Forks，还有一句话简介（没有就写\"未列出\"），整理成一张表。最后帮我算一下这 8 个仓库本周新增 star 的总和与平均值（平均保留一位小数），再找出\"本周新增 star ÷ 总 Stars\"比值最高的那个仓库，告诉我它的全名和这个比值（保留三位小数）。",
  "website": "https://github.com/trending",
  "level": "high",
  "reference_length": 10,
  "site_mode": "single",
  "site_count": 1,
  "categories": ["Computers Electronics and Technology > Programming and Developer Software"],
  "note": "实跑校准（YYYY-MM-DD, wiek-browser）：登出态无登录墙/验证码/Cloudflare；since=weekly + 语言 Python 经 URL 生效；每行可分别抽本周新增 star（\"X stars this week\"）与总 Stars/Forks。Trending 为实时数据，判分按运行时页面核对。",
  "rubrics": {
    "R1": {
      "requirement": "到达 GitHub Trending 并将语言设为 Python、时间范围设为 This week（since=weekly）。",
      "verification": "截图/URL 显示 python 语言筛选与 since=weekly 均生效，列表为本周 Python trending，未被拦截。"
    },
    "R2": {
      "requirement": "抽取前 8 个仓库，每个含排名、owner/repo、本周新增 star、总 Stars、总 Forks、描述（无则\"未列出\"）。",
      "verification": "恰 8 行、字段齐全；本周新增 star 与总 Stars 被正确区分，各值与页面一致，无编造。"
    },
    "R3": {
      "requirement": "正确计算 8 个仓库本周新增 star 的总和与平均值（平均保留一位小数）。",
      "verification": "总和与平均值与所列 8 条数据算术一致。"
    },
    "R4": {
      "requirement": "找出\"本周新增 star ÷ 总 Stars\"比值最高的仓库，给出全名与比值（三位小数）。",
      "verification": "按所列数据逐条计算，被选中者确为最大，比值数值正确。"
    }
  }
}
```

## Loading a new benchmark (same schema)

Adding a *new* dataset file with this schema is three steps: drop `data/<file>.json`,
add `wiek_bench/datasets/<adapter>.py` inheriting `OdysseysAdapter` (override `name` /
`_source_file`), register it in `wiek_bench/datasets/__init__.py::_ADAPTERS`. For just adding
tasks to `real_world_bench.json`, none of that is needed — append to the array.
