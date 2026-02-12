# Agent Tracing - Spec

## 🎯 Agent Tracing

### 🧠 One-Line Definition

> **A VS Code extension that gives AI coding agents (GitHub Copilot Chat, Claude Code) local-first observability through one-click tracing setup with pluggable backends.**

### Top Principles

1. **Zero-config start** — One click to go from fresh install to traces flowing.
2. **User sees the outcome, not the plumbing** — Hooks are an implementation detail; users see agents and tracing solutions.
3. **Local-first** — All tracing data stays on the developer's machine (Docker stack). No cloud accounts required.
4. **Non-destructive** — Installing/removing hooks never corrupts existing agent configs; all changes are reversible.
5. **Minimal UI surface** — One sidebar panel, one tree view, inline icons. No wizards, no settings pages.

---

### 1. Sidebar Panel

Single activity bar entry ("Agent Tracing") with one tree view: **Tracing Solutions**.

**Title bar:** Refresh `$(refresh)` (left of `...`). No other icons — all actions are inline on tree items.

---

### 2. Tree Structure & States

#### Fresh Install

```
TRACING SOLUTIONS                                    [↻] [...]
├── Langfuse                  Not configured          [▶]
```

- Single root node, description `Not configured`, icon `$(circle-outline)` dimmed.
- Inline action: **Setup** `$(play)` → starts setup flow.

#### Running + Hooks Enabled

```
TRACING SOLUTIONS                                    [↻] [...]
├── Langfuse                  Running — localhost:3000    [🔑] [⏹] [🔗]
│   ├── GitHub Copilot Chat   Tracing
│   └── Claude                Tracing
```

- Langfuse: icon `$(pass-filled)` green. Inline: **Login Info** `$(key)`, **Stop** `$(debug-stop)`, **Open Dashboard** `$(link-external)`. Click row → opens dashboard.
- **Login Info** opens a modal dialog (`vscode.window.showInformationMessage` with `modal: true`) displaying email and password, with **Copy Email** and **Copy Password** buttons.
- Agent children (expanded by default):
  - icon `$(check)` green, description `Tracing` when hook is installed. Inline: **Disable** `$(close)`.
  - icon `$(circle-outline)` dimmed, description `Not tracing` when hook is not installed. Inline: **Enable** `$(plug)`.
  - Each agent is independent — one can be tracing while the other is not.

#### Running + Mixed Hook State

```
TRACING SOLUTIONS                                    [↻] [...]
├── Langfuse                  Running — localhost:3000    [🔑] [⏹] [🔗]
│   ├── GitHub Copilot Chat   Tracing                      [✕]
│   └── Claude                Not tracing                   [🔌]
```

- Each agent independently shows its hook status. User can enable/disable each separately via inline icons.

#### Stopped

```
TRACING SOLUTIONS                                    [↻] [...]
├── Langfuse                  Stopped                    [▶]
│   ├── GitHub Copilot Chat   Tracing
│   └── Claude                Tracing
```

- Icon `$(circle-outline)` dimmed. Inline: **Start** `$(play)` (docker compose up only, no setup wizard).
- Agent children visible, hooks still installed.

#### Docker Not Available

```
TRACING SOLUTIONS                                    [↻] [...]
├── Langfuse                  Docker not found           [▶]
```

- Icon `$(warning)` yellow. Inline: **Setup** `$(play)` → setup flow with actionable Docker error.

---

### 3. Setup Flow

Triggered by **Setup** on an unconfigured/error Langfuse node. No agent selection — hooks are installed for all supported agents automatically.

| Step | Detail |
|------|--------|
| **1. Install hooks** | Writes hook config + script + config file for both agents (see §4). |
| **2. Python check** | `python3 -c "import langfuse"` → if missing, `pip3 install --user langfuse`. |
| **3. Docker check** | `docker info` → fail with actionable error if unavailable. |
| **4. Start Langfuse** | `docker compose up -d --wait` (web, worker, postgres, clickhouse, redis, minio). |
| **5. Health poll** | `/api/public/health` up to 90s. |
| **6. Open browser** | Auto-opens `http://localhost:{port}` in Simple Browser. Login info available anytime via `$(key)` icon. |

**Key management:** Public/secret keys are auto-generated on first setup and persisted in `context.globalState`. They survive hook disable/enable, extension restarts, and VS Code updates. Keys are seeded into Langfuse via `LANGFUSE_INIT_*` env vars in Docker Compose.

---

### 4. Hook Installation

#### Tested Hook Formats

