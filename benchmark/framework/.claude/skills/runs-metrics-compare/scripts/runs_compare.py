#!/usr/bin/env python3
"""Multi-run metrics comparison for wiek-benchmark-harness.

Recomputes every reported metric from `runs/<id>/tasks.jsonl` + the pi session
JSONL (NOT the HTML report), aligns runs on their common base tasks, and prints
standardized comparison tables: aggregate, Odysseys rubric, duration distribution,
turns/tool, errors, per-task success matrix, and helper distribution + DOM ratio.

Usage (run from the repository root, or pass --repo-root):
  uv run python .claude/skills/runs-metrics-compare/scripts/runs_compare.py RUN_ID [RUN_ID ...] [--exclude BASE_TASK ...] [--runs-dir DIR]
      [--labels "L1,L2,..."] [--only SECTION,...] [--repo-root PATH]

Examples:
  uv run python .claude/skills/runs-metrics-compare/scripts/runs_compare.py \
     real-world-bench_pi_wiek-browser_20260613T041813Z_rejudge_selected \
     real-world-bench_pi_wiek-browser_20260630T035657Z

Sections (for --only): align aggregate odysseys rubrics duration turns errors pertask helpers crosscheck
Default: all sections.

Design notes:
- Source of truth = tasks.jsonl fields (verdict/score/num_rubrics[_passed]/category/
  started_at/ended_at/error/judge_error/reached_captcha/impossible_task) + session JSONL.
- Runs are aligned on the INTERSECTION of base_task_ids by default. A renamed task
  (e.g. linkedin-apply -> openai-careers-apply) has different ids and is auto-dropped;
  the align section reports exactly what was dropped and why.
- `--exclude` drops a base task that exists in ALL runs but is not comparable
  (e.g. same id, changed difficulty/rubrics).
- Helper counting normalizes the 2026-06-29 Playwright rename (js->evaluate, etc.)
  and excludes agent-authored inline functions. See references/helper_taxonomy.md.
"""
import argparse
import json
import re
import statistics as st
import sys
from collections import Counter
from pathlib import Path
from datetime import datetime

