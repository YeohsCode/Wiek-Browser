# wiek-browser Helper Taxonomy & Rename Mapping

Use this reference for helper-distribution and DOM-share statistics in `runs_compare.py`.
`LEGACY_ALIAS` / `BUCKET` in the script are the executable source of truth; this file explains the
conventions and maintenance process. Keep both synchronized.

> **Canonical naming**: Since 2026-07-25, canonical names always use `<receiver>.<method>`
> (`page.snapshot`, `locator.click`, `taskSpaces.useOrCreate`). Merge legacy bare names through
> `LEGACY_ALIAS`. The old mapping tables in §1/§1.5 remain valid; only their right-hand columns now
> use qualified names.

## 1. Old→New Rename Mapping (2026-06-29 Playwright Alignment)

wiek-lite commit `546bd84 align helper API to Playwright naming and units` (plus `8e3ec39` /
`4d0b1f6`, all from 2026-06-29) changed both names and units (timeout seconds→milliseconds). Runs
before 6/29 use old names and later runs use new names. Before comparing helper statistics across
runs, merge them into canonical names:

| Operation | Old name (≤6/29) | Canonical (new name) | Bucket |
|---|---|---|---|
| In-page JS | `js` | `evaluate` | JS evaluation |
| Fill form | `fillInput` | `fill` | DOM action |
| Navigate page | `gotoAndWait` / `navigate` | `goto` | Navigation |
| Fixed wait | `wait` / `sleep` | `waitForTimeout` | Navigation |
| Wait for load | `waitForLoad` | `waitForLoadState` | Navigation |
| Press key | `pressKey` | `press` | DOM action |
| Scroll | `scrollBy` | `wheel` | Visual |
| Type text | `typeText` | `insertText` | DOM action |
| Screenshot | `captureScreenshot` | `screenshot` (signature changed to `{path,fullPage}`) | Visual |
| Check | `setChecked` | `check` | DOM action |
| Log | `cliLog` | `console.log` (collides with a JS built-in; intentionally not tracked, see §1.6) | — |

**Unchanged (stable)**: `click` `dblclick` `hover` `drag` `pageInfo`
`openOrReuseTab` `switchTab` `listTabs` `useOrCreateTaskSpace` `completeTaskSpace`
`cdp` `browserFetch` `serverFetch` `setInputFiles` `selectOption` `focus`
`scrollIntoViewIfNeeded` `waitForNetworkIdle` `help`.

## 1.5 Snapshot Helper Renaming (2026-06-30 Collapse)

wiek-lite commit `1beb04c refactor(wiek-browser): collapse snapshot helpers to snapshot +
snapshotRaw` (2026-06-30 17:44 +0800) narrowed three snapshot helpers to two and reused the bare
name `snapshot`, creating a time-dependent ambiguity with usage before 6/29:

| Operation | Old name ≤6/30 | New name >6/30 | Canonical | Bucket |
|---|---|---|---|---|
| Text observation (agent-friendly, primary) | `snapshotText` | `snapshot` | `snapshot` | P-dom |
| Structured observation (with refs, for refreshing the ref map) | `snapshot` (old bare name, historical use ≈0) | `snapshotRaw` | `snapshotRaw` | P-dom |

**This caused a real misclassification** (found while comparing the 0704 run on 2026-07-04):
`ALIAS`/`BUCKET` in `runs_compare.py` recognized only the old name `snapshotText`. In the 0704 run
(which used the new `snapshot`), the helper was classified 100% as "unrecognized = agent-defined
function" and discarded. The DOM-perception bucket fell to 0, the DOM share falsely collapsed from
71% in 0630 to 29%, and JS evaluation falsely surged to 64%. A heuristic check showed
`snapshotText(` 656 times and bare `snapshot(` 0 times in the 0630 run; the 0704 run had the
reverse: `snapshotText(`=0, `snapshot(`=1073, `snapshotRaw(`=0. After wiek-lite commit `1beb04c`
confirmed a rename rather than a capability regression, the mapping was fixed in `ALIAS`
(`snapshotText`→`snapshot`) and `BUCKET` (both `snapshot`/`snapshotRaw` count as P-dom). After the
fix, the 0704 DOM share is 51% (JS 44%)—a real but modest shift, not a paradigm reversal.

### How to update the taxonomy for a new rename

First read the current capability list in the wiek-lite skill (`skills/wiek-browser/SKILL.md` §3.1);
it is the source of truth for the API surface. Then inspect the rename commit:

```bash
cd <your wiek-lite checkout>
git log --oneline --all | grep -iE 'helper.*rename|Playwright.*align|rename.*helper|align.*runtime'
git show <commit> | grep -E '^[-+].*(await |function )'   # inspect -old-name +new-name pairs
```

