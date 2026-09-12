#!/usr/bin/env bash
# Create a throwaway project for manual pi-bridge repro/testing, with an
# isolated ext log via PI_BRIDGE_LOG_FILE.
#
# test-pi.sh and test-nvim.sh are interactive (TUI apps) — launch them
# yourself in separate terminals from the created directory. This script
# only scaffolds the project and prints the exact commands (absolute
# paths, so they work from any cwd).
#
# Usage:
#   ./scripts/create-test-repro-project.sh                 # /tmp/bridge-repro
#   ./scripts/create-test-repro-project.sh /tmp/my-repro   # custom dir
#
# Teardown when done:
#   rm -rf <dir>    # also removes the isolated pi-bridge log inside it

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
REPO_DIR="$(dirname "$EXT_DIR")"
PI_SH="$EXT_DIR/scripts/test-pi.sh"
NVIM_SH="$REPO_DIR/pi-bridge.nvim/scripts/test-nvim.sh"

DIR="${1:-/tmp/bridge-repro}"

if [[ -e "$DIR" ]]; then
	echo "warning: $DIR already exists — sample.js will be reset, log kept" >&2
fi

mkdir -p "$DIR"
printf 'const x = 1\n' >"$DIR/sample.js"

echo "=== test repro project ==="
echo "Dir:        $DIR"
echo "Sample:     $DIR/sample.js  (const x = 1)"
echo "Ext log:    $DIR/pi-bridge.log"
echo "=========================="
echo
echo "Terminal 1 — pi (loads local pi-bridge.ext/src, isolated log):"
echo "  PI_BRIDGE_LOG_FILE=$DIR/pi-bridge.log \\"
echo "    $PI_SH"
echo
echo "Terminal 2 — nvim (loads local pi-bridge.nvim, isolated XDG state):"
echo "  cd $DIR"
echo "  XDG_STATE_HOME=$DIR/nvim-state \\"
echo "    $NVIM_SH sample.js"
echo
echo "Then in nvim:  :PiBridge change const to let and add a comment"
echo "Teardown:      quit both, then rm -rf $DIR"