# --- helper taxonomy (keep in sync with references/helper_taxonomy.md) -------
# Two call shapes coexist across eras and BOTH must keep working:
#   legacy     (runs <= 2026-07-16): bare builtins -> snapshotText(...), js(...)
#   namespaced (runs >= 2026-07-21): facades + Playwright locator chains ->
#                                    page.locator('tr').nth(1).click()
# Canonical name is "<receiver>.<method>"; legacy bare names alias onto it, so a
# 06-05 run and a 07-25 run land in the same buckets.
LEGACY_ALIAS = {
    # page-level
    # `js` is the <=06-29 name; 06-29..07-16 runs call the same builtin `evaluate`
    # bare (07-04/07-06 runs do so 500+ times each), so both must map.
    "js": "page.evaluate", "evaluate": "page.evaluate",
    "snapshotText": "page.snapshot", "snapshot": "page.snapshot",
    "snapshotRaw": "page.snapshotRaw", "pageInfo": "page.info",
    "captureScreenshot": "page.screenshot", "screenshot": "page.screenshot",
    "gotoAndWait": "page.goto", "navigate": "page.goto", "goto": "page.goto",
    "wait": "page.waitForTimeout", "sleep": "page.waitForTimeout",
    "waitForTimeout": "page.waitForTimeout", "waitForLoad": "page.waitForLoadState",
    "waitForLoadState": "page.waitForLoadState", "waitForNetworkIdle": "page.waitForNetworkIdle",
    "waitForSelector": "page.waitForSelector", "drainEvents": "page.drainEvents",
    "scrollBy": "page.mouse", "wheel": "page.mouse",
    # element ops (legacy took a selector/ref; the modern shape is a locator chain)
    "click": "locator.click", "dblclick": "locator.dblclick", "hover": "locator.hover",
    "drag": "locator.drag", "fillInput": "locator.fill", "fill": "locator.fill",
    "pressKey": "locator.press", "press": "locator.press", "type": "locator.type",
    "typeText": "locator.insertText", "insertText": "locator.insertText",
    "setChecked": "locator.check", "check": "locator.check", "uncheck": "locator.uncheck",
    "selectOption": "locator.selectOption", "focus": "locator.focus",
    "scrollIntoViewIfNeeded": "locator.scrollIntoViewIfNeeded",
    "setInputFiles": "locator.setInputFiles",
    # tabs / task spaces / net / misc
    "openOrReuseTab": "browser.openOrReuseTab", "switchTab": "browser.switchTab",
    "listTabs": "browser.listTabs", "closeTab": "browser.closeTab",
    "currentTab": "browser.currentTab", "ensureRealTab": "browser.ensureRealTab",
    "useOrCreateTaskSpace": "taskSpaces.useOrCreate", "listTaskSpaces": "taskSpaces.list",
    "claimTaskSpace": "taskSpaces.claim", "completeTaskSpace": "taskSpaces.complete",
    "handOffTaskSpace": "taskSpaces.handOff",
    "waitForAgentControl": "taskSpaces.waitForAgentControl",
    "serverFetch": "fetch.server", "browserFetch": "fetch.browser",
    "cdp": "cdp", "cliLog": "cli.log", "help": "cli.help",
}
# canonical -> interaction bucket. A rooted call whose method is NOT here is
# reported as unclassified so taxonomy drift surfaces instead of reading as zero.
BUCKET = {
    "page.snapshot": "P-dom", "page.snapshotRaw": "P-dom",
    # Locator state/collection reads: the read path that replaced js() scraping
    # once the Playwright-style API landed (>= 2026-07-21). Absent in old runs.
    "locator.innerText": "R-dom", "locator.textContent": "R-dom",
    "locator.inputValue": "R-dom", "locator.getAttribute": "R-dom",
    "locator.isChecked": "R-dom", "locator.isVisible": "R-dom",
    "locator.isEnabled": "R-dom", "locator.isDisabled": "R-dom",
    "locator.isEditable": "R-dom", "locator.count": "R-dom",
    "locator.allInnerTexts": "R-dom", "locator.allTextContents": "R-dom",
    "locator.boundingBox": "R-dom", "locator.all": "R-dom",
    "locator.click": "A-dom", "locator.dblclick": "A-dom", "locator.hover": "A-dom",
    "locator.drag": "A-dom", "locator.dragTo": "A-dom", "locator.fill": "A-dom",
    "locator.press": "A-dom", "locator.insertText": "A-dom", "locator.type": "A-dom",
    "locator.clear": "A-dom", "locator.check": "A-dom", "locator.uncheck": "A-dom",
    "locator.selectOption": "A-dom", "locator.focus": "A-dom",
    "locator.scrollIntoViewIfNeeded": "A-dom", "locator.setInputFiles": "A-dom",
    "locator.dispatchEvent": "A-dom", "locator.setChecked": "A-dom",
    "locator.blur": "A-dom", "page.keyboard": "A-dom",
    "page.evaluate": "J-eval", "locator.evaluate": "J-eval",
    "locator.evaluateAll": "J-eval", "cdp": "J-eval",
    "page.screenshot": "V-visual", "locator.screenshot": "V-visual",
    "page.mouse": "V-visual", "page.elementCenter": "V-visual",
    "locator.elementCenter": "V-visual",
    "page.goto": "nav", "page.reload": "nav", "page.url": "nav", "page.title": "nav",
    "page.info": "nav", "page.setDefaultTimeout": "nav", "page.drainEvents": "nav",
    "page.waitForTimeout": "nav", "page.waitForLoadState": "nav",
    "page.waitForNetworkIdle": "nav", "page.waitForSelector": "nav",
    "page.waitForURL": "nav", "page.waitForFunction": "nav", "page.waitForRequest": "nav",
    "page.waitForResponse": "nav", "page.waitForEvent": "nav", "page.screencast": "nav",
    "locator.waitFor": "nav",
    "browser.openOrReuseTab": "nav", "browser.switchTab": "nav", "browser.listTabs": "nav",
    "browser.closeTab": "nav", "browser.currentTab": "nav", "browser.ensureRealTab": "nav",
    "browser.iframeTarget": "nav",
    "taskSpaces.useOrCreate": "nav", "taskSpaces.list": "nav", "taskSpaces.switch": "nav",
    "taskSpaces.new": "nav", "taskSpaces.claim": "nav", "taskSpaces.complete": "nav",
    "taskSpaces.handOff": "nav", "taskSpaces.takeOver": "nav",
    "taskSpaces.waitForAgentControl": "nav",
    "fetch.server": "nav", "fetch.browser": "nav",
    "cli.log": "nav", "cli.help": "nav",
    # cli.log only ever fires for <=0615b runs (legacy `cliLog`); newer runtimes
    # use console.log, which collides with the JS builtin and is deliberately
    # not tracked. See references/helper_taxonomy.md.
}
DUAL = {"locator.click", "locator.dblclick", "locator.hover", "locator.drag"}
BUCKET_LABEL = {
    "P-dom": "DOM sense snapshot/snapshotRaw", "R-dom": "DOM reads innerText/count/…",
    "A-dom": "DOM actions click/fill/press…", "V-visual": "Visual screenshot/mouse/coords",
    "J-eval": "JS evaluation evaluate/cdp", "nav": "Navigation/lifecycle",
}
BUCKET_ORDER = ["P-dom", "R-dom", "A-dom", "V-visual", "J-eval", "nav"]

