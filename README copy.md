# Agent Tracing

**Local-first observability for AI coding agents.** Pluggable tracing for VS Code Copilot and Claude Code sessions with one-click setup. Ships with Langfuse support out of the box — more backends coming soon.

## Features

- **One-click setup** — Spins up an observability backend (Docker), installs hook scripts, and wires API keys automatically
- **VS Code sidebar** — Hooks status and observability stack management in the Activity Bar
- **Dual agent support** — Traces from both VS Code Copilot Chat and Claude Code sessions
- **Integrated dashboard** — Open your tracing dashboard in VS Code's built-in browser
- **Zero-config tracing** — Hooks fire automatically on every agent Stop event
- **Pluggable backends** — Langfuse included; architecture supports additional backends (Jaeger, Phoenix, OpenTelemetry)

## Quick Start

1. **Install** the extension from the VS Code Marketplace
2. Click the **Agent Tracing** icon in the Activity Bar (pulse icon)
3. Click the **rocket** icon or run `Agent Tracing: Full Setup` from the Command Palette
4. Start using Copilot Chat or Claude Code — traces appear automatically

## Requirements

- **Docker** — for running observability stacks locally
- **Python 3** — for the hook scripts
- **pip** — required Python packages are auto-installed

## How It Works

Agent Tracing uses the VS Code agent [hooks system](https://code.visualstudio.com/docs/copilot/customization/hooks) and Claude Code's [hooks system](https://code.claude.com/docs/en/hooks-guide) to capture conversation transcripts after each agent response (Stop hook event).

```
Agent Session → Stop Hook → Parse Transcript → Send to Backend → View in Dashboard
```

### What gets traced

| Data | Captured |
|------|----------|
| User prompts | ✅ |
| Assistant responses | ✅ |
| Reasoning/thinking text | ✅ |
| Tool invocations + results | ✅ |
| Subagent calls | ✅ |
| Session grouping | ✅ |
| Timing | ✅ |

## Supported Backends

| Backend | Status |
|---------|--------|
| **Langfuse** | ✅ Included |
| Jaeger | Planned |
| Phoenix (Arize) | Planned |
| OpenTelemetry Collector | Planned |

## Sidebar Views

### Hooks
Shows installed hook status for:
- **VS Code Stop Hook** — traces Copilot Chat agent sessions
- **Claude Code Stop Hook** — traces Claude Code terminal sessions

### Observability
Shows available observability stacks:
- **Langfuse** — click to open the dashboard; inline buttons to start/stop

## Commands

| Command | Description |
|---------|-------------|
| `Agent Tracing: Full Setup` | Backend + hooks + env vars in one step |
| `Agent Tracing: Start Observability Stack` | Start backend containers |
| `Agent Tracing: Stop Observability Stack` | Stop backend containers |
| `Agent Tracing: Open Dashboard` | Open dashboard in VS Code browser |
| `Agent Tracing: Install Hooks` | Install hook scripts for both agents |
| `Agent Tracing: Remove Hooks` | Remove hook scripts |
| `Agent Tracing: Refresh` | Refresh sidebar status |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agentTracing.langfuse.port` | `3000` | Langfuse dashboard port |
| `agentTracing.langfuse.autoStart` | `false` | Auto-start Langfuse on VS Code launch |

## Roadmap

- [ ] Additional observability backends (Jaeger, Phoenix, OpenTelemetry)
- [ ] Token/cost tracking per session
- [ ] Inline trace annotations in the editor
- [ ] Evaluation scoring integration
- [ ] Multi-workspace support

## License

MIT