The two agents use different config formats and locations (verified manually):

**VS Code Copilot Chat** — Copilot format, workspace-scoped:
```json
// {workspace}/.github/hooks/agent-tracing.json
{
  "hooks": {
    "Stop": [
      {
        "type": "command",
        "command": "python3 ~/.claude/hooks/langfuse_hook.py",
        "timeout": 60,
        "env": {
          "TRACE_TO_LANGFUSE": "true",
          "LANGFUSE_PUBLIC_KEY": "<pk>",
          "LANGFUSE_SECRET_KEY": "<sk>",
          "LANGFUSE_HOST": "http://localhost:3000"
        }
      }
    ]
  }
}
```

**Claude Code** — Claude format, user-scoped:
```json
// ~/.claude/settings.json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.claude/hooks/langfuse_hook.py"
          }
        ]
      }
    ]
  },
  "env": {
    "TRACE_TO_LANGFUSE": "true",
    "LANGFUSE_PUBLIC_KEY": "<pk>",
    "LANGFUSE_SECRET_KEY": "<sk>",
    "LANGFUSE_HOST": "http://localhost:3000"
  }
}
```

#### Key Differences

| | VS Code Copilot Chat | Claude Code |
|-|---------------------|-------------|
| Config path | `{workspace}/.github/hooks/agent-tracing.json` | `~/.claude/settings.json` |
| Scope | Workspace (per-project) | User (global) |
| Hook format | `{ type, command, timeout, env }` directly in array | `{ hooks: [{ type, command }] }` wrapper |
| Env vars | Embedded per-hook in `env` field | Root-level `env` in settings.json |

#### Shared Hook Script

Both configs point to the **same script** at `~/.claude/hooks/langfuse_hook.py`. The script is installed once and reused for both agents. It detects the calling agent at runtime via stdin format.

