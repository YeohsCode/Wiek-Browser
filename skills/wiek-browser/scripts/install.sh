#!/bin/sh
set -eu
WIEK_SEARCH_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
while [ ! -f "$WIEK_SEARCH_ROOT/cli/wiek-browser.mjs" ]; do
  if [ "$WIEK_SEARCH_ROOT" = / ]; then
    echo 'Run this installer from a Wiek source checkout or application package.' >&2
    exit 1
  fi
  WIEK_SEARCH_ROOT=$(dirname -- "$WIEK_SEARCH_ROOT")
done
exec node "$WIEK_SEARCH_ROOT/cli/wiek-browser.mjs" install