# --- call-shape scanning -----------------------------------------------------
FACADES = ("page", "browser", "taskSpaces", "fetch")
LOCATOR_FACTORY = {
    "locator", "getByRole", "getByText", "getByLabel", "getByPlaceholder",
    "getByTestId", "getByAltText", "getByTitle", "frameLocator",
}
# Chain links that only narrow the selection; the action is whatever follows.
CHAIN_REFINE = LOCATOR_FACTORY | {"first", "last", "nth", "filter", "and", "or"}
PAGE_SUBNS = {"mouse", "keyboard", "screencast"}
NS_ROOT_RE = re.compile(r"(?<![.\w])(page|browser|taskSpaces|fetch)\s*\.")
SEGMENT_RE = re.compile(r"\s*\.\s*([A-Za-z_]\w*)\s*")
LOC_ASSIGN_RE = re.compile(r"(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?([A-Za-z_]\w*)\b")


def classify_click(after: str) -> str:
    s = after.lstrip()
    if s.startswith("["):
        return "coord"
    if s.startswith("{"):
        inner = s[1:].lstrip()
        if inner.startswith("selector"):
            return "dom"
        if re.match(r"x\s*:", inner):
            return "coord"
        return "dom"
    return "dom"  # '@N', 'css', "..."


def locator_vars(cmd: str) -> set[str]:
    """Identifiers bound to a locator: `const rows = page.locator('tr')`.

    Measured on the 07-24/07-25 runs, 59% of locator actions reach the element
    through such a variable, so a scanner that only matches `page.locator(...)`
    inline undercounts DOM work by more than half.
    """
    found: set[str] = set()
    for _ in range(2):  # a locator var may be derived from another locator var
        before = len(found)
        for m in LOC_ASSIGN_RE.finditer(cmd):
            name, recv = m.group(1), m.group(2)
            if recv != "page" and recv not in found:
                continue
            segs = _segments(cmd, m.end())
            # A chain that ends in an action yields data, not a locator:
            # `const cells = await page.locator(x).allInnerTexts()` binds strings.
            if segs and _resolve("locator" if recv in found else recv, segs) is None:
                found.add(name)
        if len(found) == before:
            break
    return found


def _segments(cmd: str, i: int) -> list[tuple[str, bool]]:
    """Consume `.name(...)` / `.name` links from index i, balancing parentheses."""
    segs: list[tuple[str, bool]] = []
    while i < len(cmd):
        m = SEGMENT_RE.match(cmd, i)
        if not m:
            break
        name, i = m.group(1), m.end()
        if i < len(cmd) and cmd[i] == "(":
            depth = 0
            while i < len(cmd):
                if cmd[i] == "(":
                    depth += 1
                elif cmd[i] == ")":
                    depth -= 1
                    if depth == 0:
                        i += 1
                        break
                i += 1
            segs.append((name, True))
        else:
            segs.append((name, False))
    return segs


def _resolve(root: str, segs: list[tuple[str, bool]]) -> str | None:
    """Chain -> canonical '<receiver>.<method>', or None when it has no action."""
    receiver = root
    for name, called in segs:
        if receiver == "page" and name in PAGE_SUBNS:
            receiver = f"page.{name}"
            continue
        if receiver in ("page.mouse", "page.keyboard"):
            return receiver  # bucket by sub-namespace, not by key/button
        if name in CHAIN_REFINE:
            receiver = "locator"
            continue
        if not called:
            continue
        return f"{receiver}.{name}"
    return None


