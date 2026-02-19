# Troubleshooting

Quick guide for diagnosing common issues with the Agent Tracing extension.

---

## Where Are the Logs?

### Extension Logs (TypeScript — VS Code side)

1. Open the **Output** panel (`Ctrl+Shift+U` / `Cmd+Shift+U`)
2. Select **"Agent Tracing (Log)"** from the dropdown
3. Set log level via the gear icon (Trace → Debug → Info → Warning → Error)

These logs cover: setup steps, Docker operations, hook install/remove, health checks.

### Hook Script Logs (Python — runs per agent event)

The hook script writes to an aggregate log file:

| Log | Path | Use |
|-----|------|-----|
| **Aggregate** | `~/.config/Code/User/globalStorage/zhichli.vscode-agent-tracing/logs/hook.log` | All agents, all sessions in one file |

> The exact `globalStorage` path varies by OS and VS Code variant. Check the `log_dir` value in `~/.claude/hooks/.langfuse_config.json`.

**Watch in real-time:**

```bash
# Tail the aggregate log
tail -f "$(python3 -c "import json,pathlib; print(json.loads((pathlib.Path.home()/'.claude'/'hooks'/'.langfuse_config.json').read_text())['log_dir'])")/hook.log"
```

**Enable debug-level output (stderr + extra detail):**

Add to the hook's `env` in `~/.claude/settings.json`:

```json
"CC_LANGFUSE_DEBUG": "true"
```

This prints all log lines to stderr and enables `[DEBUG]` entries (stdin keys, transcript paths, etc.).

---

## Common Issues

### Setup fails: "Docker is not installed or not running"

**Cause:** `docker info` returned an error.

**Fix:**
```bash
# Check if Docker daemon is running
docker info

# Start Docker if needed (Linux)
sudo systemctl start docker

# Or install Docker: https://docs.docker.com/get-docker/
```

### Setup fails: "Pool overlaps" or "address pools have been fully subnetted"

**Cause:** Docker ran out of network address space (too many dangling networks).

**Fix:**
```bash
docker network prune
```

Then retry setup.

### Hooks installed but no traces appearing

**Check 1: Is Langfuse running?**
```bash
curl -s http://localhost:3000/api/public/health
# Should return {"status":"OK"}
```

**Check 2: Is the hook entry in settings.json?**
```bash
cat ~/.claude/settings.json | python3 -m json.tool | grep agent_tracing_hook
```

**Check 3: Is TRACE_TO_LANGFUSE set?**
```bash
cat ~/.claude/settings.json | python3 -m json.tool | grep TRACE_TO_LANGFUSE
# Should appear in both the hook's "env" and root "env"
```

**Check 4: Are API keys set?**
```bash
cat ~/.claude/hooks/.langfuse_config.json | python3 -m json.tool
# Should show public_key, secret_key, host, log_dir
```

**Check 5: Is the Python langfuse package installed?**
```bash
python3 -c "import langfuse; print(langfuse.__version__)"
```

**Check 6: Look at hook logs for errors**
```bash
# Find the aggregate log
cat ~/.claude/hooks/.langfuse_config.json | python3 -c "import sys,json; print(json.load(sys.stdin)['log_dir'])"
# Then check hook.log in that directory
```

### Traces appear for one agent but not the other

Both agents share a single hook entry. If one works, the hook script and Langfuse are fine. Check:

1. **VS Code Copilot Chat** — requires an active Copilot subscription and a chat session that generates a transcript
2. **Claude** — requires Claude to be installed and have at least one session in `~/.claude/projects/`

Look at the aggregate `hook.log` for the `agent=` field to confirm which agent is firing.

### "Langfuse is already running" during setup

Another Langfuse instance is reachable at the configured port. Options:

1. **Connect to it** — use "Connect to Existing Langfuse" (provide your API keys)
2. **Change port** — set `agentTracing.langfuse.port` in VS Code settings, then retry setup
3. **Stop the other instance** — `docker compose down` in the other project

### Dashboard shows "This site can't be reached" in VS Code browser

The integrated browser may fail if Langfuse isn't fully ready yet.

**Fix:** Wait a few seconds and click **Refresh** in the sidebar, then click the Langfuse row to reopen. Or use the `$(link-external)` icon to open in your system browser.

### Dashboard login — what are the credentials?

Click the inline **Login Info** (`$(account)`) button on the running Langfuse row, or use the command palette: `Agent Tracing: Info: Login Credentials`.

Default credentials (managed mode):
- **Email:** `vscode@agent.tracing`
- **User Name:** `vscode`
- **Password:** `vscode@agent.tracing`

The login prompt now includes a single **Copy** action. Email and password use the same value.

### Port conflict (3000 already in use)

Change the port in VS Code settings:

```json
{
  "agentTracing.langfuse.port": 3001
}
```

Then run **Full Setup** again (it regenerates the Docker Compose file with the new port).

### Hook script errors: Python/runtime issues

The hook script uses Python stdlib only (no `langfuse` pip package required).

```bash
# Check which python3 the hook will use
which python3

# Check Python version (3.8+ required)
python3 --version
```

### Existing hooks in settings.json — will the extension break them?

No. The extension is designed to be non-destructive:

- **Install:** Appends our entry to `hooks.Stop` array, merges our 4 env keys into root `env`. Existing entries and env vars are untouched.
- **Remove:** Filters out entries containing `agent_tracing_hook.py` (and legacy `langfuse_hook.py` during migration). Deletes only our 4 env keys. If arrays/objects become empty, they're cleaned up.

### I want to reset everything

```bash
# Remove hook entry from settings.json
# (or use the Disable Hook command — it's cleaner)

# Remove shared files
rm ~/.claude/hooks/agent_tracing_hook.py
rm ~/.claude/hooks/.langfuse_config.json

# Stop and remove Docker containers + volumes
docker compose -p agent-tracing down -v
```

---

## Diagnostic Commands Cheat Sheet

```bash
# Is Docker running?
docker info >/dev/null 2>&1 && echo "OK" || echo "FAILED"

# Is Langfuse healthy?
curl -sf http://localhost:3000/api/public/health && echo " OK" || echo "FAILED"

# Are containers running?
docker ps --filter "label=com.agent-tracing.managed=true" --format "{{.Names}}\t{{.Status}}"

# Hook entry present?
python3 -c "
import json, pathlib
s = json.loads((pathlib.Path.home()/'.claude'/'settings.json').read_text())
hooks = s.get('hooks',{}).get('Stop',[])
found = any('agent_tracing_hook' in str(h) or 'langfuse_hook' in str(h) for h in hooks)
print('Hook entry:', 'FOUND' if found else 'MISSING')
print('Root env TRACE_TO_LANGFUSE:', s.get('env',{}).get('TRACE_TO_LANGFUSE','NOT SET'))
"

# Python runtime available?
python3 --version

# Hook log location
python3 -c "
import json, pathlib
c = json.loads((pathlib.Path.home()/'.claude'/'hooks'/'.langfuse_config.json').read_text())
print('Log dir:', c.get('log_dir','NOT SET'))
print('Aggregate:', c.get('log_dir','')+'/hook.log')
"
```

---

## Getting Help

- **Extension Output:** Check "Agent Tracing (Log)" in the Output panel first
- **Hook logs:** Check `hook.log` in the log directory
- **GitHub Issues:** [github.com/zhichli/vscode-agent-tracing/issues](https://github.com/zhichli/vscode-agent-tracing/issues)
