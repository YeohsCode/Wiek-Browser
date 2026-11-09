# Wiek canonical SDK V2 evaluation

The evaluation framework is owned by this repository under `benchmark/framework`. It uses the Wiek command and SDK only. No reference application, external checkout, debug injection or external Skill is required for local validation. Third-party provenance is retained in NOTICE and the framework LICENSE.

```sh
uv sync --project benchmark/framework --python 3.13.13 --frozen --group dev
PYTHONPATH="$PWD/benchmark/framework" benchmark/framework/.venv/bin/python -m pytest -q benchmark/sdk-v2/test_canonical_v2.py benchmark/framework/tests/test_wiek_browser_runtime_contract.py benchmark/framework/tests/test_screenshotter_ax_tree.py benchmark/framework/tests/test_runspace_core.py benchmark/framework/tests/test_bootstrap_script.py
benchmark/framework/.venv/bin/python benchmark/sdk-v2/smoke.py benchmark/framework --browser wiek
node tools/benchmark-readiness.mjs
```

The 31 ordered public task records and attachments are retained unchanged. Local smoke uses loopback fixtures only, with screenshot/AX/cleanup hooks and no paid models or real account writes. Online Stage A/Judge evaluation still requires explicit model, limit and account configuration. Do not infer online scores from the local 69-case browser suite.
