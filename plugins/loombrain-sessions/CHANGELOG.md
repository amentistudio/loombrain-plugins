# Changelog

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
