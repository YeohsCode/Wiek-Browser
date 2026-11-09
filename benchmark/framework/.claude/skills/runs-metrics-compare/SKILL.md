---
name: runs-metrics-compare
description: Compare standardized metrics across multiple wiek-benchmark-harness runs by recalculating them from tasks.jsonl and session JSONL, never from HTML reports. Covers overall aggregates (success rate/average score), Odysseys per-rubric pass rates, duration distributions (avg/p50/p90/max), turns/tools/cost, error and exception counts, per-task success matrices, helper distributions, and the share of DOM operations. Use whenever users ask to compare data or metrics across runs, calculate aggregate/Odysseys/duration/turn/error/helper metrics, inspect differences among runs, or compare multiple rwb/real-world-bench runs. Use pi-session-analyzer instead for deep forensic analysis of why an individual task was slow or failed.
---

# Runs Metrics Compare — Standardized Multi-Run Metrics

## What this skill solves

Users often need to place multiple runs of the same benchmark side by side to inspect improvement
or regression: success rate, average score, Odysseys per-rubric results, duration, turns, errors,
and helper usage. These values are distributed across `runs/<id>/tasks.jsonl` and pi session JSONL,
and several recurring pitfalls can distort the comparison. This skill packages the calculations
and safeguards into a parameterized script that produces the full comparison in one command.

> Division of responsibility with `pi-session-analyzer`: that skill handles **forensics** (why an
> individual task was slow or failed, execution paths, error clustering, and the largest outliers
> between two runs); this skill handles **statistics** (standard metric tables for N runs). Use
> this skill for the global view first, then use pi-session-analyzer for specific tasks.

## One command

```bash
PY=.venv/bin/python
SKILL=.claude/skills/runs-metrics-compare
$PY $SKILL/scripts/runs_compare.py RUN_ID_A RUN_ID_B [RUN_ID_C ...] \
    [--labels "a,b,c"] [--exclude rwb-foo-01 ...] [--only aggregate,helpers]
```

- **Use the harness's own `.venv` (with the `loguru`/`wiek_bench` dependencies)**. Do not use another
  project's venv. With the wrong interpreter, the `session_parser` import fails silently, causing
  the entire "Turns / Tools / Cost" section and the tool_failures row to disappear without
  terminating the script.
- Run from the harness root (the parent of `runs/`), or use `--runs-dir /abs/path/to/runs`.
- Run order equals column order. Sort runs chronologically from oldest to newest so the trend is
  immediately visible.
- Use `--labels` for short column names (otherwise the script derives `YYYYMMDD` timestamps).
- Use `--only` to emit selected sections (section names: `align aggregate odysseys rubrics duration turns errors pertask
  helpers crosscheck`).

Output sections: Run Metadata & Alignment → Aggregate → Odysseys → Per-Rubric → Duration →
Turns / Tools / Cost → Errors → Per-Task Matrix → Helper Distribution & DOM Share → Cross-Check.

## Required conventions (hardened after observed pitfalls)

1. **Data source = recalculate from JSONL; never read the HTML report.**
   Read `verdict/score/num_rubrics[_passed]/category/started_at/ended_at/error/judge_error` from
   `tasks.jsonl`; read turns/tool/cost/tool_failures from session JSONL through the project's
   `wiek_bench.session_parser`. Use `summary.json`/`run_metadata.json` only for metadata
   (model/judge_mode/skill_hash/wiek_sha). Their aggregates cover all 50 tasks, including excluded
   ones, so do not use them directly. The final script section automatically cross-checks the
   full JSONL recalculation against `summary.json`; only an all-✓ result confirms that the pipeline
   is aligned.

2. **Align the shared base-task intersection across runs before aggregating.**
   Task sets may differ across runs (for example, a task may be renamed or change difficulty).
   By default, the script takes the intersection of `base_task_id` across all runs and prints each
   excluded task with its reason. Renamed tasks with different IDs are excluded automatically—for
   example, `rwb-linkedin-apply-01` (old) vs `rwb-openai-careers-apply-01` (new) are both removed
   during intersection alignment, with no manual `--exclude` needed.

3. **Manually `--exclude` tasks whose content changed under the same ID.**
   If a task ID stays the same but its difficulty or rubric changes, the intersection retains it
   even though it is not comparable. Remove it with `--exclude <base_id>`. Two automatic warnings
   help detect this case:
   - `⚠️ rubric dimensions differ across runs` → `num_rubrics` changed, so Odysseys is not
     comparable.
   - `⚠️ category labels differ across runs` → do not aggregate by category; inspect only the
     per-task matrix. Category is an unstable label, and task difficulty bands may be relabeled
     during dataset iteration.

4. **judge_error / null verdict often cluster in excluded tasks.**
   Rejudge looks up rubrics by `task_id` in the current dataset, so removed or renamed old tasks
   produce "no rubrics" errors. These errors usually disappear after alignment exclusions; do not
   count them among retained-task errors.

5. **Confirm matching judge_mode before reporting metrics** (the metadata section lists it).
   Agent vs simple mode and different judge models can shift pass rate. Compare only runs with the
   same judge configuration. See [[odysseys-judge-variance-4axes]].

