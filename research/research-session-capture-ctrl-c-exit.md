---
date: 2026-04-11
git_commit: 36af559ffdbca382b29be64c80e681a3ab3c3bdc
branch: main
repository: amentistudio/loombrain-plugins
topic: Why v0.2.0 session capture still fails on double CTRL+C exit
tags: [loombrain-sessions, hooks, session-end, sigint, claude-code, capture-wrapper]
status: complete
last_updated: 2026-04-11
last_updated_by: Claude
---

# Research: Why v0.2.0 session capture still fails on double CTRL+C exit

## Research Question

After installing loombrain-sessions v0.2.0 (which was specifically released to fix "session capture lost on Claude Code exit"), sessions are still not being captured to the remote when the user exits Claude Code with a double CTRL+C. Why?

## Summary

**The v0.2.0 fix works, but it can only help on exit paths where Claude Code actually invokes the SessionEnd hook. Double CTRL+C is not one of those paths.**

Two independent facts combine to produce the observed behavior:

1. **v0.2.0's fix is about hook *survival*, not hook *invocation*.** The commit `13f6db9` "detach capture process so it survives Claude Code exit" modifies `capture-wrapper.sh` to buffer stdin to a temp file and launch the bun capture process via `nohup … & disown`. That protects a running capture from dying when Claude Code's process group is torn down. It does nothing to make Claude Code *start* the hook in the first place.

