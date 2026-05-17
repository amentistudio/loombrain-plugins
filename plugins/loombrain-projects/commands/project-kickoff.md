---
description: "Bootstrap a new PARA project with vision link, goals, and initial tasks in one guided flow"
---

# /lb:project-kickoff

Wizard that creates a brand-new PARA project with full strategic frame in one sitting: PARA item + purpose + vision link + 1-3 goals + 3-5 seed tasks. Idempotent — if a PARA project already matches the working directory, offers to extend it rather than creating a duplicate. For backfilling existing projects use `/lb:project-backfill`.

## Workflow

1. **Detect existing PARA** via `mcp__loombrain__lb_get_context` with the current working directory.
   - **Single match** → ask (AskUserQuestion): "Project '{label}' already exists. Extend it (skip to step 3 using its `para_item_id`) or create a separate new project?"
   - **No match** → propose a new project. Derive a default label from the working directory's last component (strip `.com`/`.io`/`-` separators), let user accept or override.
   - **Ambiguous match** → AskUserQuestion to disambiguate, then handle as single match.

2. **Create PARA project** (only on "create new" path):
   - Ask for label (pre-fill from cwd), short description, and purpose (one paragraph — why does this project exist?).
   - Call `mcp__loombrain__lb_create_para_item({category: "projects", label, description, purpose_text})`.
   - Capture the returned `id` as `para_item_id` for all subsequent calls.

3. **Resolve vision link**:
   - List existing visions: `mcp__loombrain__lb_list_nodes({tags: ["vision"], limit: 10})`.
   - **If visions exist**: AskUserQuestion "Link this project's goals to which vision?" (options = vision titles + "create new vision" + "skip").
   - **If none exist**: ask "No vision yet — create one now (recommended for first-ever project) or skip?"
   - If create: interview title + body (4-6 sentences) + horizon_years (default 5). Call `mcp__loombrain__lb_set_vision({title, body_markdown, horizon_years})`.
   - Store the chosen `vision_id` (or `null` if skipped).

4. **Goal interview** (1-3 goals):
   - For each goal: ask title + body (2-4 sentences) + optional deadline.
   - Call `mcp__loombrain__lb_set_goal({title, para_item_id, body_markdown, deadline?})`.
   - If `vision_id` is set, immediately call `mcp__loombrain__lb_link_nodes({source_id: goal_node_id, target_id: vision_id, link_type: "supports"})`.
   - After each goal, ask "Add another? (1 done, 2 more allowed)". Cap at 3.

5. **Task seeding** (3-5 tasks):
   - Ask "Seed initial tasks now? Recommended 3-5 to get rolling."
   - For each task: title + optional estimated_minutes + optional priority (low/medium/high) + which goal it advances (pick from just-created goals or "no specific goal").
   - Call `mcp__loombrain__lb_add_task({title, para_item_id, source_node_id: goal_node_id?, estimated_minutes?, priority?})`.
   - After each task, ask "Add another?". Cap at 5.

6. **Summary**: print created PARA id + vision link + goal IDs + task list. End with: `Run /lb:project-status anytime to see this briefing again.`

## Usage

```
/lb:project-kickoff
```

## Implementation

Default label derivation (step 1):

- Take `basename` of working directory.
- Strip trailing `.com`, `.io`, `.dev`, `.ai`.
- Replace `-` and `_` with spaces.
- Title-case the result.
- Example: `/Users/iamladi/Projects/foo-bar.com` → `Foo Bar`.

Extend-vs-create branch (step 1 single match):

- "Extend" means: skip step 2, reuse the existing `para_item_id`, jump straight to step 3 (vision link check). Useful when the project exists but has no vision/goals yet.
- "Create separate" means: append a numeric suffix to the default label to avoid label collision, then proceed normally.

Vision creation prompts (step 3 "create new"):

- Vision title: short, future-tense, ambitious (e.g., "Personal knowledge layer that compounds over decades").
- Vision body: 4-6 sentences. Encourage the "5 years from now…" framing.
- `horizon_years` default 5 unless user specifies otherwise (range 3-10).

Goal interview prompts (step 4):

- Goal title: outcome-flavored, not task-flavored. Encourage "Ship X" or "Reach Y" framings without enforcing a methodology.
- Goal body: 2-4 sentences. What does done look like? Why does this matter now?
- Deadline: ISO date (YYYY-MM-DD) or "none". Don't insist.
- After each goal-link pair, surface the returned node IDs so the user can copy them if needed.

Task seeding rules (step 5):

- 3 is a strong default ("if you can't think of 3 concrete next actions, the goals might be too vague").
- Tasks are top-level only — no `parent_task_id` at kickoff. Subtasks come later via direct MCP calls or `/lb:weekly-review`.
- `source_node_id` points to the goal that motivated this task — this writes a `derived_from` edge and helps `/lb:project-status` render `[task → goal]` relationships.

AskUserQuestion shape:

- Recommended option always first, labeled with "(Recommended)".
- "Skip" and "Quit" options always available where it makes sense (vision link, additional goals, additional tasks).
- For free-text fields (titles, bodies, deadlines), use AskUserQuestion sparingly — for long-form fields, ask once via AskUserQuestion with a single "I'll type my answer below" option, then read the user's next message.

Edge cases:

- If `lb_create_para_item` fails (e.g., label collision when status='archived' projects exist), surface the error and offer to retry with a different label.
- If the user quits after creating the PARA but before goals/tasks, that's fine — partial state is valid; they can run `/lb:project-backfill` later to finish.
- If `lb_set_vision` succeeds but `lb_link_nodes` fails for a goal-vision link, retry once; if still failing, print a warning and proceed (the goal exists; the link can be added manually).

Out of scope:

- Editing existing visions (use `lb_update_node` directly).
- Creating sub-tasks (kickoff is top-level only).
- Areas or resources — only `category: "projects"` at kickoff.
