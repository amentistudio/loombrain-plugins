---
description: "Guided task triage — pending-review, overdue, stale, plus goal-without-tasks audit"
---

# /lb:weekly-review

Walk through the user's tasks with structured triage decisions: pending-review tasks first (LoomBrain's compound-score signal), then overdue and stale open tasks, then a goal-without-tasks audit. Optionally capture the review session as an episode for future reference.

## Workflow

1. **Project scope** (AskUserQuestion):
   - "Review this project only" (auto-detected via `mcp__loombrain__lb_get_context`) — recommended default.
   - "Review across all projects" (no `para_item_id` filter).
   - "Pick a different project" → list active PARA projects, user picks.

2. **Pending-review pass** (the "did it matter?" signal):
   - Call `mcp__loombrain__lb_review_tasks({pending_review: true, para_item_id?, limit: 50})`.
   - These are tasks completed 21-35 days ago with compound score < 1.0 — flagged by the nightly `experiment-check` cron because they didn't generate downstream activity.
   - For each, AskUserQuestion:
     - **Archive** (work was a dead end) → the task record itself stays completed (no MCP endpoint archives tasks today). Two things happen on "Archive": (1) if the task has a `source_node_id`, call `mcp__loombrain__lb_update_node({id: source_node_id, metadata: {archived_at, archived_reason: "review_dead_end"}})` to retire the originating capture node so it stops surfacing in search; (2) record the "dead end" decision in the optional episode capture at step 5 so future reviews can see this task was already triaged. If the task has no `source_node_id`, only step (2) applies.
     - **Keep** (still matters, just slow burn) → no mutation, mark internally as reviewed.
     - **Convert to follow-up task** → `mcp__loombrain__lb_add_task({title: "Follow up on {original}", para_item_id, source_node_id: original_task.source_node_id, priority})`. Pass through the original task's `source_node_id` (the capture node that motivated the original task) so the follow-up preserves provenance. If the original task has no `source_node_id`, omit the field on the follow-up.
   - If no pending-review tasks, say so and move on.

3. **Open tasks pass** (overdue → stale → fresh):
   - Call `mcp__loombrain__lb_review_tasks({status: "open", para_item_id?, limit: 50})`.
   - Tasks are pre-ordered: overdue first, then stale (no update >14 days), then fresh.
   - Triage one at a time (AskUserQuestion per task):
     - **Complete now** (with optional `actual_minutes` and notes) → `mcp__loombrain__lb_complete_task({id, actual_minutes?, notes?})`. Ask `cascade: true` if `child_count > 0`.
     - **Reschedule** (push deadline) → decision tree based on what the MCP surface exposes:
       1. **If `mcp__loombrain__lb_update_task` exists**: call it with the new `deadline`. (Today it does not — tasks have only `lb_add_task` and `lb_complete_task` exposed.)
       2. **Else**: complete the current task via `mcp__loombrain__lb_complete_task({id, notes: "rescheduled to {new_deadline}: {reason}"})`, then `mcp__loombrain__lb_add_task({title: "{original title}", para_item_id, source_node_id: original_task.source_node_id, deadline: new_deadline, priority})`. This is the only viable path on today's MCP surface.
       Do NOT call `mcp__loombrain__lb_update_node` on the task — tasks live in the `tasks` table, not `nodes`, so the node-update endpoint does not apply.
     - **Cancel** (no longer relevant) → `mcp__loombrain__lb_complete_task({id, notes: "cancelled: {reason}"})` — completion with a cancellation note is the cleanest path given the current MCP surface.
     - **Unblock** (note that the blocker resolved) → if the task has `blocked_by_count > 0`, ask which blocker is now done and complete that blocker first.
     - **Convert to subtask of another** → `mcp__loombrain__lb_add_task` with `parent_task_id` pointing to a new parent (max depth 3 — check `depth` before nesting).
     - **Skip** (defer decision) → no mutation, move on.
   - Stop the pass when the user says "enough" or after 20 tasks reviewed (to avoid review fatigue).

