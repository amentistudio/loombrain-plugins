# Changelog

## [0.7.0] - 2026-06-25

### Added
- SessionStart hook now also injects the **open question set** alongside project context — fetches the user's open questions via `GET /api/v1/questions?status=open&limit=8` and renders them as a markdown block (`## ❓ Open questions you're chasing`), one line per question with an `(N bearing on it)` suffix when captures are linked, so each session opens knowing what the user is actively trying to figure out
- `fetchOpenQuestions` + `buildQuestionsBlock` in `src/load-context.ts`; context and questions are fetched in parallel, and the question render is capped to the requested limit so an over-returning server can't flood session-start context
- `QuestionsApiResponse` + a minimal question item type in `src/types.ts`

### Notes
- Best-effort and non-blocking, same contract as the existing context fetch — every failure path (no auth, network error, timeout, no questions) stays silent and never blocks startup
- Requires the `/api/v1/questions` route on the LoomBrain API (amentistudio/loombrain.com#554); end-to-end works once both ship

## [0.6.0] - 2026-06-22

### Added
- SessionStart hook that injects LoomBrain project context at the start of every session — derives a topic from the working directory, fetches the top-ranked knowledge nodes via `POST /api/v1/context`, and prints them (with the matched PARA project) so the brain shows up automatically instead of needing to be queried (#13)
- Context block points the agent at `lb_recall(...)` for a synthesized answer and `lb_get_original(node_id)` for full source
- `src/load-context.ts` (`deriveTopic`, `fetchContext`, `buildContextBlock`, `main`) and `load-context-wrapper.sh` hook entry; never blocks startup — every failure path (no auth, no project match, network error, timeout) exits silently (6s fetch budget, 10s hook timeout)

### Fixed
- `deriveTopic` strips a trailing domain TLD (`loombrain.com` → `loombrain`, `iamladi.dev` → `iamladi`) so domain-named project folders search for the project, not the literal folder name — the suffix diluted the topic match and injected scattered, unrelated nodes (#14)

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