Then update this table together with `LEGACY_ALIAS` (old bare name→qualified canonical name) and
`BUCKET` in `scripts/runs_compare.py`. If a new method appears in the report's "Unclassified facade
calls," add it to `BUCKET`.

### Heuristic fallback (detect renames without a commit)

Extract all `(?<![.\w])NAME\(` call names from command bodies in each run. Compare the "present in
old run, absent in new run" and "present in new run, absent in old run" sets. Complementary pairs
with similar call volumes—one dropping to 0 while the other rises from 0—are almost certainly
renames.

## 1.6 cliLog→console.log Rename: Intentionally Not Tracked (≥2026-06-30)

The wiek-lite Playwright-style migration renamed the logging helper `cliLog` to `console.log`.
Unlike the renames in §1/§1.5, this one is intentionally not merged into the taxonomy; leave both
ALIAS and BUCKET unchanged, for three reasons:

1. **It collides with a JS built-in and cannot be distinguished.** The new name `console.log` has
   the same form as the standard JS built-in, which agents use heavily for debugging inside
   `evaluate()` scripts. The 0704 run contains 2,229 occurrences of `console.log(`, most of which
   are agent debug logs rather than wiek-browser logging helper calls. The tokens are identical and
   cannot be separated.
2. **It is in the nav bucket, outside the DOM-share denominator.** Even if it could be separated,
   tracking it would add no value to the only helper conclusion, DOM share.
3. **Mapping it would create false positives.** Adding `console.log→nav` would miscount thousands
   of inline agent debug statements as helpers and flood the nav bucket, producing a worse
   distortion than not tracking them.

Therefore, keep `cliLog` in `BUCKET` only for reverse-calculating old runs ≤0615b that used the old
name `cliLog`.

**Two consequences to remember** (measured `cliLog(`/`console.log(`: 0630=0/1206,
0704=0/2229, proving the rename was already live in 0630 with wiek_sha 3fe9757a):

- A **cliLog count of 0 in runs ≥0630 is expected**, not evidence that "the agent stopped logging."
- **Absolute nav counts are underestimated across the 0630 boundary** (about 1,200–2,200
  console.log calls are invisible to the script). Together with the effect of the persistent REPL
  on command-body parsing, only interaction shares—not absolute helper counts—are comparable
  across the 0630 boundary.

## 1.7 Namespacing + Playwright Chaining (2026-07-17…21, the Largest Break)

wiek-lite replaced the entire API surface with facades and chained locators (wiek-lite
`skills/wiek-browser/SKILL.md` §3.1 is the current source of truth). All bare functions disappeared:

| Old form (≤0716) | New form (≥0721) |
|---|---|
| `useOrCreateTaskSpace('x')` | `taskSpaces.useOrCreate('x')` |
| `snapshotText()` / `js(...)` | `page.snapshot()` / `page.evaluate(...)` |
| `click('@3')` / `fillInput(sel, v)` | `page.locator(sel).click()` / `.fill(v)` |
| `openOrReuseTab(url)` / `listTabs()` | `browser.openOrReuseTab(url)` / `browser.listTabs()` |
| `serverFetch` / `browserFetch` | `fetch.server` / `fetch.browser` |
| `pageInfo()` | `page.info()` |
| `cliLog` | `console.log` (as in §1.6, still not tracked) |

**This caused one complete failure** (found during a 2026-07-25 retrospective). The old scanner
used `(?<![.\w])NAME\(`. Its negative lookbehind was meant to exclude in-page DOM calls such as
`el.click()`, but every call in the new API has the `.method(` form. It counted only 1 helper
across 686 command bodies, and the report read "DOM 100% / visual 0% / JS 0%." The measured
transition point: the 0716 run used only old names (0 `taskSpaces.useOrCreate`, 456
`useOrCreateTaskSpace`), while runs from 0721 onward used only new names, with wiek_sha
`b8b0f3ea → cc0f5415`.

The current scanner is **receiver-aware**: it recognizes only the `page` / `browser` /
`taskSpaces` / `fetch` facade roots, bare `cdp(`, and variables bound to locators. It consumes
filter-only chain stages such as `locator/getByRole/first/nth/filter`, then records the first real
action. Two implementation constraints must be remembered:

1. **Track locator variables.** In measured 0724/0725 runs, **59% (893/1521)** of element actions
   have forms such as `rows.nth(1).click()` after `const rows = page.locator('tr')`. Matching only
   `page.locator(...).click()` misses more than half and cuts the DOM-action count by more than
   half. When an assignment chain ends in an action
   (`const cells = await page.locator(x).allInnerTexts()`), it binds data rather than a locator and
   must not be registered as a locator variable; otherwise, later `cells.slice(...)` calls are
   miscounted as helpers.
2. **Gate legacy bare-name scanning per command body.** An agent uses only one API style within a
   command body, so skip bare-name scanning as soon as a facade root appears. Bare `check(` /
   `type(` calls in new-style command bodies are agent-defined functions, not built-ins.
