---
description: "End-of-session distill — extract completed tasks, new tasks, goal progress from the work just done"
---

# /lb:session-retro

Interview the user at the end of a work session to capture what just happened: which open tasks got completed, what new tasks surfaced, what goal progress was made. Optionally records the session as an episode for future retrieval. Distinct from `loombrain-sessions:lb:capture-session` (which captures raw event streams automatically) — this command is guided reflection, not raw capture.

## Workflow

1. **Detect project** via `mcp__loombrain__lb_get_context` with the current working directory. If no match, ask the user to pick a PARA project (the retro needs a project scope to attach tasks and read goals).

2. **Pull current state** (parallel calls for the resolved `para_item_id`):
   - `mcp__loombrain__lb_review_goals({para_item_id, status: "active"})` — for the goal-progress interview.
   - `mcp__loombrain__lb_review_tasks({para_item_id, status: "open", limit: 20})` — for the "which of these did you actually do?" check.

3. **Completed-work interview** ("What got done?"):
   - Show the user the list of open tasks for this project (titles only, with IDs as references).
   - AskUserQuestion: "Which of these did you complete this session?" (multi-select). Allow "none of these — but I did other things" as an option.
   - For each selected task: ask optional `actual_minutes` and optional notes. Call `mcp__loombrain__lb_complete_task({id, actual_minutes?, notes?})`. If the task has `child_count > 0`, ask `cascade: true/false`.
   - For "other things done": ask the user to list them (free text). For each, ask: "Capture as a completed task (creates + immediately completes) or just note in the episode?". If completed-task: call `mcp__loombrain__lb_add_task` then immediately `mcp__loombrain__lb_complete_task` on the returned id (with the work duration as `actual_minutes` if known).

4. **New-task interview** ("What new tasks surfaced?"):
   - "Did any new follow-up tasks come out of this session?" (yes/no, default yes for productive sessions).
   - If yes: interview tasks one at a time — title, optional estimated_minutes, optional priority, which goal it advances (pick from step 2 goals or "no specific goal").
   - For each: `mcp__loombrain__lb_add_task({title, para_item_id, source_node_id: goal_node_id?, estimated_minutes?, priority?})`.
   - Cap at 5 new tasks per retro to keep it focused.

5. **Goal-progress interview** ("Any movement on goals?"):
   - For each active goal from step 2, AskUserQuestion: "Progress on '{title}'?"
     - **Significant progress** — ask for a 1-2 sentence note. Patch `metadata` via `mcp__loombrain__lb_update_goal({id, metadata: {last_progress_note: "...", last_progress_at: "{ISO}"}})`.
     - **Blocked** — ask for blocker description. Patch `metadata.blocker: "..."`.
     - **Complete now** → `mcp__loombrain__lb_update_goal({id, status: "completed"})`.
     - **No change** — no mutation.
   - Skip this step entirely if the project has zero active goals (suggest `/lb:project-backfill` instead).

6. **Episode capture** (optional, asked last):
   - "Capture this retro as a LoomBrain episode for future retrieval?" (yes/no, default yes).
   - If yes: `mcp__loombrain__lb_episode_capture` with:
     - `title`: "Session retro {YYYY-MM-DD HH:MM} — {project label}"
     - `why`: "session retrospective"
     - `events`: one event per interview answer (sequenced, `role: "user"` for user inputs, `role: "tool_result"` for MCP responses)
     - `summary`: 2-3 sentence digest the user wrote OR auto-compose from the interview answers
     - `para_hint`: the resolved PARA `id` (exact match — skips LLM classification)

7. **Print summary**: counts of tasks completed / created / goal updates. End with: `Run /lb:project-status next time you start working here to see the current state.`

## Usage

```
/lb:session-retro
```

## Implementation

Distinction from `loombrain-sessions:lb:capture-session`:

- `loombrain-sessions` captures the raw JSONL event stream of the session automatically at session end via a hook — that data goes into LoomBrain unprocessed for the fact-extraction pipeline.
- `/lb:session-retro` is a guided interview that produces structured mutations (`lb_complete_task`, `lb_add_task`, `lb_update_goal`) — the user is in the loop deciding what changed.
- Both can coexist for the same session: the raw capture preserves the full transcript, the retro distills the meaningful state changes. The retro's optional `lb_episode_capture` call is for the retro INTERVIEW itself (a separate episode), not the underlying work session.

Completed-work interview rules:

- Show task titles + IDs in the multi-select so the user can match against their memory of what got done.
- If the user picks 0 open tasks AND says "I did other things", that's the cue to interview free-form completed-work items.
- For "other things", don't force task creation — let the user decide whether each item is worth a task record or just a note in the episode.

New-task interview rules:

- Cap at 5. After 3, surface "3 down, 2 more allowed — keep going?".
- For each new task, default `source_node_id` to the goal-of-conversation if the user mentioned advancing a specific goal in step 3 or 5.

Goal-progress patch shape:

- The MCP `lb_update_goal` accepts a `metadata` field that is shallow-merged. Don't replace metadata — only set the keys you're updating.
- Standard keys to use: `last_progress_note` (string), `last_progress_at` (ISO datetime), `blocker` (string, only when status is "blocked"). Clear `blocker` by setting it to empty string when the user reports progress on a previously-blocked goal.

Episode capture sequencing:

- `seq` field must be strictly ascending and unique. Use 1, 2, 3, … in order of interview answers.
- `occurred_at` should be the time the user gave the answer, not the session start.
- Events list should be terse — don't dump full quoted user answers, summarize each step in one line.

AskUserQuestion shape:

- Multi-select for "which open tasks completed?".
- Single-select per goal in the goal-progress interview.
- Free-text answers (notes, blocker descriptions) come from the user's next message after a "I'll type my answer below" option.

Edge cases:

- If the session truly did nothing useful, the user should be able to bail at step 3 with "nothing to record" — exit cleanly without capturing an empty episode.
- If `lb_complete_task` fails (e.g., already completed by another agent in the meantime), report inline and skip that task.
- If `lb_episode_capture` fails, log the error and still print the summary — the mutations from steps 3-5 already persisted.

Out of scope:

- Auto-detecting completed work from git log or shell history (no automation — user-in-the-loop interview only).
- Multi-session digests (this is single-session — for weekly summaries, see `/lb:weekly-review`).
- Cross-project retros (always project-scoped).
