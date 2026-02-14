# Agent Tracing — Implementation Plan

> Derived from [spec.md](spec.md). Tracks delta between spec and current code.

---

## Legend

- [x] Done — implemented and working
- [ ] Todo — not yet implemented

---

## 1. Sidebar Panel & Tree Structure

Single tree view **"Tracing Solutions"** with Langfuse as a flat leaf node (no agent children).

| # | Task | Status |
|---|------|--------|
| 1.1 | Single `agentTracing.solutions` view ("Tracing Solutions") | [x] |
| 1.2 | Langfuse leaf node with hook state in contextValue (not-configured / running+hooks-on / running+hooks-off / stopped+hooks-on / stopped+hooks-off / docker-not-found) | [x] |
| 1.3 | Title bar: only Refresh `$(refresh)` icon | [x] |
| 1.4 | Inline icons on Langfuse node: hook toggle (leftmost) + state-specific actions | [x] |
| 1.5 | Click Langfuse row → opens dashboard (when running) | [x] |
| 1.6 | Green `$(pass-filled)` / dimmed `$(circle-outline)` / yellow `$(warning)` icons | [x] |
| 1.7 | Login Info + Stack Version in right-click context menu (not inline) | [x] |

---

## 2. Setup Flow

| # | Task | Status |
|---|------|--------|
| 2.1 | Install single hook entry for all agents automatically | [x] |
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
| 3.1 | Single hook entry in `~/.claude/settings.json` with env embedded + root env | [x] |
| 3.2 | Single shared script at `~/.claude/hooks/langfuse_hook.py` detecting agent at runtime | [x] |
| 3.3 | `.langfuse_config.json` with keys + log_dir as fallback config | [x] |
| 3.4 | Script reads config with env-var-first fallback | [x] |

---

## 4. Hook Enable / Disable (Single Toggle)

| # | Task | Status |
|---|------|--------|
| 4.1 | `agentTracing.enableHook` command (single toggle, no agent selection) | [x] |
| 4.2 | `agentTracing.disableHook` command (single toggle) | [x] |
| 4.3 | Disable = config-only removal (script stays on disk) | [x] |
| 4.4 | Enable = re-write config using persisted keys | [x] |
| 4.5 | No confirmation dialog — lightweight toggle | [x] |

---

## 5. Login Info Dialog

| # | Task | Status |
|---|------|--------|
| 5.1 | `$(key)` Login Info in right-click context menu on running Langfuse node | [x] |
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
- Per-agent trace filtering (future: `TRACE_AGENTS` env var)

---

## 9. Future Work

- [ ] Per-agent filtering via `TRACE_AGENTS` env var in hook script
- [ ] Automated tests (HookManager, tree provider, integration)
- [ ] Additional backends (Jaeger, Phoenix, OpenTelemetry)
- [ ] Token/cost tracking per session
- [ ] Multi-workspace support
- [ ] Windows native path support
