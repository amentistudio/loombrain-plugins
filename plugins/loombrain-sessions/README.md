# LoomBrain Sessions

Two-way bridge between Claude Code and your [LoomBrain](https://loombrain.com) second brain:

- **Write** — every meaningful coding session is automatically captured to episodic memory when you exit or `/clear`, building a searchable record of your decisions, debugging trails, and approaches.
- **Read** — every session *starts* with your brain already in context: the relevant project knowledge and the open questions you're actively chasing are injected automatically, so you don't have to remember to ask.

## Features

### Session capture — `SessionEnd`

- Automatic capture of meaningful sessions on exit, `Ctrl+D`, or `/clear`
- JSONL transcript → `EpisodeEvent` conversion (user, assistant, tool_call, tool_result, system); thinking blocks and metadata stripped
- Trivial sessions (fewer than 5 meaningful events) are skipped
- Large sessions split into chunks (250 events / 1.8MB each)
- Git remote detection for automatic project tagging
- Runs detached and non-blocking — never delays shutdown
- Per-session lockfile deduplication + idempotency guard; the API is also idempotent on `session_id`, so retries are harmless

### Session-start injection — `SessionStart`

- **Auth warning** — a visible warning when you're not logged in, or when your token expired more than 30 days ago (refresh will fail). Keeps sessions from being silently lost.
- **Project context** — derives a topic from the working directory, fetches the top-ranked knowledge nodes (`POST /api/v1/context`), and prints them with the matched PARA project so the brain shows up automatically. Points you at `lb_recall(...)` for a synthesized answer and `lb_get_original(node_id)` for full source.
- **Open questions** — fetches your open question set (`GET /api/v1/questions?status=open&limit=8`) and renders "what you're chasing", one line per question with an `(N bearing on it)` suffix when captures are linked.
- Every injection is best-effort and **never blocks startup** — no auth, no project match, a network error, a timeout, or no results all exit silently.

### Prompt-time auth guard — `UserPromptSubmit`

- Belt-and-suspenders: re-warns once per session if auth is still missing (deduped via a session-scoped marker), so the warning isn't missed if it scrolled past at startup.

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

**Important:** Without logging in, the plugin installs but sessions are silently lost and nothing is injected at session start. Always run `/lb:login` after installation.

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

## How it works

### SessionEnd — capture

1. When a Claude Code session ends (`/exit`, `Ctrl+D`, `/clear`), the `SessionEnd` hook fires and launches the capture detached (`nohup`/`disown`) so it can't delay shutdown.
2. The hook reads the session JSONL transcript and converts lines to `EpisodeEvent` format; thinking blocks and metadata are stripped.
3. Sessions with fewer than 5 meaningful events are skipped.
4. Large sessions are split into chunks (250 events / 1.8MB each).
5. Each chunk is POSTed to the LoomBrain API, tagged with the git remote URL for the project.

> Capture is **forward-only**: only sessions that end while the hook is installed are captured. The catchup/resurrection scan present in 0.2–0.3 was removed in 0.4.0.

### SessionStart — auth, context, and questions

1. The auth check runs first and warns if you're logged out or your token is stale (> 30 days past expiry).
2. In parallel, two best-effort fetches run: project context (when a topic is derivable from the working directory) and your global open question set (always).
3. The context block and the questions block are printed to stdout, where Claude Code adds them to the session. Any failure path produces no output for that section and never blocks startup.

### Deduplication

- Per-session lockfiles (`.lock.<session_id>`) prevent concurrent uploads of the same session
- Idempotency tracking via the `captured-sessions` file prevents re-uploads across runs
- The API is idempotent on `session_id`, so duplicate attempts are harmless

## State Files

All under `~/.loombrain-sessions/` unless noted:

- `~/.config/loombrain/config.json` — auth credentials (written by `/lb:login`)
- `captured-sessions` — idempotency tracking
- `capture.log` — capture error log
- `.lock.<session_id>` — per-session lockfiles (transient)
- `.success.<session_id>` — upload success markers
- `.stdin.<pid>.json` — transient stdin buffer for the detached capture (auto-cleaned after 1h)

## Development

```bash
cd plugins/loombrain-sessions
bun install
bun test                  # Run tests
bun run validate          # Validate plugin manifest + README commands
bun run validate:versions # Check plugin.json / package.json / CHANGELOG versions match
```

## License

MIT
