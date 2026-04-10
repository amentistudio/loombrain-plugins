#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="$HOME/.loombrain-sessions"
mkdir -p "$STATE_DIR"

# Clean up stale temp files (older than 1 hour) from prior crashed captures
find "$STATE_DIR" -name '.stdin.*.json' -mmin +60 -delete 2>/dev/null || true

# Buffer stdin to a temp file — background processes lose access to stdin
STDIN_FILE="$STATE_DIR/.stdin.$$.json"
cat > "$STDIN_FILE"

# Launch bun detached from Claude Code's process group:
#   nohup  → ignore SIGHUP when parent exits
#   &      → background the process
#   disown → remove from shell job table
nohup bun run "$SCRIPT_DIR/src/capture-hook.ts" --stdin-file "$STDIN_FILE" \
  </dev/null >>"$STATE_DIR/capture.log" 2>&1 &
disown

exit 0
