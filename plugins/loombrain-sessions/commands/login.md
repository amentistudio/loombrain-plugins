---
description: "Log in to LoomBrain to enable session capture"
---

# /lb:login

Log in to LoomBrain. Without a logged-in account, the session capture plugin cannot send your sessions to LoomBrain — they will be silently lost.

## Workflow

### 1. Check current auth status

Run these checks using the Bash tool:

```bash
# Check env var
if [ -n "$LB_TOKEN" ] || [ -n "$LB_API_KEY" ]; then
  echo "AUTH_OK: Using API key from environment variable"
  exit 0
fi

# Check config file
if [ -f ~/.config/loombrain/config.json ]; then
  echo "AUTH_OK: Config file exists at ~/.config/loombrain/config.json"
  exit 0
fi

echo "AUTH_MISSING"
```

### 2. If already logged in

Tell the user they are already authenticated and the session capture hook is active. Show which auth method is in use.

### 3. If NOT logged in

**This is critical** — tell the user clearly:

> You are **not logged in** to LoomBrain. Without authentication, the session capture hook runs but **silently fails** — your coding sessions are not being saved.

Then offer two options:

#### Option A: Browser login (recommended)

Tell the user to run this command in their terminal (the `!` prefix runs it interactively in this session):

```
! bun run ${CLAUDE_PLUGIN_ROOT}/src/login.ts
```

This opens a browser to `app.loombrain.com`, completes the login, and saves credentials to `~/.config/loombrain/config.json`.

#### Option B: API key

1. Go to [app.loombrain.com/settings/api-keys](https://app.loombrain.com/settings/api-keys)
2. Create a new API key
3. Add to your shell profile:

```bash
export LB_TOKEN="your-api-key-here"
```

Then restart Claude Code for the env var to take effect.

### 4. Verify

After login, run `/lb:capture-status` to confirm everything is working.
