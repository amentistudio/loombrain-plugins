#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
exec bun run "$(dirname "$0")/src/capture-hook.ts" "$@"
