---
name: pi-session-analyzer
description: Analyze pi (coding-agent) session JSONL and wiek-benchmark-harness run artifacts to explain slow or failed individual tasks, compare execution-path differences between agents or browser tools, and count tool calls and error types. Use this skill whenever users ask to analyze a pi session, explain why a task was slow or failed, compare two runs, investigate an error, locate the session corresponding to tasks.jsonl, inspect an agent execution path, count tool calls, analyze a run ID, or perform any forensic or retrospective analysis of JSONL under ~/.pi/agent/sessions/ or agent-home/.pi/agent/sessions/.
---

# Pi Session Analyzer

Pi session JSONL is the source of truth for agent execution details; `tasks.jsonl` is the source of
truth for final task state; `attempts/<task_id>.json` is the source of truth for the retry
lifecycle. Route metrics through `wiek_bench/session_parser.py`; use the skill scripts only for
filtering, locating evidence, and presentation.

## Core constraints

1. For a specific run, read the raw JSON/JSONL first. Do not infer from memory or HTML prose.
2. Read duration, think/LLM/env, turn, token, cost, and tool distributions only from
   `SessionStats`. Do not duplicate the metric convention inside the skill.
3. Treat the actual `toolResult` as the source of truth for tool calls and error details.
   Assistant narration can explain intent only.
4. Tool errors include not only `toolResult.isError=true`, but also code-0 shell/wiek-browser
   wrapped failures recognized by the project parser. Assistant `stopReason=error` events, such as
   `provider_transport_failure`, are separate session-level abnormal stops.
5. Cite evidence with the `task_id` and the session line number or turn number.
6. Inspect the attempt artifact when `attempt_count>1`. When an old run lacks that artifact,
   explicitly state that "historical attempts have no reliable linkage"; do not infer a definite
   association from timing or prompts alone. `attempt_count==1` does not mean the task ran only
   once: force-rerun overwrites the result and attempt file in place, leaving its only trace in the
   `reruns` array in `run_metadata.json`. Inspect it before discussing success rates.
7. Stream raw evidence line by line through the session. Do not load an entire large session with
   `json.load`.
8. Do not modify original run artifacts unless the user explicitly requests it.

## Runtime environment

`.claude/skills/pi-session-analyzer` is the source directory; the user-level `.codex` skill should
symlink to it. Resolve the harness from each script's real path. Do not hard-code a checkout path
or use a silent parser fallback. Use the project environment consistently:

```bash
ROOT=$(git rev-parse --show-toplevel)
PY="$ROOT/.venv/bin/python"
SCRIPTS="$ROOT/.claude/skills/pi-session-analyzer/scripts"
```

If the project environment lacks a dependency, fail loudly and identify the correct interpreter.
Do not install dependencies during the analysis.

## Data model

### `runs/<run_id>/tasks.jsonl`

Each line is one final task instance. Key fields:

| Field | Meaning |
| --- | --- |
| `task_id` | Composite task ID, such as `rwb-x__iter2` |
| `base_task_id` / `iteration_index` | Base ID and iteration number |
| `session_file` / `session_id` | Session locator for the final attempt |
| `attempt_count` | Total attempts in this task lifecycle |
| `started_at` / `ended_at` | Outer task timestamps for the final attempt |
| `error` / `verdict` / `score` | Runtime and judge results |
| `failure_reason` / `judge_reasoning` | Judge explanation |

### `runs/<run_id>/attempts/<task_id>.json`

A new run updates this atomically after each completed provider lifecycle:

```json
{
  "schema_version": 1,
  "task_id": "rwb-x__iter2",
  "attempts": [
    {
      "attempt_index": 1,
      "session_file": "/abs/path/first.jsonl",
      "provider_error": null,
      "failure_reason": "provider_transport_failure: WebSocket error",
      "step_limit_hit": false
    }
  ]
}
```

This stores only control-flow provenance, without duplicating derived metrics such as token, cost,
or duration. Force-rerun overwrites the task's old attempt file. It is normal for legacy runs to
lack this directory.

### Other run-level artifacts

| Path | Purpose |
| --- | --- |
| `judges/<task_id>_judge.json` | Per-rubric decisions (`metadata.rubric_scores`/`rubric_results`), the judge session for each rubric, judge cost/turns/image count. For scoring disputes, inspect this before relying only on `judge_reasoning` in `tasks.jsonl` |
| `browser_state/<task_id>.json` | Task spaces left open by the task at teardown |
| `close_done/<task_id>.json` | Whether harness teardown actually closed successfully (`ok`/`return_code`/`stdout_tail`) |
| `screenshots/` + `screenshot_trees_dir` | Frames and structure trees seen by the judge. Frames are webp; frame and tree numbers are not synchronized in `manifest.jsonl`, so use the field mapping |
| `pi_stderr/<task_id>.log` | Provider process stderr for startup/transport errors absent from the session |

