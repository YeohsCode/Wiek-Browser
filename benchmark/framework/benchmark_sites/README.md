# Benchmark Sites

This directory is the single local host for deterministic websites used by
browser-agent benchmark tasks. Each simulated website owns one route inside the
application, while installation, build, port, and process lifecycle stay shared.

## Rules

- Keep each site under `app/<site-slug>/`, served at `/<site-slug>`.
- Site routes must not import from `wiek_bench/` or `frontend/`.
- Benchmark datasets reference a site by slug (`"local_site": "<slug>"`), never by
  URL and never by site internals. `wiek_bench/task_resources.py` joins the slug to
  this host's origin, so the port below is the only place it is written down.
- Observable success and failure states must remain visible for rubric grading.
- Do not add shared infrastructure until a second site proves the same invariant.
- Local harness startup owns one fixed origin: `http://127.0.0.1:4374`. Override it
  for both sides with `BENCHMARK_SITES_ORIGIN` plus the matching port flag.

Adding a site is therefore a directory and a dataset field, with nothing to register
in between. `tests/test_task_resources.py` fails if a dataset names a slug with no
directory here, or if the port this host binds drifts from the one the harness expects.

`make dev` and `make serve` start this host with the rest of the local harness
stack. `make benchmark-sites-dev` and `make benchmark-sites-serve` run it alone.

## Sites

- `/ticket-rush` — an English-language U.S. concert ticket sale with a
  navigation-relative two-minute wait and a two-second claim window.
