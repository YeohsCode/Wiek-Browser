"""Ad-hoc input boundary shared by CLI, WebUI and run reconstruction.

Both free-form text tasks and Odysseys-shaped JSON are normalised to one
``list[BenchmarkTask]`` spine before Stage A scheduling.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from copy import deepcopy
from typing import Any, Literal

from wiek_bench.datasets.base import BenchmarkTask
from wiek_bench.datasets.odysseys import parse_odysseys_entry

AdhocRubricMode = Literal["none", "all"]


def text_tasks_to_entries(tasks: Sequence[str]) -> list[dict[str, Any]]:
    """Convert repeated text inputs to rubric-less Odysseys-shaped entries."""
    cleaned = [task.strip() for task in tasks]
    if not cleaned or any(not task for task in cleaned):
        raise ValueError("adhoc text tasks must contain at least one non-empty task")
    single = len(cleaned) == 1
    return [
        {
            "task_id": "adhoc" if single else f"adhoc-{index}",
            "confirmed_task": task,
            "rubrics": {},
        }
        for index, task in enumerate(cleaned, start=1)
    ]


def _normalise_rubrics(value: Any, *, task_id: str) -> dict[str, dict[str, Any]]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValueError(f"adhoc task {task_id!r}: rubrics must be an object")

    rubrics: dict[str, dict[str, Any]] = {}
    for raw_rubric_id, raw_spec in value.items():
        rubric_id = str(raw_rubric_id).strip()
        if not rubric_id:
            raise ValueError(f"adhoc task {task_id!r}: rubric id must be non-empty")
        if not isinstance(raw_spec, Mapping):
            raise ValueError(f"adhoc task {task_id!r}: rubric {rubric_id!r} must be an object")
        requirement = raw_spec.get("requirement")
        verification = raw_spec.get("verification")
        if not isinstance(requirement, str) or not requirement.strip():
            raise ValueError(f"adhoc task {task_id!r}: rubric {rubric_id!r} requires non-empty requirement")
        if not isinstance(verification, str) or not verification.strip():
            raise ValueError(f"adhoc task {task_id!r}: rubric {rubric_id!r} requires non-empty verification")
        spec = deepcopy(dict(raw_spec))
        spec["requirement"] = requirement.strip()
        spec["verification"] = verification.strip()
        rubrics[rubric_id] = spec
    return rubrics


def _normalise_entry(raw_entry: Any, *, index: int) -> dict[str, Any]:
    if not isinstance(raw_entry, Mapping):
        raise ValueError(f"adhoc.tasks[{index}] must be an object")

    raw_task_id = raw_entry.get("task_id")
    if not isinstance(raw_task_id, str) or not raw_task_id.strip():
        raise ValueError(f"adhoc.tasks[{index}].task_id must be a non-empty string")
    task_id = raw_task_id.strip()
    if task_id in {".", ".."} or "/" in task_id or "\\" in task_id:
        raise ValueError(f"adhoc task_id is not path-safe: {task_id!r}")
    if any(ord(char) < 32 or ord(char) == 127 for char in task_id):
        raise ValueError(f"adhoc task_id contains control characters: {task_id!r}")

    instruction = raw_entry.get("confirmed_task")
    if not isinstance(instruction, str) or not instruction.strip():
        raise ValueError(f"adhoc task {task_id!r}: confirmed_task must be a non-empty string")

    entry = deepcopy(dict(raw_entry))
    entry["task_id"] = task_id
    entry["confirmed_task"] = instruction.strip()
    for field_name in ("level", "website"):
        field_value = entry.get(field_name)
        if field_value is not None and not isinstance(field_value, str):
            raise ValueError(f"adhoc task {task_id!r}: {field_name} must be a string when provided")
    entry["rubrics"] = _normalise_rubrics(entry.get("rubrics"), task_id=task_id)
    return entry


def normalize_adhoc_node(node: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    """Return canonical entries from new ``tasks`` or legacy ``task`` config.

    Empty config returns ``[]``. New and legacy inputs are mutually exclusive.
    """
    if not node:
        return []
    raw_tasks = node.get("tasks")
    raw_legacy = node.get("task")
    legacy = raw_legacy.strip() if isinstance(raw_legacy, str) else raw_legacy

    if raw_tasks is not None and legacy:
        raise ValueError("adhoc.tasks and legacy adhoc.task are mutually exclusive")
    if raw_tasks is None:
        if legacy is None or legacy == "":
            return []
        if not isinstance(legacy, str):
            raise ValueError("legacy adhoc.task must be a string")
        return text_tasks_to_entries([legacy])
    if not isinstance(raw_tasks, list):
        raise ValueError("adhoc.tasks must be a JSON array")
    if not raw_tasks:
        raise ValueError("adhoc.tasks must contain at least one task")

    entries = [_normalise_entry(entry, index=index) for index, entry in enumerate(raw_tasks)]
    ids = [str(entry["task_id"]) for entry in entries]
    duplicates = sorted(task_id for task_id, count in Counter(ids).items() if count > 1)
    if duplicates:
        raise ValueError(f"adhoc task_id values must be unique: {duplicates}")
    adhoc_rubric_mode(entries)  # enforce the whole-batch invariant at the boundary
    return entries


def adhoc_rubric_mode(entries: Sequence[Mapping[str, Any]]) -> AdhocRubricMode:
    """Return the uniform rubric mode, rejecting mixed batches."""
    populated = [bool(entry.get("rubrics")) for entry in entries]
    if any(populated) and not all(populated):
        raise ValueError("adhoc batch cannot mix tasks with rubrics and tasks without rubrics")
    return "all" if populated and all(populated) else "none"


def build_adhoc_tasks(
    node: Mapping[str, Any] | None,
) -> tuple[list[BenchmarkTask], dict[str, Any] | None, AdhocRubricMode]:
    """Build Stage-A tasks plus the canonical metadata snapshot."""
    entries = normalize_adhoc_node(node)
    if not entries:
        return [], None, "none"
    mode = adhoc_rubric_mode(entries)
    tasks = [parse_odysseys_entry(entry, benchmark="adhoc") for entry in entries]
    return tasks, {"tasks": deepcopy(entries)}, mode


def adhoc_is_active(node: Mapping[str, Any] | None) -> bool:
    """Whether a config/metadata node selects the ad-hoc task source."""
    return bool(normalize_adhoc_node(node))
