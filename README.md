# LoomBrain Plugins

Official Claude Code plugins for [LoomBrain](https://loombrain.com) — a personal knowledge graph SaaS.

## Installation

```bash
/plugins marketplace add amentistudio/loombrain-plugins
```

## Available Plugins

### loombrain-sessions

Two-way bridge to your episodic memory: auto-captures every meaningful coding session when you exit or `/clear`, and injects your project context + the open questions you're chasing at the **start** of each session — so the brain is ambient instead of something you must remember to query.

**Commands:** `/lb:login` · `/lb:capture-session` · `/lb:capture-status`

```bash
/plugin install loombrain-sessions
```

See the [plugin README](plugins/loombrain-sessions/README.md) for setup, configuration, and how capture + session-start injection work.

### loombrain-projects

Guided workflows for managing projects, vision, goals, and tasks inside LoomBrain. Wraps the LoomBrain MCP surface (`lb_set_goal`, `lb_review_tasks`, `lb_set_vision`, PARA CRUD, episode capture) as opinionated slash commands, auto-detecting the active PARA project from your working directory.

**Commands:**

| Command | What it does |
|---|---|
| `/lb:project-kickoff` | Bootstrap a new PARA project — vision link + 1–3 goals + initial tasks in one guided flow |
| `/lb:project-backfill` | Gap-fill interview for an existing project — only asks about what's actually missing |
| `/lb:project-status` | Visible briefing: vision, active goals, top open tasks, and the review queue (read-only) |
| `/lb:weekly-review` | Guided task triage — pending-review, overdue, stale, plus a goal-without-tasks audit |
| `/lb:session-retro` | End-of-session distill — completed tasks, new tasks, and goal progress from the work just done |

```bash
/plugin install loombrain-projects
```

See the [plugin README](plugins/loombrain-projects/README.md) for prerequisites, project auto-detection, and methodology.

## License

MIT