2. **Claude Code does not fire `SessionEnd` on SIGINT-based exits.** External research (anthropics/claude-code#29096) confirms "SessionEnd hooks only fire on interactive exits (`/exit`, `Ctrl+D`)." Double CTRL+C sends SIGINT to the Claude Code process, which exits immediately without invoking the hook at all. There is no hook process to protect with `nohup`/`disown` because no hook process is ever spawned.

The installed local log (`~/.loombrain-sessions/capture.log`) corroborates this: since v0.2.0 added the `"Capture hook started"` INFO line, only **2** such entries exist (both at timestamps consistent with clean `/exit` shutdowns). No log lines correspond to the user's double-CTRL+C exit attempts, which is exactly what you would expect if the hook was never invoked.

## Detailed Findings

### 1. What v0.2.0 actually changed

From `CHANGELOG.md`:

```
## [0.2.0] - 2026-04-10
### Fixed
- Session capture lost on Claude Code exit — capture process now detaches
  from parent process group via nohup/disown so it survives exit
```
— `plugins/loombrain-sessions/CHANGELOG.md:3-6`

The relevant change is entirely inside `capture-wrapper.sh`:

```bash
# Buffer stdin to a temp file — background processes lose access to stdin
STDIN_FILE="$STATE_DIR/.stdin.$$.json"
cat > "$STDIN_FILE"

# Launch bun detached from Claude Code's process group:
#   nohup  → ignore SIGHUP when parent exits
#   &      → background the process
#   disown → remove from shell job table
nohup bun run "$SCRIPT_DIR/src/capture-hook.ts" --stdin-file "$STDIN_FILE" \
  </dev/null >>"$STATE_DIR/capture.log" 2>&1 &
disown
```
— `plugins/loombrain-sessions/capture-wrapper.sh:12-22`

The bun entry point now reads its input from the temp file instead of a now-orphaned stdin:

```ts
export async function readHookInput(
    argv: string[],
    stdinStream: ReadableStream = Bun.stdin.stream(),
): Promise<HookInputResult> {
    const idx = argv.indexOf("--stdin-file");
    if (idx !== -1 && idx + 1 < argv.length) {
        const tempFile = argv[idx + 1];
        const raw = await readFile(tempFile, "utf-8");
        await unlink(tempFile).catch(() => {});
        return { raw, tempFile };
    }
    // Fall back to stdin
    const raw = await new Response(stdinStream).text();
    return { raw };
}
```
— `plugins/loombrain-sessions/src/capture-hook.ts:21-36`

**Interpretation (describing what the fix does, not what it should do):** The fix presumes the hook has already been invoked by Claude Code. It solves the problem that a *running* hook subprocess dies when its parent Claude Code process exits. It does not and cannot address the scenario where the hook is never invoked at all.

### 2. How the hook is registered

`plugin.json` registers a single `SessionEnd` hook that runs `capture-wrapper.sh` asynchronously with a 120-second timeout:

```json
"hooks": {
  "SessionEnd": [
    {
      "matcher": "",
      "hooks": [
        {
          "type": "command",
          "command": "${CLAUDE_PLUGIN_ROOT}/capture-wrapper.sh",
          "async": true,
          "timeout": 120
        }
      ]
    }
  ]
}
```
— `plugins/loombrain-sessions/.claude-plugin/plugin.json:27-41`

Claude Code is the only entity that decides whether to trigger this hook. If Claude Code does not fire `SessionEnd`, the wrapper script never runs, and none of the v0.2.0 changes apply.

### 3. What the installed version looks like

Confirmed the cache contains v0.2.0 at `~/.claude/plugins/cache/loombrain-plugins/loombrain-sessions/0.2.0/`:

```
$ ls ~/.claude/plugins/cache/loombrain-plugins/loombrain-sessions/
0.1.0
0.2.0
```

And the marketplace copy matches:

```json
{
  "name": "loombrain-sessions",
  "version": "0.2.0",
  ...
}
```
— `~/.claude/plugins/marketplaces/loombrain-plugins/plugins/loombrain-sessions/.claude-plugin/plugin.json`

The installed `capture-wrapper.sh` contains the `nohup … & disown` block and the `--stdin-file` argument, matching the source.

### 4. What the capture log tells us

`~/.loombrain-sessions/capture.log` is the persistent log written by `src/logger.ts`:

```ts
const STATE_DIR = join(homedir(), ".loombrain-sessions");
const LOG_FILE = join(STATE_DIR, "capture.log");
```
— `plugins/loombrain-sessions/src/logger.ts:5-6`

v0.2.0 added an INFO entry at the start of every invocation:

```ts
await logInfo(sessionId, "Capture hook started");
```
— `plugins/loombrain-sessions/src/capture-hook.ts:89`

Counting those lines on the current machine:

```
$ grep -c "Capture hook started" ~/.loombrain-sessions/capture.log
2

$ grep "Capture hook started" ~/.loombrain-sessions/capture.log | tail
[2026-04-11T19:39:18.732Z] [unknown] INFO: Capture hook started
[2026-04-11T19:51:13.851Z] [unknown] INFO: Capture hook started
```

Two invocations total under v0.2.0. Both were followed by `Processing session from …` INFO lines, confirming the hook proceeded past the stdin-read step — i.e., Claude Code *did* fire SessionEnd for those two events. For every double-CTRL+C exit the user performed, there is no corresponding `Capture hook started` line, which means `capture-wrapper.sh` was never launched by Claude Code for those exits.

### 5. Claude Code hook-invocation semantics on CTRL+C

The `hooks/session-end.md` documentation in the plugin itself describes the expected trigger conditions:

```
Automatically captures Claude Code sessions to LoomBrain when a session ends
(via `/clear`, logout, or exit).
```
— `plugins/loombrain-sessions/hooks/session-end.md:11`

Double CTRL+C is not listed. External research (see Code References, "External references") corroborates that Claude Code:

- Fires `SessionEnd` with `reason: "prompt_input_exit"` on CTRL+D / EOF at the prompt
- Fires `SessionEnd` with `reason: "clear"` on `/clear`
- Fires `SessionEnd` with `reason: "logout"` on logout
- Fires `SessionEnd` with `reason: "other"` as a catch-all for "process termination" — but there are **no confirmed reports** of this actually firing on SIGINT-initiated exits
- Does **not** fire `SessionEnd` when the process receives SIGINT (double CTRL+C), SIGTERM, or SIGKILL (anthropics/claude-code#29096)

`SessionHookInput` in the plugin currently does not model a `reason` field at all:

```ts
export interface SessionHookInput {
    session_id: string;
    transcript_path: string;
    cwd: string;
}
```
— `plugins/loombrain-sessions/src/types.ts:16-20`

(Documenting what IS: the plugin does not branch on `reason`, so even if a SIGINT-born invocation did arrive, the plugin would process it identically to any other invocation.)

### 6. A separate observation from the log (not the reported bug)

The log also shows that when the hook *does* run under v0.2.0, it runs to completion but uploads zero chunks:

```
[2026-04-11T19:39:18.732Z] [unknown] INFO: Capture hook started
[2026-04-11T19:39:18.734Z] [...] INFO: Processing session from /Users/iamladi/.claude/projects/.../82bbac2e-….jsonl
[2026-04-11T19:39:19.512Z] [...] ERROR: Episodic memory not enabled for this tenant
[2026-04-11T19:39:19.513Z] [...] INFO: Capture complete: 0/1 chunk(s) uploaded

[2026-04-11T19:51:13.851Z] [unknown] INFO: Capture hook started
[2026-04-11T19:51:13.852Z] [...] INFO: Processing session from .../0be99b27-….jsonl
[2026-04-11T19:51:14.280Z] [...] ERROR: API error 400: {"error":"Validation error", ...
  "path":["episode_events",6,"content"],"message":"Invalid input: expected string, received array"}
[2026-04-11T19:51:14.281Z] [...] INFO: Capture complete: 0/1 chunk(s) uploaded
```

These are distinct problems from the CTRL+C question and are documented here only as context for the full log state. They are:

- `Episodic memory not enabled for this tenant` — rejected by the LoomBrain API, `src/api-client.ts`
- `API error 400: … expected string, received array` — content-shape validation failure on a specific event, originating from converter output that leaves `content` as an array instead of a string

Neither error explains missing captures on double CTRL+C exits, because in those cases the hook never runs at all.

## Code References

Local (plugin source, commit `36af559`):

- `plugins/loombrain-sessions/.claude-plugin/plugin.json:27-41` — SessionEnd hook registration
- `plugins/loombrain-sessions/capture-wrapper.sh:12-22` — nohup/disown detach block (v0.2.0 fix)
- `plugins/loombrain-sessions/src/capture-hook.ts:21-36` — `readHookInput` with `--stdin-file` support
- `plugins/loombrain-sessions/src/capture-hook.ts:85-146` — main entry point, INFO logging for startup/completion
- `plugins/loombrain-sessions/src/types.ts:16-20` — `SessionHookInput` interface (no `reason` field)
- `plugins/loombrain-sessions/src/logger.ts:5-6` — log and state dir paths
- `plugins/loombrain-sessions/hooks/session-end.md:11` — documented trigger conditions (`/clear`, logout, exit)
- `plugins/loombrain-sessions/CHANGELOG.md:3-6` — v0.2.0 release notes

Installed locations on this machine:

- `~/.claude/plugins/cache/loombrain-plugins/loombrain-sessions/0.2.0/` — active cached install
- `~/.claude/plugins/marketplaces/loombrain-plugins/plugins/loombrain-sessions/` — marketplace copy, v0.2.0 confirmed
- `~/.loombrain-sessions/capture.log` — persistent capture log (state dir)
- `~/.loombrain-sessions/captured-sessions` — idempotency record file

External references (from web research):

- Claude Code hooks reference — https://code.claude.com/docs/en/hooks (canonical SessionEnd schema and `reason` values: `clear`, `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, `other`)
- anthropics/claude-code#29096 — "Graceful shutdown signal for headless sessions." Confirms SIGINT/SIGTERM kill the process without firing SessionEnd and orphan Bash tool child processes. Explicit quote: "SessionEnd hooks only fire on interactive exits (`/exit`, `Ctrl+D`)."
- anthropics/claude-code#41577 — "SessionEnd hooks killed before async completion." Confirms Claude Code does not wait for async hook subprocesses on clean exits either; the documented workaround is `nohup … & disown` (the approach v0.2.0 uses). Related to anthropics/claude-code#32712 on hook cancellation with "Request interrupted by user".
- anthropics/claude-code#6428 — Open bug: SessionEnd doesn't always fire on `/clear` (platform-dependent).

## Architecture Documentation

### Flow on a clean exit (e.g., `/exit`, `Ctrl+D`, `/clear`)

1. Claude Code fires the `SessionEnd` event and pipes a JSON payload (`session_id`, `transcript_path`, `cwd`) to the registered hook command via stdin.
2. `capture-wrapper.sh` runs under `set -euo pipefail`:
   - `cat > "$STATE_DIR/.stdin.$$.json"` buffers the payload to disk (`capture-wrapper.sh:14`).
   - `nohup bun run … --stdin-file "$STDIN_FILE" </dev/null >> capture.log 2>&1 &` starts the bun process in the background, redirecting its stdin from `/dev/null`, and `disown` removes it from the shell's job table (`capture-wrapper.sh:20-22`).
   - Because the bun process is disowned and `nohup` ignores SIGHUP, it continues running after Claude Code's process group is torn down.
3. The wrapper `exit 0`s immediately; Claude Code is free to exit.
4. The bun process reads the temp stdin file (`capture-hook.ts:25-30`), deletes it, then runs `main()`:
   - Parses JSONL, counts meaningful events, splits into chunks, resolves auth, posts each chunk to `POST /api/v1/captures`.
   - Logs an INFO line on start (`capture-hook.ts:89`) and an INFO line on completion summarising `uploaded/total` chunks (`capture-hook.ts:138-141`).
   - Always `process.exit(0)` at the end (`capture-hook.ts:150`).

### Flow on double CTRL+C

1. User presses CTRL+C once — Claude Code typically interrupts the current in-flight task.
2. User presses CTRL+C again — SIGINT is delivered to the Claude Code process. Claude Code exits.
3. No `SessionEnd` event is fired. `capture-wrapper.sh` is not invoked. The bun capture-hook process is not spawned. Nothing is written to `capture.log`.
4. The session transcript JSONL still exists under `~/.claude/projects/…/<session-id>.jsonl` (Claude Code writes it incrementally during the session), but the LoomBrain capture pipeline never sees it.

### Idempotency state

`~/.loombrain-sessions/captured-sessions` is the idempotency record, written by `src/idempotency.ts`. It is only appended to when a chunk or session is successfully uploaded. In the current log, `uploaded = 0` for every recent attempt, so no session IDs will have been added for v0.2.0 runs.

## Related Research

None pre-existing in `research/`. This is the first document in this folder.

## Open Questions

1. **Does Claude Code ever deliver `reason: "other"` for a SIGINT-initiated exit in practice?** The public docs list `"other"` as a catch-all for "process termination," but there are no confirmed reports of it actually firing on double CTRL+C in linked issues. This affects whether any hook-side handling is even possible without a Claude Code change.
2. **How does Claude Code handle double CTRL+C specifically vs. single?** The first CTRL+C is understood to interrupt in-progress work; the second is the force-exit signal. Whether these go through the same SessionEnd path as `/exit` internally is not documented in the public references found. Empirically (log evidence above), it does not.
3. **Is the `[unknown]` session_id seen in `"Capture hook started"` log lines expected?** The INFO line at `capture-hook.ts:89` runs *before* `sessionId` is reassigned from the parsed payload (`capture-hook.ts:94`), so the first INFO line will always be tagged `[unknown]`. This is descriptive only — documenting the current behavior, not evaluating it.
4. **Unrelated to the reported bug but surfaced by the log**: the API is returning `expected string, received array` for one of the event content fields, and separately `Episodic memory not enabled for this tenant`. These would cause captures to fail on clean exits too, independently of the CTRL+C question.
