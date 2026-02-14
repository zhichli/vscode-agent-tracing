# Agent Tracing - Spec

## 🎯 Agent Tracing

### 🧠 One-Line Definition

> **A VS Code extension that gives AI coding agents (GitHub Copilot Chat, Claude) local-first observability through one-click tracing setup with pluggable backends.**

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
├── Langfuse                  Running — localhost:3000    [✕] [⏹] [📄] [🔗]
```

- Langfuse: icon `$(pass-filled)` green. Leaf node (no children).
- Inline L→R: **Disable Hooks** `$(close)`, **Stop** `$(debug-stop)`, **Open Dashboard** `$(open-preview)`, **Open External** `$(link-external)`.
- Click row → opens dashboard in integrated browser.
- Right-click context menu: **Login Info**, **Stack Version**.
- **Login Info** opens a modal dialog (`vscode.window.showInformationMessage` with `modal: true`) displaying email and password, with **Copy Email** and **Copy Password** buttons.

#### Running + Hooks Disabled

```
TRACING SOLUTIONS                                    [↻] [...]
├── Langfuse                  Running — localhost:3000    [🔌] [⏹] [📄] [🔗]
```

- Same as above but inline @1 is **Enable Hooks** `$(plug)` instead of Disable.

#### Stopped + Hooks Enabled

```
TRACING SOLUTIONS                                    [↻] [...]
├── Langfuse                  Stopped                    [▶] [✕]
```

- Icon `$(circle-outline)` dimmed. Inline: **Start** `$(play)`, **Disable Hooks** `$(close)`.
- Right-click: Connect External, Stack Version.

#### Stopped + Hooks Disabled

```
TRACING SOLUTIONS                                    [↻] [...]
├── Langfuse                  Stopped                    [▶] [🔌]
```

- Inline: **Start** `$(play)`, **Enable Hooks** `$(plug)`.

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
| **1. Install hooks** | Writes single hook entry (env embedded + root env) + script + config file (see §4). |
| **2. Python check** | `python3 -c "import langfuse"` → if missing, `pip3 install --user langfuse`. |
| **3. Docker check** | `docker info` → fail with actionable error if unavailable. |
| **4. Start Langfuse** | `docker compose up -d --wait` (web, worker, postgres, clickhouse, redis, minio). |
| **5. Health poll** | `/api/public/health` up to 90s. |
| **6. Open browser** | Auto-opens `http://localhost:{port}` in Simple Browser. Login info available anytime via `$(key)` icon. |

**Key management:** Public/secret keys are auto-generated on first setup and persisted in `context.globalState`. They survive hook disable/enable, extension restarts, and VS Code updates. Keys are seeded into Langfuse via `LANGFUSE_INIT_*` env vars in Docker Compose.

---

### 4. Hook Installation

#### Tested Hook Formats

Both agents share **a single hook entry** in `~/.claude/settings.json`. The entry has `env` embedded in the hook object (read by VS Code agent) and root-level `env` (read by Claude agent). This avoids duplicate hook executions:

```json
// ~/.claude/settings.json — single entry, serves both agents
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.claude/hooks/langfuse_hook.py",
            "env": {
              "TRACE_TO_LANGFUSE": "true",
              "LANGFUSE_PUBLIC_KEY": "<pk>",
              "LANGFUSE_SECRET_KEY": "<sk>",
              "LANGFUSE_HOST": "http://localhost:3000"
            }
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

#### How Each Agent Reads It

| | VS Code Copilot Chat | Claude |
|-|---------------------|-------------|
| Config path | `~/.claude/settings.json` | `~/.claude/settings.json` |
| Reads env from | `env` embedded in hook object | Root-level `env` |
| Hook entry | Same entry | Same entry |

#### Agent Isolation via Langfuse Environments

The hook script sets the Langfuse `environment` parameter based on the detected agent:
- VS Code Copilot Chat → `github-copilot-chat`
- Claude → `claude`

Users filter by environment in the Langfuse nav-bar dropdown — applies globally across all views (traces, sessions, observations). Environments are auto-created on first trace ingestion.

#### Langfuse Project Naming
- **Org:** Local (represents the local machine — local-first tool)
- **Project:** Agent Traces (describes the content)
- Nav header: `Local › Agent Traces`
- Seeded via `LANGFUSE_INIT_*` env vars in Docker Compose

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
~/.claude/
├── settings.json                ← Both VS Code + Claude hook configs (merged) + root env vars
└── hooks/
    ├── langfuse_hook.py         ← Single script, shared by both agents
    └── .langfuse_config.json    ← Langfuse keys + log dir (written by extension)
```

#### What Setup Writes

1. **`~/.claude/hooks/langfuse_hook.py`** — Copies script from extension resources. `chmod +x`.
2. **`~/.claude/hooks/.langfuse_config.json`** — Writes keys and log dir from `globalState`.
3. **`~/.claude/settings.json`** — Writes single hook entry with embedded `env` AND sets root-level `env`.

#### Hook Status Detection

- Check if `~/.claude/settings.json` contains a `hooks.Stop` entry referencing `langfuse_hook.py`.
- Single boolean: hooks installed or not.

#### Enable / Disable

Single toggle (not per-agent):
- **Disable**: Remove the `langfuse_hook.py` entry from `hooks.Stop` + remove Langfuse env keys from root `env`.
- **Enable**: Re-add entry + root env using keys from `.langfuse_config.json`.

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

Hooks use a single toggle on the Langfuse node (not per-agent).

| Action | Trigger | Behavior |
|--------|---------|----------|
| **Disable hooks** | `$(close)` inline icon on Langfuse node (leftmost) | Removes hook entry from `~/.claude/settings.json` + cleans root env keys. Script + `.langfuse_config.json` stay on disk for re-enable. |
| **Enable hooks** | `$(plug)` inline icon on Langfuse node (leftmost) | Writes hook entry + root env back using persisted keys. |

Also available via command palette: `Agent Tracing: Enable Hook` / `Agent Tracing: Disable Hook`.

No confirmation dialog — lightweight toggle.

---

### 7. UI / UX Principles

| Principle | Description |
|-----------|-------------|
| **Actions on items** | Setup/Stop/Open/Hook toggle are inline icons on the Langfuse node, not title bar buttons. |
| **Progressive disclosure** | Fresh: one row, one button. Post-setup: inline icons change to reflect state. |
| **Status at a glance** | Green = running. Dimmed = stopped/not configured. Yellow = problem. Hook toggle icon shows enable/disable state. |
| **Single toggle** | One hook entry serves both agents. Future: `TRACE_AGENTS` env var for per-agent filtering. |
| **Fail fast** | Missing Docker/pip/python → actionable error message. No silent failures. |

---

### 8. Platform & Scope

| Target | Priority |
|--------|----------|
| Linux / macOS | Primary |
| Windows (WSL) | Supported |
| Windows (native) | Future |
| VS Code forks (Cursor, Windsurf) | Future |
| GitHub Copilot Chat + Claude | Primary |
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
| Per-agent hook customization | Single hook entry serves both agents. Per-agent filtering via `TRACE_AGENTS` env var is a future option. |
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
  ├── Langfuse  Running — localhost:3000      [✕] [⏹] [📄] [🔗]
         │
    Setup (one click, no prompts):
      Install hooks → pip check → Docker check
      → docker compose up → health poll → open browser
         │
    Hook config (~/.claude/settings.json):
      Single entry: env embedded (VS Code) + root env (Claude)
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