`judges/_job.json` is the scoring job's progress file, not an artifact for a specific task.
Odysseys `task_id` values are hashes, so judge filenames may not be readable. Index them by the
`task_id` field inside the file.

### Pi session JSONL

- Top-level `entry.timestamp`: timing coordinate for the report and parser.
- `message.timestamp`: provider-internal message time; display it as-is, but do not use it for
  timing attribution.
- `assistant.content[].toolCall`: call ID, name, and arguments.
- `toolResult.toolCallId`: pairs with the call; `isError=true` indicates a tool failure.
- `assistant.usage`: per-turn input/output/cache/reasoning/cost.
- `customType=wiek-bench-think`: thinking wall time for that assistant turn.
- `assistant.stopReason=error`: session-level abnormal stop, not a tool failure.

### wiek-browser runtime semantics (how to interpret errors)

The wiek-lite API and failure semantics are evolving. Confirm these rules before interpreting
`tool_failures`:

- **Wait failures are silent**: `waitForURL` / `waitForSelector` / `locator.waitFor` /
  `waitForFunction` return a false value on timeout instead of throwing
  (`waitForRequest`/`waitForResponse` still throw). Therefore, a lower tool-error count across
  versions does not necessarily mean greater stability; a failure may simply have changed from an
  exception to a false value. Check whether subsequent actions became ineffective.
- **Bare locators use strict matching**: matching multiple elements throws `matched N elements`,
  which is the opposite problem from `matched 0 elements` (selector too broad vs no match). These
  belong to the `locator_ambiguous` and `locator_miss` buckets, respectively.
- **Agent assertions**: failures triggered by `throw new Error('...')` in a heredoc belong to
  `script_assertion`. They show that the agent's self-check worked, not that the tool broke.
  Report them separately when calculating a tool defect rate.
- **User takeover is a hard stop**: `user has taken control` / `user is controlling` belong to
  `user_control_stop`. By contract, the agent should stop and ask rather than retry.
- **Attachments/local sites**: `wiek_bench/task_resources.py` stages task resources in
  `task-files/` under the agent working directory. Errors caused by the agent using the wrong path
  belong to `task_resource_missing` (observed in both old and new runs).

Error buckets are defined in `ERR_BUCKETS` in `scripts/_pi_session_lib.py`; order is priority
(first match wins). When adding a bucket, ensure an earlier broad pattern does not consume it. A
high share in the fallback `nonzero_exit`/`other` buckets signals that the taxonomy needs updating.

## Standard analysis path

### A. Inspect one run first

```bash
$PY "$SCRIPTS/analyze_run.py" runs/<run_id> --top 5
$PY "$SCRIPTS/analyze_run.py" runs/<run_id> --task-id <task_id> --json
```

The entry point:

1. Reads final task state with `latest_by_task_id`.
2. Recalculates full-sample metrics with `session_parser`.
3. Prioritizes runtime errors, false verdicts, retried tasks, tool failures, and slow tasks.
4. Attaches attempt data, error line numbers, and similar retry segments to selected entries.
5. Emits an explicit warning when a legacy run lacks attempt artifacts.

### B. Summarize one session and inspect errors

```bash
$PY "$SCRIPTS/session_summary.py" "$SESSION" | jq
$PY "$SCRIPTS/session_quickscan.py" "$SESSION"
$PY "$SCRIPTS/extract_errors.py" "$SESSION" --table
```

`session_summary` and `quickscan` must show:

- `duration_s / think_time_s / llm_time_s / env_time_s`;
- `stop_reason_error / parse_error / warnings`;
- turns, tools, tool failures, tokens, reasoning, and cost;
- error buckets and whether final output exists.

### C. Inspect tool calls and retries

```bash
$PY "$SCRIPTS/extract_tool_calls.py" "$SESSION" --table
$PY "$SCRIPTS/extract_tool_calls.py" "$SESSION" --errors-only --full
$PY "$SCRIPTS/extract_tool_calls.py" "$SESSION" --missing-only
$PY "$SCRIPTS/retry_clusters.py" "$SESSION" --threshold 0.82
```

