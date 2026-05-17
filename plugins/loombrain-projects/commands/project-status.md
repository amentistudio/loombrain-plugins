---
description: "Surface vision, goals, and active tasks for the current project as a visible briefing"
---

# /lb:project-status

Print a visible briefing of the vision, active goals, and top open tasks for the PARA project that matches the current working directory. Read-only — never mutates. Run this at the start of a work session so the user (not just Claude) sees what they're working toward.

## Workflow

1. **Detect project**: call `mcp__loombrain__lb_get_context` with the current working directory.
2. **Handle no match**: if no PARA item matches, list active projects via `mcp__loombrain__lb_list_para_items({category: "projects", status: "active"})` and ask the user to pick one (AskUserQuestion). If they decline, exit gracefully — no briefing to show.
3. **Parallel fetch** for the resolved `para_item_id`:
   - `mcp__loombrain__lb_review_goals({para_item_id, status: "active"})`
   - `mcp__loombrain__lb_review_tasks({para_item_id, status: "open", limit: 10})`
   - `mcp__loombrain__lb_review_tasks({para_item_id, pending_review: true, limit: 10})`
4. **Vision lookup**: if any goal has a non-empty `linked_visions` array, pull the first vision via `mcp__loombrain__lb_get_node({id: vision_id})`. If no goals have linked visions, fall back to `mcp__loombrain__lb_list_nodes({tags: ["vision"], limit: 1})` so the user still sees their tenant-level vision.
5. **Render briefing** (visible to user — print the markdown directly in your response, do not paraphrase or compress).
6. **End with one-line nudge**: `Run /lb:weekly-review to triage tasks, /lb:project-backfill if anything looks missing.`

## Usage

```
/lb:project-status
```

## Implementation

Run steps 1-4 with parallel MCP calls where possible. Then render exactly this briefing shape, filling in real values and omitting sections that are empty:

```
# {project label}  ·  {category}

## Vision
{vision title} — {horizon_years}y
{first 2-3 lines of vision body, trimmed}

## Active goals ({N})
1. {goal title} — {completed}/{total} tasks · deadline {date or "none"}
   ↑ supports: {linked vision title, or "—" if no link}
2. {goal title} — ...

## Top open tasks ({M})
• [OVERDUE] {task title} · {estimated_minutes}m · blocked by {N} tasks
• [STALE] {task title} · last updated {N days ago}
• {task title} · {priority}

## Needs review ({K})
• {task title} — completed {date}, low compound score
```

Rendering rules:

- **Project header**: include category emoji or label (projects/areas/resources).
- **Vision section**: omit entirely if no vision found. If the body is long, show first 2-3 lines and append `…`.
- **Goals**: max 10; if more, show count and append `(+N more — run /lb:weekly-review)`.
- **Tasks**: `lb_review_tasks` already orders overdue → stale → fresh. Tag overdue with `[OVERDUE]`, tag stale (no update >14 days) with `[STALE]`. Show `blocked_by_count` only when > 0.
- **Needs review**: show only if `pending_review` query returned results. These are tasks completed 21-35 days ago with compound score < 1.0 — surface them so the user can decide if the work mattered.
- **Empty state**: if the project has no goals AND no tasks, render the header + a one-liner: `No goals or tasks yet. Run /lb:project-backfill to set them up.`

Edge cases:

- If `lb_get_context` returns ambiguous matches (multiple PARA items), use AskUserQuestion to disambiguate before any data fetch.
- If MCP calls fail, report the error inline (don't silently render a partial briefing).
- Do NOT call any mutation tools — no `lb_set_*`, `lb_add_task`, `lb_update_*`, `lb_complete_*`. This command is strictly read-only.
