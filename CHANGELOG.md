# Changelog

## 0.2.0

### UI/UX
- Added Jaeger backend management alongside Langfuse in the sidebar.
- Moved shared Hook controls (Install/Uninstall) to the Agent Tracing title bar.
- Moved shared Hook Log action to the Agent Tracing title bar.
- Promoted Langfuse Login Info to an inline row action with account icon for faster discovery.
- Grouped stack lifecycle actions consistently for both backends (`Stack: Stop`, `Stack: Recreate`, `Stack: Delete`) in context menus.
- Reordered title bar controls so Refresh appears at the far right.

### Hooks & Tracing
- Renamed shared hook script to `agent_tracing_hook.py` with migration support for legacy `langfuse_hook.py` installs.
- Kept one shared hook execution for both agents/backends to avoid duplicate trace emission.
- Added support for multi-backend exporters with automatic Jaeger exporter inclusion when configured.

### Langfuse Setup & Auth
- Updated managed default credentials and login prompts.
- Updated login prompts to use a single Copy action for credentials.
- Clarified that Langfuse dashboard login is required in managed mode.
- Hardened purge flow to reset auth-related secrets for cleaner re-login testing.

### Reliability
- Improved handling around hook/settings state visibility and actions in the UI.
- Fixed Jaeger stack info to show Jaeger-specific details instead of Langfuse stack data.

## 0.1.0

### Features
- One-click Langfuse Docker stack setup (web, worker, postgres, clickhouse, redis, minio)
- Auto-install shared hook script for VS Code Copilot Chat and Claude
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
