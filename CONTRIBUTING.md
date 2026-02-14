# Contributing to Agent Tracing

## Development Setup

```bash
git clone https://github.com/zhichli/vscode-agent-tracing.git
cd vscode-agent-tracing
npm install
```

### Build

```bash
npm run build          # production build (esbuild)
npm run watch          # dev mode with auto-rebuild
npx tsc --noEmit       # type-check only (no emit)
```

### Run & Debug

1. Open the repo in VS Code
2. Press **F5** — launches an Extension Development Host
3. The extension activates on startup (`onStartupFinished`)

### Package

```bash
npm run package        # creates .vsix file
```

---

## Architecture Overview

```
src/
├── extension.ts                       ← Entry point: activate(), command registration
├── exec.ts                            ← Shell exec helper (child_process wrapper)
├── hooks/
│   └── hookManager.ts                 ← Hook install/remove/status in ~/.claude/settings.json
├── stacks/
│   ├── langfuseManager.ts             ← Docker Compose lifecycle, keys, health checks
│   └── stackVersions.ts               ← Pinned Docker image versions
└── views/
    └── tracingSolutionsTreeProvider.ts ← Sidebar tree view (single flat node)

resources/
└── hooks/
    └── langfuse_hook.py               ← Shared Python hook script (bundled, copied to ~/.claude/hooks/)
```

### Key Classes

| Class | File | Responsibility |
|-------|------|---------------|
| `HookManager` | `hookManager.ts` | Reads/writes `~/.claude/settings.json` — single hook entry with embedded env + root env. Copies Python script. Writes `.langfuse_config.json`. |
| `LangfuseManager` | `langfuseManager.ts` | Docker Compose lifecycle (setup/start/stop/health). Key generation and persistence. Managed vs external mode. |
| `TracingSolutionsTreeProvider` | `tracingSolutionsTreeProvider.ts` | Single flat tree view. `LangfuseNode` leaf with hook state encoded in `contextValue`. No children. |

### Data Flow

```
extension.ts
  └─ registers commands → calls HookManager or LangfuseManager
  └─ creates TreeProvider → reads state from both managers
  └─ LogOutputChannel → "Agent Tracing" in Output panel

HookManager
  └─ writeHookConfig() → ~/.claude/settings.json
  └─ installSharedScript() → ~/.claude/hooks/langfuse_hook.py
  └─ writeLangfuseConfig() → ~/.claude/hooks/.langfuse_config.json

LangfuseManager
  └─ writeComposeFile() → <globalStorage>/docker-compose.langfuse.yml
  └─ docker compose up/down → Langfuse containers
  └─ health check → /api/public/health
```

---

## Hook Entry Format

Both agents share a single entry in `~/.claude/settings.json`:

```json
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
              "LANGFUSE_PUBLIC_KEY": "pk-lf-...",
              "LANGFUSE_SECRET_KEY": "sk-lf-...",
              "LANGFUSE_HOST": "http://localhost:3000"
            }
          }
        ]
      }
    ]
  },
  "env": {
    "TRACE_TO_LANGFUSE": "true",
    "LANGFUSE_PUBLIC_KEY": "pk-lf-...",
    "LANGFUSE_SECRET_KEY": "sk-lf-...",
    "LANGFUSE_HOST": "http://localhost:3000"
  }
}
```

- **VS Code Copilot Chat** reads `env` from the inner hook object
- **Claude** reads `env` from the root-level `env` key
- Single entry → single execution per Stop event → no duplicate traces

### Robustness Rules

When editing `settings.json`, the extension:

1. **Preserves existing entries** — only touches our `langfuse_hook.py` entry
2. **Preserves existing env vars** — only manages our 4 keys (`TRACE_TO_LANGFUSE`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`)
3. **Cleans up empties** — removes `hooks.Stop` array if empty after our removal, removes `hooks` object if empty, removes `env` object if empty
4. **Guards against corruption** — validates `hooks` is an object, `Stop` is an array, catches parse errors

---

## Logging Architecture

### Extension Side (TypeScript)

Uses VS Code's `LogOutputChannel` (created via `createOutputChannel("Agent Tracing", { log: true })`):

| Method | When |
|--------|------|
| `output.info()` | Normal operations: setup steps, hook install/remove, stack start/stop |
| `output.warn()` | Recoverable issues: pip install failed, unreachable host |
| `output.error()` | Failures: Docker not found, compose crashed |
| `output.debug()` | Verbose internals: compose file writes, health check retries, config file writes |

Benefits over plain `OutputChannel`:
- Automatic timestamps on every line
- User-controllable log level filter in the Output panel
- Structured levels instead of manual `[prefix]` tags

### Hook Side (Python)

Dual-write logging:

| Destination | Path | Purpose |
|-------------|------|---------|
| **Aggregate** | `<log_dir>/hook.log` | All agents, all sessions — `tail -f` friendly |
| **Per-session** | `<log_dir>/<agent>/<date>/<sessionId>.log` | Isolated per-session history |
| **Stderr** | (terminal) | Only when `CC_LANGFUSE_DEBUG=true` — immediate visibility |

Log format: `YYYY-MM-DD HH:MM:SS [LEVEL] [agent/sessionId] message`

- `[INFO]` — every invocation, completion summary
- `[ERROR]` — missing keys, unhandled exceptions
- `[DEBUG]` — stdin keys, transcript path, detailed context (only with `CC_LANGFUSE_DEBUG=true`)

`<log_dir>` is set in `~/.claude/hooks/.langfuse_config.json` → `log_dir` field (auto-configured by the extension to `<globalStorage>/logs`).

---

## Tree View & contextValue

The Langfuse node encodes both stack state and hook state in `contextValue`:

| contextValue | Stack | Hooks |
|-------------|-------|-------|
| `langfuse-not-configured` | Not set up | — |
| `langfuse-docker-not-found` | Docker missing | — |
| `langfuse-running-hooks-on` | Running | Enabled |
| `langfuse-running-hooks-off` | Running | Disabled |
| `langfuse-running-external-hooks-on` | External | Enabled |
| `langfuse-running-external-hooks-off` | External | Disabled |
| `langfuse-stopped-hooks-on` | Stopped | Enabled |
| `langfuse-stopped-hooks-off` | Stopped | Disabled |

Menu visibility in `package.json` uses regex `when` clauses matching these values.

---

## Key Management

- API keys are auto-generated on first setup: `pk-lf-<uuid>` / `sk-lf-<uuid>`
- Stored in `context.globalState` — survives extension updates and VS Code restarts
- Seeded into Langfuse Docker via `LANGFUSE_INIT_*` env vars
- Written to both `settings.json` (for hooks) and `.langfuse_config.json` (fallback)

---

## Adding a New Tracing Backend

The architecture is designed for future backends. To add one:

1. Create `src/stacks/<backend>Manager.ts` implementing lifecycle (setup/start/stop/health)
2. Add a new root node in `tracingSolutionsTreeProvider.ts`
3. Register commands in `extension.ts` and `package.json`
4. Create a hook script in `resources/hooks/` if the backend needs its own

---

## Commit Guidelines

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add per-agent trace filtering
fix: preserve existing env vars on hook disable
refactor: simplify tree provider to flat node
docs: add troubleshooting guide
```
