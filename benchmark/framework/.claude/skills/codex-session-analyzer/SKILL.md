---
name: codex-session-analyzer
description: Analyze Codex provider rollout JSONL and wiek-benchmark-harness run artifacts to identify slow or failed individual tasks, tool retries, token/cost anomalies, and differences in agent execution paths. Use when users ask to analyze a Codex session or rollout, explain why a Codex task was slow or failed, inspect a Codex provider execution trace, compare Codex runs, count function_call or tool output events, or investigate agent-home/.codex/sessions.
---

# Codex Session Analyzer

Codex rollout JSONL is the source of truth for agent execution details; `tasks.jsonl` is the
source of truth for final task state; `attempts/<task_id>.json` is the source of truth for the
retry lifecycle. Route duration, turn, token, cost, and tool distributions through
`wiek_bench/session_parser.py`; use the skill scripts only to filter, pair evidence, and present it.

## Core constraints

1. For a specific run, read the raw JSON/JSONL first. Do not infer from HTML prose or the
   assistant's own account.
2. Read duration, LLM/env, TTFT, turn, token, reasoning, cost, and tool distributions only from
   `SessionStats`. Do not duplicate the aggregation logic inside the skill.
3. Keep Codex `think_time_s` as `None` because it is currently not measurable. Do not fabricate it
   from reasoning items.
4. Treat `function_call_output` / `custom_tool_call_output` as tool evidence.
   `agent_message` expresses intent only.
5. Distinguish tool failures, rollout terminal errors, runtime errors, and judge failures.
6. Cite evidence with the `task_id` and the rollout line number or turn number.
7. Inspect the attempt artifact when `attempt_count>1`. When a legacy run lacks the artifact,
   explicitly state that "historical attempts have no reliable linkage"; do not infer a definite
   association from timing or prompts.
8. Stream rollout evidence line by line instead of loading large files with a single `json.load`.
   Do not modify original run artifacts.

## Runtime environment

`.claude/skills/codex-session-analyzer` is the source directory; `.agents/skills` contains only a
symlink to it. Resolve the harness from each script's real path. Do not hard-code a checkout or use
a silent parser fallback.

```bash
ROOT=$(git rev-parse --show-toplevel)
PY="$ROOT/.venv/bin/python"
SCRIPTS="$ROOT/.claude/skills/codex-session-analyzer/scripts"
```

If the project environment lacks a dependency, fail loudly and identify the correct interpreter.
Do not install dependencies during the analysis.

## Rollout data model

- `session_meta.payload`: session ID, cwd, Codex CLI version, and originator.
- `turn_context.payload`: model and context for that turn.
- `response_item.message`: user/developer/assistant text; assistant `output_text` is the source of
  the final output.
- `response_item.reasoning`: displayable reasoning summary; an empty summary does not mean there
  were no reasoning tokens.
- `response_item.function_call` / `function_call_output`: standard tool calls, paired by `call_id`.
- `response_item.custom_tool_call` / `custom_tool_call_output`: Codex Desktop dynamic tool calls,
  also paired by `call_id`; `input` may be raw non-JSON code text.
- `event_msg.mcp_tool_call_end`: MCP execution details inside a dynamic tool. Session HTML folds
  these into the parent `exec` only when the tool name and normalized arguments match uniquely;
  otherwise, it preserves them as unlinked events. Do not count them again as model tool calls.
- `event_msg.token_count`: completion of one model response; the authoritative counting event for
  `num_turns`.
- `event_msg.task_complete`: native duration, TTFT, and final agent message.
- `event_msg.item_completed`: newer rollouts may include native tool duration; prefer it over the
  call-to-output time difference.
- `event_msg.error` / `turn_aborted`: rollout-level exceptions, not tool failures.

Codex token_count `total_token_usage` values are cumulative. The project parser takes the final
cumulative value and uses each turn's `last_token_usage` to calculate API-equivalent cost. Do not
recalculate these inside the skill.

The Codex shell wrapper may display `Process exited with code 0` while its output still contains
`wiek's nodejs process exited with code 1`, or a persistent REPL may return `Uncaught ...`. The
formal report, this skill, and `BashAction.is_error` all use the project parser's high-confidence
rules to count these as `tool_failures`. Retain `embedded_output_errors` only for compatibility
with old JSON output; recognized wrapped errors must not also land in that field.

## Standard analysis path

### 1. Inspect one run first

```bash
$PY "$SCRIPTS/analyze_run.py" runs/<run_id> --top 5
$PY "$SCRIPTS/analyze_run.py" runs/<run_id> --task-id <task_id> --json
```

The entry point uses the project parser to recalculate full-sample metrics. It prioritizes runtime
errors, false verdicts, retried tasks, tool failures, and slow tasks, then attaches attempt data,
error line numbers, and similar retry segments to selected entries.

### 2. Summarize one rollout and inspect errors

