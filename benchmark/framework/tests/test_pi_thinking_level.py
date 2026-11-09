from __future__ import annotations

import re
from pathlib import Path
from typing import get_args

import run_eval
from wiek_bench.config import HarnessConfig, ThinkingLevel
from wiek_bench.providers.pi_coding_agent import build_agent_argv


ROOT = Path(__file__).resolve().parents[1]
PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]


def test_max_is_valid_for_pi_config_and_cli_argv() -> None:
    assert list(get_args(ThinkingLevel)) == PI_THINKING_LEVELS

    configured = HarnessConfig(
        providers={"pi": {"thinking_level": "max"}},
        judge={"thinking_level": "max"},
    )
    assert configured.providers.pi.thinking_level == "max"
    assert configured.judge.thinking_level == "max"

    parser = run_eval.build_parser()
    thinking_action = next(action for action in parser._actions if action.dest == "thinking")
    assert list(thinking_action.choices or []) == PI_THINKING_LEVELS

    args = parser.parse_args(["--thinking", "max"])
    cli_config = run_eval._apply_cli_overrides(HarnessConfig(), args)
    argv = build_agent_argv(
        pi_bin="pi",
        provider="openai",
        model="gpt-5.6-sol",
        thinking_level=cli_config.providers.pi.thinking_level,
        allowed_tools=["read"],
        skill_path="/tmp/test-skill",
    )

    thinking_index = argv.index("--thinking")
    assert argv[thinking_index + 1] == "max"


def test_webui_exposes_every_pi_thinking_level() -> None:
    source = (ROOT / "frontend" / "src" / "components" / "ConfigForm.tsx").read_text(
        encoding="utf-8"
    )
    match = re.search(
        r'<Form\.Item name="thinking_level" noStyle>\s*'
        r"<SegField\s+options=\{\[([^\]]+)\]\}",
        source,
    )

    assert match is not None
    assert re.findall(r'"([^"]+)"', match.group(1)) == PI_THINKING_LEVELS
    assert 'max: t("newRun.provider.thinkingLevels.max")' in source
    for locale in ("en", "zh"):
        messages = (ROOT / "frontend" / "src" / "i18n" / "messages" / f"{locale}.ts").read_text(
            encoding="utf-8"
        )
        assert re.search(r'thinkingLevels:\s*\{[^}]*\bmax:\s*"max"', messages)