The script **also** reads a config file for Langfuse keys as a fallback (in case env vars aren't available):

```
~/.claude/hooks/.langfuse_config.json
```

```json
{
  "public_key": "pk-lf-...",
  "secret_key": "sk-lf-...",
  "host": "http://localhost:3000",
  "log_dir": "/home/user/.config/Code/User/globalStorage/zhichli.vscode-agent-tracing/logs"
}
```

The script loads config with env-var-first fallback:
```python
CONFIG_PATH = Path.home() / ".claude" / "hooks" / ".langfuse_config.json"
config = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}

pk = os.environ.get("LANGFUSE_PUBLIC_KEY") or config.get("public_key")
sk = os.environ.get("LANGFUSE_SECRET_KEY") or config.get("secret_key")
host = os.environ.get("LANGFUSE_HOST") or config.get("host", "http://localhost:3000")
log_dir = config.get("log_dir", "")
```

This way:
- **VS Code** hooks get env vars injected via the Copilot format `env` field AND the config file.
- **Claude** hooks get env vars from root `env` in `settings.json` AND the config file.
- The config file is the canonical source for `log_dir` (not available via env).

#### File Layout

```
{workspace}/.github/hooks/
└── agent-tracing.json           ← VS Code hook config (Copilot format, env embedded)

~/.claude/
├── settings.json                ← Claude hook config (merged) + root env vars
└── hooks/
    ├── langfuse_hook.py         ← Single script, shared by both agents
    └── .langfuse_config.json    ← Langfuse keys + log dir (written by extension)
```

#### What Setup Writes

1. **`~/.claude/hooks/langfuse_hook.py`** — Copies script from extension resources. `chmod +x`.
2. **`~/.claude/hooks/.langfuse_config.json`** — Writes keys and log dir from `globalState`.
3. **`~/.claude/settings.json`** — Merges hook entry into `hooks.Stop` and keys into root `env` (for Claude).
4. **`{workspace}/.github/hooks/agent-tracing.json`** — Writes standalone file with env embedded (for VS Code). Requires open workspace.

#### Hook Status Detection

- **VS Code hook**: Check if `{workspace}/.github/hooks/agent-tracing.json` exists.
- **Claude hook**: Check if `~/.claude/settings.json` contains a `hooks.Stop` entry referencing `langfuse_hook.py`.
- Both checks are independent — one agent can be hooked without the other.

#### Enable / Disable

Since hooks are now separate per-agent, enable/disable works per-agent:
- **Disable VS Code hook**: Delete `{workspace}/.github/hooks/agent-tracing.json`.
- **Disable Claude hook**: Remove the `langfuse_hook.py` entry from `~/.claude/settings.json`.
- **Enable**: Re-write the config file / entry using keys from `.langfuse_config.json`.

---

### 5. Hook Script Logging

```
<log_dir>/
├── github-copilot-chat/<YYYY-MM-DD>/<sessionId>.log
└── claude/<YYYY-MM-DD>/<sessionId>.log
```

`log_dir` is read from `.langfuse_config.json`. Scripts append agent, date, and session ID:
```python
log_file = Path(config["log_dir"]) / agent / datetime.now().strftime("%Y-%m-%d") / f"{session_id}.log"
```

---

### 6. Hooks Enable / Disable

Since hooks are per-agent (different files and formats), each agent child node has its own toggle.

| Action | Trigger | Behavior |
|--------|---------|----------|
| **Disable agent** | `$(close)` inline icon on tracing agent child | VS Code: deletes `{workspace}/.github/hooks/agent-tracing.json`. Claude: removes `langfuse_hook.py` entry from `~/.claude/settings.json`. Script + `.langfuse_config.json` stay on disk for re-enable. |
| **Enable agent** | `$(plug)` inline icon on non-tracing agent child | Writes config back using keys from `.langfuse_config.json`. VS Code: creates `agent-tracing.json`. Claude: adds entry to `settings.json`. |

Also available via command palette: `Agent Tracing: Enable Hook` / `Agent Tracing: Disable Hook` (prompts for agent if ambiguous).

No confirmation dialog — lightweight toggle.

---

### 7. UI / UX Principles

| Principle | Description |
|-----------|-------------|
| **Actions on items** | Setup/Stop/Open are inline icons on tree items, not title bar buttons. |
| **Progressive disclosure** | Fresh: one row, one button. Post-setup: tree expands with agent children. |
| **Status at a glance** | Green = running/tracing. Dimmed = stopped/not tracing. Yellow = problem. |
| **Per-agent control** | Each agent has its own config file → independent enable/disable. |
| **Fail fast** | Missing Docker/pip/python → actionable error message. No silent failures. |

---

### 8. Platform & Scope

| Target | Priority |
|--------|----------|
| Linux / macOS | Primary |
| Windows (WSL) | Supported |
| Windows (native) | Future |
| VS Code forks (Cursor, Windsurf) | Future |
| GitHub Copilot Chat + Claude Code | Primary |
| Other agents (Cline, Roo) | Future |
| Langfuse (self-hosted) | Primary |
| Langfuse (cloud) / Phoenix / Jaeger | Future |

---

### 9. Non-Goals

| Feature | Rationale |
|---------|-----------|
| Cloud Langfuse | V0.2 is local-only. |
| Custom hook script editing | Extension owns hook scripts. |
| Real-time trace viewer | Langfuse dashboard handles this. |
| Trace export/backup | Docker volumes persist data. |
| Auto-start on launch | User starts explicitly. |
| Per-agent hook customization | Enable/disable is per-agent, but hook script and config are shared. No per-agent trace filtering. |
| Windows native paths | WSL works for now. |

---

### Appendix: Commands

| Command | ID |
|---------|----|
| Full Setup | `agentTracing.setup` |
| Start Stack | `agentTracing.startStack` |
| Stop Stack | `agentTracing.stopStack` |
| Open Dashboard | `agentTracing.openDashboard` |
| Show Login Info | `agentTracing.showLoginInfo` |
| Refresh | `agentTracing.refresh` |
| Enable Hook | `agentTracing.enableHook` |
| Disable Hook | `agentTracing.disableHook` |

### Appendix: Data Flow

```
  TRACING SOLUTIONS                           [↻] [...]
  ├── Langfuse  Running — localhost:3000      [🔑] [⏹] [🔗]
  │   ├── GitHub Copilot Chat  Tracing          [✕]
  │   └── Claude               Tracing          [✕]
         │
    Setup (one click, no prompts):
      Install hooks → pip check → Docker check
      → docker compose up → health poll → open browser
         │
    Hook files (per-agent config, shared script):
      VS Code:  {workspace}/.github/hooks/agent-tracing.json
      Claude:   ~/.claude/settings.json (merged entry + root env)
      Script:   ~/.claude/hooks/langfuse_hook.py
      Keys:     ~/.claude/hooks/.langfuse_config.json
         │
    Runtime (agent Stop event):
    Agent ──► Hook Script (Python) ──► Langfuse (Docker)
                 │  env vars from config OR .langfuse_config.json
                 │  detects agent via stdin format
                 │
              Log: <log_dir>/<agent>/<date>/<session>.log
```