6. **`limits.mode` and `force-rerun` determine whether two runs are the same experiment.** The
   metadata section lists both:
   - `limits.mode`: `time` (wall-clock limit) and `steps` (step limit) are different constraints;
     do not compare them as equivalent.
   - Force-rerun task count: reruns overwrite a task's result in place, `attempt_count` remains 1,
     and `tasks.jsonl` retains no trace. The discarded result appears only in
     `run_metadata.reruns`. When the count is greater than zero, the script warns. First establish
     why the rerun occurred (infrastructure failure ⇒ usually comparable; dissatisfaction with the
     result ⇒ inflated success rate and not comparable). In a recent set of measured skillcmp
     runs, rerun counts ranged from 0 to 29 and concentrated on the hardest task.

7. **Use the per-rubric table to locate the exact criterion that regressed.** A total success-rate
   change such as 90%→60% is not actionable. The `rubrics` section (reading
   `metadata.rubric_scores` from `judges/<task_id>_judge.json`) can show that expedia R2 fell from
   3/5 to 1/5 and careers-apply R2 from 5/5 to 2/5 while all other rubrics remained perfect. This
   artifact exists across run generations (verified back to 2026-06-26); legacy runs without
   `judges/` are skipped explicitly.

## Special conventions for helper distribution and DOM share

To answer whether the agent relies mainly on DOM or visual/JS operations, scan helper calls in
every `wiek-browser` command body and assign them to five interaction buckets: **DOM perception**
(snapshot), **DOM reads** (innerText/count/inputValue…), **DOM actions** (click/fill/press…),
**visual** (screenshot/mouse), and **JS evaluation** (evaluate/cdp), plus navigation plumbing.
Exclude navigation from the denominator of "DOM share."

Three correctness requirements are critical; missing any of them can reverse the conclusion:

- **Recognize both call forms.** During 2026-07-17…21, wiek-lite fully namespaced the API
  (`click(...)` → `page.locator(...).click()`, `useOrCreateTaskSpace` →
  `taskSpaces.useOrCreate`). The old `(?<![.\w])NAME\(` scan was completely blind to the new
  form: it counted only 1 helper across 686 command bodies, producing "DOM 100% / visual 0% / JS
  0%." The current scanner is receiver-aware and merges legacy bare names into the same canonical
  set through `LEGACY_ALIAS`, allowing both generations of runs in one comparison table
  (verified: old and new scripts produce byte-for-byte identical output on legacy runs).
- **Track locator variables.** Calls such as `rows.nth(1).click()` after
  `const rows = page.locator('tr')` account for 59% of element actions in new runs. Missing them
  cuts the DOM-action count by more than half.
- **Exclude agent-defined inline functions.** Functions such as
  `setVal/parseNum/walk/findControl` defined by the model in a heredoc are not built-ins and must
  not count. Exclude them through both receiver awareness (`el.click()` inside `page.evaluate` has
  a DOM-node receiver, not a locator) and the `BUCKET` allowlist.

Inspect two self-checks when reading the report:

- **"Unclassified facade calls"**: parsed methods absent from `BUCKET`. A nonempty result means
  wiek-lite added a capability and the taxonomy needs updating (the first deployment immediately
  detected `locator.setChecked` / `locator.elementCenter`).
- **Warning when more than half of command bodies contain no parsed built-in**: the taxonomy is
  behind wiek-lite. Check §3.1 of wiek-lite `skills/wiek-browser/SKILL.md` before reporting metrics;
  do not trust that run's shares.

See `references/helper_taxonomy.md` for mappings and bucket definitions (§1.7 covers the
namespacing break). When wiek-lite changes the API again, update both that file and
`LEGACY_ALIAS`/`BUCKET` in the script.

## Mandatory reporting rules (shared with pi-session-analyzer)

1. Answer the user's question in a three-sentence summary before showing tables.
2. Distinguish statistical conclusions (full sample) from individual cases (`n=1`, clues only).
3. Separate task difficulty (multiple runs rise or fall together) from agent/skill implementation
   (one-sided movement).
4. Decompose headline gains or regressions by task (which tasks flipped or failed); do not report
   only total success rate.
5. Verify any risk based on theoretical possibility with evidence (artifacts, logs, or code paths)
   before raising it. Label anything unverified explicitly.

## Typical workflow

1. Confirm the run IDs to compare (`ls runs/`) and sort them chronologically.
2. Run all script sections. Read Alignment and Cross-Check to confirm the conventions are correct:
   exclusions match expectations, all cross-checks are ✓, judge_mode matches, and there are no
   rubric/category mismatch warnings—or those warnings have been handled with `--exclude`.
3. Interpret each section and use the per-task matrix to locate flipped or regressed tasks.
4. To investigate why a task failed, switch to `pi-session-analyzer` (workflows A/E).

## Maintenance

- Keep helper rename mappings synchronized between `references/helper_taxonomy.md` and
  `LEGACY_ALIAS`/`BUCKET` in the script.
- For a new metric field, first determine whether it belongs to `tasks.jsonl`,
  `run_metadata.json`, or `judges/<task_id>_judge.json`, then add it to the corresponding section.
- The script depends on the project's `wiek_bench.session_parser` (`--repo-root` defaults to this
  harness root).
- After changing any counting convention, compare old and new output on a legacy run
  (`git show HEAD:<script> > /tmp/old.py`, then run both with the same arguments). Legacy-run
  numbers must remain byte-for-byte identical; any change breaks forward compatibility.
