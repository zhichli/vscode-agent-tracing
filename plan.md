# Agent Tracing — Implementation Plan

> Derived from [spec.md](spec.md). Tracks delta between spec and current code.

---

## Legend

- [x] Done — implemented and working
- [~] Partial — started but diverges from spec or incomplete
- [ ] Todo — not yet implemented

---

## 1. Sidebar Panel & Tree Structure

### Current state
Two separate tree views (`agentTracing.hooks` "Hooks" + `agentTracing.stacks` "Observability") with flat item lists and title-bar actions.

### Spec target
Single tree view **"Tracing Solutions"** with Langfuse as a root node and agent children nested underneath.

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1.1 | Merge two tree views into one `agentTracing.solutions` view named "Tracing Solutions" | [ ] | Remove `agentTracing.hooks` and `agentTracing.stacks` views from package.json. Register a single `TracingSolutionsTreeProvider`. |
| 1.2 | Langfuse root node with collapsible children | [ ] | Root = Langfuse (states: not-configured, running, stopped, docker-not-found). Children = agent nodes. |
| 1.3 | Agent child nodes (GitHub Copilot Chat, Claude) | [ ] | Each child shows independent hook status: "Tracing" / "Not tracing". |
| 1.4 | Title bar: only Refresh `$(refresh)` icon (left of `...`) | [ ] | Move all other actions to inline icons on tree items. Remove title-bar Setup/Start/Stop/Open/Install/Remove buttons. |
| 1.5 | Inline icons on Langfuse node per state | [ ] | Not-configured: `$(play)` Setup. Running: `$(key)` Login Info, `$(debug-stop)` Stop, `$(link-external)` Open Dashboard. Stopped: `$(play)` Start. Docker-not-found: `$(play)` Setup. |
| 1.6 | Inline icons on agent child nodes | [ ] | Tracing: `$(close)` Disable. Not tracing: `$(plug)` Enable. |
| 1.7 | Click Langfuse row → opens dashboard (when running) | [x] | Already wired via `command` on tree item. |
| 1.8 | Green `$(pass-filled)` / dimmed `$(circle-outline)` / yellow `$(warning)` icons | [x] | Stacks view already uses these. Need to carry over to merged view. |

---

## 2. Setup Flow

| # | Task | Status | Notes |
|---|------|--------|-------|
| 2.1 | Step 1: Install hooks for **all** agents automatically | [x] | `hookManager.installAll()` does both. |
| 2.2 | Step 2: Python check (`python3 -c "import langfuse"` → pip install) | [x] | `ensurePythonLangfuse()` in LangfuseManager. |
| 2.3 | Step 3: Docker check | [x] | `requireDocker()`. |
| 2.4 | Step 4: Start Langfuse (`docker compose up -d --wait`) | [x] | `start()`. |
| 2.5 | Step 5: Health poll (90s timeout) | [x] | `waitForReady()`. |
| 2.6 | Step 6: Auto-open dashboard in Simple Browser | [~] | Opens after user clicks "Open Dashboard" in notification. Spec says auto-open. |
| 2.7 | Key management: auto-generate + persist in globalState | [x] | `generateAndStoreKeys()`. |
| 2.8 | Keys seeded into Docker via `LANGFUSE_INIT_*` env vars | [x] | In compose YAML. |

---

## 3. Hook Installation

### 3a. VS Code Copilot Chat hook

| # | Task | Status | Notes |
|---|------|--------|-------|
| 3.1 | Config at `{workspace}/.github/hooks/agent-tracing.json` | [x] | Written by `installVSCodeHook()`. |
| 3.2 | Env vars embedded per-hook in `env` field | [x] | JSON includes `env` block. |
| 3.3 | Script copied to workspace `.github/hooks/` | [~] | Spec says shared script at `~/.claude/hooks/langfuse_hook.py`. Current code copies a separate `langfuse_vscode_hook.py` to workspace. |

### 3b. Claude Code hook

| # | Task | Status | Notes |
|---|------|--------|-------|
| 3.4 | Hook entry merged into `~/.claude/settings.json` | [x] | `installClaudeCodeHook()`. |
| 3.5 | Root-level `env` in settings.json | [~] | Currently env vars go to `{workspace}/.claude/settings.local.json`. Spec says root `env` in `~/.claude/settings.json`. |
| 3.6 | Script at `~/.claude/hooks/langfuse_hook.py` | [x] | Copied from resources. |

### 3c. Shared config file

