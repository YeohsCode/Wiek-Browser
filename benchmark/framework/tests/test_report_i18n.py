from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi import FastAPI
from pydantic import ValidationError

import wiek_bench.webui.app as webui_app
from wiek_bench.report.compare import render_html
from wiek_bench.report.i18n import REPORT_MESSAGES, ReportLocale
from wiek_bench.report.modules import module_render_js, module_sections_html
from wiek_bench.report.template_single import TEMPLATE
from wiek_bench.webui.exporter import build_single_report
from run_report import build_parser


def _payload() -> dict[str, Any]:
    return {
        "meta": {
            "mode": "single",
            "base_label": "fixture",
            "base_run": "fixture-run",
            "base_dirs": ["fixture-run"],
            "base_dropped": [],
            "benchmark": "fixture",
            "iterations": [],
        },
        "totals": {"base": {"count": 0}, "test": None},
        "iter": {},
        "per_base": {},
        "rows": [],
        "dataset": [],
        "modules": {},
        "gen_at": "2026-07-24 12:00 UTC",
    }


def _endpoint(
    app: FastAPI,
    path: str,
) -> Callable[[webui_app.SingleExportBody], Awaitable[dict[str, str]]]:
    for route in app.routes:
        if getattr(route, "path", None) == path:
            return cast(
                Callable[[webui_app.SingleExportBody], Awaitable[dict[str, str]]],
                route.endpoint,
            )
    raise AssertionError(f"route not found: {path}")


def test_report_catalogs_cover_every_template_reference() -> None:
    assembled = (
        TEMPLATE.replace("__MODULE_SECTIONS__", module_sections_html())
        .replace("__MODULE_JS__", module_render_js())
    )
    references = set(re.findall(r'data-i18n="([a-z0-9_]+)"', assembled))
    references.update(re.findall(r'\bI\.([a-z0-9_]+)', assembled))
    references.update(re.findall(r'tr\("([a-z0-9_]+)"', assembled))

    assert REPORT_MESSAGES["zh"].keys() == REPORT_MESSAGES["en"].keys()
    assert references <= REPORT_MESSAGES["zh"].keys()
    assert re.search(r"[\u3400-\u9fff]", assembled) is None
    assert (
        re.search(
            r"[\u3400-\u9fff]",
            "".join(REPORT_MESSAGES["en"].values()),
        )
        is None
    )


@pytest.mark.parametrize(
    ("locale", "html_lang", "title", "selected_label", "other_label"),
    [
        ("zh", "zh-CN", "单 run 评测报告", "运行元信息", "Dropped samples"),
        ("en", "en", "Single-run Evaluation Report", "Run Metadata", "运行元信息"),
    ],
)
def test_render_html_injects_only_the_selected_report_locale(
    locale: str,
    html_lang: str,
    title: str,
    selected_label: str,
    other_label: str,
) -> None:
    report = render_html(_payload(), locale=cast(ReportLocale, locale))

    assert f'<html lang="{html_lang}">' in report
    assert f"fixture · {title} · fixture" in report
    assert selected_label in report
    assert other_label not in report
    assert "__REPORT_" not in report


def test_cli_report_locale_defaults_to_english_and_accepts_chinese() -> None:
    parser = build_parser()

    assert parser.parse_args(["--single", "run"]).locale == "en"
    assert parser.parse_args(["--single", "run", "--locale", "zh"]).locale == "zh"


def test_webui_report_options_validate_locale() -> None:
    assert webui_app.SingleExportBody(runs=["run"]).options.locale == "en"
    assert (
        webui_app.SingleExportBody(
            runs=["run"],
            options={"exclude": ["task-1"], "locale": "zh"},
        ).options.locale
        == "zh"
    )

    with pytest.raises(ValidationError):
        webui_app.SingleExportBody(
            runs=["run"],
            options={"locale": "fr"},
        )


def test_exporter_renders_requested_locale(tmp_path: Path) -> None:
    run_dir = tmp_path / "fixture-run"
    run_dir.mkdir()
    (run_dir / "run_metadata.json").write_text(
        json.dumps(
            {
                "run_id": run_dir.name,
                "benchmark": "fixture",
                "provider": "pi",
                "model": "fixture-model",
            }
        ),
        encoding="utf-8",
    )

    report_path = build_single_report([run_dir], locale="zh")
    report = report_path.read_text(encoding="utf-8")

    assert '<html lang="zh-CN">' in report
    assert "单 run 评测报告" in report


def test_webui_single_report_endpoints_forward_locale(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output_dir = tmp_path / "runs"
    run_dir = output_dir / "fixture-run"
    run_dir.mkdir(parents=True)
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "run": {"output_dir": str(output_dir)},
                "webui": {"downloads_dir": str(tmp_path / "downloads")},
            }
        ),
        encoding="utf-8",
    )
    received: list[tuple[str, set[str], str]] = []

    def fake_export(
        run_dirs: list[Path],
        downloads_dir: Path,
        *,
        exclude_ids: set[str] | None = None,
        locale: str = "en",
    ) -> Path:
        del run_dirs, downloads_dir
        received.append(("export", exclude_ids or set(), locale))
        return tmp_path / "report.zip"

    def fake_build(
        run_dirs: list[Path],
        *,
        exclude_ids: set[str] | None = None,
        locale: str = "en",
    ) -> Path:
        del run_dirs
        received.append(("build", exclude_ids or set(), locale))
        return tmp_path / "report.html"

    monkeypatch.setattr(webui_app, "export_single_bundle", fake_export)
    monkeypatch.setattr(webui_app, "build_single_report", fake_build)
    app = webui_app.create_app(str(config_path))
    body = webui_app.SingleExportBody(
        runs=[run_dir.name],
        options={"exclude": ["task-1"], "locale": "zh"},
    )

    asyncio.run(_endpoint(app, "/api/export/single")(body))
    asyncio.run(_endpoint(app, "/api/report/single")(body))

    assert received == [
        ("export", {"task-1"}, "zh"),
        ("build", {"task-1"}, "zh"),
    ]