```bash
$PY "$SCRIPTS/session_summary.py" "$SESSION" --run runs/<run_id> | jq
$PY "$SCRIPTS/session_quickscan.py" "$SESSION" --run runs/<run_id>
$PY "$SCRIPTS/extract_errors.py" "$SESSION" --table
```

`--run` supplies the Codex pricing snapshot. Without it, token and duration remain accurate, but
cost may be `None`. Summary and quickscan show duration, LLM/env, TTFT, terminal errors, parser
warnings, turns, tools, tokens, reasoning, cost, and final-output status.

### 3. Inspect tool calls and retries

```bash
$PY "$SCRIPTS/extract_tool_calls.py" "$SESSION" --table
$PY "$SCRIPTS/extract_tool_calls.py" "$SESSION" --errors-only --full
$PY "$SCRIPTS/extract_tool_calls.py" "$SESSION" --missing-only
$PY "$SCRIPTS/retry_clusters.py" "$SESSION" --threshold 0.82
```

For each call, output the call/output line numbers, turn, duration source, and 12-character
argument fingerprint. A call without an output has `missing` status and must not be treated as
successful. A retry cluster is only a clue about similar calls; inspect every actual output.

### 4. Inspect per-turn timing

```bash
$PY "$SCRIPTS/turn_timings.py" "$SESSION" --top 5
```

- `turn_wall_s`: wall time between adjacent `token_count` events (from task start for the first
  turn).
- `env_s`: sum of tool durations in the turn, preferring native item duration.
- `llm_s`: `max(turn_wall_s - env_s, 0)`.
- `reasoning_tokens`: the turn's `last_token_usage.reasoning_output_tokens`.
- Always print the parser's authoritative duration/LLM/env/TTFT for session totals.

Parallel tool durations may sum to more than turn wall time. This is the report/parser's
accumulated tool-time convention; do not describe the values as mutually exclusive wall-time
intervals.

### 5. Inspect input, process, and final answer

```bash
$PY "$SCRIPTS/extract_io.py" "$SESSION"
$PY "$SCRIPTS/extract_outputs.py" "$SESSION" --mode final
$PY "$SCRIPTS/extract_outputs.py" "$SESSION" --mode agent --turn 7
$PY "$SCRIPTS/extract_outputs.py" "$SESSION" --mode reasoning --turn 7
```

`agent` shows visible `event_msg.agent_message` values, `text` shows assistant `output_text`, and
`reasoning` shows only summaries persisted in the rollout. Include turn and line on every output.

### 6. Compare two Codex runs

```bash
$PY "$SCRIPTS/runs_pair_diff.py" runs/<baseline> runs/<test> --top 10
```

Pair the intersection by `(base_task_id, iteration_index)`. Inspect full-sample
duration/turn/tool/token/cost differences first, then investigate the 2–3 tasks with the largest
differences. Do not generalize from individual cases.

## Script responsibilities

| Script | Responsibility |
| --- | --- |
| `analyze_run.py` | Run-level filtering and attempt/error/retry summary |
| `session_summary.py` | One-line JSON projection of `SessionStats` |
| `session_quickscan.py` | Human-readable overview and error samples |
| `extract_errors.py` | Tool errors and terminal errors with line numbers |
| `extract_tool_calls.py` | Call/output pairing, status, and argument fingerprints |
| `retry_clusters.py` | Clustering of consecutive similar calls |
| `turn_timings.py` | Per-turn wall/LLM/env timing and parser totals |
| `extract_outputs.py` | Reasoning/agent/text/final output with turn/line |
| `extract_io.py` | User prompt and final assistant output |
| `runs_pair_diff.py` | Paired differences between two Codex runs |

## Reporting rules

1. Use the first three sentences to answer what happened, what the root cause was, and how broad
   the impact was.
2. Separate full-sample statistics from individual evidence; label individual cases as `n=1`.
3. Include the task ID and line/turn with error evidence, and name the duration source.
4. Normalize failures embedded in output to `tool_failure` through the project parser first. If
   the compatibility field `embedded_output_errors` is nonzero, treat it as a parser-rule gap and
   collect separate evidence; do not privately patch the count inside the skill.
5. Keep duration/LLM/env/TTFT/token/cost consistent with the single-run HTML parser convention.
6. Label Codex cost as an API-equivalent estimate and identify the pricing snapshot source.
7. For legacy attempts, report only that reliable linkage is unavailable; label time-window or
   prompt matching as inference.

## Anti-patterns

- Do not duplicate token/cost/duration aggregators inside the skill.
- Do not treat the presence of a reasoning item as measurable thinking wall time.
- Do not treat `agent_message` as evidence that a tool succeeded.
- Do not ignore `event_msg.error` / `turn_aborted`.
- Do not mark a call without tool output as successful.
- Do not silently skip parser import, schema, or provider errors.
- Do not modify historical rollouts to fill in attempt linkage.
