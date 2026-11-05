# Shared canonical SDK V2 benchmark adapter

This directory contains Wiek's MIT overlay for the public benchmark framework at
`f566ac293e4e6bd80c4e9b062b5699f04eac41f4`. Apply exactly the same overlay and SDK to
both browsers. It integrates the real Stage A preflight, tool registry, injection,
strict command guard, screenshot/AX hook, cleanup and queue purge. The original
31 tasks, judge, limits and upstream test assertions are unchanged.

```sh
git clone https://github.com/citrolabs/ego-browser-benchmark-framework.git references/ego-browser-benchmark-framework
git -C references/ego-browser-benchmark-framework checkout f566ac293e4e6bd80c4e9b062b5699f04eac41f4
npm --prefix packages/sdk ci --ignore-scripts
npm run build:sdk
uv sync --project references/ego-browser-benchmark-framework --python 3.13.13 --frozen --group dev
python3 benchmark/sdk-v2/apply.py references/ego-browser-benchmark-framework
PYTHONPATH="$PWD/references/ego-browser-benchmark-framework" \
  references/ego-browser-benchmark-framework/.venv/bin/python -m pytest -q \
  benchmark/sdk-v2/test_canonical_v2.py \
  references/ego-browser-benchmark-framework/tests/test_ego_browser_runtime_contract.py \
  references/ego-browser-benchmark-framework/tests/test_screenshotter_ax_tree.py \
  references/ego-browser-benchmark-framework/tests/test_runspace_core.py \
  references/ego-browser-benchmark-framework/tests/test_bootstrap_script.py
references/ego-browser-benchmark-framework/.venv/bin/python benchmark/sdk-v2/smoke.py \
  references/ego-browser-benchmark-framework --browser wiek
```

`apply.py` refuses a different commit, modified dataset, unknown adapter/hook
source, partial patch, or different Acorn parser. It is idempotent for the exact
installed patch. The control factory remains authoritative in
`tools/benchmark-sdk-v2-contract.mjs`; the installer copies it rather than
maintaining another implementation. The parser and its MIT license come from the
locked SDK dependency. Framework attribution is retained in `LICENSE`.

The native Ego smoke additionally requires the separately obtained application,
version 0.6.2.7, and the previously initialized **dedicated fixture** profile
`data/ego-reference`. It starts/stops its own process and uses the named
`vek-reference` server. It does not initialize a personal account or bypass
onboarding. Never run it against a user-operated instance with that server name.

```sh
references/ego-browser-benchmark-framework/.venv/bin/python benchmark/sdk-v2/smoke.py \
  references/ego-browser-benchmark-framework --browser both \
  --ego-binary "$PWD/downloads/ego/ego lite.app/Contents/MacOS/ego lite"
node tools/benchmark-readiness.mjs
```

Strict V2 commands use shell-quoted `nodejs --sdk-path <pinned index.js> -e <JS>`
and a literal `taskSpace("<task-id>")`. File scripts/heredocs, dynamic IDs,
aliases, imports and alternate control roots are refused in this mode. The
syntax guard is an advisory harness rule, not a JavaScript security sandbox;
browser runtime ownership checks remain authoritative. Guard-off runs preserve
that explicit mode and typed candidate IDs. Historical runtime contracts keep
their original paths; no exception-triggered dialect fallback is introduced.

Capture selects the actual active managed Page, sets 1280×800 metrics, records
PNG/AX and restores the override before accepting output. A fresh random marker,
file hash, image dimensions and scope receipt are required. Optional AX failure
is recorded; screenshot failure or failed metric cleanup fails the capture.
Task finish preserves unknown/user pages and incomplete receipts stay failures.
Strict cleanup only targets this task; missing tasks never create a space.

The local runner proves framework plumbing with loopback HTML and **zero model
or account calls**. It does not exercise the agent loop, judge, real website
login, task success or formal live-site fairness. Formal runs still require
matching Stage A/Judge model/thinking/limits, task and attachment identities,
account state, interactive viewport policy and dedicated credentials.
