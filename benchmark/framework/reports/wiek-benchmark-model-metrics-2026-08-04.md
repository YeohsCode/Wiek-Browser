# Wiek Benchmark — Model Metrics

**Real-World Bench · 16 models × 31 browser tasks · 154 rubrics per model**
Snapshot taken 2026-08-04. Runs executed 2026-07-28 through 2026-08-03.

Every model in this report is scored over the same complete 31-task set. All figures are recomputed from each run's final `tasks.jsonl`, the provider session logs, per-attempt manifests, and the retained judge artifacts — never from pre-aggregated HTML. All 16 recomputations cross-check against their own run summaries.

---

## What this measures

Real-World Bench asks an agent to complete multi-step tasks on live public websites through a browser tool: search and filter listings, book flights, read government statistics portals, drive web apps, extract and compute over what it finds.

Each task carries 4–6 **rubrics** — independent, binary checks written against the task's ground truth. A separate judge model inspects the agent's actual session log, tool results, and screenshots to decide each rubric.

Two headline numbers:

| Metric | Definition |
|---|---|
| **Perfect rate** | A task counts only if **every** rubric passes. No partial credit. |
| **Rubric avg score** | Per-task rubric pass ratio (passed ÷ total), averaged across tasks. Credits partial completion. |

---

## Overall Performance

| Model | Judged | Successful tasks | Perfect rate | Rubric avg score | Rubrics passed |
|---|---:|---:|---:|---:|---:|
| GPT-5.6-sol | 31 / 31 | 27 / 31 | **87.1%** | 0.9699 | 149 / 154 |
| Claude Fable 5 | 31 / 31 | 26 / 31 | **83.9%** | 0.9570 | 147 / 154 |
| Claude Opus 5 | 31 / 31 | 24 / 31 | 77.4% | 0.9371 | 143 / 154 |
| Qwen 3.8 Max Preview | 31 / 31 | 23 / 31 | 74.2% | 0.9226 | 140 / 154 |
| Qwen 3.8 Max | 31 / 31 | 21 / 31 | 67.7% | 0.8667 | 131 / 154 |
| DeepSeek V4 Flash | 31 / 31 | 21 / 31 | 67.7% | 0.8565 | 129 / 154 |
| Doubao Seed Evolving | 31 / 31 | 20 / 31 | 64.5% | 0.8247 | 125 / 154 |
| Kimi K3 | 31 / 31 | 20 / 31 | 64.5% | 0.8043 | 119 / 154 |
| GLM-5.2 | 31 / 31 | 19 / 31 | 61.3% | 0.8366 | 126 / 154 |
| Tencent HY3 | 31 / 31 | 16 / 31 | 51.6% | 0.7554 | 114 / 154 |
| MiniMax M3 | 31 / 31 | 14 / 31 | 45.2% | 0.7220 | 107 / 154 |
| DeepSeek V4 Pro | 31 / 31 | 11 / 31 | 35.5% | 0.7204 | 109 / 154 |
| Step 3.7 Flash | 31 / 31 | 11 / 31 | 35.5% | 0.6011 | 87 / 154 |
| LongCat 2.0 | 31 / 31 | 9 / 31 | 29.0% | 0.4855 | 69 / 154 |
| ERNIE 5.1 | 31 / 31 | 5 / 31 | 16.1% | 0.4640 | 66 / 154 |
| MiMo V2.5 Pro | 31 / 31 | 4 / 31 | 12.9% | 0.2737 | 36 / 154 |

> All 16 × 31 tasks reached the judge. No task is scored as a loss because of a missing verdict.

---

## Execution Cost, Average Turns, Average Duration

Cost of the model under test completing the tasks. Judge cost is tracked separately and is never added in.