| # | Task | Status | Notes |
|---|------|--------|-------|
| 3.7 | Write `~/.claude/hooks/.langfuse_config.json` with keys + log_dir | [ ] | Not implemented. Spec requires this as fallback config for the hook script. |
| 3.8 | Script reads config with env-var-first fallback | [ ] | Hook scripts need to read `.langfuse_config.json` if env vars missing. |
| 3.9 | Single shared script for both agents | [ ] | Currently two separate scripts. Spec says one script detecting agent at runtime. |

---

## 4. Hook Enable / Disable (Per-Agent)

| # | Task | Status | Notes |
|---|------|--------|-------|
| 4.1 | `agentTracing.enableHook` command (per-agent) | [ ] | Current `installHooks` installs all. Need per-agent enable. |
| 4.2 | `agentTracing.disableHook` command (per-agent) | [ ] | Current `removeHooks` removes all. Need per-agent disable. |
| 4.3 | Disable VS Code hook = delete `agent-tracing.json` only (keep script) | [ ] | Current remove deletes both script + config. |
| 4.4 | Disable Claude hook = remove entry from `settings.json` only (keep script) | [~] | Current remove also deletes the script file. |
| 4.5 | Enable = re-write config using keys from `.langfuse_config.json` | [ ] | Depends on 3.7. |
| 4.6 | No confirmation dialog — lightweight toggle | [ ] | |
| 4.7 | Command palette: prompt for agent if ambiguous | [ ] | |

---

## 5. Login Info Dialog

| # | Task | Status | Notes |
|---|------|--------|-------|
| 5.1 | `$(key)` inline icon on running Langfuse node | [ ] | Currently in title bar overflow. Move to inline. |
| 5.2 | Modal dialog with email + password + Copy buttons | [~] | Currently non-modal `showInformationMessage`. Spec says `modal: true`. |

---

## 6. Hook Script Logging

| # | Task | Status | Notes |
|---|------|--------|-------|
| 6.1 | Log dir structure: `<log_dir>/<agent>/<date>/<session>.log` | [ ] | Need to verify hook scripts implement this. |
| 6.2 | `log_dir` sourced from `.langfuse_config.json` | [ ] | Depends on 3.7. Extension should set `log_dir` to globalStorage path. |

---

## 7. Package.json / Commands Alignment

| # | Task | Status | Notes |
|---|------|--------|-------|
| 7.1 | Rename commands per spec appendix | [ ] | Need `agentTracing.enableHook` / `agentTracing.disableHook` instead of `installHooks` / `removeHooks`. |
| 7.2 | Remove `agentTracing.installHooks` and `agentTracing.removeHooks` | [ ] | Replace with per-agent enable/disable. |
| 7.3 | Update menus to use single tree view + `contextValue` matching | [ ] | `view/item/context` menus need new contextValues for agent children. |
| 7.4 | Remove `agentTracing.hooks` and `agentTracing.stacks` view registrations | [ ] | Replace with single `agentTracing.solutions`. |
| 7.5 | Remove `viewsWelcome` for stacks (fresh install shows tree node instead) | [ ] | Spec: fresh install = one row "Langfuse — Not configured [▶]". |

---

## 8. Suggested Implementation Order

> Each phase is a shippable increment. Complete and test each phase before starting the next.

### Phase 1 — Shared hook infrastructure (3.7, 3.8, 3.9)
Unify hook scripts into a single `langfuse_hook.py` that reads `.langfuse_config.json`. Write the config file from the extension. This is foundational for per-agent enable/disable.

### Phase 2 — Per-agent enable/disable (4.1–4.7, 7.1–7.2)
Add `enableHook` / `disableHook` commands that operate per-agent. Update HookManager to support individual enable/disable without deleting scripts.

### Phase 3 — Unified tree view (1.1–1.8, 7.3–7.5)
Replace two tree views with a single `TracingSolutionsTreeProvider`. Langfuse = root, agents = children. Move all actions from title bar to inline icons. Update package.json contributions.

### Phase 4 — UX polish (2.6, 5.1–5.2, 6.1–6.2)
Auto-open dashboard after setup. Make login info modal. Verify logging works end-to-end.

---

## 9. Out of Scope (per spec §9)

- Cloud Langfuse
- Custom hook script editing
- Real-time trace viewer (use Langfuse dashboard)
- Trace export/backup
- Auto-start on launch (keep as opt-in setting)
- Windows native paths
- Per-agent trace filtering