def iter_helper_calls(cmd: str):
    """Yield canonical helper names for one wiek-browser command body.

    Namespaced chains are read receiver-first, so `el.click()` inside a
    page.evaluate body (a DOM node, not a locator) never counts as a helper.
    The legacy bare-name pass is skipped whenever the body uses a facade: within
    one body an agent writes one API style, and bare `check(`/`type(` in a modern
    body is an agent-authored function, not a builtin.
    """
    lvars = locator_vars(cmd)
    roots = "|".join(FACADES + tuple(re.escape(v) for v in sorted(lvars)))
    for m in re.finditer(rf"(?<![.\w])({roots})\b", cmd):
        root = m.group(1)
        canon = _resolve("locator" if root in lvars else root, _segments(cmd, m.end()))
        if canon:
            yield canon
    for m in re.finditer(r"(?<![.\w])cdp\s*\(", cmd):
        yield "cdp"
    if NS_ROOT_RE.search(cmd):
        return
    for m in re.finditer(r"(?<![.\w])([A-Za-z_]\w+)\s*\(", cmd):
        canon = LEGACY_ALIAS.get(m.group(1))
        if canon and canon != "cdp":
            if canon in DUAL and classify_click(cmd[m.end():m.end() + 40]) == "coord":
                yield "page.mouse"
            else:
                yield canon


def percentile(vals, p):
    if not vals:
        return float("nan")
    if len(vals) == 1:
        return vals[0]
    s = sorted(vals)
    k = (len(s) - 1) * p / 100.0
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def parse_ts(s):
    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None


def load_rows(runs_dir, rid):
    path = f"{runs_dir}/{rid}/tasks.jsonl"
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def load_json(runs_dir, rid, name):
    try:
        with open(f"{runs_dir}/{rid}/{name}") as f:
            return json.load(f)
    except Exception:
        return {}


def load_judges(runs_dir, rid):
    """task_id -> per-task judge artifact (per-rubric scores, judge cost/turns).

    Keyed by the file's own ``task_id``: the odysseys dataset uses hashed task
    ids, so the filename stem is not always a readable id. ``_job.json`` is the
    judging job's progress file, not a task, and is skipped.
    """
    out = {}
    for path in sorted(Path(f"{runs_dir}/{rid}/judges").glob("*.json")):
        if path.name == "_job.json":
            continue
        try:
            with open(path) as f:
                row = json.load(f)
        except Exception:
            continue
        tid = row.get("task_id")
        if tid:
            out[str(tid)] = {**row, **(row.get("metadata") or {})}
    return out


def cell(width, *vals):
    return "".join(f"{v:>{width}}" for v in vals)


