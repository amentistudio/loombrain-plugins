---
description: "Walk an existing PARA project through a gap-fill interview — vision, goals, tasks added only where missing"
---

# /lb:project-backfill

Onboard an **existing** PARA project that's missing some of the strategic frame: purpose, linked vision, active goals, or initial tasks. Walks one project at a time. Surgical — only asks about gaps that actually exist. For brand-new projects use `/lb:project-kickoff` instead.

## Workflow

1. **Enumerate**: `mcp__loombrain__lb_list_para_items({category: "projects", status: "active"})`. If zero results, tell the user there are no active projects to backfill and suggest `/lb:project-kickoff`.
2. **Coverage scan**: for each project (run in parallel where possible), compute a coverage tuple:
   - `has_purpose` = `purpose_text` field is non-empty
   - `has_vision_link` = at least one goal has a non-empty `linked_visions` array (check via the goal review below)
   - `has_goals` = `lb_review_goals({para_item_id, status: "active"}).items.length > 0`
   - `has_tasks` = `lb_review_tasks({para_item_id, status: "open", limit: 1}).items.length > 0`
3. **Skip fully-covered projects** from the picker (`has_purpose && has_vision_link && has_goals && has_tasks` → not shown). Tell the user how many were skipped.
4. **Pick a project** (AskUserQuestion): show up to 4 projects with gap markers in the labels (e.g., `"loombrain.com  [no goals, 0 tasks]"`). Always include an "I'm done — quit" option.
5. **Gap-fill interview** for the chosen project — run only the branches whose gap is real:
   - **Missing purpose**: ask "What's the purpose of this project? (One paragraph — why does it exist?)" → `mcp__loombrain__lb_update_para_item({id, purpose_text})`.
   - **Missing vision link** (or no goals yet): list existing visions via `mcp__loombrain__lb_list_nodes({tags: ["vision"], limit: 10})`. If any exist, ask "Link to which vision?" (AskUserQuestion with vision titles + "create new" + "skip" options). If user picks "create new", interview vision title + body + horizon_years and call `mcp__loombrain__lb_set_vision`. Store the chosen `vision_id` for use when creating goals below.
   - **Missing goals**: run a 1-3 goal mini-interview. For each goal, ask title + 1-paragraph body + optional deadline (ISO date or "none"). Call `mcp__loombrain__lb_set_goal({title, para_item_id, body_markdown, deadline?})` and immediately `mcp__loombrain__lb_link_nodes({source_id: goal_node_id, target_id: vision_id, link_type: "supports"})` if a vision was resolved.
   - **Missing tasks**: ask "Want to seed 2-5 initial tasks for this project?" (yes/no/skip). If yes, interview tasks one at a time (title + optional estimated_minutes + optional priority + which goal it advances, if any). Call `mcp__loombrain__lb_add_task({title, para_item_id, source_node_id: goal_node_id?, estimated_minutes?, priority?})`.
6. **Summary for this project**: print what was added (purpose? vision linked? N goals? M tasks?) with the new node IDs.
7. **Loop**: ask "Backfill another project?" (yes/no). If yes, return to step 4 with the just-finished project removed from the picker. If no, print a final session summary listing every project touched and what was added across all of them.

## Usage

```
/lb:project-backfill
```

## Implementation

Coverage detection rules (critical — these prevent re-asking about gaps that don't exist):

- Re-evaluate `has_*` flags **after every mutation**. If the user just added a vision link, don't ask about vision again on the next iteration of the same project.
- The picker should hide projects that gain full coverage during the session.
- `lb_review_goals` returns each goal's `linked_visions` array — use that to compute `has_vision_link` without an extra MCP call per goal.

Vision interview branch (`/lb:project-backfill` does NOT auto-create a vision):

- ALWAYS offer the existing visions first via AskUserQuestion before proposing creation.
- If the tenant has no visions yet, ask once: "No vision exists yet — create one now or skip?" Don't push.
- Visions are tenant-wide (multiple allowed, see `lb_set_vision` semantics). Don't deduplicate by title — let the user decide.

Goal interview branch:

- Cap at 3 goals per backfill session per project. If the user wants more, they can re-run the command.
- For each goal body, encourage 2-4 sentences. Don't enforce a framework (no OKR/SMART prompts).
- After `lb_set_goal` returns the `node_id`, immediately link to vision via `lb_link_nodes` with `link_type: "supports"`. Source = goal, target = vision.

Task interview branch:

- Cap at 5 tasks per backfill session per project.
- If goals were just created, ask which goal each task advances and pass that node id as `source_node_id`. This writes a `derived_from` edge automatically.
- Skip `parent_task_id` — backfill tasks are top-level only.

AskUserQuestion shape (per `feedback_ask_user_question.md` memory):

- Use AskUserQuestion for every decision branch — never inline numbered lists in your response.
- Recommended choice always first, labeled with "(Recommended)".
- For free-text input (goal title, vision body), use AskUserQuestion with an "Other" path or invite the user to type their answer in the next turn.

Edge cases:

- If `lb_update_para_item` or any `lb_set_*` call fails, surface the error inline and ask whether to retry or skip that gap for now.
- If the user quits mid-project (e.g., after adding goals but before tasks), the partial state is fine — goals are already persisted, tasks remain a gap for next time.
- If a project's category is `areas` or `resources` instead of `projects`, this command does not touch it (we only enumerate `category: "projects"` in step 1).

Out of scope for this command:

- Editing existing goals/tasks (use `lb_update_goal` directly or wait for `/lb:weekly-review`).
- Archiving projects (use the MCP tool `lb_archive_para_item` directly).
- Creating new PARA projects (use `/lb:project-kickoff`).
