#!/usr/bin/env bash
# SessionStart context loader. Hook must always exit 0.
# Prints a LoomBrain project-context block to stdout (injected into the session).
# stdin (the hook JSON with cwd) flows through to the script; stdout is preserved.
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

bun run "$SCRIPT_DIR/src/load-context.ts" 2>/dev/null || true

exit 0