| Model | Total cost (USD) | Cost / task (USD) | Reasoning tokens | Avg turns | Avg duration (s) | Avg duration (min) |
|---|---:|---:|---:|---:|---:|---:|
| GPT-5.6-sol | 88.97 | 2.8701 | 268,977 | 29.8 | 629.1 | 10.48 |
| Claude Fable 5 | 88.73 | 2.8622 | 396,558 | 23.5 | 605.3 | 10.09 |
| Claude Opus 5 | 53.10 | 1.7129 | 361,165 | 27.8 | 625.1 | 10.42 |
| Qwen 3.8 Max Preview ‡ | 21.98 | 0.7091 | 392,921 | 32.3 | 819.1 | 13.65 |
| Qwen 3.8 Max | 31.80 | 1.0258 | 453,284 | 37.4 | 880.0 | 14.67 |
| DeepSeek V4 Flash | 0.62 | 0.0201 | 487,968 | 41.7 | 516.6 | 8.61 |
| Doubao Seed Evolving | 14.56 | 0.4695 | 194,926 | 30.5 | 689.5 | 11.49 |
| Kimi K3 | 11.43 | 0.3687 | 132,194 | 20.3 | 534.4 | 8.91 |
| GLM-5.2 † | 25.09 | 0.8094 | 1,043,308 | 29.4 | 1281.0 | 21.35 |
| Tencent HY3 | 3.18 | 0.1025 | 564,185 | 39.3 | 789.6 | 13.16 |
| MiniMax M3 | 5.11 | 0.1649 | 150,463 | 48.6 | 597.9 | 9.97 |
| DeepSeek V4 Pro | 1.57 | 0.0508 | 227,068 | 35.5 | 475.5 | 7.93 |
| Step 3.7 Flash | 5.98 | 0.1930 | 0 | 45.8 | 748.0 | 12.47 |
| LongCat 2.0 | 2.22 | 0.0716 | 146,487 | 21.3 | 395.2 | 6.59 |
| ERNIE 5.1 | 37.26 | 1.2021 | 209,806 | 33.1 | 893.8 | 14.90 |
| MiMo V2.5 Pro | 1.11 | 0.0358 | 34,241 | 8.5 | 118.8 | 1.98 |

> † GLM-5.2 is recomputed record by record from its published rate card against the real persisted tokens of its 31 final sessions, and the result was written back to the run. See the recomputation section below.
> ‡ Qwen 3.8 Max Preview's raw usage carries no cost, so it is estimated at the qwen-3.8-max rate card.

**Reasoning tokens** come from the provider-reported `reasoning_tokens` field wherever available; all 496 final sessions in this batch carry a provider-reported value, so no session is estimated. The column is for observing reasoning volume — it is not a separate cost line added on top of output cost.

### How to read cost against turns and duration

- **Long trajectories are not more successful.** Step 3.7 Flash and MiniMax M3 average 45.8 and 48.6 turns and land at 35.5% and 45.2% perfect rate. More steps bought them nothing.
- **Low cost is not always efficiency.** MiMo V2.5 Pro's $0.0358 / task and 1.98-minute average come from stopping early, not finishing fast — its low numbers are an artifact of incomplete runs, not throughput.
- **The cheap end is genuinely cheap.** DeepSeek V4 Flash reaches a 67.7% perfect rate at $0.62 across all 31 tasks — $0.0201 / task, roughly 1/140 of the top two. Price differences across providers still have to be read against each provider's own published rate card, not as a like-for-like unit.
- **GLM-5.2's 21.35-minute average is a tail, not a uniform slowdown.** Its p90 is 3505.8 s and max 3601.9 s, both near the harness backstop, with 3 tasks hitting a time limit. The mean is dominated by those.
- **Cache reads dominate the expensive runs.** GPT-5.6-sol read 88,937,472 cached input tokens for $49.5508 — 55.7% of its total. See the next section.

Costs cover the final effective session per task only. Executions superseded by a re-run are excluded from cost, turns, and duration, so these figures are a reproducible comparison basis rather than a billing reconciliation.

---

## Judge Cost

