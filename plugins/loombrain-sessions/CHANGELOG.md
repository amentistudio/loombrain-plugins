# Changelog

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
