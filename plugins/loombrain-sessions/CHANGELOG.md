# Changelog

## [0.3.1] - 2026-04-12

### Changed
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