| Model judged | Judge artifacts | Judge cost (USD) |
|---|---:|---:|
| GPT-5.6-sol | 31 | 20.27 |
| Claude Fable 5 | 31 | 16.21 |
| Claude Opus 5 | 31 | 17.65 |
| Qwen 3.8 Max Preview | 31 | 18.04 |
| Qwen 3.8 Max | 31 | 16.17 |
| DeepSeek V4 Flash | 31 | 16.48 |
| Doubao Seed Evolving | 31 | 19.94 |
| Kimi K3 | 31 | 14.07 |
| GLM-5.2 | 31 | 19.47 |
| Tencent HY3 | 31 | 19.80 |
| MiniMax M3 | 31 | 19.83 |
| DeepSeek V4 Pro | 31 | 20.94 |
| Step 3.7 Flash | 31 | 22.55 |
| LongCat 2.0 | 31 | 16.02 |
| ERNIE 5.1 | 31 | 19.78 |
| MiMo V2.5 Pro | 31 | 11.69 |

Judge cost is the resource consumption of the independent scoring pass. **It is not added to execution cost**, and it says nothing about the cost or cost-efficiency of the model under test — the judge configuration is identical for every model, so what varies is the volume of evidence each trajectory left for the judge to read. Figures come from the retained judge artifacts only; superseded judge calls are excluded.

All 496 judge artifacts in this report were verified file by file to use one identical judge configuration — same judge model, agent mode, and read-only tool set. 496 = 16 runs × 31 tasks.

---

## Cost and Context-Cache Pricing Verification

Cache-hit pricing is the easiest place for a cost table to double-count, so every figure above is decomposed and re-derived.

| Model | Uncached input (USD) | Output (USD) | Cache read (USD) | Cache write (USD) | Recomputed total (USD) | Verification |
|---|---:|---:|---:|---:|---:|---|
| GPT-5.6-sol | 24.3724 | 15.0493 | 49.5508 | 0.0000 | 88.9726 | Verified |
| Claude Fable 5 | 0.0143 | 36.0080 | 32.2778 | 20.4291 | 88.7293 | Verified |
| Claude Opus 5 | 0.0088 | 19.6891 | 20.8828 | 12.5201 | 53.1008 | Verified |
| Qwen 3.8 Max Preview ‡ | 11.5308 | 3.6148 | 6.8364 | 0.0000 | 21.9820 | Estimated at qwen-3.8-max rates |
| Qwen 3.8 Max | 18.5536 | 4.0522 | 9.1942 | 0.0000 | 31.8000 | Provider-reported line items match total |
| DeepSeek V4 Flash | 0.1778 | 0.2403 | 0.2060 | 0.0000 | 0.6242 | Recomputed at official API price |
| Doubao Seed Evolving | 2.5665 | 2.4571 | 9.5314 | 0.0000 | 14.5550 | Recomputed at undiscounted list price |
| Kimi K3 | 3.2897 | 4.1591 | 3.9822 | 0.0000 | 11.4309 | Verified |
| GLM-5.2 † | 5.5908 | 5.5958 | 13.9061 | 0.0000 | 25.0927 | Recomputed at published rate card |
| Tencent HY3 | 0.6801 | 0.5383 | 1.9576 | 0.0000 | 3.1761 | Recomputed at undiscounted list price |
| MiniMax M3 | 0.6409 | 0.6377 | 3.8328 | 0.0000 | 5.1114 | Recomputed at undiscounted list price |
| DeepSeek V4 Pro | 0.8050 | 0.5449 | 0.2248 | 0.0000 | 1.5748 | Recomputed at official API price |
| Step 3.7 Flash | 0.9384 | 0.8752 | 4.1703 | 0.0000 | 5.9839 | Recomputed at undiscounted list price |
| LongCat 2.0 | 1.0436 | 0.9259 | 0.2501 | 0.0000 | 2.2196 | Recomputed at undiscounted list price |
| ERNIE 5.1 | 35.6065 | 1.6573 | 0.0000 | 0.0000 | 37.2638 | Recomputed at undiscounted list price, 32K tier |
| MiMo V2.5 Pro | 1.0281 | 0.0711 | 0.0118 | 0.0000 | 1.1110 | Recomputed at undiscounted list price |

