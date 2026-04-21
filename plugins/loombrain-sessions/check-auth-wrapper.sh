#!/usr/bin/env bash
# Sync auth-status check. Hook must always exit 0.
# Prints warning to stdout when session capture is unauthenticated.
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

bun run "$SCRIPT_DIR/src/check-auth.ts" 2>/dev/null || true

exit 0
