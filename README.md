# Agent Tracing

**Local-first observability for AI coding agents.**  
One-click tracing setup for VS Code Copilot Chat and Claude with Langfuse — no cloud accounts required.

---

## Features

- **One-click setup** — Spins up Langfuse (Docker), installs hooks, wires API keys, opens the dashboard
- **Dual agent support** — Traces from both GitHub Copilot Chat and Claude sessions
- **Hook toggle** — Enable/disable tracing with a single inline icon
- **Zero-config tracing** — Hooks fire automatically on every agent Stop event
- **Connect to existing** — Point at any running Langfuse instance (cloud or self-hosted)
- **Local-first** — All data stays on your machine in Docker volumes

## Quick Start

1. **Install** the extension from the VS Code Marketplace
2. Click the **Agent Tracing** icon in the Activity Bar
3. Click **▶ Setup** on the Langfuse row
4. Start using Copilot Chat or Claude — traces appear in the Langfuse dashboard

> Requires **Docker** (for the Langfuse stack) and **Python 3** (for hook scripts; `langfuse` pip package is auto-installed).

## How It Works

```
Agent Session → Stop Hook → Parse Transcript → Send to Langfuse → View in Dashboard
```

The extension uses the VS Code [hooks system](https://code.visualstudio.com/docs/copilot/customization/hooks) and Claude's [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) to capture session transcripts after each agent response.

A single shared Python script (`~/.claude/hooks/langfuse_hook.py`) detects the calling agent at runtime and handles both transcript formats. Both agents share a single hook entry in `~/.claude/settings.json`:

- **VS Code Copilot Chat** reads env vars from the `env` field embedded in the hook object
- **Claude** reads env vars from the root-level `env` key in settings.json

This means one hook execution per event — no duplicates.

### What Gets Traced

| Data | Captured |
|------|----------|
| User prompts | ✅ |
| Assistant responses | ✅ |
| Reasoning/thinking text | ✅ |
| Tool invocations + results | ✅ |
| Subagent calls | ✅ |
| Session grouping | ✅ |
| Timing | ✅ |

## Sidebar

The sidebar shows a single flat tree view with inline actions on the Langfuse node:

```
TRACING SOLUTIONS                                [↻]
├── Langfuse    Running — localhost:3000    [✕] [⏹] [📄] [🔗]
```

### States

| State | Inline Icons (L→R) | Right-click Menu |
|-------|-------------------|-----------------|
| **Not configured** | ▶ Setup, 🔌 Connect | — |
| **Running + hooks on** | ✕ Disable, ⏹ Stop, 📄 Dashboard, 🔗 External | Login Info, Stack Version |
| **Running + hooks off** | 🔌 Enable, ⏹ Stop, 📄 Dashboard, 🔗 External | Login Info, Stack Version |
| **Stopped + hooks on** | ▶ Start, ✕ Disable | Connect External, Stack Version |
| **Stopped + hooks off** | ▶ Start, 🔌 Enable | Connect External, Stack Version |
| **Docker not found** | ▶ Setup, 🔌 Connect | — |

Clicking the Langfuse row opens the dashboard when running.

## File Layout

```
~/.claude/
├── settings.json              ← Hook entry (env embedded) + root env vars
└── hooks/
    ├── langfuse_hook.py       ← Shared script (both agents)
    └── .langfuse_config.json  ← Langfuse keys + log dir (fallback config)
```

## Commands

| Command | Description |
|---------|-------------|
| `Agent Tracing: Full Setup` | Backend + hooks + dashboard in one step |
| `Agent Tracing: Start Stack` | Start Langfuse containers |
| `Agent Tracing: Stop Stack` | Stop Langfuse containers |
| `Agent Tracing: Open Dashboard` | Open Langfuse in VS Code integrated browser |
| `Agent Tracing: Open Dashboard (External)` | Open Langfuse in system browser |
| `Agent Tracing: Show Login Info` | Modal with email/password + copy buttons |
| `Agent Tracing: Connect to Existing Langfuse` | Connect to a running Langfuse instance |
| `Agent Tracing: Enable Hook` | Enable tracing hooks |
| `Agent Tracing: Disable Hook` | Disable tracing hooks |
| `Agent Tracing: Refresh` | Refresh sidebar status |
| `Agent Tracing: Show Stack Version` | Show pinned Docker image versions |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agentTracing.langfuse.port` | `3000` | Langfuse dashboard port |
| `agentTracing.langfuse.autoStart` | `false` | Auto-start Langfuse when VS Code opens |

## Logging & Troubleshooting

The extension provides two independent logging layers. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for full details.

### Extension Logs (TypeScript)

Open **Output** panel → select **"Agent Tracing"** from the dropdown. Supports log level filtering (Trace/Debug/Info/Warning/Error) via the gear icon.

### Hook Script Logs (Python)

The hook script writes to two places simultaneously:

| Log | Path | Purpose |
|-----|------|---------|
| **Aggregate** | `<globalStorage>/logs/hook.log` | All agents, all sessions — `tail -f` friendly |
| **Per-session** | `<globalStorage>/logs/<agent>/<date>/<sessionId>.log` | One file per session |

Enable verbose stderr output:

```bash
# In ~/.claude/settings.json, add to the hook's env:
"CC_LANGFUSE_DEBUG": "true"
```

### Quick Diagnostics

```bash
# Watch all hook executions in real-time
tail -f ~/.config/Code/User/globalStorage/zhichli.agent-tracing/logs/hook.log

# Check if hooks are installed
cat ~/.claude/settings.json | python3 -m json.tool

# Check if Langfuse is reachable
curl -s http://localhost:3000/api/public/health
```

## Roadmap

- [ ] Per-agent trace filtering via `TRACE_AGENTS` env var
- [ ] Additional backends (Jaeger, Phoenix, OpenTelemetry)
- [ ] Token/cost tracking per session
- [ ] Multi-workspace support
- [ ] Windows native path support

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture overview, and contribution guidelines.

## License

MIT
