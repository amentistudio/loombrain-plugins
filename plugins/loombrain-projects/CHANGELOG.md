# Changelog

## [0.1.0] - 2026-05-17

### Added
- Initial release
- `/lb:project-status` — read-only briefing that surfaces vision, active goals, top open tasks, and pending-review tasks for the PARA project matching the current working directory
- `/lb:project-backfill` — gap-fill interview for existing PARA projects that lack purpose, vision link, goals, or tasks; surgical (only asks about gaps, never re-asks coverage that already exists)
- `/lb:project-kickoff` — bootstrap wizard for brand-new PARA projects (creates project + links to vision + sets 1-3 goals + seeds initial tasks)
- `/lb:weekly-review` — guided triage over `lb_review_tasks` output (pending-review compound-score-flagged tasks first, then overdue/stale, plus goal-without-tasks audit)
- `/lb:session-retro` — end-of-session distill interview that closes completed tasks, captures new tasks, records goal progress, and optionally calls `lb_episode_capture`

### Notes
- All commands wrap existing LoomBrain MCP tools — no MCP surface changes
- No methodology framework imposed (no OKR/SMART/BHAG); goal/task fields stay free-form per project preference
- Commands-only plugin; no hooks
