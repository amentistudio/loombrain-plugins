---
name: loombrain-session-capture
description: Auto-captures Claude Code sessions to LoomBrain episodic memory on session end
hooks:
  - event: SessionEnd
---

# LoomBrain Session Capture Hook

Automatically captures Claude Code sessions to LoomBrain when a session ends (via `/clear`, logout, or exit).

## How it works

1. Claude Code fires `SessionEnd` event with `session_id`, `transcript_path`, and `cwd` on stdin.
2. The hook reads the session JSONL transcript and converts lines to `EpisodeEvent` format.
3. Sessions with fewer than 5 meaningful events (user + assistant) are silently skipped.
4. Large sessions are split into chunks of 250 events / 1.8MB each.
5. Each chunk is POSTed directly to the LoomBrain API (`POST /api/v1/captures`).
6. Git remote URL is extracted for automatic project tagging (`para_hint`).
7. An idempotency guard prevents duplicate captures.

## Configuration

The hook is registered via `plugin.json` and runs asynchronously with a 120-second timeout.

Auth is resolved from (in order):
1. `LB_TOKEN` or `LB_API_KEY` environment variable
2. `~/.config/loombrain/config.json` (created by `lb login`)

## Error handling

- All errors are logged to `~/.loombrain-sessions/capture.log`
- The hook always exits 0 — it never blocks session exit
- Failed chunks can be retried (idempotency tracks per-chunk, not per-session)
