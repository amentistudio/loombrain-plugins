# Changelog

## [0.5.0] - 2026-04-21

### Added
- SessionStart hook that surfaces a visible warning when the user is not logged in — prevents the silent-failure window where sessions are lost because auth is missing or stale
- UserPromptSubmit hook as belt-and-suspenders: re-warns once per session if auth is still missing (deduped via marker file in state dir)
- `src/check-auth.ts` with pure `checkAuth()` function (env var priority, config file parse, 30-day refresh-token staleness detection) and `shouldWarnOnce()` session-scoped dedupe
- `check-auth-wrapper.sh` sync wrapper (5s timeout) invoked by both hooks

### Notes
- Hooks are read-only and do not scan transcripts, do not re-upload anything, and do not reintroduce catchup/resurrection logic removed in 0.4.0
- `stale` state only triggers when config has been expired > 30 days (refresh-token lifetime); access-token expiry is handled transparently by the existing refresh flow in `api-client.ts`

## [0.4.0] - 2026-04-12

### Removed
- **BREAKING:** SessionStart hook and catchup system (orphan recovery + resurrection scan) — caused backend flooding with duplicate entries
- `parseMode()` and `--mode start` CLI argument

### Changed
- Session capture is now forward-only: captured at session end, missed sessions are not retried
- Session titles now include repo name: "loombrain: Claude Code session (part 1 of 3)" instead of generic "Claude Code session (part 1 of 3)"

## [0.3.0] - 2026-04-12

### Fixed
- CTRL+C exits no longer lose sessions — SessionStart catchup scans for orphaned transcripts
- Converter now handles tool_result with array content blocks (was causing `400 expected string` API errors)
- Root session only marked as captured when ALL chunks succeed (was unconditionally marking even on partial failures)

### Added
- SessionStart hook for automatic catchup of missed sessions
- Per-session lockfile deduplication (prevents double-uploads from hook double-firing)
- Auth failure cooldown (1h backoff on consecutive auth failures)
- Batch cap (max 20 orphan uploads per catchup run)
- Structured catchup logging (`Catchup scan: scanned=N, orphans=M, uploaded=K, deferred=D, failed=F`)
- One-time resurrection scan for v0.2.0 false-captured sessions

### Removed
- Dead `episodic_memory` detection in API client

## [0.2.0] - 2026-04-10

### Fixed
- Session capture lost on Claude Code exit — capture process now detaches from parent process group via nohup/disown so it survives exit

### Added
- `logInfo` for observability — capture hook now logs startup and completion events
- `--stdin-file` argument for reliable stdin buffering across process boundaries
- Stale temp file cleanup (>1 hour) in capture wrapper

## [0.1.0] - 2026-04-09

### Added
- Initial release
- SessionEnd hook for auto-capturing Claude Code sessions
- JSONL-to-EpisodeEvent converter with full line type mapping
- Event chunking (≤250 events, ≤1.8MB per chunk)
- Direct LoomBrain API client with token refresh
- Git remote project detection for auto-tagging
- Idempotency guard for duplicate prevention
- `/lb:capture-session` command for config verification
- `/lb:capture-status` command for health checks