The check covers all **15,651 assistant usage records** included in this report:

- Every record satisfies `totalTokens = input + output + cacheRead + cacheWrite`. **Cache-hit tokens are already deducted from plain `input`** — cache reads in this table are not billed on top of a full input charge.
- Every record satisfies `cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite`. The parser's aggregate differs from the raw line items only by floating-point error.
- **Cache writes are priced as their own line** where the provider charges for them; for every other model in this batch `cacheWrite = 0`.
- DeepSeek V4 is recomputed from the [official DeepSeek API price list](https://api-docs.deepseek.com/quick_start/pricing/): Pro at $0.435 / $0.87 / $0.003625 and Flash at $0.14 / $0.28 / $0.0028 per million tokens for cache-miss input / output / cache hit.
- Models accessed through a third-party routing provider are recomputed per assistant request at the **undiscounted list price** currently shown on that provider's model page, ignoring promotional discounts.
- **Long-context tiers apply to the whole request, not the marginal tokens.** The harness decides the tier from `input + cacheRead + cacheWrite`, then bills plain input, cache hits, and cache writes at that tier's rates. MiniMax M3 switches tier at 512K total input; ERNIE 5.1 at 32K. Across ERNIE's 1,027 final usage records the base / high split is 490 / 537, recomputing to $37.263807 — consistent with the persisted session cost and run summary.
- Qwen 3.8 Max Preview's raw usage records carry no cost line items, so its figures are estimated by applying the qwen-3.8-max rate card to its persisted tokens — real tokens at a published price, not an invoice. Qwen 3.8 Max itself needs no recomputation: the provider reports cost on every usage record, and those line items sum exactly to the reported total.

### Tiered pricing and why GPT-5.6-sol is expensive

GPT-5.6-sol's published rate card selects a tier from the total input of a single request (`input + cached input + cache writes`):

| Context tier | Trigger | Input | Cached input | Cache writes | Output |
|---|---|---:|---:|---:|---:|
| Short context | total input ≤ 272K tokens | $5.00 / MTok | $0.50 / MTok | $6.25 / MTok | $30.00 / MTok |
| Long context | total input > 272K tokens | $10.00 / MTok | $1.00 / MTok | $12.50 / MTok | $45.00 / MTok |

Once a request crosses 272K, **all four components of that request** bill at long-context rates. Per-turn results match the rule exactly:

| Tier | Turns | Tasks | Total input per request | Actual cost | Share of total |
|---|---:|---:|---:|---:|---:|
| Short context | 889 | 31 | 2,098–269,215 | $75.8207 | 85.2% |
| Long context | 36 | 4 | 272,131–310,428 | $13.1519 | 14.8% |

Those 36 long-context turns are 3.9% of 925 turns — concentrated in four tasks — but 14.8% of cost. At identical token usage billed entirely at short-context rates they would cost $6.8463; the tier switch adds $6.3056, taking the total from a hypothetical $82.6670 to the actual $88.9726.

The tier is not the main driver, though. GPT-5.6-sol read 88,937,472 cached input tokens for $49.5508 — **55.7% of its total cost**. The dominant factor is large context repeatedly re-entering as cache reads; the 36 tier switches are a secondary effect on top.

### GLM-5.2 cost recomputation

The run's usage records persist token counts but no cost, so cost is derived from the published rate card — input ¥8 / M tokens, output ¥28 / M, cache hit ¥2 / M, cache storage free for a limited period. Uncached input and `cacheRead` are recorded separately, so each assistant message is priced directly:

`CNY cost = input × 8 / 1M + output × 28 / 1M + cacheRead × 2 / 1M + cacheWrite × 0`

| Basis | Sessions | Uncached input | Output | Cache hit | Cost (CNY) | Cost (USD) |
|---|---:|---:|---:|---:|---:|---:|
| **Reported basis: 31 tasks, uniform formula** | 31 | 4,728,608 | 1,352,244 | 47,046,144 | ¥169.783984 | $25.092750 |
| Currently persisted cost (2 sessions at 0) | 29 / 31 | 4,604,998 | 1,311,699 | 44,895,680 | ¥163.358916 | $24.143175 |

This is an exact application of a published rate card to real persisted tokens, not a modelled estimate, and the result was written back into the run per session with before/after hashes recorded.

Two tasks were re-run after that backfill and their new sessions persisted zero cost, which is why the run's stored total still reads $24.143175. Those two sessions are priced by the same formula (¥5.398992 / $0.797929 and ¥1.026076 / $0.151646, together $0.949575) to reach the 31-task figure of $25.092750. Only the report was updated for that last step; no run or session cost field was rewritten.

### Currency

CNY is the native pricing unit for the recomputed rows above. USD conversion uses [ECB euro reference rates for 2026-07-29](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html): EUR/USD = 1.1380, EUR/CNY = 7.7000, giving **USD/CNY = 0.1477922078**. USD figures shift with the chosen rate.

---

## How the numbers are computed

- **Sample.** 16 models × 31 tasks, all judged.
- **Perfect rate.** Tasks with `verdict = true` ÷ 31. A task score is passed rubrics ÷ total rubrics, rounded to 4 decimals; `verdict = true` requires all rubrics to pass.
- **Rubric avg score.** Arithmetic mean of non-null per-task scores.
- **Average duration.** Task wall-clock from start to end.
- **Turns and cost.** Parsed from the provider session log referenced by each task's final row. Superseded historical attempts never enter these figures.
- **Final-state rule.** One row per `(task, iteration)`. Where a task was re-run, the final task row and its last attempt's session are authoritative; original and re-run rows are never summed, and no task is counted twice.
- **Effort.** Each model ran at the highest reasoning effort configurable for it at the time. The provider-reported effective level was sometimes lower than the requested one, which is worth keeping in mind when comparing turns and cost.
- **Judging.** One independent judge call per rubric, in agent mode with read-only tools, at a fixed configuration identical across all models. The judge is given file paths rather than a pre-digested trajectory, and inspects the session log, real tool results, errors, screenshot manifest, and images itself. Each rubric returns `{reasoning, satisfied, confidence}`; `satisfied` is strictly binary and `confidence` is audit-only, never folded into the score.
- **Blocked tasks.** A task blocked by CAPTCHA or access denial is held as unjudged rather than scored as a loss — distinct from both a judge-assessed failure and a judge error. No task in this snapshot ended in that state.

## Limits of comparison

Stated plainly, because they bound what these numbers support:

- **Concurrency was not uniform across runs.** Some models executed at concurrency 1, others at 3, 5, or 10. Duration and provider rate-limiting are therefore batch observations, not measurements from a concurrency-controlled baseline.
- **Runs span several days.** Most executed 2026-07-28 to 2026-07-30, with some tasks and two runs on 2026-08-03. Live web state, browser runtime, and skill snapshots shifted across that window, so cross-model deltas are not a clean A/B.
- **Some tasks were selectively re-run after execution errors.** Final state is reported per the rule above, which correctly answers "how did it do once errors were cleared." It does **not** make those runs unbiased repeat measurements — re-runs targeted known-failing samples, so before/after deltas should not be read as expected improvement under random repetition.
- **MiMo V2.5 Pro's low cost and duration are not efficiency.** 24 of its 27 failures end with the model returning a normal stop message that describes its *next* intended action, with zero tool calls — a premature-termination signature, not fast completion. Its turns on those tasks run about 0.3× the cross-model median.
- **Execution cost and judge cost are never summed.** They answer different questions and share no denominator.
- **Two tasks were solved by all 16 models** (`calcnet-mortgage`, `hn-top10`) and carry almost no discriminative power at the top of the table. Conversely `courtlistener-sec-helix` was solved by one model only.
