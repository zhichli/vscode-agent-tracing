# Agent Tracing — Implementation Plan

> Derived from [spec.md](spec.md). Tracks delta between spec and current code.

---

## Legend

- [x] Done — implemented and working
- [ ] Todo — not yet implemented

---

## 1. Sidebar Panel & Tree Structure

Single tree view **"Tracing Solutions"** with Langfuse as a root node and agent children.

| # | Task | Status |
|---|------|--------|
| 1.1 | Single `agentTracing.solutions` view ("Tracing Solutions") | [x] |
| 1.2 | Langfuse root node with collapsible children (not-configured / running / stopped / docker-not-found) | [x] |
| 1.3 | Agent child nodes (GitHub Copilot Chat, Claude) with independent hook status | [x] |
| 1.4 | Title bar: only Refresh `$(refresh)` icon | [x] |
| 1.5 | Inline icons on Langfuse node per state (Setup / Login Info + Stop + Dashboard / Start) | [x] |
| 1.6 | Inline icons on agent child nodes (Disable / Enable) | [x] |
| 1.7 | Click Langfuse row → opens dashboard (when running) | [x] |
| 1.8 | Green `$(pass-filled)` / dimmed `$(circle-outline)` / yellow `$(warning)` icons | [x] |

---

## 2. Setup Flow

| # | Task | Status |
|---|------|--------|
| 2.1 | Install hooks for all agents automatically | [x] |
| 2.2 | Python check (`python3 -c "import langfuse"` → pip install) | [x] |
| 2.3 | Docker check | [x] |
| 2.4 | Start Langfuse (`docker compose up -d --wait`) | [x] |
| 2.5 | Health poll (90s timeout) | [x] |
| 2.6 | Auto-open dashboard in Simple Browser | [x] |
| 2.7 | Key management: auto-generate + persist in globalState | [x] |
| 2.8 | Keys seeded into Docker via `LANGFUSE_INIT_*` env vars | [x] |

---

## 3. Hook Installation

| # | Task | Status |
|---|------|--------|
| 3.1 | VS Code config at `{workspace}/.github/hooks/agent-tracing.json` with embedded env vars | [x] |
| 3.2 | Claude config merged into `~/.claude/settings.json` with root-level env | [x] |
| 3.3 | Single shared script at `~/.claude/hooks/langfuse_hook.py` detecting agent at runtime | [x] |
| 3.4 | `.langfuse_config.json` with keys + log_dir as fallback config | [x] |
| 3.5 | Script reads config with env-var-first fallback | [x] |

---

## 4. Hook Enable / Disable (Per-Agent)

| # | Task | Status |
|---|------|--------|
| 4.1 | `agentTracing.enableHook` command (per-agent) | [x] |
| 4.2 | `agentTracing.disableHook` command (per-agent) | [x] |
| 4.3 | Disable = config-only removal (script stays on disk) | [x] |
| 4.4 | Enable = re-write config using persisted keys | [x] |
| 4.5 | No confirmation dialog — lightweight toggle | [x] |
| 4.6 | Command palette: QuickPick prompt for agent selection | [x] |

---

## 5. Login Info Dialog

| # | Task | Status |
|---|------|--------|
| 5.1 | `$(key)` inline icon on running Langfuse node | [x] |
| 5.2 | Modal dialog with email + password + Copy buttons | [x] |

---

## 6. Hook Script Logging

| # | Task | Status |
|---|------|--------|
| 6.1 | Log dir structure: `<log_dir>/<agent>/<date>/<session>.log` | [x] |
| 6.2 | `log_dir` sourced from `.langfuse_config.json` | [x] |

---

## 7. Package.json / Commands Alignment

| # | Task | Status |
|---|------|--------|
| 7.1 | Commands per spec: `setup`, `startStack`, `stopStack`, `openDashboard`, `showLoginInfo`, `refresh`, `enableHook`, `disableHook` | [x] |
| 7.2 | Single `agentTracing.solutions` view, no `viewsWelcome` | [x] |
| 7.3 | Inline menus via `contextValue` matching per node type | [x] |

---

## 8. Out of Scope (per spec §9)

- Cloud Langfuse
- Custom hook script editing
- Real-time trace viewer (use Langfuse dashboard)
- Trace export/backup
- Auto-start on launch (keep as opt-in setting)
- Windows native paths
- Per-agent trace filtering

---

## 9. Future Work

- [ ] Automated tests (HookManager, tree provider, integration)
- [ ] Additional backends (Jaeger, Phoenix, OpenTelemetry)
- [ ] Token/cost tracking per session
- [ ] Multi-workspace support
- [ ] Windows native path support
