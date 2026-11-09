# The gate: testing a candidate with wiek-browser

A task is not real until wiek-browser has executed it. This file is how you run that probe and
read its result. (For full wiek-browser helper docs, use the `wiek-browser` skill; here we focus
on *testing a candidate task*.)

Run everything via `wiek-browser nodejs <<'EOF' ... EOF` heredoc. Reuse ONE task space across
rounds (`taskSpaces.useOrCreate`), and close it at the end (`taskSpaces.complete(id, { keep:false })`).
**Probes are sequential — one shared real browser. Never run two wiek-browser probes in parallel**
(they fight over focus / task spaces, and a captcha needs a human handoff). When research wants
breadth, parallelize the *web-search* lanes in a Workflow, but keep every browser probe here.

## What you must confirm before writing the task

1. **Reachable, no risk-control block the run can't get past** on the start page. An automated
   hard wall (Cloudflare / DataDome / PerimeterX) → drop. A human-verification / captcha is the
   one carve-out (hand off once; usable only if it then stays cleared — see the captcha bullet).
2. **Every interaction the task needs** (search, each filter, sort, pagination, form fields,
   cross-site navigation, doc write) actually works.
3. **The target data is extractable** (you can read the exact numbers/fields the rubric checks).
4. **Concrete values + trajectory** captured — you'll calibrate rubrics and the `note` to these.

If 1 fails (hard wall, or a captcha that recurs after the handoff) → drop the site. If 2/3 fails
→ redesign or drop. Don't "hope it works in the run."

## Risk-control signals (the block list)

| signal | how it shows up | verdict |
|---|---|---|
| Cloudflare challenge | title/body `Just a moment…`, `Performing security verification`, `Ray ID`; doesn't clear after ~10s | **hard block — drop** |
| DataDome | URL gains `?dd_referrer=…`; `document.body` briefly null; may show a captcha | **risky — usually drop** (it auto-cleared once for Etsy search but forced login at checkout) |
| PerimeterX / HUMAN | `#px-captcha`, `_px` cookies, "Press & Hold" | **hard block — drop** |
| generic captcha | iframe `src*=captcha` / `recaptcha` / `captcha-delivery` | hand off to user once; if it recurs after the solve → **skip** (OK if it clears itself) |
| login wall | "log in to continue", "sign up to continue", a login form gating content | drop, or pick a logged-out entry point (e.g. `old.reddit.com`) |
| JS challenge (benign) | URL gains `js_challenge=1&solution=…&token=…` **but content still renders** | **OK** — real Chromium solved it; verify content loaded |

Detection probe (defensive against null body; tune the keywords per site):

```bash
wiek-browser nodejs <<'EOF'
const task = await taskSpaces.useOrCreate('probe <site>')
await browser.openOrReuseTab('https://<start-url>', { wait: true, timeout: 35000 })
await page.waitForTimeout(3000)
const info = await page.info()
console.log('url: ' + info.url + ' | title: ' + JSON.stringify(info.title))
const r = await page.evaluate(() => {
  const body = document.body
  const txt = body ? (body.innerText || '') : '(no body)'
  const t = document.title + ' ' + txt
  return {
    cloudflare: /just a moment|performing security verification|attention required/i.test(t),
    datadome: /datadome|dd_referrer|captcha-delivery/i.test(document.documentElement.innerHTML),
    perimeterx: !!document.querySelector('#px-captcha, [class*="px-captcha" i]'),
    captchaFrame: !!document.querySelector('iframe[src*="captcha"], iframe[src*="recaptcha"]'),
    loginWall: /log in to continue|sign up to continue|you must log in/i.test(txt),
    jsChallengeSolved: /js_challenge|solution=/i.test(location.href),
    head: txt.slice(0, 200),
  }
})
console.log('SIGNALS: ' + JSON.stringify(r, null, 2))
EOF
```

Cloudflare/JS-challenge sometimes auto-clears — if the first read looks like a challenge, `page.waitForTimeout(8000)`
and re-read the SAME tab once before deciding. If it's still challenging, it's a hard block.

> Caution on false positives: a naive `/blocked|captcha/` regex matches ordinary page text (a
> post titled "…blocked…", an "ad blocker" notice). Trust the **specific** signatures above and
> the fact that real content rendered (e.g. N result rows present), not loose keyword hits.

## Then drive the real interactions + extract

After reachability, run the task's actual steps and read back the data. Prefer the **semantic /
DOM** path (`page.snapshot()`, `page.evaluate(...)` / locator reads) for normal pages — it gives you exact values for
the rubric. Examples of "confirm the interaction landed":

- A filter applied → the URL path/query or filter chips changed AND the result count dropped.
- A sort applied → list order matches; control shows the sort state.
- Extraction works → you can pull the precise fields (score, price, %change, Metascore…) the
  rubric will check, with correct units / thousands separators.

## Special cases worth knowing (battle-tested)

- **React-controlled inputs** (e.g. Bankrate): setting `.value` won't update React state. Use the
  native setter + dispatch `input`+`change`:
  ```js
  const set = (el,v)=>{const p=el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(p,'value').set.call(el,v);
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));}
  ```
  React field ids are often unstable (`:r0:`) — target by the `<label for>` text, not the id.

