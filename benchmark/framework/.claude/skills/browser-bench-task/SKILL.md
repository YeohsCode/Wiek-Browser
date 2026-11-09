---
name: browser-bench-task
description: Author or expand browser-agent benchmark tasks in data/real_world_bench.json (Odysseys schema, per-rubric graded). Use when creating, adding, or expanding real-world browser tasks, writing rubrics, or picking bot-friendly sites — every task MUST be verified runnable through wiek-browser before it is written.
---

# Browser benchmark task author

## Why this skill exists

You are building tasks for `data/real_world_bench.json` — a browser-agent benchmark where
each task is graded checkpoint-by-checkpoint (per-rubric). A good task is **real-world,
completable, and free of any risk-control block the autonomous run can't get past**: an agent
driving wiek-browser must be able to actually finish it, and a grader must be able to verify each checkpoint from screenshots,
trajectory, or final output.

The one rule that matters most, and the reason this skill exists:

> **Never write a task you have not run through wiek-browser first.**
> Web research and model priors *lie* about bot-friendliness — sites that look "low risk" on
> paper hard-block real automation (Product Hunt → Cloudflare "Just a moment"; Etsy → DataDome
> + forced login at checkout). The only proof is a live wiek-browser probe. Then calibrate the
> rubrics to what you actually observed, not to what you imagined.

This operationalizes the repository's core authoring rule: calibrate every task from a real
wiek-browser run.

## The loop

Do **one task at a time**. Read the referenced file the first time you need its detail.

1. **Load context.** Read `data/real_world_bench.json` (tail for the live schema; scan all
   `website` + `task_id` values to avoid duplicating a site or play you already have). Skim
   `references/schema.md` for the schema and `references/authoring.md` for rubric discipline.
   Recall the bot-friendliness memory if present.

2. **Pick a candidate.** Honor the user's constraints (US mainstream site, required `level`,
   cross-site wanted?, a mandated site such as reddit?). Avoid sites already in the dataset
   unless the *play* is genuinely new. To cover breadth fast you may fan out research with a
   `Workflow` (parallel web-search lanes → shortlist ranked by bot-risk), but research only
   **prioritizes probe order — it never replaces the probe.** → `references/site-selection.md`

3. **Probe with wiek-browser — this is the gate.** Drive the EXACT interactions the task will
   need: reach the start page, confirm the autonomous run won't be walled off, apply every
   filter/sort/form step, and confirm the target data is actually extractable. Capture the real
   trajectory and concrete values. An **automated hard wall** (Cloudflare / DataDome / PerimeterX
   that won't clear) or an unreachable key interaction → **drop it and pick another**, do not
   write the task. A **human-verification / captcha** is the one carve-out: pause and hand off to
   the user to solve it **once** — if it then clears and does **not** return on repeated probing,
   treat it as a one-time trust gate (not a per-request wall) and the site is usable; if the SAME
   site re-challenges **after** that solve, **skip it** — a per-entry captcha can't be driven by
   the agent at run time. Probes share one real browser, so run them **sequentially, never in
   parallel.**
   → `references/wiek-browser-testing.md`

4. **Design + write `confirmed_task`.** Fit a proven, gradeable pattern (aggregate-and-compute /
   form-fill-then-stop / calculator / cross-site or cross-app), with concrete filters, fields,
   computations, and stop-boundaries. Write it in **natural user voice** — first person, the
   motivation woven in, like the odysseys medium/hard tasks. **No operator meta-instructions**
   ("read-only", "don't log in", "must use old.reddit.com") — a real user would not say those;
   put any such rationale in the `note` field. → `references/authoring.md`

5. **Write rubrics** (3–6). Each rubric = one independently verifiable checkpoint; verification
   is **state-based** (what a grader sees in a screenshot / final output, not an action
   sequence); operation rubrics must be "applied AND confirmed"; all of it calibrated to your
   real run. → `references/authoring.md`

6. **Append + validate.** Append the object **surgically** (do not reformat or rewrite existing
   entries — keep the diff to an append). Then validate:
   ```bash
   uv run python -c "import json; json.load(open('data/real_world_bench.json')); print('json ok')"
   uv run python -c "from wiek_bench.datasets import _ADAPTERS; ts=_ADAPTERS['real-world-bench']().load(); t=[x for x in ts if x.task_id==NEW_ID][0]; print(len(ts), 'rubrics:', len(t.metadata['rubrics']))"
   ```
   Missing/empty rubrics fail-loud in Stage B, so confirm the new entry carries them.

7. **Capture learnings.** Update the bot-friendliness memory with any new pass/fail site and
   its evidence.

## Definition of done

- [ ] Ran end-to-end through wiek-browser — no automated hard wall, and any human-verification cleared on a **single** handoff and did **not** recur; key interactions reached; data extracted.
- [ ] `confirmed_task` reads like a real user request — first person, motivated, **zero operator meta-instructions**.
- [ ] 3–6 rubrics, each one verifiable checkpoint, **calibrated to the real run** (not invented).
- [ ] JSON valid, adapter loads, new entry has rubrics.
- [ ] `level` / `site_mode` / `site_count` / `categories` / `reference_length` filled; `note` carries operator hints + the calibration record.

## Reference files

- `references/schema.md` — the Odysseys schema fields, semantics, and a worked JSON example.
- `references/wiek-browser-testing.md` — **the gate**: risk-control signals, copy-paste probe
  recipes, special cases (React inputs, cross-origin editors, captcha handoff), and the known
  bot-friendly / bot-hostile site table.
- `references/authoring.md` — the proven task patterns, the natural-phrasing rules (with
  before/after), rubric discipline with examples, and the anti-patterns to avoid.
