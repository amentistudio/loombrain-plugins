---
description: "View LoomBrain capture health, recent log entries, and configuration"
---

# /lb:capture-status

Quick health check for the LoomBrain session capture system.

## Workflow

1. **Read capture log**: Show the last 20 lines from `~/.loombrain-sessions/capture.log`.
2. **Count captures**: Count lines in `~/.loombrain-sessions/captured-sessions`.
3. **Check auth**: Report which auth method is active (LB_TOKEN, LB_API_KEY, or config file).
4. **Report**: Present a concise status summary.

## Usage

```
/lb:capture-status
```

## Implementation

Run these diagnostic commands using the Bash tool:

```bash
echo "=== Auth ==="
if [ -n "$LB_TOKEN" ]; then
  echo "Method: LB_TOKEN env var"
elif [ -n "$LB_API_KEY" ]; then
  echo "Method: LB_API_KEY env var"
elif [ -f ~/.config/loombrain/config.json ]; then
  echo "Method: Config file"
  # Check token expiry
  bun -e "const c=JSON.parse(require('fs').readFileSync('$HOME/.config/loombrain/config.json','utf-8')); const exp=new Date(c.expires_at*1000); console.log('Expires:', exp.toISOString(), exp<new Date()?'(EXPIRED)':'(valid)')"
else
  echo "Method: NONE — run 'lb login' or set LB_TOKEN"
fi

echo ""
echo "=== Captures ==="
if [ -f ~/.loombrain-sessions/captured-sessions ]; then
  echo "Total captured: $(wc -l < ~/.loombrain-sessions/captured-sessions | tr -d ' ')"
else
  echo "Total captured: 0"
fi

echo ""
echo "=== Recent Errors ==="
if [ -f ~/.loombrain-sessions/capture.log ]; then
  tail -20 ~/.loombrain-sessions/capture.log
else
  echo "No errors logged"
fi
```

Present the output to the user with clear formatting.