def _fit(value, width):
    """Truncate from the left: the tail is what distinguishes model/judge names
    (`openai/gpt-5.6-terra` vs `openai/gpt-5` must not both read as `openai/gpt-5`)."""
    s = str(value)
    return s if len(s) <= width else "…" + s[-(width - 1):]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run_ids", nargs="+")
    ap.add_argument("--exclude", nargs="*", default=[], help="base_task_id(s) to drop from the aligned set")
    ap.add_argument("--runs-dir", default="runs")
    ap.add_argument("--labels", default=None, help="comma-separated short labels, one per run")
    ap.add_argument("--only", default=None, help="comma-separated section subset")
    # Default to the repository this skill is checked out in.
    ap.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[4]))
    args = ap.parse_args()

    sys.path.insert(0, args.repo_root)
    try:
        from wiek_bench.session_parser import safe_parse
    except Exception as e:  # pragma: no cover
        print(f"!! cannot import session_parser from {args.repo_root}: {e}", file=sys.stderr)
        safe_parse = None

    runs = args.run_ids
    if args.labels:
        labels = args.labels.split(",")
        if len(labels) != len(runs):
            ap.error("--labels count must match number of runs")
    else:
        # short label = the timestamp token if present, else trimmed id
        labels = []
        for r in runs:
            m = re.search(r"_(\d{8}T\d{6}Z)", r)
            labels.append(m.group(1)[:8] if m else r[:12])
    L = {r: labels[i] for i, r in enumerate(runs)}
    W = max(13, max(len(x) for x in labels) + 2)
    sections = set(args.only.split(",")) if args.only else None

    def want(name):
        return sections is None or name in sections

    data = {r: load_rows(args.runs_dir, r) for r in runs}
    meta = {r: load_json(args.runs_dir, r, "run_metadata.json") for r in runs}
    summ = {r: load_json(args.runs_dir, r, "summary.json") for r in runs}

    base_sets = {r: {row["base_task_id"] for row in data[r]} for r in runs}
    common = set.intersection(*base_sets.values()) if base_sets else set()
    excluded = set(args.exclude)
    kept = sorted(common - excluded)

    # filter rows to aligned + non-excluded base tasks
    rows_f = {r: [x for x in data[r] if x["base_task_id"] in kept] for r in runs}

    head = f"{'':<30}" + cell(W, *[L[r] for r in runs])

    # ---------------- ALIGN ----------------
    if want("align"):
        print("=" * (30 + W * len(runs)))
        print("RUN METADATA & TASK ALIGNMENT")
        print("=" * (30 + W * len(runs)))
        for field, getter in [
            ("model", lambda m, s: m.get("model") or s.get("model")),
            ("judge_mode", lambda m, s: m.get("judge_mode")),
            ("judge_model", lambda m, s: m.get("judge_model") or s.get("judge_model")),
            ("concurrency", lambda m, s: m.get("concurrency")),
            ("iterations", lambda m, s: m.get("iterations")),
            # A time-limited run and a step-limited run are not the same experiment.
            ("limits.mode", lambda m, s: (m.get("limits") or {}).get("mode")),
            ("max_turns", lambda m, s: (m.get("limits") or {}).get("max_turns")),
            ("skill_hash[:8]", lambda m, s: (m.get("skill_file_hash") or "")[:8]),
            ("wiek_sha[:8]", lambda m, s: ((m.get("wiek_browser_release") or {}).get("index_js_sha256") or "")[:8]),
            # force-rerun replaces a task's result in place: attempt_count stays 1
            # and tasks.jsonl keeps no trace, so the discarded outcome is only
            # visible here. A run with reruns is not comparable to one without.
            ("force-rerun task count", lambda m, s: sum(x.get("count") or 0 for x in (m.get("reruns") or []))),
        ]:
            vals = [_fit(getter(meta[r], summ[r]), W - 1) for r in runs]
            print(f"{field:<30}" + cell(W, *vals))
        rerun_hits = [L[r] for r in runs if (meta[r].get("reruns") or [])]
        if rerun_hits:
            print(f"⚠️ {','.join(rerun_hits)} contains force-rerun: overwritten results are no longer in tasks.jsonl; "
                  "success rates may be inflated. Confirm the rerun reason (infrastructure failure vs unsatisfactory result) before comparing runs.")
        print("-" * (30 + W * len(runs)))
        print(f"Alignment: shared base-task intersection (after --exclude) = {len(kept)}; instances per run × iteration:")
        print(f"{'Instance count N':<30}" + cell(W, *[len(rows_f[r]) for r in runs]))
        # report dropped tasks
        union = set.union(*base_sets.values())
        dropped = sorted(union - set(kept))
        if dropped:
            print("Excluded/unmatched base tasks (reason):")
            for b in dropped:
                where = [L[r] for r in runs if b in base_sets[r]]
                why = "manual --exclude" if b in excluded else f"present in only {len(where)}/{len(runs)} runs ({','.join(where)})"
                print(f"   - {b:<32} {why}")
        # num_rubrics consistency (validity of Odysseys comparison)
        warn = []
        for b in kept:
            seen = set()
            for r in runs:
                vs = {x.get("num_rubrics") for x in data[r] if x["base_task_id"] == b}
                seen |= vs
            if len(seen) > 1:
                warn.append((b, sorted(v for v in seen if v is not None)))
        if warn:
            print("⚠️ Rubric dimensions differ across runs (Odysseys comparison is questionable; consider --exclude):")
            for b, vs in warn:
                print(f"   - {b}: num_rubrics={vs}")
        else:
            print("✓ num_rubrics matches across runs for every shared task (Odysseys is comparable)")
        # category relabel detection
        relabel = []
        for b in kept:
            cats = {}
            for r in runs:
                cs = {x.get("category") for x in data[r] if x["base_task_id"] == b}
                for c in cs:
                    cats.setdefault(c, []).append(L[r])
            if len(cats) > 1:
                relabel.append((b, cats))
        if relabel:
            print("⚠️ Category labels differ across runs (do not aggregate by category; use per-task comparison):")
            for b, cats in relabel:
                print(f"   - {b}: " + "; ".join(f"{c}={','.join(rs)}" for c, rs in cats.items()))
        print()

    # session stats cache
    sstats = {}
    if safe_parse is not None and (want("duration") or want("turns") or want("errors") or want("crosscheck")):
        for r in runs:
            for x in rows_f[r]:
                sf = x.get("session_file")
                if sf and sf not in sstats:
                    sstats[sf] = safe_parse(sf)

    # ---------------- AGGREGATE ----------------
    if want("aggregate"):
        print(head)
        print("-" * (30 + W * len(runs)))
        print("[OVERALL AGGREGATE]")
        succ = {r: sum(1 for x in rows_f[r] if x.get("verdict") is True) for r in runs}
        print(f"{'Successes verdict=true':<30}" + cell(W, *[succ[r] for r in runs]))
        print(f"{'Success rate':<30}" + cell(W, *[f"{succ[r]/len(rows_f[r])*100:.1f}%" if rows_f[r] else "-" for r in runs]))
        def avgscore(r):
            sc = [x["score"] for x in rows_f[r] if x.get("score") is not None]
            return st.mean(sc) if sc else float("nan")
        print(f"{'Average score':<30}" + cell(W, *[f"{avgscore(r):.4f}" for r in runs]))
        print()

    # ---------------- ODYSSEYS ----------------
    if want("odysseys"):
        print("[ODYSSEYS (PER-RUBRIC)]")
        for r in runs:
            pass
        passed = {r: sum(x.get("num_rubrics_passed") or 0 for x in rows_f[r]) for r in runs}
        total = {r: sum(x.get("num_rubrics") or 0 for x in rows_f[r]) for r in runs}
        macro = {}
        for r in runs:
            ratios = [(x.get("num_rubrics_passed") or 0) / x["num_rubrics"]
                      for x in rows_f[r] if x.get("num_rubrics")]
            macro[r] = st.mean(ratios) if ratios else float("nan")
        print(f"{'Rubric pass rate (micro)':<30}" + cell(W, *[f"{passed[r]/total[r]*100:.1f}%" if total[r] else "-" for r in runs]))
        print(f"{'Rubric pass rate (macro)':<30}" + cell(W, *[f"{macro[r]*100:.1f}%" for r in runs]))
        print(f"{'Passed/total rubrics':<30}" + cell(W, *[f"{passed[r]}/{total[r]}" for r in runs]))
        print()

    # ---------------- PER-RUBRIC ----------------
    if want("rubrics"):
        print("[PER-RUBRIC PASS RATE (judges/<task_id>_judge.json · metadata.rubric_scores)]")
        # tasks.jsonl only carries num_rubrics_passed, which cannot say WHICH
        # rubric failed. The per-task judge artifact can, and it exists in every
        # era of run (verified back to 2026-06-26); a run without it is legacy.
        jud = {r: load_judges(args.runs_dir, r) for r in runs}
        missing = [L[r] for r in runs if not jud[r]]
        if missing:
            print(f"   ⚠️ {','.join(missing)} has no judges/ artifacts (legacy run); skipping those columns in this section")
        if any(jud[r] for r in runs):
            jcols = []
            for r in runs:
                vals = [jud[r][x["task_id"]] for x in rows_f[r] if x["task_id"] in jud[r]]
                jcols.append(vals)
            for label, key in [("judge cost avg USD", "judge_cost_usd"),
                               ("judge turns avg", "judge_turns"),
                               ("judge images avg", "image_count")]:
                outc = []
                for vals in jcols:
                    nums = [v.get(key) for v in vals if isinstance(v.get(key), (int, float))]
                    outc.append(f"{st.mean(nums):.4f}" if key.endswith("usd") and nums
                                else (f"{st.mean(nums):.1f}" if nums else "-"))
                print(f"{label:<30}" + cell(W, *outc))
            for b in kept:
                rubric_ids = sorted({rid for r in runs for x in rows_f[r]
                                     if x["base_task_id"] == b and x["task_id"] in jud[r]
                                     for rid in (jud[r][x["task_id"]].get("rubric_scores") or {})})
                if not rubric_ids:
                    continue
                print(f"  {b}")
                for rid in rubric_ids:
                    cells = []
                    for r in runs:
                        scores = [(jud[r][x["task_id"]].get("rubric_scores") or {}).get(rid)
                                  for x in rows_f[r]
                                  if x["base_task_id"] == b and x["task_id"] in jud[r]]
                        scores = [s for s in scores if s is not None]
                        cells.append(f"{sum(1 for s in scores if s)}/{len(scores)}" if scores else "-")
                    print(f"    {rid:<26}" + cell(W, *cells))
        print()

    # ---------------- DURATION ----------------
    if want("duration"):
        print("[DURATION DISTRIBUTION (per-task wall time in seconds, started→ended)]")
        durs = {}
        for r in runs:
            ds = []
            for x in rows_f[r]:
                a, b = parse_ts(x.get("started_at", "")), parse_ts(x.get("ended_at", ""))
                if a and b:
                    ds.append((b - a).total_seconds())
            durs[r] = ds
        for label, fn in [("avg", lambda d: st.mean(d)), ("p50", lambda d: st.median(d)),
                          ("p90", lambda d: percentile(d, 90)), ("max", lambda d: max(d))]:
            print(f"{label:<30}" + cell(W, *[f"{fn(durs[r]):.1f}" if durs[r] else "-" for r in runs]))
        print()

    # ---------------- TURNS / TOOL / COST ----------------
    if want("turns") and safe_parse is not None:
        print("[TURNS / TOOLS / COST (SESSION PARSING)]")
        def col(fn):
            out = []
            for r in runs:
                vals = [fn(sstats[x["session_file"]]) for x in rows_f[r]
                        if x.get("session_file") and sstats.get(x["session_file"])]
                out.append(vals)
            return out
        turns = col(lambda s: s.num_turns)
        tcalls = col(lambda s: sum(s.tool_call_dist.values()))
        costs = col(lambda s: s.cost_usd)
        print(f"{'turns avg':<30}" + cell(W, *[f"{st.mean(v):.1f}" if v else "-" for v in turns]))
        print(f"{'turns p50':<30}" + cell(W, *[f"{st.median(v):.0f}" if v else "-" for v in turns]))
        print(f"{'turns max':<30}" + cell(W, *[f"{max(v):.0f}" if v else "-" for v in turns]))
        print(f"{'tool calls avg/task':<30}" + cell(W, *[f"{st.mean(v):.1f}" if v else "-" for v in tcalls]))
        print(f"{'cost avg/task USD':<30}" + cell(W, *[f"{st.mean(v):.4f}" if v else "-" for v in costs]))
        print(f"{'cost total USD':<30}" + cell(W, *[f"{sum(v):.2f}" if v else "-" for v in costs]))
        print()

    # ---------------- ERRORS ----------------
    if want("errors"):
        print("[ERRORS / EXCEPTIONS]")
        def cnt(field):
            return [sum(1 for x in rows_f[r] if x.get(field)) for r in runs]
        print(f"{'task error':<30}" + cell(W, *cnt("error")))
        print(f"{'judge error':<30}" + cell(W, *cnt("judge_error")))
        print(f"{'captcha':<30}" + cell(W, *cnt("reached_captcha")))
        print(f"{'impossible':<30}" + cell(W, *cnt("impossible_task")))
        if safe_parse is not None:
            tf = []
            for r in runs:
                tf.append(sum(sstats[x["session_file"]].tool_failures for x in rows_f[r]
                              if x.get("session_file") and sstats.get(x["session_file"])))
            print(f"{'tool_failures(session)':<30}" + cell(W, *tf))
        print()

    # ---------------- PER-TASK SUCCESS ----------------
    if want("pertask"):
        print("[PER-TASK SUCCESS RATE (n/iteration, stable comparison unit)]")
        print(f"{'base_task':<30}" + cell(W, *[L[r] for r in runs]))
        for b in kept:
            cells = []
            for r in runs:
                v = [x for x in rows_f[r] if x["base_task_id"] == b]
                p = sum(1 for x in v if x.get("verdict") is True)
                cells.append(f"{p}/{len(v)}" if v else "-")
            print(f"{b:<30}" + cell(W, *cells))
        print()

    # ---------------- HELPERS ----------------
    if want("helpers"):
        print("[HELPER DISTRIBUTION + DOM SHARE (merge legacy bare names with page/locator chains; exclude agent-defined functions)]")
        bybucket = {r: Counter() for r in runs}
        byhelper = {r: Counter() for r in runs}
        unknown = {r: Counter() for r in runs}
        ninv = {r: 0 for r in runs}
        nhit = {r: 0 for r in runs}
        for r in runs:
            for x in rows_f[r]:
                sf = x.get("session_file")
                if not sf:
                    continue
                try:
                    fh = open(sf)
                except Exception:
                    continue
                with fh:
                    for line in fh:
                        if "wiek-browser" not in line:
                            continue
                        try:
                            e = json.loads(line)
                        except Exception:
                            continue
                        if e.get("type") != "message":
                            continue
                        m = e.get("message", {})
                        if m.get("role") != "assistant":
                            continue
                        for c in (m.get("content") or []):
                            if not (isinstance(c, dict) and c.get("type") == "toolCall" and c.get("name") == "bash"):
                                continue
                            cmd = (c.get("arguments") or {}).get("command", "")
                            if "wiek-browser" not in cmd:
                                continue
                            ninv[r] += 1
                            hit = 0
                            for canon in iter_helper_calls(cmd):
                                bkt = BUCKET.get(canon)
                                if bkt is None:
                                    unknown[r][canon] += 1
                                    continue
                                bybucket[r][bkt] += 1
                                byhelper[r][canon] += 1
                                hit += 1
                            nhit[r] += 1 if hit else 0
        for b in BUCKET_ORDER:
            print(f"{BUCKET_LABEL[b]:<30}" + cell(W, *[bybucket[r].get(b, 0) for r in runs]))
        print(f"{'wiek-browser command bodies':<30}" + cell(W, *[ninv[r] for r in runs]))
        print("- Interaction share (denominator=DOM perception+reads+actions+visual+JS; excludes navigation):")
        for label, keys in [("  DOM method %", ("P-dom", "R-dom", "A-dom")),
                            ("  Visual %", ("V-visual",)),
                            ("  JS evaluation %", ("J-eval",))]:
            outc = []
            for r in runs:
                c = bybucket[r]
                d = sum(c.get(k, 0) for k in ("P-dom", "R-dom", "A-dom", "V-visual", "J-eval"))
                outc.append(f"{sum(c.get(k, 0) for k in keys)/d*100:.0f}%" if d else "-")
            print(f"{label:<30}" + cell(W, *outc))
        # Taxonomy staleness guard: wiek-lite renamed its whole API surface on
        # 2026-07-17..21 and the old scanner silently read every modern run as
        # all-zero. A run whose command bodies mostly yield nothing is the tell.
        stale = [L[r] for r in runs if ninv[r] >= 20 and nhit[r] / ninv[r] < 0.5]
        if stale:
            print(f"⚠️ {','.join(stale)}: more than half of command bodies contain no parsed built-in—the taxonomy may lag wiek-lite. "
                  "Check the capability list in wiek-lite skills/wiek-browser/SKILL.md before reporting metrics.")
        rev = {}
        for old, cn in LEGACY_ALIAS.items():
            if old != cn.split(".")[-1]:
                rev.setdefault(cn, []).append(old)
        print("- Helper details (canonical · legacy old names):")
        allh = sorted(set().union(*[set(byhelper[r]) for r in runs]),
                      key=lambda h: -sum(byhelper[r].get(h, 0) for r in runs))
        for h in allh:
            if sum(byhelper[r].get(h, 0) for r in runs) < 3:
                continue
            old = ",".join(rev.get(h, [])) or "same name"
            print(f"  {f'{h} ({old})'[:28]:<28}" + cell(W, *[byhelper[r].get(h, 0) for r in runs]))
        unk = sorted(set().union(*[set(unknown[r]) for r in runs]),
                     key=lambda h: -sum(unknown[r].get(h, 0) for r in runs))[:6]
        if unk:
            print("- Unclassified facade calls (candidate taxonomy gaps):")
            for h in unk:
                print(f"  {h[:28]:<28}" + cell(W, *[unknown[r].get(h, 0) for r in runs]))
        print()

    # ---------------- CROSS-CHECK vs summary.json ----------------
    if want("crosscheck"):
        print("[CROSS-CHECK: full unfiltered JSONL recalculation vs official summary.json]")
        for r in runs:
            allrows = data[r]
            sc = sum(1 for x in allrows if x.get("verdict") is True)
            scores = [x["score"] for x in allrows if x.get("score") is not None]
            avg = st.mean(scores) if scores else float("nan")
            s = summ[r]
            ok = (sc == s.get("success_tasks")) and (abs(avg - (s.get("average_score") or -1)) < 0.001)
            print(f"  {L[r]:<12} mine={sc}/{len(allrows)} {avg:.4f}  "
                  f"summary={s.get('success_tasks')}/{s.get('total_tasks')} {s.get('average_score')}  "
                  f"{'✓' if ok else '✗ mismatch (inspect rejudge/fields)'}")
        print()


if __name__ == "__main__":
    main()
