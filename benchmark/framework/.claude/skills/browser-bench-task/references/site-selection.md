# Picking and researching a candidate site

## Constraints checklist

- **US mainstream site** (English, US-user-facing) unless the user says otherwise.
- **Honors the user's `level`** — most real-world tasks are `high` (multi-filter / form-fill /
  cross-site). Be honest; don't pad a thin task to look high.
- **Not already in the dataset** (same site + same play). Scan existing `website` + `task_id`
  first. A new site, or a genuinely new play on a covered site, is fine.
- **A required site** if the user named one (e.g. "one must use reddit" → reddit.com proper,
  not a reddit-branded ATS).
- **Plausibly automatable** — favor sites likely to pass the probe. See the known bot-friendly /
  bot-hostile table in `wiek-browser-testing.md`. But the table only prioritizes which to probe
  first; the probe is still mandatory.

## Researching for breadth (optional accelerator)

When you need to choose among many sites (e.g. "give me 5 across different domains"), fan out
research with a `Workflow` so you don't probe blindly:

- Parallelize **web-search lanes** by category (social / dev / e-commerce / finance / media /
  travel / real-estate-auto / cross-site). Each lane returns candidate sites + a draft task +
  a bot-risk guess + evidence.
- Synthesize into a shortlist **ranked by bot-risk ascending** = your probe order (probe the
  likely-friendly ones first; keep the first N that pass).

**Research informs probe order — it does not replace the probe.** Pure web research mislabels
risk control (it called Product Hunt and Etsy "low risk"; both hard-block real automation). The
wiek-browser probe is the only source of truth.

## Diversity (for multi-task requests)

When asked for several tasks, spread across **domains** (social, dev, finance, movies, games,
shopping, travel…) and across **patterns** (aggregate / form-stop / calculator / cross-site) so
the batch isn't five variations of one thing. The dataset is already pattern-balanced, so a
slightly aggregate-heavy batch is acceptable — reliability (passes the probe) outranks diversity.