4. **Goal audit**:
   - Call `mcp__loombrain__lb_review_goals({status: "active", para_item_id?})`.
   - For each goal where `task_count === 0` OR (`task_count > 0` AND `task_completed_count === task_count` AND no open task in the step-3 results has `source_node_id` equal to the goal's node id):
     - AskUserQuestion: "Goal '{title}' has no active tasks. Add a next task / mark complete / archive / leave alone?"
     - **Add task** → `mcp__loombrain__lb_add_task({title, para_item_id, source_node_id: goal_node_id})`.
     - **Mark complete** → `mcp__loombrain__lb_update_goal({id: goal_node_id, status: "completed"})`.
     - **Archive** → `mcp__loombrain__lb_update_goal({id: goal_node_id, status: "archived"})`.
     - **Leave** → no mutation.

5. **Capture the review** (optional, asked at the end):
   - "Capture this review as an episode for future reference?" (yes/no, default yes).
   - If yes: `mcp__loombrain__lb_episode_capture` with a summary like "Weekly review {YYYY-MM-DD}: {N tasks triaged, M completed, K archived, P goals audited}", events listing each decision made.

6. **Print summary**: counts of completed / archived / new tasks / goal updates. End with: `Run /lb:project-status to see what's next.`

## Usage

```text
/lb:weekly-review
```

## Implementation

Pacing rules (avoid review fatigue):

- Hard cap step 3 at 20 tasks per session. If more remain, tell the user and suggest running the command again tomorrow.
- After every 5 task decisions, surface a brief progress note ("5 down, 12 to go in this pass — keep going / take a break?").

Pending-review interpretation:

- These tasks were completed but the work didn't compound (no downstream searches/captures touching the same nodes). Treat the user's review as the source of truth — they know whether the work mattered even if the graph doesn't show it.
- Don't auto-archive. Always require an explicit decision.

Open tasks pass — handling MCP gaps:

- The MCP surface today exposes `lb_add_task`, `lb_complete_task`, `lb_review_tasks` but does NOT expose a direct `lb_update_task` mutation tool. For "reschedule" and similar edits, document the intent in completion notes or use the underlying `lb_update_node` if the task is also represented as a node. If neither path works for a given edit, surface this to the user as a limitation and capture the intent for manual follow-up.
- For "cancel" decisions, completion-with-cancellation-note is the cleanest current path.

Goal audit logic:

- `lb_review_goals` returns `task_count` and `task_completed_count`. A goal is stale when either: (a) `task_count === 0` (no tasks ever attached), or (b) `task_completed_count === task_count` AND no open task in the step-3 results has `source_node_id` equal to the goal's node id (every task this goal motivated is done, no new ones in flight). Both conditions only use data already fetched — no extra MCP call. If you want a stricter "created in last N days" check, that requires a separate `lb_list_nodes` query with a date filter; treat it as out of scope for the basic audit.
- Don't audit archived goals (the default `status: "active"` filter handles this).

Episode capture (step 5):

- Events list should be terse — one event per decision in `tool_call`/`tool_result` style, sequenced.
- `why` field on the capture: "weekly review {date}".
- Don't block the workflow on capture failure — if `lb_episode_capture` errors, log it and continue to summary.

AskUserQuestion shape:

- One question per task. Don't batch multiple tasks into a single multi-select question — the cognitive load is wrong for triage.
- Recommended option per task should be inferred from signals: overdue+blocked → unblock; overdue+unblocked → complete or reschedule; stale → complete or cancel; pending-review → keep (default) or archive.

Edge cases:

- If the user is not in a project directory and picks "this project only" with no auto-detect, fall back to AskUserQuestion to pick.
- If `lb_review_tasks` returns zero open tasks AND zero pending-review tasks, print "Nothing to triage — inbox zero" and skip to goal audit.
- If a task has `blocked_by_count > 0` AND all blockers are themselves blocked, surface the blocker chain so the user can see the deadlock.

Out of scope:

- Cross-project priority ranking (no opinion on which project to work on next).
- Energy/calendar-based scheduling (no integration with calendars).
- Auto-suggesting task breakdowns (no LLM-side task splitting at MVP).
