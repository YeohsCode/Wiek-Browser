---
name: wiek-bench-judge
description: Verify a tested web agent's real behavior from its recorded Pi or Codex session and selected screenshots before scoring. The judge prompt provides absolute artifact paths; use targeted queries to compare actual outputs, errors, and the final answer with the recorded behavior, then return only the verdict JSON. Only for wiek-bench judging—never to drive a browser or rerun the agent.
---

# wiek-bench Judge — session & screenshot verification

You are a JUDGE running in agent mode. The summarized command list in the prompt has the
command names but NOT their real outputs — your job is to verify against ground truth (the
recorded session + screenshots) before deciding, then output ONLY the verdict JSON.

## Hard rules (read first)

1. **Read-only.** Do NOT launch a browser, re-run the agent, edit/write any file, or modify
   anything under `runs/`. You only inspect already-recorded artifacts.
2. **Use the injected absolute paths verbatim.** The judge prompt's `<investigation>` block
   gives you `session_file` (the agent's full Pi or Codex session JSONL), `screenshots_dir`, and (when
   the run has one) the `frames/manifest.jsonl` command↔screenshot map. Read those exact paths.
   Do NOT scan directories, guess filenames, or search for the session — the path is already known.
3. **The agent's action history and final answer are NOT in the prompt.** In agent mode they
   are deliberately left out so you ground the verdict in the recorded session, not the agent's
   self-report. The final answer is the LAST assistant text in `session_file` (also surfaced as
   `summary`'s `last_assistant_text`).
4. **Investigate, then stop.** Run the few targeted queries you need, reach a conclusion,
   then stop calling tools and emit ONLY the JSON specified by the prompt's `<response_format>`.
   Do not keep digging after you can answer.
5. **Ground every claim.** Base the verdict on what the session/screenshots actually show
   (toolResult output, `isError`, the open page in a screenshot) — not on the agent's own
   self-description in its final answer.
6. **Derived fields are claims.** Treat tested-agent-derived fields such as `isReply`,
   `replying`, `isPinned`, `qualifies`, and filtered rows as claims, not raw ground truth. If
   they were derived from whole `innerText` / descendant aggregate text, or conflict with raw
   screenshot, DOM, or AX evidence, verify the outer target node separately from nested
   quoted/embedded scopes. A `Replying to @` marker inside a nested quoted/embedded post does
   not propagate to the outer quote main post. The derived field or conflict alone cannot prove
   failure: continue to independent raw evidence, decide the verdict from that evidence, and use
   low `confidence` when the response schema requests it and evidence remains insufficient.

## One-shot recipes (prefer these over step-by-step probing)

`SESSION` = the injected `session_file` absolute path; `PROBE` = the injected helper-script
absolute path (both are printed in the judge prompt's `<investigation>` block). The probe is
pure-stdlib, so `python3 "$PROBE" ...` runs anywhere. **Always invoke it by that absolute
path — your cwd is the pi workspace, NOT the skill dir, so a relative `scripts/probe.py` will
not resolve.**

- **See every command's REAL output** (the part dropped from the prompt's command list):
  `python3 "$PROBE" calls "$SESSION" --name bash`
  Add `--full` for untruncated output, `--errors-only` to see just the failures.
- **List only the failures** (commands whose toolResult `isError` is true):
  `python3 "$PROBE" errors "$SESSION"`
- **Get a one-line picture** (turns, tool distribution, error count, last assistant text):
  `python3 "$PROBE" summary "$SESSION"`
- **Keyword trace** (did it ever reach a URL / hit a captcha / fabricate a value):
  `grep -n "<keyword>" "$SESSION"`  — then `read` that region of `$SESSION` for context.
- **Read the raw transcript** when you want the model's thinking + text inline:
  `read "$SESSION"` (pi's read paginates large files; jump with offset/grep first).
- **Map a command to its screenshot / AX tree (or vice-versa)** — `frames/manifest.jsonl` is plain
  JSONL, one line per capture in time order; no probe subcommand exists for it because `read` /
  `grep` are enough. Each line is `{"command", "sha256", "frame", "new", "tree_sha256", "tree",
  "tree_new", "captured_at"}`; the frame (and the same-capture AX tree named in `tree`) is captured
  right AFTER its command, so it shows that command's resulting page.
  - which command produced a frame: `grep -n '"frame": *"007.webp"' "<manifest>"`
  - the unique frames in order (skip duplicate page states): `grep '"new": *true' "<manifest>"`
  - then `read "<screenshots_dir>/<frame>"` to inspect that image.
- **Confirm a visual detail** (small text, error dialog, the actually-open page/tab):
  `read "<screenshots_dir>/<file>.webp"` — the attached thumbnails are downscaled; read the
  original when a thumbnail is too small to be sure.
- **Cross-check a text detail against the accessibility tree** — a SECOND evidence source that
  corroborates the screenshot, never replaces it. Use it when a screenshot alone can't settle a
  link's href, an aria-label, a role, a selected/expanded state, or a form value. Each manifest
  line's `tree` field points at that command's `frames/trees/NNN.json` — a slimmed getFullAXTree
  (schema v2 drops raw CDP ids/pointers, flattens AXValues, and keeps role/name/value/properties
  plus `parent_index`; old schema v1 has no hierarchy). It is plain text and NOT capped by
  `max_screenshots`. Query it with the probe:
  - summary (node count + role histogram): `python3 "$PROBE" axtree "<screenshots_dir>/trees/003.json"`
  - literal OR: repeat `--grep`, for example `--grep "Replying to" --grep "Listen up"`.
  - regex: add `--regex`; a literal `--grep` containing `|` is rejected so regex intent cannot
    silently return no matches.
  - properties: add `--properties` to search/show href/checked/selected/expanded/disabled.
  - scope: add `--show-ancestors` on schema v2 to print the matched node's ancestor chain and
    distinguish an outer article from nested quoted/embedded content. Schema v1 says hierarchy
    is unavailable instead of inventing it.

You rarely even need the script: `read` + `grep` over the injected absolute `session_file`
(and `frames/manifest.jsonl`) already answer most questions.

## What to actually check (typical judging questions)

- Did the command the agent claims it ran actually succeed, or did its toolResult carry
  `isError` / an exception / a 4xx-5xx / "Access Denied" / a captcha wall?
- Does the agent's final answer match the values visible in the session output and the
  screenshots, or did it fabricate / approximate / answer a different question?
- For filter/sort/form requirements: was the action actually applied and confirmed (visible
  in a later screenshot or toolResult), not merely attempted?
- Was the agent blocked (captcha, login wall, page-load failure) such that the requirement
  could not be satisfied?
- For "is it still open / was it created" requirements, the LAST `listTabs` / `pageInfo` `toolResult` in the session is the authoritative end-state — read it directly and decide on it.
- When the rubric names a specific entity (a particular restaurant / product / service / page), verify the page the agent used is that EXACT entity — check the name plus a disambiguating field (address / URL / location) in the `toolResult` / `pageInfo`, not just a keyword — to catch same-name-different-place pages, right-fact-wrong-source, marketing boilerplate, and "evidence" pages that actually returned 404 or a block.
- When a screenshot alone can't confirm a small textual detail (a link's href, a field's value,
  a control's selected/expanded state), cross-check the same command's AX tree with
  `--properties`. When outer-vs-nested scope can change the verdict, add `--show-ancestors` and
  verify the matched label belongs to the target node rather than a quoted/embedded descendant.
  The AX tree corroborates the screenshot/session; it is not a substitute for them.

## Session JSONL shapes (for grep/read)

One JSON object per line; `type` decides how to read it:

- `type=session` (first line): `{id, version, cwd}` — session metadata.
- `type=message`, `message.role`:
  - `assistant`: `content[]` may hold `{type:"thinking"}`, `{type:"text"}`,
    `{type:"toolCall", id, name, arguments}` (bash command is `arguments.command`).
  - `toolResult`: `toolCallId` links back to the toolCall; `content[].text` is the real
    tool output; `isError:true` means the tool call failed.

Codex rollouts start with `type=session_meta`. Their transcript entries use
`type=response_item`; assistant text is a `payload.type=message`, tool calls are
`payload.type=function_call`, and matching results are `payload.type=function_call_output`.
The probe commands above normalize both formats to the same output.

## Output

When verification is done: stop calling tools and output ONLY the JSON object required by
the prompt's `<response_format>` — no surrounding text, no code fences.
