# Deferred Work

Items that are out of scope for current plans but should be revisited.

## Stop hook for near-live session capture
Why: Current v0.3.0 plan uses SessionStart catchup (eventual consistency, up to a session-length latency). A Stop hook firing after each assistant turn would reduce the loss window to seconds, not full sessions.
Context: Deferred from `plans/plugin-session-capture-resilience.md`. Needs byte-offset idempotency (bigger change than session-id idempotency) and interaction with the "hooks stop after 2.5h" bug (anthropics/claude-code#16047).
Dependencies: Byte-offset idempotency support, clarity on Claude Code Stop hook input schema.

## Byte-offset incremental upload
Why: Allows uploading partial sessions safely, which unblocks live-session catchup without quiescence deferral.
Context: Current plan uploads whole sessions keyed by session_id. An offset-tracking scheme (`~/.loombrain-sessions/offsets.json` → `{session_id: last_byte_offset}`) would enable delta uploads.
Dependencies: LoomBrain API support for partial-session merge OR accept duplicate-uploads-collapsed-server-side; agreement on idempotency model.

## XDG state directory migration
Why: `~/.loombrain-sessions/` is a non-standard state location; XDG convention is `~/.local/state/loombrain-sessions/`.
Context: Current plan keeps `~/.loombrain-sessions/` to avoid a migration shim. A later release could move the state dir with one-shot migration.
Dependencies: None.

## Windows support for loombrain-sessions plugin
Why: Expand user base; currently macOS/Linux only.
Context: `capture-wrapper.sh` and `catchup-wrapper.sh` are bash scripts; `flock` was in the original plan but removed in favor of Node-side locks. The real blocker is that Claude Code hooks on Windows have different stdin semantics (anthropics/claude-code#36156).
Dependencies: Upstream fix or workaround for Windows hook stdin; PowerShell wrapper equivalents.

## `/lb:capture-status` catchup metrics
Why: Users debugging "is catchup working" currently need to grep `capture.log`. A richer status command would surface catchup scan counts, last run timestamp, deferred files, cooldown state.
Context: Deferred from `plans/plugin-session-capture-resilience.md`. Low priority but improves operator experience.
Dependencies: v0.3.0 catchup module shipping first.

## Gemini blindspot re-review of plugin and backend plans
Why: Both plans were reviewed only by Codex (GPT-5.3-Codex xhigh). Gemini 3 Pro returned 429 "exhausted capacity" across 10 retries on 2026-04-11. A second opinion would strengthen the plans.
Context: Rerun `timeout 300 gemini -m gemini-3-pro-preview --approval-mode yolo "..."` with the plan cat'd in when API capacity returns. Findings go into the Blindspot Review section of each plan.
Dependencies: Gemini API capacity availability.

## Delete episodic_memory_flag_archive table (30-day retention)
Why: The backend migration plan creates an archive table to make rollback restorable. This table should be cleaned up after a 30-day retention window.
Context: Deferred from `plans/backend-remove-episodic-memory-flag.md` Phase 5. Track as a separate operational follow-up ticket.
Dependencies: Backend migration executed and stable for 30 days.

## Periodic pruning of captured-sessions for deleted transcripts
Why: Currently `captured-sessions` grows monotonically; session_ids whose JSONL files have been deleted by the user stay in the file forever.
Context: Deferred from `plans/plugin-session-capture-resilience.md`. Low priority — rotation at 1000 entries already bounds growth.
Dependencies: None.

## `LB_PAUSE=1` env var to temporarily disable uploads
Why: Users may want to mute uploads temporarily without uninstalling.
Context: Deferred from `plans/plugin-session-capture-resilience.md`. Would need wrapper scripts to check the env var early and exit 0.
Dependencies: None.
