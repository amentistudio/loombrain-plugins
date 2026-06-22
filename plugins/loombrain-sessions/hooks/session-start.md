---
description: Catchup scan for orphaned session transcripts
---

# SessionStart: Catchup

On every session start, scans for orphaned JSONL transcripts that were never uploaded (e.g., from CTRL+C exits) and uploads them to LoomBrain.

- Scans `~/.claude/projects/*/*.jsonl` for files modified within the last 7 days (30 days on first v0.3.0 run)
- Skips already-captured sessions, the active session, and recently-modified files (quiescence window)
- Uploads at most 20 orphans per run to avoid rate limiting
- Runs asynchronously — does not block session startup

## SessionStart: Project context injection

On every session start, also loads relevant LoomBrain knowledge for the current
project and injects it into the session, so the brain shows up automatically
instead of needing to be queried.

- Derives a topic from the working directory (the project folder name)
- Calls `POST /api/v1/context` and prints the top-ranked nodes (title + why/summary) plus the matched PARA project
- Points the agent at `lb_recall(...)` for a synthesized answer and `lb_get_original(node_id)` for full source
- Skips silently when unauthenticated, when there is no project match, or on any network/timeout error — never blocks startup (6s fetch budget, 10s hook timeout)
