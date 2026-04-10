---
description: "Verify LoomBrain capture config and test the pipeline"
---

# /lb:capture-session

Verify that the LoomBrain session capture pipeline is correctly configured and working.

## Workflow

1. **Check auth**: Verify that `LB_TOKEN` env var is set OR `~/.config/loombrain/config.json` exists with valid tokens.

2. **Check hook registration**: Verify that the `SessionEnd` hook is registered by checking if this plugin's hook config is active.

3. **Test API connectivity**: Make a lightweight API call to verify the auth credentials work (e.g., GET the usage endpoint).

4. **Report status**:
   - Auth method detected (env var / config file)
   - API URL in use
   - Hook registration status
   - Last 5 entries from `~/.loombrain-sessions/capture.log` (if any errors)
   - Count of captured sessions from `~/.loombrain-sessions/captured-sessions`

## Usage

```
/lb:capture-session
```

## Implementation

Run these checks using Bash tool:

```bash
# Check auth
if [ -n "$LB_TOKEN" ]; then
  echo "Auth: LB_TOKEN env var"
elif [ -f ~/.config/loombrain/config.json ]; then
  echo "Auth: config file (~/.config/loombrain/config.json)"
else
  echo "ERROR: No auth configured. Run 'lb login' or set LB_TOKEN."
fi

# Check captured sessions count
if [ -f ~/.loombrain-sessions/captured-sessions ]; then
  wc -l < ~/.loombrain-sessions/captured-sessions | tr -d ' '
else
  echo "0"
fi

# Check recent errors
if [ -f ~/.loombrain-sessions/capture.log ]; then
  tail -5 ~/.loombrain-sessions/capture.log
else
  echo "No errors logged"
fi
```

Report findings in a concise summary table.
