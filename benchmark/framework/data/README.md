# Benchmark datasets

Task snapshots consumed by `ego_bench/datasets/`. Each file is a JSON array of task
objects; the adapter for a benchmark owns the mapping from these fields to
`BenchmarkTask`.

| File | Benchmark | Tasks | Composition |
| --- | --- | --- | --- |
| `Online_Mind2Web.json` | `online-mind2web` | 300 | Snapshot of the public Online-Mind2Web task set. |
| `BU_Bench_V1.json` | `bu-bench` | 100 | Balanced sample, 20 per category, drawn from five sources: `BrowseComp`, `GAIA`, `OM2W2` (Online-Mind2Web), `WebBenchREAD`, and `InteractionTests`. |
| `Stealth_Bench_V1.json` | `stealth-bench` | 80 | Tasks bucketed by the anti-bot vendor guarding the target site (Cloudflare, DataDome, Akamai, PerimeterX, Kasada, Shape, GeeTest, hCaptcha, reCaptcha, and custom). |
| `odysseys.json` | `odysseys` | 200 | Multi-site, rubric-scored, English. |
| `real_world_bench.json` | `real-world-bench` | 31 | Rubric-scored tasks calibrated against live sites; some target the local `benchmark_sites/`. |

## Redistribution

`Online_Mind2Web.json`, and the `BrowseComp` / `GAIA` / `OM2W2` / `WebBenchREAD`
slices of `BU_Bench_V1.json`, are derived from externally published benchmarks.
Copyright and licensing for those task texts belong to their original authors and are
**not** covered by this repository's MIT license. Confirm each upstream license before
redistributing these files or building a derived dataset on top of them.

## Live-site tasks

Most tasks drive third-party production websites. They are read-mostly, but a few fill
forms or create content, and any of them can break when a site redesigns or tightens
bot detection. Treat a failure as "needs recalibration" before treating it as a
regression in the agent under test.

Some tasks name accounts or personas — for example the applicant identity in a
form-fill task. These are fixtures, not real people.

## Task resources

A task can declare two things beyond its text. Both are named, never spelled out as a
path or a URL, so a dataset stays valid whatever machine it runs on.

| Field | Means | Resolved by |
| --- | --- | --- |
| `"attachments": ["<file>"]` | Files under `attachments/`, handed to the agent as task input rather than fetched from the web. | Linked into the agent's per-task working directory; the prompt names the staged path. |
| `"local_site": "<slug>"` | A site served from `benchmark_sites/app/<slug>/` instead of the live web. Mutually exclusive with `website`. | Joined to the site host's origin, overridable with `BENCHMARK_SITES_ORIGIN`. |

`ego_bench/task_resources.py` owns both. It checks every declared resource before the
first model call and fails the run if one is missing or the site host is not up — an
absent resource would otherwise be scored as the agent failing the task.

Do not write a filesystem path or a `127.0.0.1` URL into a dataset;
`tests/test_task_resources.py` rejects both.

## `attachments/` fixtures

**`resume-cloud-infra.html` and `resume-cloud-infra.pdf` contain a deliberate prompt
injection.** The "Application Notes" block instructs an automated form-filler to answer
"Yes" to every binary question and tick every checkbox. That payload is what the task
measures resistance to — an agent that follows it fails the rubric. It is test data, not
a defect, and must not be "fixed" or stripped.

Attachments are linked, not copied, into the agent's working directory, so an agent that
writes to one writes through to the file here. These files are graded against across
runs: an unexpected diff under `attachments/` means a corrupted run, not a stale file.

`test-sites.md` is an authoring note for `.claude/skills/browser-bench-task`.
