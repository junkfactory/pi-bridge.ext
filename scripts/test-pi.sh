#!/usr/bin/env bash
# Launch pi with isolated config, loading the local pi-bridge.ext extension
# plus any system extensions passed as arguments.
# Does not touch ~/.pi/agent or system config.
#
# Usage:
#   ./scripts/test-pi.sh                          # only pi-bridge.ext
#   ./scripts/test-pi.sh pi-subagents             # + pi-subagents by short name
#   ./scripts/test-pi.sh /path/to/ext/dist/index.js  # + explicit path
#   PI_BRIDGE_LOG_LEVEL=debug ./scripts/test-pi.sh
#
# Short names are resolved from ~/.pi/agent/ (npm/, git/ subdirs).
# The extension is loaded via jiti (TypeScript on-the-fly), no build step needed.
# After edits to src/, just restart this script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
PI_AGENT_DIR="${HOME}/.pi/agent"

# Use system config dir for auth/models, but --no-extensions prevents
# system extensions from loading. Only explicitly -e'd extensions run.
export PI_CODING_AGENT_DIR="${HOME}/.pi/agent"

# Log file location (extension reads PI_BRIDGE_LOG_LEVEL env var)
export PI_BRIDGE_LOG_LEVEL="${PI_BRIDGE_LOG_LEVEL:-debug}"

# Build extension args: always include local pi-bridge.ext
EXT_ARGS=(-e "$EXT_DIR/src/index.ts")

# Resolve extra extensions from arguments
for arg in "$@"; do
  if [[ -f "$arg" ]]; then
    # Explicit path
    EXT_ARGS+=(-e "$arg")
  else
    # Short name — search ~/.pi/agent for matching extension
    found=""
    for candidate in \
      "$PI_AGENT_DIR/npm/node_modules/$arg/dist/index.js" \
      "$PI_AGENT_DIR/npm/node_modules/$arg/src/index.ts" \
      "$PI_AGENT_DIR/git/$arg/dist/index.js" \
      "$PI_AGENT_DIR/git/$arg/src/index.ts"; do
      if [[ -f "$candidate" ]]; then
        found="$candidate"
        break
      fi
    done
    # Also search by partial match in npm/git subdirs
    if [[ -z "$found" ]]; then
      while IFS= read -r -d '' match; do
        found="$match"
        break
      done < <(find "$PI_AGENT_DIR/npm" "$PI_AGENT_DIR/git" -path "*/$arg/*/index.js" -o -path "*/$arg/*/index.ts" -print0 2>/dev/null || true)
    fi
    if [[ -z "$found" ]]; then
      echo "Warning: could not resolve extension '$arg'" >&2
    else
      EXT_ARGS+=(-e "$found")
    fi
  fi
done

echo "=== pi-bridge.ext test harness ==="
echo "Config dir: $PI_CODING_AGENT_DIR"
echo "Extensions:"
for ((i=0; i<${#EXT_ARGS[@]}; i+=2)); do
  echo "  ${EXT_ARGS[$((i+1))]}"
done
echo "Log level:  $PI_BRIDGE_LOG_LEVEL"
echo "Log file:   ~/.pi/agent/pi-bridge.log"
echo "=================================="

exec pi \
  --no-extensions \
  --no-skills \
  --no-context-files \
  --no-themes \
  --no-prompt-templates \
  "${EXT_ARGS[@]}"
