"""CAPTCHA interception: the agent self-reports a hard block, the harness stops
before Stage B.

A blocked task is a **valid observation**, not a broken measurement: the agent ran
correctly and the site refused it. So it gets its own ``TaskRecord`` field rather than
borrowing ``error`` — which means resume treats it as done, the error counts stay
"things that actually went wrong", and the sample still carries real timing/cost data
into the report.

The task prompt (``prompts/task/default.j2``) asks for the sentinel on its own line
inside the final message. A line-leading match, rather than "starts the whole message",
lets it coexist with the ``FINAL ANSWER:`` opener the same template requires; rather
than "appears anywhere", it does not fire when the agent merely *discusses* the marker
("no need to emit [CAPTCHA_BLOCKED] this time").

Both ends read ``intercepts()``: an excluded benchmark neither receives the sentinel
instruction nor gets intercepted, so the prompt can never ask for a marker the harness
ignores.
"""

from __future__ import annotations

from typing import Any

# What the agent writes, on a line of its own, followed by site and check.
# Bracketed and upper-case so it reads as a machine token the model is emitting rather
# than prose it might paraphrase.
SENTINEL = "[CAPTCHA_BLOCKED]"

# stealth-bench scores exactly "was the agent blocked by an anti-bot check?", so a block
# is its primary signal and must reach the judge as a fail. bu-bench ships a task that
# asks the agent to *solve* a canvas CAPTCHA, where the wall is the task.
EXCLUDED_BENCHMARKS = frozenset({"stealth-bench", "bu-bench"})

# Leading markdown emphasis / list bullets the agent may wrap the sentinel line in.
_DECORATION = "*`_-#> \t"

_NO_DETAIL = "(no detail reported)"


def intercepts(benchmark: str | None) -> bool:
    """Whether this benchmark participates in sentinel injection and interception."""
    return str(benchmark or "") not in EXCLUDED_BENCHMARKS


def detail_from_final_output(final_output: str | None) -> str | None:
    """Return the reported block detail for a sentinel line, else None.

    Matches the first line whose content *starts* with the sentinel. Mid-sentence
    mentions are narration about the mechanism, not a report of being blocked.
    """
    for line in (final_output or "").splitlines():
        stripped = line.lstrip(_DECORATION)
        if stripped[: len(SENTINEL)].upper() != SENTINEL:
            continue
        detail = stripped[len(SENTINEL) :].strip().strip(_DECORATION).strip()
        return detail or _NO_DETAIL
    return None


def is_blocked(record: dict[str, Any]) -> bool:
    """Whether a tasks.jsonl row was intercepted. The single read path for consumers."""
    return bool(record.get("blocked_by_captcha"))
