from __future__ import annotations

from wiek_bench.screenshotter import _slim_ax_tree


def _ax_value(value: object) -> dict[str, object]:
    return {"type": "string", "value": value}


def test_slim_ax_tree_records_direct_retained_parent() -> None:
    raw = {
        "nodes": [
            {"nodeId": "root", "role": _ax_value("RootWebArea")},
            {
                "nodeId": "child",
                "parentId": "root",
                "role": _ax_value("button"),
            },
        ]
    }

    assert _slim_ax_tree(raw) == {
        "schema_version": 2,
        "nodes": [
            {"role": "RootWebArea", "parent_index": None},
            {"role": "button", "parent_index": 0},
        ],
    }


def test_slim_ax_tree_walks_through_ignored_parent() -> None:
    raw = {
        "nodes": [
            {"nodeId": "root", "role": _ax_value("RootWebArea")},
            {"nodeId": "ignored", "parentId": "root", "ignored": True},
            {
                "nodeId": "child",
                "parentId": "ignored",
                "role": _ax_value("StaticText"),
            },
        ]
    }

    assert _slim_ax_tree(raw)["nodes"] == [
        {"role": "RootWebArea", "parent_index": None},
        {"role": "StaticText", "parent_index": 0},
    ]


def test_slim_ax_tree_missing_parent_degrades_to_null() -> None:
    raw = {
        "nodes": [
            {
                "nodeId": "orphan",
                "parentId": "missing",
                "role": _ax_value("button"),
            }
        ]
    }

    assert _slim_ax_tree(raw)["nodes"] == [{"role": "button", "parent_index": None}]


def test_slim_ax_tree_cycle_degrades_to_null() -> None:
    raw = {
        "nodes": [
            {"nodeId": "a", "parentId": "b", "role": _ax_value("group")},
            {"nodeId": "b", "parentId": "a", "role": _ax_value("button")},
        ]
    }

    assert _slim_ax_tree(raw)["nodes"] == [
        {"role": "group", "parent_index": None},
        {"role": "button", "parent_index": None},
    ]


def test_slim_ax_tree_preserves_semantic_fields_and_drops_raw_graph_fields() -> None:
    raw = {
        "nodes": [
            {
                "nodeId": "root",
                "parentId": "raw-parent",
                "childIds": ["raw-child"],
                "role": _ax_value("link"),
                "name": _ax_value("OpenAI"),
                "value": _ax_value("visible value"),
                "properties": [
                    {"name": "url", "value": _ax_value("https://x.com/OpenAI")},
                    {"name": "focusable", "value": {"type": "boolean", "value": True}},
                ],
                "chromeRole": {"type": "internalRole", "value": 110},
            }
        ]
    }

    assert _slim_ax_tree(raw) == {
        "schema_version": 2,
        "nodes": [
            {
                "role": "link",
                "name": "OpenAI",
                "value": "visible value",
                "properties": {
                    "url": "https://x.com/OpenAI",
                    "focusable": True,
                },
                "parent_index": None,
            }
        ],
    }
