# Changelog

## 0.1.0

### Features
- One-click Langfuse Docker stack setup (web, worker, postgres, clickhouse, redis, minio)
- Auto-install shared hook script for VS Code Copilot Chat and Claude Code
- Single hook entry in `~/.claude/settings.json` — works for both agents, no duplicate executions
- Sidebar tree view with inline actions (setup, start, stop, dashboard, hook toggle)
- Connect to existing Langfuse instances (cloud or self-hosted)
- Auto-generate and persist Langfuse API keys
- Open dashboard in VS Code integrated browser or system browser
- Login info modal with copy buttons
- Python `langfuse` package auto-install

### Logging
- Extension: `LogOutputChannel` with level filtering (Debug/Info/Warning/Error)
- Hook script: dual-write logging (aggregate `hook.log` + per-session files)
- Hook script: debug mode via `CC_LANGFUSE_DEBUG=true` (stderr output)
- Hook script: logs agent identity, env source, host, and turn count per invocation