- **Path-parameterized filters** (e.g. Metacritic `/browse/game/{platform}/{genre}/{window}/{sort}/`):
  the URL itself encodes the filter — easy to apply and easy for the rubric to verify. Watch for
  filters that are NOT URL-addressable (Metacritic's RELEASE YEAR is a two-handle drag slider —
  can't be set precisely, so don't build a task that requires an exact year range from it).

- **Cross-origin sandboxed editors** (CryptPad Sheets / OnlyOffice, Google Docs, Notion): the
  editing surface is a cross-origin iframe — you cannot read or fill it via DOM. Use the **visual
  workflow**: `page.mouse.click(x, y)` a cell, `page.keyboard.type`, `page.keyboard.press('Enter')`/`Tab`. Proof the editor is
  live by the page URL upgrading to a real doc id (CryptPad: `cryptpad.fr/sheet/#/2/sheet/edit/<hash>/`).
  Note: `page.screenshot()` may CDP-timeout on these continuously-rendering pages — that's a
  screenshot-tooling limit, not a task block; verify via URL/title/state instead.

- **Human-verification / captcha**: if a real captcha appears, `await taskSpaces.handOff(task.id)`,
  tell the user exactly what to solve, and resume only after they confirm — **one** human solve.
  If it then clears and does **not** reappear on repeated probing, treat it as a *one-time trust
  gate* (not a per-request wall) and the site is usable. If the SAME site re-challenges **after**
  that solve, **skip the site**: a site that demands a human captcha on every entry can't be driven
  by the agent at run time. (Caveat: how durably a single solve carries into a benchmark *run* is
  **browser-tool-specific**, not guaranteed, because each tool has its own session model. Recurrence
  on probing is therefore a best-effort signal, not a cross-tool promise.)

## Interaction realities on modern JS sites (these cost probe rounds if you don't expect them)

- **Node scope vs page scope.** Code in the heredoc body runs in Node; code inside `page.evaluate(...)` runs
  in the browser page. Don't reference Node variables (e.g. `info.url` from `page.info()`) inside a
  `page.evaluate()` closure — it throws `ReferenceError`. Use page globals there (`location.href`, `document`,
  `window`); compute Node-side signals in the heredoc body and merge after the `page.evaluate()` call.
- **Persisted-but-reset filters.** Stateful sites (localStorage-backed screeners/filters) can keep
  a filter *chip* visible across a `browser.openOrReuseTab` reload while silently resetting its *value* to
  "Any" — so the page looks filtered but the result count is back to the full set. Don't trust the
  chip; **re-read the result count** to confirm the filter is actually live before extracting.
- **Click-to-sort is toggle state, not deterministic.** One click on a column header may land
  *ascending*; you may need a second click to reach descending. Verify direction by the **data**
  (top value ≥ next) and re-click if wrong — don't assume one click = the direction you wanted.
- **No `<select>`; custom menus.** Many modern sites use `[role=menu]` / listbox with
  `<button>`/checkbox rows instead of native `<select>`. Read the menu rows and match an option;
  beware that the same label can appear both as an add-list option AND as an active-filter chip, so
  exact-`innerText` matching can hit the wrong one (scope your query to the open menu).

## Cleanup

End the probe with its own round: `await taskSpaces.useOrCreate(id); await taskSpaces.complete(id, { keep:false })`.

## Known site bot-friendliness (extend this as you test; mirror into the memory)

**Friendly — no risk-control block via wiek-browser (real Chromium, inherits user session):**
- `old.reddit.com` search/listings (`restrict_sr`/`sort`/`t` filters; www.reddit.com throws a JS
  challenge that auto-solves but shows login popups — prefer old.reddit.com as start URL)
- `github.com` (trending, advanced search; path/query filters)
- `bankrate.com` calculators (React forms)
- `boxofficemojo.com` (deterministic year charts)
- `en.wikipedia.org` (infobox — the most reliable cross-site anchor; never risk-controlled)
- `metacritic.com/browse` (path-based platform/genre/sort filters)
- `stockanalysis.com/screener` (reachable; "Add Filters" is a search-box flow; `%Change` shows
  `-` when market closed → don't build an average-%change computation on it)
- `rottentomatoes.com` browse (reachable; scores are %, list order not great for exact top-N)

**Hostile — blocked in real probes (do NOT use):**
- `producthunt.com` → Cloudflare "Just a moment" hard wall, won't clear
- `etsy.com` → DataDome + forced login at checkout (form-stop can't reach the address step logged-out)

**Reputation caution (verify with a probe — these vary):** Zillow / Realtor (PerimeterX),
Walmart / Best Buy (frequent blocks), most travel sites (Expedia/Booking/Kayak — heavy), Indeed
(Cloudflare), Glassdoor / Crunchbase (login wall). The existing dataset already covers Expedia &
Yelp with a "可能被风控，人工过验证" note — that's the fallback if a chosen site is borderline.
