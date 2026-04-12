---
title: "loombrain-sessions: resilient capture — catchup on SessionStart + converter fix"
type: Bug
issue: 6
research: ["research/research-session-capture-ctrl-c-exit.md"]
status: Ready for Implementation
reviewed: true
reviewers: ["codex"]
reviewers_skipped: ["gemini (API capacity exhausted 2026-04-11)"]
created: 2026-04-11
last_updated: 2026-04-11
---

# PRD: loombrain-sessions — resilient session capture with SessionStart catchup

## Metadata
- **Type**: Bug (with bundled converter fix and defensive hardening)
- **Priority**: High
- **Severity**: Major — every CTRL+C exit currently loses the session; every clean exit currently uploads 0 chunks (converter bug)
- **Estimated Complexity**: 6
- **Created**: 2026-04-11
- **Status**: Draft

## Overview

### Problem Statement

Two independent bugs are producing the same user-visible symptom — "my sessions aren't being saved":

**Bug 1 — CTRL+C 2x loses the session.** Claude Code does not fire `SessionEnd` on SIGINT-based exits (confirmed: anthropics/claude-code#29096). v0.2.0's `nohup/disown` fix only helps when the hook has already been invoked; it cannot help when the hook is never started. Any user who exits via double CTRL+C loses the session upload entirely. Evidence: `~/.loombrain-sessions/capture.log` shows zero `"Capture hook started"` entries for the user's recent CTRL+C exits while v0.2.0 was installed.

**Bug 2 — Converter returns 0/N uploaded on clean exits.** `src/converter.ts` does not stringify `tool_result` `content` when the JSONL line provides it as an array of content blocks. The untouched array propagates into the API payload, and the LoomBrain API rejects the request with `400 Validation error: expected string, received array`. This means every capture that contains at least one multi-block tool_result silently fails, returning `Capture complete: 0/1 chunk(s) uploaded`. Evidence: `~/.loombrain-sessions/capture.log` timestamps `[2026-04-11T10:44:24.754Z]`, `[2026-04-11T19:51:14.280Z]`, and three similar 400s from 2026-04-10.

**Combined effect:** Even if Bug 1 were fixed (via catchup), Bug 2 would still cause uploads to return 0. Both must ship together for the user to observe any captures succeeding.

**Expected behavior:**
1. Sessions are uploaded regardless of exit path (clean exit, double CTRL+C, kill -9, power loss, laptop-lid-close, `/clear`).
2. Uploads include all meaningful events without server-side validation failures.

**Actual behavior:**
1. Sessions are uploaded only on `/exit`, `Ctrl+D`, and `/clear` exit paths; lost on SIGINT/SIGTERM/SIGKILL/crash.
2. Even when uploaded, the API rejects payloads containing multi-block tool_results.

### Goals & Objectives

1. **No session loss within the recovery window**: Every meaningful session whose JSONL was modified within the last 7 days (30 days on first v0.3.0 run) eventually gets uploaded, regardless of how Claude Code exited — unless the session is still being written to, in which case it is deferred to a later catchup run. <!-- Addressed [Codex High]: narrowed goal to recovery window, explicit deferral of in-progress files -->
2. **Fix the existing idempotency bug**: `capture-hook.ts` currently marks the root session_id as captured even when `uploaded === 0` (line 137 runs unconditionally despite the misleading comment). This causes failed sessions to be permanently skipped by catchup. Fix: only mark root session captured when all chunks succeed. <!-- Addressed [Codex Critical]: failed sessions prematurely marked captured -->
3. **Fix the converter bug**: Every non-empty event in a session arrives at the API as a valid string, end-to-end.
4. **Defensive hardening against known Claude Code hook quirks**: The plugin tolerates double-firing hooks (#10871, #24115), hooks stopping after 2.5h (#16047), and `SessionStart` reliability issues (#10373, #19491) without producing duplicates or crashing.
5. **Stay within the existing architecture**: Reuse `converter`, `splitter`, `api-client`, `idempotency`, and `logger` modules. Do not introduce a long-running daemon.
6. **Remove plugin-side dead detection of the `episodic_memory` 403**: Once the backend flag is removed (separate plan), the plugin's string-match special case in `api-client.ts` becomes dead code.

### Success Metrics

- **Primary Metric**: For a user who alternates between `/exit` and double-CTRL+C exits, the ratio of uploaded sessions to total meaningful sessions on disk reaches ≥ 95% (measured by counting JSONL files in `~/.claude/projects/*/*.jsonl` vs. session IDs in `~/.loombrain-sessions/captured-sessions`).
- **Secondary Metrics**:
  - `Capture complete: N/N chunk(s) uploaded` (not `0/N`) for any clean-exit session that contains tool_results.
  - `~/.loombrain-sessions/capture.log` contains `Catchup scan` INFO entries on session startup.
- **Quality Gates**:
  - `bun test` passes with new unit tests for catchup, converter fix, and flock dedup.
  - `bun run validate` passes.
  - Manual test case "exit via CTRL+C, start new session, observe upload within 30s" succeeds.

## User Stories

### Story 1: CTRL+C exit should not lose work

- **As a**: Claude Code user who exits via double CTRL+C (habit, panic, or hung task)
- **I want**: My session to be uploaded to LoomBrain automatically
- **So that**: I don't have to re-teach myself a new exit habit, and I don't lose context on long research sessions
- **Acceptance Criteria**:
  - [ ] After exiting a session via double CTRL+C, starting a new Claude Code session triggers upload of the orphaned transcript within 60 seconds
  - [ ] The orphaned transcript is not re-uploaded on every subsequent SessionStart (idempotency holds)
  - [ ] The upload happens asynchronously — the user is not blocked waiting for it

### Story 2: Converter must round-trip tool_result content

- **As a**: Claude Code user whose sessions include tool calls with structured results
- **I want**: My captured sessions to successfully arrive at the LoomBrain API
- **So that**: My knowledge graph actually contains these sessions and I can search them later
- **Acceptance Criteria**:
  - [ ] Sessions containing tool_results with array `content` blocks upload successfully (no `400 expected string`)
  - [ ] Image blocks, text blocks, and mixed blocks inside tool_results are all flattened to a single string
  - [ ] No capture that previously returned `0/1` due to this bug continues to return `0/1`

### Story 3: Operator should see what catchup did

- **As a**: User debugging "why isn't my session captured"
- **I want**: Clear log entries for catchup runs
- **So that**: I can tell whether catchup found and processed my orphaned transcripts
- **Acceptance Criteria**:
  - [ ] `capture.log` contains a `Catchup scan: found N orphan(s), uploaded M/N` line per catchup run
  - [ ] Each orphan processed is logged with its session_id and outcome

## Requirements

### Functional Requirements

1. **FR-1: SessionStart catchup hook** — On every `SessionStart` event (any `source` including `startup`, `resume`, `clear`, `compact`), scan `~/.claude/projects/*/*.jsonl` for files modified within the last 7 days, filter out sessions already in the `captured-sessions` idempotency record, skip the currently-active session_id and any file with mtime within the last 120 seconds (quiescence rule), and upload each remaining orphan via the existing `processSession` + `postCapture` path. <!-- Addressed [Codex Critical]: in-progress session truncation — quiescence + active-session skip -->
   - Details: Reuse `capture-hook.ts`'s processing pipeline. Catchup logic lives in a new `src/catchup.ts`. A new `hooks/session-start.md` registers the hook.
   - Active session is identified from the SessionStart hook input's `session_id` field, passed through to `runCatchup()`.
   - Quiescence: `now - stat.mtime >= 120_000` ms. Files newer than 120s are deferred to the next catchup run. Rationale: guards against racing with concurrent live sessions from other terminals.
   - Priority: Must Have

2. **FR-2: Converter fix for array tool_result content** — When `JsonlLine.content` is an array of content blocks (or when a nested `tool_result` block's `content` is an array), flatten it to a single string before pushing the event. Text blocks become their `text`; non-text blocks become a placeholder like `[image]` or `[unknown: <type>]`.
   - Details: Fix in `src/converter.ts` at line 60-62 (top-level `tool_result`) and line 97 (nested `tool_result` inside user message). Update the `JsonlLine` interface to reflect that `content` may be an array or string. Add helper `stringifyToolResultContent(content: string | ContentBlock[]): string`.
   - Priority: Must Have

3. **FR-3: Node-side per-session lockfile for deduplication** — Before processing any single session_id (in either SessionEnd or catchup paths), acquire an atomic lockfile at `$STATE_DIR/.lock.<session_id>`. If the lock is already held and its PID is live, skip this session silently. If the lock is held but the PID is dead, reclaim and proceed. The lock is held inside the bun process, not in the wrapper shell — this ensures the lock lives as long as the upload work lives. <!-- Addressed [Codex High]: wrapper flock released before work finished; Codex High: catchup vs SessionEnd lock namespace race -->
   - Details: New helper `src/locks.ts` provides `withSessionLock(sessionId, fn)`. Implementation: `fs.open(path, "wx")` for atomic creation (POSIX O_EXCL), write PID + ISO timestamp, register `process.on("exit")` + signal handlers to unlink. On EEXIST: read file, check PID liveness via `process.kill(pid, 0)`, reclaim if dead (atomic replace via tmp+rename).
   - SessionEnd path: `withSessionLock(input.session_id, () => processSession(...))`
   - Catchup path: for each orphan, `withSessionLock(orphan.session_id, () => processSession(...))`
   - This replaces the previously-proposed shell `flock` entirely.
   - Must work on macOS and Linux; Windows is out of scope.
   - Priority: Must Have (production stability per #10871, #24115)

4. **FR-4: Remove dead client-side episodic_memory detection** — Delete the special-case in `src/api-client.ts:144-152` that matches `body.includes("episodic_memory")` and logs a different error. Once the backend flag is removed (separate plan), this code is unreachable.
   - Details: Keep the generic `403` handling but remove the `if (body.includes("episodic_memory"))` branch. Log generically.
   - Priority: Should Have (cosmetic cleanup, safe to ship)

5. **FR-5: Bounded catchup scope with first-run extension** — Catchup scan is limited to JSONL files whose `mtime` falls within the last 7 days AND whose size is > 0. On first v0.3.0 run (detected via absence of `~/.loombrain-sessions/.v3-marker`), the lookback extends to 30 days to recover orphans from the v0.2.0 buggy period. <!-- Addressed [Codex High]: goal/lookback contradiction -->
   - Details: Constants `CATCHUP_LOOKBACK_DAYS = 7`, `CATCHUP_FIRST_RUN_LOOKBACK_DAYS = 30`. After first successful catchup run, write `.v3-marker` atomically.
   - Priority: Must Have

6. **FR-6: Structured catchup logging** — Each catchup run writes one summary INFO line and one per-orphan INFO/ERROR line.
   - Details: Format: `Catchup scan: scanned=N, orphans=M, uploaded=K, deferred=D, failed=F`. Per orphan: `Catchup upload: <session_id> → OK` or `Catchup upload: <session_id> → ERROR: <msg>`. Log line per skipped-by-quiescence file: `Catchup defer: <session_id> (mtime too recent)`.
   - Priority: Should Have

7. **FR-7: Fix premature `markCaptured(sessionId)` bug** — Change `src/capture-hook.ts:137` so the root session_id is only added to the idempotency record when `uploaded === result.chunks.length`. The misleading comment ("if all chunks succeeded") currently hides an unconditional call. <!-- Addressed [Codex Critical]: failed sessions marked captured -->
   - Details: Wrap the `markCaptured(sessionId)` call in an `if (uploaded === result.chunks.length)`.
   - Priority: Must Have

8. **FR-8: One-time recovery pass for v0.2.0 false-captured entries** — On first v0.3.0 run (detected via absence of `.v3-marker`), after normal catchup completes, also run a "resurrection scan": for each JSONL in the extended 30-day window whose session_id IS in `captured-sessions`, check whether a corresponding success-marker file exists (`.success.<session_id>`). If not, it was likely a pre-v0.3.0 false-captured entry. Attempt re-upload; if the API is idempotent, duplicates are harmless; if not, the API rejects with 409 which we treat as success. <!-- Addressed [Codex Critical]: recovery of mis-marked entries -->
   - Details: After v0.3.0 every successful upload also writes `.success.<session_id>` marker. Resurrection scan only runs once (guarded by `.v3-marker`).
   - Risk: If the API is NOT idempotent on session_id, this could create duplicate captures. Open question below — BLOCKER until the backend engineer confirms.
   - Priority: Must Have (if API is idempotent) / Must Skip (if not)

9. **FR-9: Auth failure cooldown** — On consecutive auth failures (401 or 403), write a cooldown marker `~/.loombrain-sessions/.auth-cooldown-until` with an ISO timestamp 1 hour in the future. Subsequent catchup runs check this file and exit early if the cooldown is active. Successful auth resolution deletes the file. <!-- Addressed [Codex Medium]: persistent auth failure retry loop -->
   - Details: Cooldown is 1h; deleted on successful upload; logged both when set and when skipped.
   - Priority: Should Have

10. **FR-10: Catchup batch cap and rate-limit backoff** — A single catchup run uploads at most `CATCHUP_MAX_UPLOADS_PER_RUN = 20` orphans. On hitting a 429 from the API, catchup aborts the current batch (remaining orphans stay as orphans), logs the cap hit, and exits cleanly. The next SessionStart picks up where this run left off. <!-- Addressed [Codex Medium]: rate-limit burst handling -->
   - Details: Constant in `catchup.ts`. Process orphans in deterministic order (e.g., mtime descending → newest first) so bounded progress converges quickly on the most recent work.
   - Priority: Should Have

### Non-Functional Requirements

1. **NFR-1: Catchup must not block session startup**
   - Requirement: The SessionStart hook returns control to Claude Code within 100ms.
   - Target: Wrapper script (which buffers stdin, then `nohup ... & disown`) exits in < 100ms on cold cache.
   - Measurement: Time `capture-wrapper.sh` end-to-end with a fresh tmpdir. Manual benchmark documented in plan.

2. **NFR-2: Catchup must be idempotent across double-firing**
   - Requirement: When the same SessionStart hook fires twice (#10871, #24115), the plugin uploads each orphan exactly once.
   - Target: Concurrent executions produce zero duplicate API calls (verified by API returning same capture ID for the first, 409 or idempotent-response for the second — or no second call at all if flock holds).
   - Measurement: Integration test simulating double-fire.

3. **NFR-3: Catchup must tolerate corrupt/partial JSONL**
   - Requirement: A malformed line in one transcript does not crash the catchup batch or prevent other orphans from uploading.
   - Target: Each orphan processed in its own try/catch; partial uploads logged and skipped.
   - Measurement: Unit test feeding a batch with one valid and one corrupt file.

4. **NFR-4: State dir location must match existing plugin**
   - Requirement: Keep state in `~/.loombrain-sessions/` (do not migrate to XDG `~/.local/state/` in this plan, to avoid migration logic).
   - Target: No file path changes to `capture.log` or `captured-sessions`.
   - Measurement: Grep for `.loombrain-sessions` — no moves.

### Technical Requirements

- **Stack**: Bun runtime (TypeScript), bash for wrapper scripts. Existing plugin conventions.
- **Dependencies**: None new. All locking moves to Node-side `fs.open(path, "wx")` — no `flock` binary needed. <!-- Addressed [Codex Medium]: removed PID fallback fragility -->
- **Architecture**: Two separate wrapper scripts share the same downstream pipeline:
  - `SessionEnd` path (existing wrapper, unchanged): `capture-wrapper.sh` → `capture-hook.ts main(mode=end)` → `withSessionLock` → processSession → postCapture
  - `SessionStart` path (new wrapper): `catchup-wrapper.sh` → `capture-hook.ts main(mode=start)` → catchup.runCatchup() → for each orphan: `withSessionLock` → processSession → postCapture
  - Two wrappers avoid depending on unverified `plugin.json` `args` schema support. Each wrapper hard-codes its mode via argv. <!-- Addressed [Codex Medium]: hook args gate -->
  - Both paths reuse the same bun entry point and downstream modules.
- **Data Model**: No schema changes to the captured-sessions file. New: `.success.<session_id>` marker files per successful upload (written alongside captured-sessions). New: `.v3-marker` sentinel for first-run detection. New: `.auth-cooldown-until` optional marker.
- **API Contracts**: No changes. Uses existing `POST /api/v1/captures`. Plan assumes the API is idempotent on session_id — **blocker for FR-8 resurrection scan until confirmed**.

## Scope

### In Scope

- New `src/catchup.ts` module implementing orphan discovery, quiescence filter, batched upload, batch cap.
- New `src/locks.ts` module implementing `withSessionLock(sessionId, fn)` with atomic Node-side lockfiles.
- New `catchup-wrapper.sh` script (distinct from existing `capture-wrapper.sh`) for the SessionStart hook entry point.
- New `hooks/session-start.md` and `plugin.json` registration for SessionStart.
- Modified `src/capture-hook.ts`:
  - Add `--mode start|end` argv dispatch
  - **Fix bug**: wrap `markCaptured(sessionId)` on line 137 in `if (uploaded === result.chunks.length)`
  - Wrap both paths in `withSessionLock(...)`
- Modified `src/api-client.ts`: on successful upload, also write `.success.<session_id>` marker.
- Fix `src/converter.ts` `tool_result` array content handling.
- Removed `episodic_memory` string-match branch in `src/api-client.ts`.
- New unit tests: `__tests__/catchup.test.ts`, `__tests__/locks.test.ts`, extension to `__tests__/converter.test.ts`, extension to `__tests__/capture-hook.test.ts` for the markCaptured fix.
- CHANGELOG entry for v0.3.0 and version bump in `plugin.json` + `package.json`.
- README section explaining catchup behavior.

### Out of Scope

- **Backend feature flag removal** — tracked in separate plan `plans/backend-remove-episodic-memory-flag.md`.
- **Byte-offset-based incremental upload** — this plan uploads whole sessions keyed on session_id, matching existing idempotency. Incremental offset tracking is a future optimization.
- **Stop-hook-based live streaming** — deferred. Would reduce loss window to minutes but adds API pressure and dup-upload risk; catchup alone meets the correctness goal.
- **Windows support** — current plugin is macOS/Linux only; `flock` dep makes this explicit.
- **XDG state directory migration** (`~/.local/state/loombrain-sessions/`) — keep existing `~/.loombrain-sessions/`.
- **File watcher daemon** — out of scope per user decision; correctness is achieved without a daemon.

### Future Considerations

- Stop hook for near-live incremental upload (requires offset tracking).
- XDG state directory migration with one-shot migration on first run.
- Windows support via a Node-native lock library.
- Surface catchup outcomes via `/lb:capture-status` command.

## Impact Analysis

### Affected Areas

- `plugins/loombrain-sessions/capture-wrapper.sh` — add flock, add mode flag
- `plugins/loombrain-sessions/src/capture-hook.ts` — dispatch on mode
- `plugins/loombrain-sessions/src/catchup.ts` — new file
- `plugins/loombrain-sessions/src/converter.ts` — fix tool_result handling
- `plugins/loombrain-sessions/src/api-client.ts` — remove episodic_memory branch
- `plugins/loombrain-sessions/.claude-plugin/plugin.json` — add SessionStart hook entry, bump version
- `plugins/loombrain-sessions/package.json` — bump version
- `plugins/loombrain-sessions/hooks/session-start.md` — new hook doc
- `plugins/loombrain-sessions/hooks/session-end.md` — add note about catchup complement
- `plugins/loombrain-sessions/CHANGELOG.md` — v0.3.0 entry
- `plugins/loombrain-sessions/README.md` — explain catchup
- `plugins/loombrain-sessions/__tests__/catchup.test.ts` — new
- `plugins/loombrain-sessions/__tests__/converter.test.ts` — extended

Total: 12 files (≈ 4 new, 8 modified). Above the 8-file soft threshold; justified because multiple unrelated bugs are being fixed in one release.

### Users Affected

- All current loombrain-sessions users (v0.2.0 and earlier). No action required by users — new version is backwards compatible.

### System Impact

- **Performance**: Each SessionStart adds a background `find` + `stat` scan of `~/.claude/projects/*/*.jsonl` (bounded to last 7 days). On a machine with ~100 projects and ~500 recent sessions, this is sub-second. Upload itself is bounded by the idempotency filter — only orphans are uploaded. Additional API calls occur only when there are actual orphans.
- **Security**: Reads user transcript files — no new attack surface beyond what the existing SessionEnd hook already does. `flock` file paths are in the user's own `~/.loombrain-sessions/` dir.
- **Data Integrity**: Idempotency is preserved by session_id-based `captured-sessions` record. Double-fire is prevented by flock. Race window: between `isAlreadyCaptured` check and `markCaptured` write, two concurrent catchup runs for the same orphan could both upload — mitigated by flock per session_id (see FR-3).

### Dependencies

- **Upstream**: None (plugin is self-contained).
- **Downstream**: LoomBrain API `/api/v1/captures` endpoint — unchanged.
- **External**: `flock` binary (Linux native, macOS via `brew install flock` or shipped with util-linux).

### Breaking Changes

- [x] **None** — backwards compatible. New hook event is additive.
- Users who had v0.2.0 installed will receive v0.3.0 with SessionStart hook added; no config change needed.

## Steps to Reproduce (for Bugs)

**Bug 1 (CTRL+C loses session):**
1. Open Claude Code in a project with loombrain-sessions v0.2.0 installed and `/lb:login` completed.
2. Have a ≥5-event conversation with Claude.
3. Exit via double CTRL+C (not `/exit`).
4. Check `~/.loombrain-sessions/capture.log` — no new "Capture hook started" entry.
5. Check `~/.loombrain-sessions/captured-sessions` — the session_id of that conversation is NOT in the file.

**Expected**: Session is uploaded to LoomBrain.
**Actual**: Session is lost; never uploaded.

**Bug 2 (converter rejects on server):**
1. Open Claude Code with v0.2.0, have a conversation that includes a tool call with a structured result (e.g., web fetch with images, or any tool returning an array of content blocks).
2. Exit via `/exit` (clean exit).
3. Check `~/.loombrain-sessions/capture.log`.

**Expected**: `Capture complete: 1/1 chunk(s) uploaded`.
**Actual**: `API error 400: ... "expected":"string","code":"invalid_type","path":["episode_events",N,"content"],"message":"Invalid input: expected string, received array"` followed by `Capture complete: 0/1 chunk(s) uploaded`.

## Root Cause Analysis (for Bugs)

**Bug 1 — Why CTRL+C loses sessions:**

1. **Why was the session not uploaded?** Because the capture-wrapper.sh script was never invoked.
2. **Why was the wrapper never invoked?** Because Claude Code never fired the `SessionEnd` hook event.
3. **Why didn't SessionEnd fire?** Because the user exited via SIGINT (double CTRL+C), and Claude Code does not fire SessionEnd on SIGINT-based exits.
4. **Why doesn't Claude Code fire SessionEnd on SIGINT?** Per anthropics/claude-code#29096, SessionEnd is only fired on interactive exits (`/exit`, `Ctrl+D`, `/clear`); SIGINT/SIGTERM/SIGKILL exit the process without invoking the hook.
5. **Root Cause**: The plugin architecture depends entirely on a hook that Claude Code does not fire on all exit paths. **The plugin needs a second trigger that runs at a guaranteed moment** — the next session's SessionStart is the obvious choice because (a) it is reliably fired (with caveats, see Risks) and (b) it is called at a point where all orphaned transcripts from prior exits are already on disk.

**Bug 2 — Why the converter produces arrays instead of strings:**

1. **Why does the API return `expected string, received array` at `episode_events[N].content`?** Because the `content` field of an `EpisodeEvent` is being sent as an array.
2. **Why is it an array?** Because `src/converter.ts:60-62` does `const content = parsed.content ?? ""` and then calls `truncateContent(content)`; however, when the source JSONL has `parsed.content` as an array of content blocks (which Claude Code emits for tool_results with mixed text/image content), this array passes through to the payload unchanged.
3. **Why does the type system not catch this?** Because `JsonlLine.content` is typed as `content?: string` (line 19), but the actual JSONL values include array forms. The type is a lie.
4. **Why does `truncateContent` not throw?** Because `truncateContent` also does not guard its input type and produces whatever it received.
5. **Root Cause**: The converter's `JsonlLine` interface does not model the actual shape of Claude Code's transcript lines for tool_results, and no runtime coercion exists. **Fix**: type the field as `string | ContentBlock[]`, add a `stringifyToolResultContent()` helper that flattens arrays to strings, and route all tool_result branches through it.

## Solution Design

### Approach

**Architecture (high level):**

```
Claude Code lifecycle events
         │
         ├─── SessionEnd ────► capture-wrapper.sh --mode=end ──┐
         │                                                    │
         └─── SessionStart ──► capture-wrapper.sh --mode=start ┘
                                                               │
                                                               ▼
                                              flock -n $STATE_DIR/.lock.<id>
                                                               │
                                                               ▼
                                               nohup bun capture-hook.ts & disown
                                                               │
                                        ┌──────────────────────┴──────────────────────┐
                                        ▼                                             ▼
                                mode=end:                                      mode=start:
                                  processSession(1)                              catchup.runCatchup()
                                    → postCapture                                  → for each orphan:
                                                                                       processSession
                                                                                         → postCapture
```

**Flow details:**

1. **SessionEnd path (unchanged semantics)**: When Claude Code fires SessionEnd on `/exit`, `/clear`, or `Ctrl+D`, the wrapper buffers stdin, acquires a flock, and launches bun in detached mode. Bun reads the input, processes the single session, and uploads it. This is the fast, happy-path upload.

2. **SessionStart catchup path (new)**: When Claude Code fires SessionStart (on `startup`, `resume`, `clear`, or `compact`), the wrapper buffers stdin, acquires a flock (keyed on a special "catchup" ID), launches bun in detached mode. Bun dispatches to `runCatchup()` which:
   a. Reads `~/.loombrain-sessions/captured-sessions` into a Set.
   b. Globs `~/.claude/projects/*/*.jsonl` with `mtime > (now - 7d)`.
   c. For each file, extracts the session_id from the filename stem and skips if in the Set.
   d. For each orphan, reads the file, runs `processSession`, and uploads via `postCapture`.
   e. Logs a summary: `Catchup scan: found N orphan(s), uploaded M/N`.

3. **Dispatch in `capture-hook.ts`**: The existing `main()` becomes `runSessionEnd()`. A new `runSessionStart()` calls `catchup.runCatchup()`. The entry point inspects `process.argv` for a `--mode` flag or the parsed `hook_event_name` field and dispatches.

4. **Flock dedup**: Prevents double-firing hooks from producing duplicate uploads. Two keys: `.lock.end.<session_id>` for SessionEnd (scoped per session), `.lock.catchup.global` for SessionStart (only one catchup process at a time, globally). `flock -n` fails immediately if already held, so the script exits cleanly without retrying.

**Why this design (vs alternatives):**

- It reuses 100% of the existing upload pipeline — catchup is a thin orchestrator.
- It relies on data Claude Code already writes (the JSONL files), not on the SessionEnd hook being fired.
- It tolerates crashes: the transcript is on disk even if Claude Code segfaults.
- Catchup happens "eventually" rather than "immediately after crash", which is acceptable for a knowledge-graph use case (users don't need sub-second upload).

### Alternatives Considered

1. **Alternative 1: Stop hook periodic upload**
   - Pros: Sub-turn latency; near-live capture.
   - Cons: Fires on every assistant turn — 10-100x more hook invocations; needs byte-offset idempotency (bigger change); interacts with hooks stopping after 2.5h (#16047); no win over catchup for correctness.
   - Why rejected: Correctness doesn't need it; complexity is high.

2. **Alternative 2: Long-running file watcher daemon**
   - Pros: Truly real-time upload.
   - Cons: launchd/systemd installer + PID management + auto-restart state machine; user must trust a persistent background process; far more surface area.
   - Why rejected: Overkill for the correctness goal; catchup on next session start is adequate.

3. **Alternative 3: Wrap `claude` CLI in a shell script with SIGINT trap**
   - Pros: Captures exit cleanly.
   - Cons: Users must change how they launch Claude (friction); easy to bypass; trap alone cannot read the Claude Code transcript if it hasn't flushed; does not help if user invokes `claude` directly.
   - Why rejected: Distribution problem + incomplete coverage.

4. **Alternative 4: Rely on future Claude Code fix for SessionEnd on SIGINT**
   - Pros: No plugin changes.
   - Cons: Not committed by Anthropic; user loses sessions in the meantime; related issues are still open (#29096, #41577).
   - Why rejected: Unknown timeline; user explicitly asked us to solve this now.

### Data Model Changes

None. `captured-sessions` file semantics unchanged.

### API Changes

None.

### UI/UX Changes

- New log lines on SessionStart (`Catchup scan: ...`) visible in `~/.loombrain-sessions/capture.log`.
- Future: `/lb:capture-status` could surface catchup metrics (out of scope).

## Implementation Plan

### Phase 1: Foundation & Preparation
**Complexity**: 3 | **Priority**: High

- [ ] Read current `capture-hook.ts`, `converter.ts`, `api-client.ts`, `idempotency.ts` (already done in research)
- [ ] Extend `SessionHookInput` type in `src/types.ts` to include the `hook_event_name`, `reason`, `source` fields Claude Code actually sends (optional fields to stay backwards compatible)
- [ ] Add constants in `src/catchup.ts` skeleton: `CATCHUP_LOOKBACK_DAYS = 7`, `CATCHUP_FIRST_RUN_LOOKBACK_DAYS = 30`, `CATCHUP_MAX_UPLOADS_PER_RUN = 20`, `CATCHUP_QUIESCENCE_MS = 120_000`
- [ ] Document tool_result array content shape as a type: `type ToolResultContent = string | ContentBlock[]`
- [ ] **BLOCKER**: Confirm with backend engineer whether `POST /api/v1/captures` is idempotent on session_id. This is a prerequisite for FR-8. If not, the resurrection scan is unsafe and must be replaced with "wipe captured-sessions file on first v0.3.0 run, accept re-upload of everything". Record answer here before starting Phase 2.

### Phase 2a: Converter fix
**Complexity**: 3 | **Priority**: High

- [ ] Add `stringifyToolResultContent(content: string | ContentBlock[]): string` helper in `src/converter.ts`
- [ ] Update `JsonlLine.content` type to `string | ContentBlock[]`
- [ ] Update line 60-62 `tool_result` top-level branch to call `stringifyToolResultContent`
- [ ] Update line 97 nested `tool_result` branch in `processUserLine` to call `stringifyToolResultContent`
- [ ] Add test cases to `__tests__/converter.test.ts` covering:
  - `tool_result` with `content: "plain string"` (unchanged)
  - `tool_result` with `content: [{type:"text", text:"hi"}]` → `"hi"`
  - `tool_result` with `content: [{type:"text", text:"a"},{type:"image", source:{...}}]` → `"a\n[image]"`
  - `tool_result` with `content: [{type:"unknown"}]` → `"[unknown: unknown]"`

### Phase 2b: Catchup module + Node-side locks
**Complexity**: 6 (split into sub-tasks) | **Priority**: High

- [ ] Implement `src/locks.ts`:
  - [ ] `withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T | null>` — returns null if lock could not be acquired
  - [ ] Internal: atomic create via `fs.open(path, "wx")`, write PID+ISO, release on `process.on("exit")` and signals
  - [ ] EEXIST recovery: read existing file, check PID via `process.kill(pid, 0)`, reclaim if dead with tmp+rename
  - [ ] Unit tests: concurrent acquire, stale lock reclaim, cleanup on normal exit
- [ ] Implement `src/catchup.ts`:
  - [ ] `findOrphanTranscripts(lookbackDays: number, quiescenceMs: number, activeSessionId: string | null): Promise<OrphanFile[]>` — globs `~/.claude/projects/*/*.jsonl`, filters by mtime range (within lookback, older than quiescence), skips activeSessionId, returns ordered by mtime descending
  - [ ] `extractSessionIdFromPath(path: string): string` — filename stem
  - [ ] `deriveCwdFromProjectDir(projectDir: string): string | null` — reverses the encoding (`-path-to-foo` → `/path/to/foo`); returns null on ambiguity. Only used to compute a best-effort `para_hint`; catchup uploads with `para_hint=null` are acceptable. <!-- Addressed [Codex Medium]: cwd derivation -->
  - [ ] `isAuthCooldownActive(): Promise<boolean>` — reads `.auth-cooldown-until` <!-- Addressed [Codex Medium]: auth backoff -->
  - [ ] `setAuthCooldown(durationMs: number): Promise<void>`
  - [ ] `clearAuthCooldown(): Promise<void>`
  - [ ] `runCatchup(activeSessionId: string, isFirstRun: boolean): Promise<CatchupResult>`:
    1. If auth cooldown active → log and return
    2. Determine lookback (30d first run, 7d otherwise)
    3. Scan orphans, filter captured, filter active, filter non-quiescent
    4. For each orphan (up to MAX_UPLOADS_PER_RUN): `withSessionLock(session_id, () => processSession + postCapture)`
    5. On 429 → abort batch, log, return partial result (continue next run)
    6. On auth failure → set cooldown, abort batch
    7. Write `.v3-marker` on first successful completion
    8. Log summary per FR-6
  - [ ] `CatchupResult` type: `{ scanned, orphans, uploaded, deferred, failed, capped, cooledDown }`
- [ ] Unit tests in `__tests__/catchup.test.ts`:
  - [ ] `findOrphanTranscripts` with fixture dir containing: old (> lookback), fresh (< quiescence → defer), stale (in range → process), active (skip), empty (skip)
  - [ ] `extractSessionIdFromPath` with various path shapes including `-part-N`
  - [ ] `deriveCwdFromProjectDir` — simple case works, ambiguous returns null
  - [ ] `runCatchup` end-to-end with mocked `postCapture`:
    - All orphans succeed → captured-sessions updated, .v3-marker written
    - One orphan fails with 429 → batch aborts mid-way, uploaded < orphans
    - Auth failure → cooldown set, next run short-circuits
    - Active session_id skipped
    - Batch cap respected
    - One orphan upload fails, rerun on next SessionStart succeeds (partial retry regression test) <!-- Addressed [Codex High]: partial upload retry test gap -->
  - [ ] Lock held by another process for same session → catchup skips it silently and logs

### Phase 2c: SessionStart wrapper + hook integration
**Complexity**: 3 | **Priority**: High

- [ ] Add `hooks/session-start.md` with frontmatter `hooks: [{ event: SessionStart }]` and plain-English description of catchup
- [ ] Create new file `catchup-wrapper.sh` — identical shape to `capture-wrapper.sh` (nohup/disown/stdin buffer) but invokes `bun run src/capture-hook.ts --mode start --stdin-file "$STDIN_FILE"`. Separate wrapper avoids depending on unverified `plugin.json` args schema. <!-- Addressed [Codex Medium]: hook args gate -->
- [ ] Update `.claude-plugin/plugin.json` to register a `SessionStart` hook entry pointing at `catchup-wrapper.sh`
- [ ] Modify `capture-wrapper.sh` to pass `--mode end` explicitly (backwards compatible; old behavior identical)
- [ ] Modify `src/capture-hook.ts`:
  - [ ] Parse `--mode` from argv; default `end`
  - [ ] If `mode === "start"`, parse input to extract `active_session_id`, compute `isFirstRun` (absence of `.v3-marker`), call `runCatchup(activeSessionId, isFirstRun)`
  - [ ] If `mode === "end"`, wrap existing `processSession`+`postCapture` loop in `withSessionLock(input.session_id, ...)`. **Apply the markCaptured bug fix** (FR-7): only call `markCaptured(sessionId)` when `uploaded === result.chunks.length`.
- [ ] Integration test: run both wrappers end-to-end in a tmpdir

### Phase 2d: Lock-based deduplication (Node-side)
**Complexity**: 3 | **Priority**: High

- [ ] Node-side locking already implemented in Phase 2b (`src/locks.ts`). This phase wires it in and tests.
- [ ] Unit test: two `withSessionLock("S", fn)` calls concurrent from the same process — one acquires, one returns null
- [ ] Integration test: two separate bun processes invoking `capture-hook.ts --mode end` with identical session_id — one processes, one exits cleanly
- [ ] Integration test: bun process A holding lock, process B starts and finds stale PID (simulate by planting a lockfile with `echo 99999999`) — B reclaims
- [ ] Verify no shell `flock` is used anywhere

### Phase 2e: api-client cleanup + success marker + version bump
**Complexity**: 2 | **Priority**: Medium

- [ ] Remove `if (body.includes("episodic_memory"))` branch at `src/api-client.ts:144-152`
- [ ] Keep generic 403 logging
- [ ] On successful upload, write `.success.<session_id>` marker file in state dir (for resurrection scan in FR-8)
- [ ] Update CHANGELOG.md with v0.3.0 entry (CTRL+C catchup, converter fix, dedup hardening, dead-code removal, markCaptured bug fix, auth cooldown)
- [ ] Bump version in `plugin.json` and `package.json` to `0.3.0`
- [ ] Run `bun run validate:versions`

### Phase 2f: Fix `markCaptured` bug + resurrection scan
**Complexity**: 4 | **Priority**: High

<!-- Addressed [Codex Critical]: failed sessions marked captured; [Codex Critical]: recovery of mis-marked entries -->

- [ ] **Bug fix**: In `src/capture-hook.ts` line 136-137, wrap `await markCaptured(sessionId)` in `if (uploaded === result.chunks.length)`. Update the comment to accurately describe behavior.
- [ ] Add unit test `__tests__/capture-hook.test.ts`: simulate `postCapture` returning null for 1 of 2 chunks; assert root `sessionId` is NOT added to captured-sessions after the run; assert the uploaded chunk's id IS added.
- [ ] Add unit test: simulate `postCapture` returning success for all chunks; assert root `sessionId` IS added.
- [ ] **Resurrection scan** (conditional on Phase 1 API-idempotency confirmation):
  - If API IS idempotent on session_id: implement FR-8 as specified. Add unit test covering the resurrection code path with a planted captured-sessions entry that lacks a `.success.*` marker.
  - If API is NOT idempotent: replace FR-8 with a simpler "wipe `captured-sessions` on first v0.3.0 run, log the wipe, let catchup re-discover". This is safe because the fixed `markCaptured` will only add entries for verified-successful uploads going forward.
  - Document which branch was taken in CHANGELOG and inline code comments.

### Phase 3: Testing & Validation
**Complexity**: 4 | **Priority**: High

- [ ] Unit tests pass: `bun test`
- [ ] Converter tests cover array-content cases (Phase 2a tests)
- [ ] Catchup tests cover orphan discovery, idempotency filter, partial failures (Phase 2b tests)
- [ ] Dedup test: simulate double-fire (Phase 2d test)
- [ ] Manual test matrix:
  - [ ] Exit via `/exit`, observe `Capture complete: 1/1` in log
  - [ ] Exit via double CTRL+C, start new session, observe `Catchup scan: found 1 orphan(s), uploaded 1/1`
  - [ ] Exit via `kill -9` on the Claude Code PID, start new session, observe same catchup
  - [ ] Start a new session when no orphans exist, observe `Catchup scan: found 0 orphan(s), uploaded 0/0`
  - [ ] Install on a machine without `flock`, verify wrapper still works (fallback path)

### Phase 4: Documentation & Polish
**Complexity**: 2 | **Priority**: Medium

- [ ] Update `README.md` with a "How capture works" section describing both paths
- [ ] Update `hooks/session-end.md` to note SessionStart catchup complement
- [ ] Write `hooks/session-start.md` for the new hook
- [ ] Update CHANGELOG.md (done in Phase 2e — verify)
- [ ] Plugin validation:
  - [ ] `bun run validate` succeeds
  - [ ] Plugin.json schema valid for dual hook registration

### Phase 5: Validation
**Complexity**: 2 | **Priority**: High

- [ ] `bun test` — all green
- [ ] `bun run validate` — all green
- [ ] Manual end-to-end on author's machine (all exit paths listed in Phase 3)
- [ ] Release via `bun run release:minor` (version 0.2.0 → 0.3.0)

## Relevant Files

### Existing Files

- `plugins/loombrain-sessions/src/capture-hook.ts` — main entry point; needs mode dispatch
- `plugins/loombrain-sessions/src/converter.ts` — has the array/string bug (lines 60-62, 97)
- `plugins/loombrain-sessions/src/api-client.ts` — has dead episodic_memory branch (lines 144-152)
- `plugins/loombrain-sessions/src/idempotency.ts` — reused as-is for the captured-sessions set
- `plugins/loombrain-sessions/src/logger.ts` — reused for catchup log entries
- `plugins/loombrain-sessions/src/types.ts` — needs SessionHookInput extension
- `plugins/loombrain-sessions/src/splitter.ts` — reused as-is
- `plugins/loombrain-sessions/src/git-hint.ts` — reused as-is
- `plugins/loombrain-sessions/capture-wrapper.sh` — add mode dispatch and flock
- `plugins/loombrain-sessions/.claude-plugin/plugin.json` — register SessionStart hook, bump version
- `plugins/loombrain-sessions/package.json` — bump version
- `plugins/loombrain-sessions/CHANGELOG.md` — v0.3.0 entry
- `plugins/loombrain-sessions/README.md` — document new behavior
- `plugins/loombrain-sessions/hooks/session-end.md` — add catchup note
- `plugins/loombrain-sessions/__tests__/converter.test.ts` — extend

### New Files

- `plugins/loombrain-sessions/src/catchup.ts` — orphan discovery + batched upload orchestrator
- `plugins/loombrain-sessions/hooks/session-start.md` — new hook frontmatter + description
- `plugins/loombrain-sessions/__tests__/catchup.test.ts` — unit tests for catchup module

### Test Files

- `plugins/loombrain-sessions/__tests__/converter.test.ts` — add array-content tests (extend existing)
- `plugins/loombrain-sessions/__tests__/catchup.test.ts` — new, covers findOrphanTranscripts, extractSessionIdFromPath, runCatchup
- Manual integration test script (one-shot) in `__tests__/integration-dedup.test.ts` — spawn two wrapper.sh instances concurrently

## Testing Strategy

### Unit Tests

- Converter: all existing tests still pass + 4 new cases for tool_result array content (text-only, text+image, unknown block, empty array)
- Locks:
  - Concurrent `withSessionLock` on same key — one acquires, one returns null
  - Stale lockfile with dead PID — next call reclaims
  - Normal exit releases lock
  - SIGTERM releases lock
- Catchup:
  - `findOrphanTranscripts` — fixture dir with old (> lookback), fresh-but-non-quiescent (defer), in-range stale (process), active (skip), empty (skip), corrupt filename (skip)
  - `extractSessionIdFromPath` — paths with/without `-part-N` suffix
  - `deriveCwdFromProjectDir` — simple → success, ambiguous → null
  - `isAuthCooldownActive` / `setAuthCooldown` / `clearAuthCooldown` — round trip
  - `runCatchup`:
    - All orphans succeed → captured-sessions updated, .v3-marker written
    - One orphan returns 429 → batch aborts, CatchupResult marks `capped=true`
    - Auth failure (401/403) → cooldown set, next run short-circuits
    - Active session_id explicitly skipped
    - Batch cap respected (21 orphans → 20 uploaded, 1 deferred)
    - Lock held by another process for same session → catchup skips it silently
    - **Partial upload retry regression test** <!-- Addressed [Codex High] -->: first run has one chunk fail → session NOT marked captured → next run retries successfully → session marked captured
- capture-hook:
  - `markCaptured(sessionId)` only called when `uploaded === result.chunks.length` (planted scenario with 2 chunks, 1 failing → assert root NOT marked; 2 succeeding → assert root marked) <!-- Addressed [Codex Critical] -->

### Integration Tests

- End-to-end with real bun runtime, real wrappers, real state dir under a tmpdir:
  - Plant an orphan JSONL (> 5 meaningful events, mtime 5 min old), invoke `catchup-wrapper.sh`, verify `captured-sessions` gains the session_id and `.success.<id>` marker written
  - Plant an already-captured JSONL, invoke wrapper, verify NO upload attempt (mock API to assert 0 calls)
  - Plant a JSONL with mtime 30s old, invoke wrapper, verify it is deferred (no upload) and logged as "defer"
  - Plant a JSONL matching the active session_id (passed through input), verify it is skipped
  - Concurrent invocation test: two `catchup-wrapper.sh` processes, verify only one upload occurs (one bun holds the lock, other sees EEXIST and skips)
  - Resurrection scan test (first run with planted mis-marked entry in captured-sessions): verify the mis-marked session is re-processed

### E2E Tests

- Not applicable (plugin is a hook, not a service). E2E is the manual test matrix.

### Manual Test Cases

1. **Test Case**: CTRL+C catchup recovery
   - Steps: Install v0.3.0 locally. Open a new Claude Code session. Have a ≥5-message conversation. Exit via double CTRL+C. Start a new Claude Code session in any project.
   - Expected: Within 30 seconds of the new session start, `~/.loombrain-sessions/capture.log` contains `Catchup scan: found 1 orphan(s), uploaded 1/1` and the orphan's session_id appears in `captured-sessions`.

2. **Test Case**: Clean exit still works
   - Steps: Install v0.3.0. Open a session. Have a conversation. `/exit`.
   - Expected: Log contains `Capture hook started` then `Capture complete: 1/1 chunk(s) uploaded`.

3. **Test Case**: Converter fix
   - Steps: Open a session that will invoke a tool returning an array-content result (e.g., web fetch with images). Exit cleanly.
   - Expected: Log contains `Capture complete: 1/1` — NOT `API error 400: expected string, received array`.

4. **Test Case**: No double-upload on dup-fire
   - Steps: Invoke `capture-wrapper.sh --mode start` twice in rapid succession with the same state dir and stdin payload.
   - Expected: One bun process runs, one exits silently at flock step. Exactly one upload call in the API-side log.

5. **Test Case**: Empty catchup (happy-case cold start)
   - Steps: Delete `~/.loombrain-sessions/captured-sessions`, start a new session.
   - Expected: Log contains `Catchup scan: found N orphan(s), uploaded M/N` where N reflects any real orphans in the last 7 days.

## Risk Assessment

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| SessionStart hook unreliable on first-run/plugin load (#10373, #19491) | Med | Med | Document limitation; catchup runs on every subsequent session start so orphans are eventually captured. |
| SessionStart hook fires twice (#10871, #24115) | High | High | Node-side per-session lockfile (FR-3) makes double-fire harmless. |
| Catchup scan is slow on machines with hundreds of projects | Low | Med | 7-day (30d first run) lookback bounds scan; non-blocking background execution (`nohup ... & disown`). |
| Converter fix changes wire format of already-captured sessions | Low | Low | Not a wire change — only corrects existing bug that produced invalid payloads. |
| Catchup uploads a huge backlog on first run | Med | Med | 30-day cap + batch size cap (MAX_UPLOADS_PER_RUN=20) + idempotency + 429 abort. Worst case user sees staggered uploads across several SessionStart events. Document in release notes. |
| Transcript file being written while catchup runs (concurrent live session) | Med | **High (was Low)** | Quiescence rule: skip files with mtime < 120s. Skip activeSessionId explicitly. Node-side per-session lock. <!-- Addressed [Codex Critical]: in-progress truncation --> |
| `--mode` arg forwarding | N/A | N/A | Avoided via two-wrapper design. Each wrapper hard-codes its mode in argv. <!-- Addressed [Codex Medium]: hook args gate --> |
| Premature markCaptured bug allowed failed sessions to be permanently skipped | **Pre-existing, HIGH** | Fixed in FR-7 (Phase 2f) + resurrection scan in FR-8. <!-- Addressed [Codex Critical] --> |
| API is not idempotent on session_id, resurrection scan would create duplicates | Med | High | Phase 1 BLOCKER confirmation with backend engineer. Fallback: wipe `captured-sessions` on first v0.3.0 run and let the fixed `markCaptured` re-converge. <!-- Addressed [Codex Critical] fallback --> |
| Persistent auth failure causes catchup retry loop | Med | Med | FR-9 auth cooldown: 1h backoff on consecutive auth failures. <!-- Addressed [Codex Medium] --> |
| Catchup rate-limited by API on large batches | Med | Med | FR-10 per-run batch cap (20) + 429 abort + deterministic mtime-desc order → bounded forward progress per run. <!-- Addressed [Codex Medium] --> |
| `[catchup.ts::runCatchup]` — fails when captured-sessions file corrupted; manifests as catchup running but treating all sessions as orphans; fallback: log error, treat as empty set (worst case: re-uploads work, caught by server-side idempotency if enabled). |
| `[locks.ts::withSessionLock]` — fails when lockfile dir not writable (permission issue); manifests as bun crash on startup; fallback: try/catch the lock creation, log, skip lock (accept possible double-upload), continue with upload. |
| `[capture-hook.ts::dispatch]` — fails when `--mode` arg missing or misspelled; manifests as running default end-mode and trying to process an empty stdin; fallback: default to end-mode, log unknown mode, exit 0. |
| `[catchup.ts::quiescence]` — fails when system clock is skewed (mtime from NTP-corrected past or wall-clock jitter); manifests as a file being deferred indefinitely or processed too early; fallback: trust filesystem mtime, accept occasional quiescence anomalies as a sub-critical fault. |
| `[resurrection scan::FR-8]` — fails when .success markers were never written in v0.2.0 and can't be used to distinguish; manifests as over-aggressive re-upload OR no-op; fallback: conservative scan treats missing-marker as "recent false-capture, attempt re-upload" (safe if API idempotent, wiped alternative if not). |

### Business Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Plugin shipping bundled unrelated fixes delays core CTRL+C fix | Low | Low | All bundled fixes are small and required for correctness. |
| v0.3.0 release surfaces new 400s from previously-masked bugs | Med | Low | Converter fix is the main source; test cases cover the known shapes. |

### Mitigation Strategy

Ship behind an incremented version (0.3.0). Prominent CHANGELOG entry. Keep the old SessionEnd path untouched so the happy path does not regress. Manual test matrix before release.

## Rollback Strategy

### Rollback Steps

1. Revert `plugin.json` and `package.json` version bump to 0.2.0
2. Revert `plugin.json` SessionStart hook registration
3. Revert `capture-wrapper.sh` to the v0.2.0 version (no mode flag, no flock)
4. `src/catchup.ts` can remain (dead code) or be deleted
5. Revert `src/converter.ts` fix ONLY if the fix itself causes regressions — otherwise leave it
6. Publish as 0.3.1 "revert SessionStart catchup"

### Rollback Conditions

- Catchup causes a crash or hang on session start for multiple users
- Flock dedup prevents legitimate captures from occurring
- Converter fix introduces content corruption (null/empty content in uploaded sessions)

## Validation Commands

```bash
# From plugins/loombrain-sessions/
cd plugins/loombrain-sessions

# Run all tests
bun test

# Validate plugin manifest + version parity
bun run validate
bun run validate:versions

# Manually exercise the two modes against a local state dir
STATE_DIR=$(mktemp -d) bash capture-wrapper.sh --mode=end <<< '{"session_id":"test-end","transcript_path":"/tmp/fake.jsonl","cwd":"/tmp"}'
STATE_DIR=$(mktemp -d) bash capture-wrapper.sh --mode=start <<< '{"session_id":"test-start","transcript_path":"/tmp/fake.jsonl","cwd":"/tmp"}'
cat "$STATE_DIR/capture.log"

# Reproduce Bug 1 is fixed (manual, requires real Claude Code)
# 1. Open Claude Code, have conversation, double-CTRL+C exit
# 2. Open Claude Code again in any project
# 3. tail -f ~/.loombrain-sessions/capture.log
# Expected: "Catchup scan: found 1 orphan(s), uploaded 1/1"

# Reproduce Bug 2 is fixed (manual)
# 1. Open Claude Code, invoke a tool with array-content result
# 2. /exit
# Expected: "Capture complete: 1/1" (not "0/1")
```

## Acceptance Criteria

- [ ] FR-1 through FR-6 implemented
- [ ] All existing `bun test` tests still pass
- [ ] New tests for converter array handling pass
- [ ] New tests for catchup module pass
- [ ] Flock dedup test passes
- [ ] Manual test matrix (Phase 3) completed
- [ ] `bun run validate` and `bun run validate:versions` pass
- [ ] CHANGELOG updated with v0.3.0 entry
- [ ] Version bumped to 0.3.0 in both manifest files
- [ ] README documents the catchup mechanism

## Dependencies

### New Dependencies

None. `flock` is a system binary; when missing, the fallback `.pid` path runs.

### Dependency Updates

None.

## Notes & Context

### Additional Context

- Research document: `research/research-session-capture-ctrl-c-exit.md` contains the full root-cause trace, external references, and the `~/.loombrain-sessions/capture.log` evidence that both bugs exist.
- The existing `capture-wrapper.sh` already handles the "how to detach from Claude Code's process group" problem correctly via `nohup ... & disown`. This plan extends that same wrapper rather than replacing it.
- Claude Code's 2026 hook schema confirms `SessionStart` fires with a `source` field (`"startup"`, `"resume"`, `"clear"`, `"compact"`). We do not need to discriminate on `source` — running catchup on every SessionStart is correct and idempotent.
- Idempotency is currently per-session-id (or per-chunk-id for split sessions). This plan preserves that scheme. A future optimization would be byte-offset tracking for incremental uploads, but that requires schema changes and is deferred.

### Scope Decision

- **What exists**: Complete SessionEnd pipeline (wrapper → detach → process → upload), idempotency, converter, splitter, API client, logger.
- **What's new**: A single new file (`src/catchup.ts`), a new hook file (`hooks/session-start.md`), modifications to wrapper and hook entry point for mode dispatch.
- **Why chosen**: User selected SessionStart catchup as the recovery strategy. Reusing existing modules keeps the footprint small. Bundling the converter fix ensures the user sees non-zero uploads on the first v0.3.0 session.
- **File count**: 12 touched (4 new, 8 modified). Above the 8-file soft guideline, but justified by the two-bug-one-release strategy.

### Assumptions

- Claude Code's 2026 hook schema is stable enough for v0.3.0 to ship against.
- Users are on macOS or Linux. Windows support is out of scope.
- LoomBrain API rate limits can handle the typical catchup batch size (single-digit orphans per session start for most users).
- `~/.claude/projects/*/*.jsonl` is the canonical location and format of Claude Code transcripts.
- The existing `idempotency.ts` `isAlreadyCaptured` check by session_id is sufficient to prevent re-uploads — confirmed by reading the code.

### Constraints

- Must not break existing SessionEnd behavior (happy path is the fast path).
- Must be backwards compatible with v0.2.0 state files (`captured-sessions`, `capture.log`).
- Must not introduce new npm dependencies (bun built-ins + fetch + flock only).
- Must keep `exit 0` invariant for hooks — no blocking of session startup.
- Biome auto-formats on edit; do not run formatter manually.

### Related Tasks/Issues

- Backend counterpart plan: `plans/backend-remove-episodic-memory-flag.md`
- Research document: `research/research-session-capture-ctrl-c-exit.md`
- Claude Code upstream issues we depend on: anthropics/claude-code#29096 (SIGINT), anthropics/claude-code#41577 (async completion), anthropics/claude-code#10871 (dup-fire), anthropics/claude-code#24115 (dup-fire), anthropics/claude-code#10373 (SessionStart reliability), anthropics/claude-code#16047 (hooks stop after 2.5h), anthropics/claude-code#19491 (SessionStart before plugins loaded)

### References

- `research/research-session-capture-ctrl-c-exit.md`
- Claude Code Hooks Reference: https://code.claude.com/docs/en/hooks
- anthropics/claude-code#29096 — SIGINT orphans hooks
- anthropics/claude-code#41577 — SessionEnd async completion
- anthropics/claude-code#10871 — plugin hooks fire twice
- anthropics/claude-code#24115 — marketplace + cache dup load
- anthropics/claude-code#10373 — SessionStart new-conversation reliability
- anthropics/claude-code#19491 — SessionStart before plugin load
- anthropics/claude-code#16047 — hooks stop after ~2.5 hours
- anthropics/claude-code#36156 — Windows stdin hook TTY issue

### Open Questions

- [ ] **BLOCKER — confirm with backend engineer**: Is `POST /api/v1/captures` idempotent on `session_id`? (Drives FR-8 branch selection between "resurrection scan" and "wipe captured-sessions on first v0.3.0 run".)
- [ ] Should catchup also prune the `captured-sessions` file of session_ids whose JSONL files no longer exist on disk? (Not in this plan — future optimization.)
- [ ] Should catchup respect `LB_PAUSE=1` or a similar env var for users who want to temporarily disable uploads? (Not in this plan — potential future switch.)
- [ ] Is the user comfortable with adding a Stop hook for near-live capture in a future release, or should catchup remain the only recovery path?
- [ ] Should the 120s quiescence window be configurable via env var? (Likely no — fixed constant for correctness.)
- [ ] Gemini blindspot critic rerun when capacity returns — potential additional findings.

## Blindspot Review

**Reviewers**: GPT-5.3-Codex (xhigh). Gemini 3 Pro **unavailable** (API returned 429 "exhausted capacity" across 10 retries, 2026-04-11 20:21 UTC). Proceeding with Codex-only review; rerun Gemini when capacity is restored.
**Date**: 2026-04-11
**Plan Readiness**: Was "Major Gaps" per Codex initial assessment (11 findings). After revisions below, plan addresses all Critical and High findings plus all Medium findings. Re-review recommended after revision if Gemini becomes available.

### Addressed Concerns

- **[Codex, Critical] Failed sessions already marked as captured (line 137 bug)** → FR-7 adds explicit fix; Phase 2f adds unit tests; risk table updated.
- **[Codex, Critical] Catchup truncating in-progress sessions** → FR-1 adds 120s quiescence rule + explicit skip of activeSessionId; FR-1 details and risk table updated.
- **[Codex, Critical] Recovery path for v0.2.0 mis-marked entries** → FR-8 resurrection scan (conditional on API idempotency), with fallback to wipe-captured-sessions if API is not idempotent; Phase 1 BLOCKER to confirm with backend engineer.
- **[Codex, High] Global catchup lock vs per-session end lock namespace race** → FR-3 rewritten: single per-session lock namespace (`.lock.<session_id>`) used by both SessionEnd and catchup paths. No separate global catchup lock.
- **[Codex, High] Wrapper-level flock releases before work finishes** → FR-3 rewritten: lock moves from shell to Node (`src/locks.ts`). Lock is held by the long-running bun process, not the wrapper, so it lives as long as the upload.
- **[Codex, High] Zero-session-loss goal conflicts with 7-day lookback** → Goal #1 narrowed to "within recovery window"; FR-5 adds 30-day first-run extension.
- **[Codex, High] Partial upload retry regression path untested** → Added explicit test case in Testing Strategy and in Phase 2b test plan.
- **[Codex, Medium] Hook args support gate** → Avoided entirely by using two separate wrapper scripts (`capture-wrapper.sh` for SessionEnd, `catchup-wrapper.sh` for SessionStart). Each hard-codes its mode.
- **[Codex, Medium] Catchup cwd derivation undefined** → `deriveCwdFromProjectDir` helper specified; para_hint becomes best-effort for catchup uploads.
- **[Codex, Medium] Persistent auth failures unbounded retry** → FR-9 auth cooldown (1h on consecutive auth failures, cleared on successful upload).
- **[Codex, Medium] Catchup burst rate-limit handling** → FR-10 per-run batch cap of 20 + 429 abort + mtime-desc ordering for bounded forward progress.
- **[Codex, Medium] PID fallback locking atomicity** → Removed PID fallback entirely. Atomic lockfile creation via `fs.open(path, "wx")` (POSIX O_EXCL) is the only path.

### Acknowledged but Deferred

- **[Codex, Low] None flagged explicitly at Low severity** — Codex returned 11 findings, all Critical/High/Medium.
- **Byte-offset incremental upload for incomplete sessions** (not a Codex finding, but related to FR-1 quiescence): deferred to future release. Current plan captures "eventually consistent" with 120s quiescence window; a live-session terminal may still miss a final 120s of events if no clean exit occurs. Acceptable trade-off for this release.

### Dismissed

- None. All Codex findings were either addressed or explicitly deferred.

### Gemini Re-run Plan

If Gemini capacity returns within 24h, rerun the critic with the revised plan, consolidate any new findings, and update this section. If no new findings, mark `reviewed: true` in frontmatter.
