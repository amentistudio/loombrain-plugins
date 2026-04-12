# LoomBrain Sessions

Auto-capture Claude Code sessions to [LoomBrain](https://loombrain.com) episodic memory.

Every meaningful coding session is automatically saved when you exit or `/clear`, building a searchable knowledge base of your development decisions, debugging trails, and implementation approaches.

## Features

- Automatic capture on session end (SessionEnd hook)
- Catchup recovery on session start (SessionStart hook) — recovers sessions lost to CTRL+C, kill, or crashes
- JSONL-to-EpisodeEvent conversion with full line type mapping
- Large session splitting (250 events / 1.8MB per chunk)
- Git remote detection for automatic project tagging
- Direct API integration (no `lb` CLI required)
- Per-session lockfile deduplication (safe against double-firing hooks)
- Idempotency guard for duplicate prevention
- Auth failure cooldown (1h backoff)
- Persistent error logging

## Prerequisites

- [Bun](https://bun.sh) runtime installed
- A [LoomBrain](https://loombrain.com) account with episodic memory enabled

## Installation

```bash
# Add the LoomBrain marketplace
/plugins marketplace add amentistudio/loombrain-plugins

# Install the sessions plugin
/plugin install loombrain-sessions

# Log in to your LoomBrain account
/lb:login
```

**Important:** Without logging in, the plugin installs but sessions are silently lost. Always run `/lb:login` after installation.

## Configuration

Run `/lb:login` to authenticate. It supports two methods:

### Option A: Browser login (recommended)

`/lb:login` opens your browser to `app.loombrain.com` and completes authentication automatically. Credentials are saved to `~/.config/loombrain/config.json`.

### Option B: API key

1. Go to [app.loombrain.com/settings/api-keys](https://app.loombrain.com/settings/api-keys)
2. Create a new API key
3. Add to your shell profile:

```bash
export LB_TOKEN="your-api-key-here"
```

### Verify Setup

```
/lb:capture-status
```

## Commands

### `/lb:login`

Log in to LoomBrain. Opens a browser for authentication or guides you through setting an API key. Without logging in, captured sessions are silently lost.

### `/lb:capture-session`

Verify that the capture pipeline is correctly configured. Checks auth, hook registration, and API connectivity.

### `/lb:capture-status`

View capture health: recent log entries, captured session count, and auth status.

## How Capture Works

### SessionEnd (clean exit)

1. When a Claude Code session ends (`/exit`, `Ctrl+D`, `/clear`), the `SessionEnd` hook fires
2. The hook reads the session JSONL transcript
3. Lines are converted to `EpisodeEvent` format (user, assistant, tool_call, tool_result, system)
4. Thinking blocks and metadata are stripped
5. Sessions with fewer than 5 meaningful events are skipped
6. Large sessions are split into chunks (250 events / 1.8MB each)
7. Each chunk is POSTed to the LoomBrain API
8. Git remote URL is used for automatic project tagging

### SessionStart catchup (crash recovery)

When Claude Code exits via CTRL+C, SIGTERM, or crash, `SessionEnd` never fires and the session is lost. The `SessionStart` catchup hook recovers these orphaned sessions:

1. On every new session start, the catchup hook scans `~/.claude/projects/*/*.jsonl`
2. Files modified within the last 7 days (30 days on first v0.3.0 run) are considered
3. Already-captured sessions, the active session, and recently-modified files (< 2 min) are skipped
4. Up to 20 orphans are uploaded per run (remaining are picked up on next session start)
5. Per-session lockfiles prevent double-uploads when hooks fire twice
6. A one-time resurrection scan re-uploads sessions that were falsely marked as captured by v0.2.0

### Deduplication

- Per-session lockfiles (`.lock.<session_id>`) prevent concurrent uploads of the same session
- Idempotency tracking via `captured-sessions` file prevents re-uploads across runs
- The API is idempotent on `session_id`, so duplicate attempts are harmless

## State Files

- `~/.loombrain-sessions/captured-sessions` — idempotency tracking
- `~/.loombrain-sessions/capture.log` — error log (100KB max)
- `~/.loombrain-sessions/.lock.<session_id>` — per-session lockfiles (transient)
- `~/.loombrain-sessions/.success.<session_id>` — upload success markers
- `~/.loombrain-sessions/.v3-marker` — first-run sentinel for v0.3.0
- `~/.loombrain-sessions/.auth-cooldown-until` — auth failure cooldown (auto-expires)

## Development

```bash
cd plugins/loombrain-sessions
bun install
bun test              # Run tests
bun run validate      # Validate plugin manifest
```

## License

MIT