3. **Map canonical bare names to themselves.** Runs after the 0629 rename but before 0721
   namespacing (0704/0706) directly call bare `evaluate(`, up to 588 times in one run.
   `LEGACY_ALIAS` needs both `js → page.evaluate` and `evaluate → page.evaluate`; without the
   latter, an entire JS path is counted as 0.

The old and new conventions have been cross-checked: the same legacy runs (0704+0716) produce
byte-for-byte identical output from the old and new scripts
(P447/A451/V132/J316/nav926 and P198/A360/V31/J267/nav1578).

## 2. Interaction Bucket Definitions (DOM-Share Convention)

| Bucket | Meaning | Members (canonical) |
|---|---|---|
| `P-dom` | DOM perception | `page.snapshot` (old bare name `snapshotText`) `page.snapshotRaw` |
| `R-dom` | **DOM reads** (exists only ≥0721) | `locator.innerText/textContent/inputValue/getAttribute/isChecked/isVisible/isEnabled/count/allInnerTexts/allTextContents/all/boundingBox` |
| `A-dom` | DOM actions (ref/selector) | `locator.click/dblclick/hover/drag(To)` (non-coordinate) `.fill` `.press` `.insertText` `.type` `.clear` `.setInputFiles` `.selectOption` `.check/uncheck/setChecked` `.focus/blur` `.scrollIntoViewIfNeeded` `.dispatchEvent` `page.keyboard` |
| `V-visual` | Visual | `page.screenshot` `locator.screenshot` `page.mouse` (including old `wheel/scrollBy` and coordinate click) `elementCenter` |
| `J-eval` | In-page JS | `page.evaluate` (old bare name `js`) `locator.evaluate/evaluateAll` `cdp` |
| `nav` | Navigation/lifecycle plumbing (excluded from share denominator) | `page.goto/reload/url/title/info/setDefaultTimeout/waitFor*/drainEvents/screencast` `locator.waitFor` `browser.*` `taskSpaces.*` `fetch.server/browser` `cli.log` (only ≤0615b, see §1.6) `cli.help` |

**DOM share = (P-dom + R-dom + A-dom) / (P-dom + R-dom + A-dom + V-visual + J-eval)**.
Exclude nav from the denominator. `R-dom` is always 0 for old runs, so this change does not affect
historical numbers.

`R-dom` is a new path introduced by the 0721 API. Previously, page data could be read only through
`js(() => ...)`; it can now be read directly with `locator.innerText()/count()/inputValue()`.
Without this bucket, new runs appear to have "lower DOM perception and continued high JS
dependence" when only the read method changed. Measured shares across three generations: JS
50% (0626) → 31% (0716) → 23% (0724) → 16% (0725), while R-dom rose from 0 to 25%.

The old bare names `click/dblclick/hover/drag` have two forms: arguments `[x,y]` / `{x:..}` indicate
visual coordinates, while `@N`/CSS/`{selector}` indicate DOM. `classify_click()` classifies them
from the first argument character. The new API has no such ambiguity: coordinate operations use
`page.mouse.*`, while a locator chain is always DOM.

## 3. Excluding Agent-Defined Functions

Models define inline functions in heredocs
(`setVal/parseNum/fmtPct/walk/deepAll/findControl/findRow/collect/getMarketCap`…). These are not
wiek-browser built-ins and must not count toward helper statistics. Use two gates:

1. **Receiver awareness** (§1.7): only chains beginning from a facade root or locator variable enter
   classification. This naturally excludes `el.click()` / `node.querySelectorAll()` inside
   `page.evaluate` because their receivers are in-page DOM nodes, not locators.
2. **`BUCKET` allowlist**: a parsed canonical name absent from the table does not count, but it is
   summarized at the end of the report under **"Unclassified facade calls."** This section probes
   taxonomy drift: a new wiek-lite method appears here immediately (the first deployment detected
   `locator.setChecked` 11 times and `locator.elementCenter` 4 times).

The script also includes a **failure self-check**: if more than half of a run's command bodies
contain no parsed built-in, it emits a warning. This turns the §1.7 failure mode—an entire API
generation changed while the report silently fell to zero—into an explicit failure.

## 4. Verified Conclusion (RWB, 9 Shared Tasks, This Method)

Across five runs (0613/0615a/0615b/0630/0704), the interaction paradigm remained a hybrid of
**primarily DOM semantics with in-page JS as support**: DOM 60→61→60→71→51%, JS
36→35→36→27→44%, visual ≤6%. The 0630 run shifted modestly toward DOM, and 0704 shifted back
toward JS; neither was a paradigm reversal. The original 0704 reading falsely appeared to collapse
to 29%/64% because the rename in §1.5 was missed; after the fix, it is 51%/44%. See memory
`[[wiek-browser-helper-rename-0629]]`.
