# LoomBrain Projects

Guided workflows for managing projects, vision, goals, and tasks inside [LoomBrain](https://loombrain.com).

Wraps the existing LoomBrain MCP surface (`lb_set_goal`, `lb_review_tasks`, `lb_set_vision`, PARA item CRUD, episode capture) as opinionated slash commands. Auto-detects the active PARA project from your working directory.

## Commands

| Command | What it does |
|---|---|
| `/lb:project-status` | Prints a visible briefing: vision, active goals, top open tasks, and tasks needing review for the project matching your cwd. Read-only. Run at the start of a work session. |
| `/lb:project-backfill` | Walks one existing PARA project at a time through a gap-fill interview — only asks about purpose / vision / goals / tasks that are actually missing. |
| `/lb:project-kickoff` | Bootstrap wizard for a brand-new PARA project (creates project + links vision + 1-3 goals + 3-5 initial tasks). |
| `/lb:weekly-review` | Guided task triage. Pending-review tasks first (compound-score flagged), then overdue and stale open tasks, then a goal-without-tasks audit. |
| `/lb:session-retro` | End-of-session distill. Interview-driven: what got done, what new tasks surfaced, what's the goal progress. Optionally captures the session as an episode. |

## Prerequisites

- [Bun](https://bun.sh) runtime installed
- A [LoomBrain](https://loombrain.com) account with the MCP server connected to Claude Code
- (Recommended) The `loombrain-sessions` plugin installed and logged in via `/lb:login` so episode capture works

## Installation

```bash
# Add the LoomBrain marketplace (if not already added)
/plugins marketplace add amentistudio/loombrain-plugins

# Install the projects plugin
/plugin install loombrain-projects
```

## Project auto-detection

Every command first calls `lb_get_context` with your current working directory. LoomBrain fuzzy-matches the path's last component (after stripping domains like `.com` / `.io`) against PARA item labels and slugs.

- **Single match** → uses that PARA project automatically
- **No match** → asks you to pick a project (or, for `/lb:project-kickoff`, proposes creating a new one)
- **Ambiguous** → asks you to disambiguate

## Methodology

This plugin deliberately ships with **no goal-setting framework** (no OKR, no SMART, no BHAG). Goals are free-form `title + body + deadline`. Tasks are free-form `title + estimated_minutes + priority`. Add structure later, opt-in, if real usage shows you want it.

## License

MIT