For each call, output the call/result line numbers and a 12-character argument fingerprint. A call
without a toolResult has `missing` status and must not be treated as successful. A retry cluster
is only a statistical clue about consecutive similar calls; inspect every actual result when
reporting. Do not automatically equate similarity with the same root cause.

### D. Calculate per-turn timing correctly

```bash
$PY "$SCRIPTS/turn_timings.py" "$SESSION" --top 5
```

Use the same field conventions as the single-run report:

- `think_s`: `wiek-bench-think`; `None` when not measurable in an old session.
- `llm_s`: interval between top-level assistant entries minus think time.
- `env_s`: top-level entry interval for toolResults in that turn.
- `turn_s`: think + LLM + env (when think is not measurable, it is already included in LLM).

Do not restore the old `message.timestamp → tool_s` algorithm; it attributes model-generation
errors to tool waiting.

### E. Inspect input, process, and final answer

```bash
$PY "$SCRIPTS/extract_io.py" "$SESSION"
$PY "$SCRIPTS/extract_outputs.py" "$SESSION" --mode final
$PY "$SCRIPTS/extract_outputs.py" "$SESSION" --mode thinking --turn 7
```

Include the final answer's source line and turn so it can be verified against the raw JSONL.

### F. Compare two runs

```bash
$PY "$SCRIPTS/runs_pair_diff.py" runs/<baseline> runs/<test> --top 10
```

Pair the intersection by `(base_task_id, iteration_index)`. Read metrics directly from the project
parser; exit if the parser cannot be imported rather than silently using a reduced fallback. After
full-sample statistics, investigate the 2–3 tasks with the largest differences. Do not generalize
from individual cases.

## Script responsibilities

| Script | Responsibility |
| --- | --- |
| `analyze_run.py` | Run-level filtering and attempt/error/retry evidence summary |
| `session_summary.py` | One-line JSON projection of `SessionStats` |
| `session_quickscan.py` | Human-readable overview and error samples |
| `extract_errors.py` | Tool errors and assistant stop errors with line numbers |
| `extract_tool_calls.py` | ToolCall/result pairing, status, and argument fingerprints |
| `retry_clusters.py` | Clustering of consecutive similar calls |
| `turn_timings.py` | Per-turn think/LLM/env timing consistent with the report |
| `extract_outputs.py` | Thinking/text/final output with turn/line |
| `extract_io.py` | First user prompt and final assistant text |
| `runs_pair_diff.py` | Paired differences between two runs |

## Reporting rules

1. Use the first three sentences to answer what happened, what the root cause was, and how broad
   the impact was.
2. Separate full-sample conclusions from individual evidence; label individual cases as `n=1`.
3. Use tables for data. Error samples must include the task ID and line or turn.
4. Distinguish `tool failure`, `assistant stop error`, runtime `error`, and judge failure.
5. Keep duration/think/LLM/env consistent with the single-run HTML parser convention.
6. For legacy attempts, report only that reliable linkage is unavailable; label time-window or
   prompt matching as inference.

## Forensic trap: skill text contaminates string searches

The agent reads the entire `SKILL.md` into every session (persisted as a `toolResult`), and that
text describes every runtime error marker. Grepping those markers directly produces a perfectly
regular set of false positives. In two recent runs, `[wiek-browser:skill-stale]`,
`[wiek-browser:notice]`, `user is controlling`, and `w: 0` each appeared 40 times—exactly once per
session—all from the skill text, with zero real runtime errors.

Search runtime signals through `is_error` results from `iter_tool_pairs`, or explicitly exclude the
turn that loaded the skill. When every session has exactly the same hit count, first suspect that
the search matched documentation rather than failures.

## Anti-patterns

- ❌ Do not duplicate the token/cost/duration parser inside the skill.
- ❌ Do not use `message.timestamp` to calculate tool duration.
- ❌ Do not inspect only `toolResult.isError` and miss code-0 wrapped failures or
  `stopReason=error`.
- ❌ Do not mark a call without a toolResult as successful.
- ❌ Do not silently skip parser import or schema errors.
- ❌ Do not describe the agent execution path from `tasks.jsonl` alone.
- ❌ Do not modify a historical run to "fill in" nonexistent attempt linkage.
- ❌ Do not grep runtime error markers without excluding the turn that loaded the skill text.
- ❌ Do not compare absolute `tool_failures` across wiek-lite versions without explaining that wait
  failures changed to silent returns.
- ❌ Do not treat `attempt_count==1` as "this task ran only once" (force-rerun leaves no trace
  there).
