#!/usr/bin/env bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
INSTALL_PI=0
INSTALL_CLI_PIN=0
CHECK_ONLY=0
[[ -f .env ]] && WIEK_DEV_INDEX="$(sed -n 's/^[[:space:]]*WIEK_DEV_INDEX=//p' .env | tail -1)"
WIEK_DEV_INDEX="${WIEK_DEV_INDEX:-}"
for argument in "$@"; do
  case "$argument" in
    --install-pi) INSTALL_PI=1 ;;
    --install-cli-pin) INSTALL_CLI_PIN=1 ;;
    --check) CHECK_ONLY=1 ;;
    --no-serve|--skip-frontend) : ;;
    *) echo "Unsupported option: $argument" >&2; exit 2 ;;
  esac
done
command -v node >/dev/null
command -v uv >/dev/null
if [[ $CHECK_ONLY -eq 0 ]]; then uv sync --frozen --group dev; fi
if [[ $INSTALL_PI -eq 0 ]]; then
  echo 'Pi installation unchanged; use --install-pi to install it explicitly.'
elif [[ $CHECK_ONLY -eq 0 ]]; then
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
fi
if [[ $INSTALL_CLI_PIN -eq 0 ]]; then
  echo 'System command unchanged; use --install-cli-pin to register Wiek.'
elif [[ $CHECK_ONLY -eq 0 ]]; then
  node "$ROOT/../../cli/wiek-browser.mjs" install
fi
if [[ -n "$WIEK_DEV_INDEX" && $CHECK_ONLY -eq 0 ]]; then
  uv run --no-sync python -m wiek_bench.wiek_release activate-external "$WIEK_DEV_INDEX"
fi
uv run --no-sync python -c 'from wiek_bench.config import load_config; c=load_config("config.yaml"); print("Wiek evaluation configuration ready:", c.run.browser_tool)'
echo 'Model/account evaluation is explicit; no paid run was started.'
