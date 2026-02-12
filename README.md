# Agent Tracing

**Local-first observability for AI coding agents.** One-click tracing setup for VS Code Copilot Chat and Claude Code with Langfuse — no cloud accounts required.

## Features

- **One-click setup** — Spins up Langfuse (Docker), installs hooks, wires API keys, opens the dashboard
- **Single sidebar panel** — "Tracing Solutions" tree view with Langfuse status and per-agent controls
- **Dual agent support** — Traces from both GitHub Copilot Chat and Claude Code sessions
- **Per-agent toggle** — Enable/disable tracing independently for each agent
- **Zero-config tracing** — Hooks fire automatically on every agent Stop event
- **Local-first** — All data stays on your machine in Docker volumes

## Quick Start

1. **Install** the extension from the VS Code Marketplace
2. Click the **Agent Tracing** icon in the Activity Bar
3. Click the **▶ Setup** button on the Langfuse row
4. Start using Copilot Chat or Claude Code — traces appear in the Langfuse dashboard

## Requirements

- **Docker** — for running the Langfuse stack locally
- **Python 3** — for the hook scripts (`langfuse` pip package is auto-installed)

## How It Works

```
Agent Session → Stop Hook → Parse Transcript → Send to Langfuse → View in Dashboard
```

The extension uses the VS Code [hooks system](https://code.visualstudio.com/docs/copilot/customization/hooks) and Claude Code's [hooks](https://code.claude.com/docs/en/hooks-guide) to capture session transcripts after each agent response.

A single shared Python script (`~/.claude/hooks/langfuse_hook.py`) detects the calling agent at runtime and handles both transcript formats.

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

## Sidebar: Tracing Solutions

The sidebar shows a single tree view with inline actions:

```
TRACING SOLUTIONS                                    [↻]
├── Langfuse                  Running — localhost:3000    [🔑] [⏹] [🔗]
│   ├── GitHub Copilot Chat   Tracing                      [✕]
│   └── Claude                Tracing                      [✕]
```

**Langfuse states:**
- **Not configured** — `▶ Setup` button runs the full setup flow
- **Running** — `🔑 Login Info` / `⏹ Stop` / `🔗 Open Dashboard` inline icons
- **Stopped** — `▶ Start` button (docker compose up only)
- **Docker not found** — `▶ Setup` with actionable error

**Agent states:**
- **Tracing** — `✕ Disable` removes the hook config (script stays for re-enable)
- **Not tracing** — `🔌 Enable` writes the hook config back

## File Layout

```
{workspace}/.github/hooks/
└── agent-tracing.json           ← VS Code hook config (env vars embedded)

~/.claude/
├── settings.json                ← Claude hook entry + root env vars
└── hooks/
    ├── langfuse_hook.py         ← Shared script (both agents)
    └── .langfuse_config.json    ← Langfuse keys + log dir (fallback)
```

## Commands

| Command | Description |
|---------|-------------|
| `Agent Tracing: Full Setup` | Backend + hooks + dashboard in one step |
| `Agent Tracing: Start Stack` | Start Langfuse containers |
| `Agent Tracing: Stop Stack` | Stop Langfuse containers |
| `Agent Tracing: Open Dashboard` | Open Langfuse in VS Code browser |
| `Agent Tracing: Show Login Info` | Modal with email/password + copy buttons |
| `Agent Tracing: Enable Hook` | Enable tracing for a specific agent |
| `Agent Tracing: Disable Hook` | Disable tracing for a specific agent |
| `Agent Tracing: Refresh` | Refresh sidebar status |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agentTracing.langfuse.port` | `3000` | Langfuse dashboard port |
| `agentTracing.langfuse.autoStart` | `false` | Auto-start Langfuse on VS Code launch |

## Roadmap

- [ ] Additional backends (Jaeger, Phoenix, OpenTelemetry)
- [ ] Token/cost tracking per session
- [ ] Multi-workspace support
- [ ] Windows native path support

## License

MIT
