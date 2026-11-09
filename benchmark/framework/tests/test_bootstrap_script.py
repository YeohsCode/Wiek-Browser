from __future__ import annotations

import subprocess
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "bootstrap.sh"


def test_bootstrap_is_valid_bash_and_targets_the_current_pi_package() -> None:
    subprocess.run(["bash", "-n", str(SCRIPT)], check=True)
    source = SCRIPT.read_text(encoding="utf-8")

    assert 'wiek_bench.wiek_release activate-external "$WIEK_DEV_INDEX"' in source
    assert "@earendil-works/pi-coding-agent" in source
    assert "@mariozechner/pi-coding-agent" not in source


def test_bootstrap_reads_the_dev_runtime_from_env_not_a_hardcoded_path() -> None:
    """A public checkout must not carry one machine's wiek-lite build path."""
    source = SCRIPT.read_text(encoding="utf-8")

    assert "WIEK_DEV_INDEX=" in source
    assert 's/^[[:space:]]*WIEK_DEV_INDEX=//p' in source
    assert 'WIEK_DEV_INDEX="${WIEK_DEV_INDEX:-}"' in source


def test_bootstrap_keeps_machine_wide_writes_opt_in() -> None:
    """Installing Pi and editing ~/.zshrc happen only when explicitly requested."""
    source = SCRIPT.read_text(encoding="utf-8")

    assert "--install-pi" in source
    assert "--install-cli-pin" in source
    # The two mutations outside the repository sit behind their flags.
    assert "$INSTALL_PI -eq 0" in source
    assert "$INSTALL_CLI_PIN -eq 0" in source
