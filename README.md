# Agent Tracing

**Local-first observability for AI coding agents.**  
One-click tracing setup for VS Code Copilot Chat and Claude with Langfuse — no cloud accounts required.

---

## Features

- **One-click setup** — Spins up Langfuse (Docker), installs hooks, wires API keys, opens the dashboard
- **Dual agent support** — Traces from both GitHub Copilot Chat and Claude sessions
- **Hook toggle** — Enable/disable tracing from the sidebar or command palette
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
├── Langfuse    Running — localhost:3000    [📄] [⏹]
```

### States

| State | Inline Icons | Right-click Menu |
|-------|-------------|-----------------|
| **Not configured** | ▶ Setup | — |
| **Running + hooks on** | 📄 Dashboard, ⏹ Stop | Open External, Login Info, Stack Version, Disable Hooks, Show Hook Log, Recreate, Delete |
| **Running + hooks off** | 🔌 Enable, 📄 Dashboard, ⏹ Stop | Open External, Login Info, Stack Version, Enable Hooks, Show Hook Log, Recreate, Delete |
| **Stopped + hooks on** | ▶ Start | Stack Version, Disable Hooks, Show Hook Log, Recreate, Delete |
| **Stopped + hooks off** | ▶ Start | Stack Version, Enable Hooks, Show Hook Log, Recreate, Delete |
| **Running (external)** | 📄 Dashboard, ⏹ Disconnect | Open External, Disable/Enable Hooks, Show Hook Log |
| **Docker not found** | ▶ Setup | — |

## File Layout

```
~/.claude/
├── settings.json              ← Hook entry (env embedded) + root env vars
└── hooks/
    ├── langfuse_hook.py       ← Shared script (both agents)
    └── .langfuse_config.json  ← Langfuse keys + log dir (fallback config)
```

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Description |
|---------|-------------|
| `Agent Tracing: Start` | Full setup: backend + hooks + dashboard in one step |
| `Agent Tracing: Start` (Stack) | Start Langfuse containers (when already configured) |
| `Agent Tracing: Stop Stack` | Stop Langfuse containers (data preserved) |
| `Agent Tracing: Recreate Stack` | Rebuild containers, keep trace data |
| `Agent Tracing: Delete Stack` | Remove containers + all trace data |
| `Agent Tracing: Open Dashboard` | Open Langfuse in VS Code integrated browser |
| `Agent Tracing: Open Dashboard (External Browser)` | Open Langfuse in system browser |
| `Agent Tracing: Login Info` | Modal with email/password + copy buttons |
| `Agent Tracing: Connect to Existing Langfuse` | Connect to a running Langfuse instance |
| `Agent Tracing: Disconnect External Langfuse` | Disconnect from external instance |
| `Agent Tracing: Enable Hooks` | Enable tracing hooks for all agents |
| `Agent Tracing: Disable Hooks` | Disable tracing hooks |
| `Agent Tracing: Show Hook Log` | Open the hook script log for debugging |
| `Agent Tracing: Stack Info` | Show pinned Docker image versions |
| `Agent Tracing: Refresh` | Refresh sidebar status |

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

The hook script writes to an aggregate log file:

| Log | Path | Purpose |
|-----|------|---------|
| **Aggregate** | `<globalStorage>/logs/hook.log` | All agents, all sessions — `tail -f` friendly |

Enable verbose stderr output:

```bash
# In ~/.claude/settings.json, add to the hook's env:
"CC_LANGFUSE_DEBUG": "true"
```

### Quick Diagnostics

```bash
# Watch all hook executions in real-time
tail -f ~/.config/Code/User/globalStorage/zhichli.vscode-agent-tracing/logs/hook.log

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
