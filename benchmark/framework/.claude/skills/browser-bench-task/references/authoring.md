# Authoring: patterns, phrasing, rubrics

## Proven task patterns

These are the shapes that have held up in this dataset — they're real-world, hard, and
gradeable. Pick one (or combine) and instantiate it with concrete details from your probe.

1. **Aggregate-and-compute** — reach a list/feed → apply multi-filter + sort → extract top-N ×
   several fields → compute (averages, ratios, extrema, intersections). Gradeable because the
   final table + numbers are verifiable against the page. *Difficulty comes from filter count +
   field richness + the computations*, not length. (reddit search, github trending, metacritic,
   Yahoo-style quote tables.)

2. **Form-fill-then-stop** — search/filter → open a form → fill with mock data → **stop before
   the irreversible submit** (Submit / Place order / Complete reservation), list filled fields
   for confirmation. **Never** submit, never enter payment. Side-effect-safe. (LinkedIn→Ashby,
   Expedia passenger form, Yelp→OpenTable, Greenhouse.) Standard mock data:
   `Morgan Chen / morgan.c@example.com / 312-555-0166`.

3. **Calculator** — open a calculator → set several parameters → trigger compute → read multiple
   results (+ a derived computation). Best when the math is deterministic (same inputs → same
   outputs) so the rubric can assert exact values. (Bankrate compound interest, calculator.net.)

4. **Cross-site / cross-app** (`site_mode:multi`) — a genuine dependency across two automatable
   sites: find entity X on site A → look up a fact about X (not on A) on site B → aggregate; or
   compute on site A → write the result into a doc app B (CryptPad Sheets). Both ends must pass
   the probe. The bridge (matching the same entity across sites) is the hard part — make the
   rubric check it. (Box Office Mojo→Wikipedia; Bankrate→CryptPad.)

## Natural phrasing — write like the user, not like a spec

Match the odysseys medium/hard voice: **first person, the motivation woven in, conversational**,
concrete requirements stated plainly. Read a few `level: hard`/`medium` entries in
`data/odysseys.json` before writing to re-tune your ear.

**Cut operator meta-instructions** — they are the #1 tell that a human didn't write the task.
A real user does not say "read-only", "don't log in", "don't vote", "don't download", "use
old.reddit.com to avoid popups", "don't click promo buttons". Any such constraint that matters
for *reliability* belongs in the `note` field (operator-only, not graded), or is enforced by the
`website` start URL. The task's own stop-boundaries (form-fill: "stop before Submit") DO belong
in the text — those are part of what the user wants.

**Before → After** (real edit from this dataset):

> ✗ `访问 https://old.reddit.com/r/personalfinance（务必用 old.reddit.com，避开新版登录弹窗与重定向）。在该板块内用站内搜索关键词 "index fund"，并应用以下筛选：…restrict_sr=on、sort=top、t=year…。…全程只读浏览，不登录、不投票、不评论。`

> ✓ `我最近在研究指数基金，想看看 r/personalfinance 版块里大家聊这个话题时最热门的帖子是哪些。帮我在 Reddit 的 r/personalfinance 版块里搜索关键词 "index fund"，把搜索范围限定在这个版块内、按 Top（最高赞）排序、时间范围选过去一年。…`

Notes on the fix: dropped the parenthetical operator hint (moved to `note`), translated
`restrict_sr=on/sort=top/t=year` into how a user would say it ("限定在这个版块内、按 Top 排序、过去
一年"), and deleted the "read-only" tail. The start URL stays `old.reddit.com` so reliability is
preserved without the user-unnatural instruction.

Keep the concrete requirements precise (exact filters, field list, computation rounding, stop
point) — natural ≠ vague. The rubric needs those specifics to be checkable.

## Rubric discipline

Per-rubric grading lifts agreement (Odysseys measured one-shot κ 0.51 → per-rubric 0.79–0.85).
Write **3–6** rubrics, each `{requirement, verification}`:

1. **One thing per rubric.** "filter applied" and "output contains field X" are separate rubrics.
2. **State-based verification.** Describe the *end state* a grader can see (filter chips visible,
   form field value, output table, computed number) — not an action sequence. Accept any valid path.
3. **Operation rubrics must be "applied AND confirmed."** Clicking sort but it didn't take ≠ done.
   Confirmation evidence may be a screenshot **or** a tool read-back in the trajectory (e.g. JS
   read of the form value / URL state) — the agent's mere claim in its final answer is not evidence.
4. **Cover the arc, don't pad:** arrival/access → each filter-sort → interaction/extraction →
   output completeness & computation. Don't split one requirement into many to hit a count.
5. **Calibrate to the real run.** Derive rubrics from your wiek-browser trajectory and known judge
   failure modes ("didn't stop before payment", "didn't use the Company filter", "invented a
   number"). For deterministic tasks (calculators, historical charts) you may assert exact values
   in `verification`; for live data (trending, quotes, today's leaderboard), assert *self-consistency*
   ("the computed average matches the listed rows", "magnitude matches the page") and say in `note`
   that it's live / judged against the run-time page.

**Good vs bad verification:**

> ✗ "Agent sorts by price." (action, not state; not confirmable)
> ✓ "Screenshot shows the sort control set to Price ↑ and the list order matches; or the trajectory
>    read back the sort param — clicking without effect doesn't count."
>
> When a site exposes **no** sort indicator (no `aria-sort`, no arrow), the sorted column's values
> being **monotonic** (each ≥ the next, for descending) is itself acceptable state-based evidence
> that the sort took — write the verification around the data, not a missing control.

> ✗ "Output is correct." (not independently checkable)
> ✓ "Output has exactly 8 rows, each with rank/title/points/comments/time; points & comments match
>    the page's .search-score / .search-comments text (incl. thousands separators), no fabrication."

## Anti-patterns (learned the hard way)

- **Writing before probing.** The cardinal sin — see `wiek-browser-testing.md`.
- **Operator meta-instructions in `confirmed_task`.** Move to `note` or drop.
- **Requiring a control you can't set reliably.** E.g. an exact range from a drag slider; pagination
  that resets filters. Redesign around what the UI actually supports cleanly.
- **Computations on flaky fields.** E.g. averaging a `%change` column that renders `-` after hours.
- **Hardcoding live values in rubrics.** Trending/quotes change per run — assert self-consistency,
  not "Inside Out 2 is #1", unless the source is historical/deterministic.
- **Duplicating an existing site+play.** Check the dataset first; bring a new site or a new play.
- **Padding to look "high".** Difficulty should be real (filters/fields/computation/cross-site),
  not a longer instruction. Set `level`/`reference_length` honestly.
