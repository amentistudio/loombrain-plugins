---
description: Catchup scan for orphaned session transcripts
---

# SessionStart: Catchup

On every session start, scans for orphaned JSONL transcripts that were never uploaded (e.g., from CTRL+C exits) and uploads them to LoomBrain.

- Scans `~/.claude/projects/*/*.jsonl` for files modified within the last 7 days (30 days on first v0.3.0 run)
- Skips already-captured sessions, the active session, and recently-modified files (quiescence window)
- Uploads at most 20 orphans per run to avoid rate limiting
- Runs asynchronously — does not block session startup
