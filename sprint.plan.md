# Sprint Plan — Marketplace Publishing

> Goal: Ship v0.1.0 to VS Code Marketplace with all P0 issues resolved.

---

## Phase 1: P0 Bug Fixes (must-fix before publish)

### 1.1 Add `session_id` + `tags` to Langfuse traces
**Files:** `resources/hooks/langfuse_hook.py`  
**Scope:** ~20 lines  
**What:** Pass `session_id` and agent-specific `tags` to `start_as_current_span()` so Langfuse groups turns into sessions and allows filtering by agent.

```python
# Both create_vscode_trace and create_claude_trace need:
with langfuse.start_as_current_span(
    name=f"Turn {turn_num}",
    session_id=session_id,                    # ← ADD: groups turns into sessions
    tags=["github-copilot-chat"],             # ← ADD: filterable by agent
    input={"role": "user", "content": user_text},
    metadata=metadata,
) as trace_span:
```

**Verify:** After tracing both agents, open Langfuse → Sessions view → sessions group properly. Traces view → filter by tag `github-copilot-chat` or `claude-code` works.

### 1.2 Fix `disconnect` to also disable hooks
**Files:** `src/extension.ts`  
**Scope:** ~3 lines  
**What:** When disconnecting from external Langfuse, also disable hooks (otherwise they fire and fail).

```typescript
vscode.commands.registerCommand("agentTracing.disconnect", async () => {
  hookManager.disableHooks();   // ← ADD
  await langfuse.disconnect();
  provider.refresh();
  flashStatus("Disconnected from Langfuse");
}),
```

### 1.3 Wrap enable/disable in try-catch
**Files:** `src/extension.ts`  
**Scope:** ~10 lines  
**What:** `enableHooks()` and `disableHooks()` do file I/O — catch and surface errors.

### 1.4 Make minio port configurable (or random)
**Files:** `src/stacks/langfuseManager.ts`  
**Scope:** ~10 lines  
**What:** Change `9090:9000` to `${minioPort}:9000` with a computed port (e.g. Langfuse port + 6090) or a setting, to avoid common conflicts.

### 1.5 Add hooks-on/off to node description
**Files:** `src/views/tracingSolutionsTreeProvider.ts`  
**Scope:** ~5 lines  
**What:** Running state description: `"Running — localhost:3000 — Tracing"` vs `"Running — localhost:3000"` when hooks off.

### 1.6 Debounce nudge notification
**Files:** `src/extension.ts`  
**Scope:** ~8 lines  
**What:** Store last nudge timestamp in globalState, skip if < 5 min ago. Prevents multi-window spam.

---

## Phase 2: Polish & Packaging

### 2.1 Test on clean machine
**What:** Spin up a fresh Linux VM or Docker container, install VS Code + Docker, install the extension from `.vsix`, run full setup flow end-to-end. Verify:
- [ ] Setup completes without errors
- [ ] Dashboard opens and loads
- [ ] Hook fires on Copilot Chat stop event → trace appears
- [ ] Hook fires on Claude Code stop event → trace appears
- [ ] Session grouping works in Langfuse
- [ ] Tag filtering works (separate agents)
- [ ] Enable/disable toggle works
- [ ] Stop/start stack works
- [ ] Connect to external works
- [ ] Disconnect cleans up hooks

### 2.2 Verify `.vsix` package contents
```bash
npm run package
# Inspect:
npx vsce ls
# Ensure no source files, node_modules, or dev docs are included
# Ensure resources/hooks/langfuse_hook.py IS included
# Ensure dist/extension.js IS included
# Ensure README.md and CHANGELOG.md ARE included (marketplace needs them)
```

### 2.3 Review `package.json` for marketplace
- [ ] `publisher` field is set (`zhichli`)
- [ ] `repository` URL is correct
- [ ] `icon` exists and is 128x128 PNG
- [ ] `categories` are appropriate (`["AI", "Other"]`)
- [ ] `keywords` are good for discoverability
- [ ] `engines.vscode` is correct (`^1.100.0`)
- [ ] `displayName`, `description` are compelling
- [ ] `license` is set (`MIT`)
- [ ] No `preview` flag unless intended

### 2.4 Screenshots for marketplace
Capture 2-3 screenshots showing:
1. Fresh install → Setup button visible
2. Running state with traces flowing (Langfuse dashboard in integrated browser)
3. Sidebar with different states

Place in `resources/screenshots/` and reference in README.md.

---

## Phase 3: GitHub Release Workflow

### 3.1 Create `.github/workflows/release.yml`

```yaml
name: Release & Publish

on:
  push:
    tags: ['v*']

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      
      - run: npm ci
      
      - run: npm run build
      
      - name: Package VSIX
        run: npx vsce package -o agent-tracing-${{ github.ref_name }}.vsix
      
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: '*.vsix'
          generate_release_notes: true
      
      - name: Publish to VS Code Marketplace
        run: npx vsce publish
        env:
          VSCE_PAT: ${{ secrets.VSCE_PAT }}
      
      - name: Publish to Open VSX
        run: npx ovsx publish agent-tracing-${{ github.ref_name }}.vsix -p ${{ secrets.OVSX_PAT }}
        continue-on-error: true  # Optional: Open VSX for Cursor/VSCodium users
```

### 3.2 Create `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - run: npx tsc --noEmit
```

### 3.3 Set up secrets
- `VSCE_PAT` — Personal Access Token from https://dev.azure.com/ → User Settings → Personal Access Tokens
  - Scope: Marketplace → Manage
  - Publisher: `zhichli`
- `OVSX_PAT` (optional) — Token from https://open-vsx.org/

---

## Phase 4: Publish Checklist

### First-time setup (one-time)
```bash
# 1. Create Azure DevOps PAT
#    Go to: https://dev.azure.com/<org>/_usersSettings/tokens
#    Create token with Marketplace > Manage scope

# 2. Create publisher (if not exists)
npx vsce create-publisher zhichli

# 3. Login
npx vsce login zhichli

# 4. Add PAT to GitHub Secrets
#    Settings → Secrets → Actions → VSCE_PAT
```

### Release process
```bash
# 1. Ensure main is clean and built
git checkout main && git pull
npm run build && npx tsc --noEmit

# 2. Bump version
npm version patch  # or minor/major
# This creates a commit + tag: v0.1.1

# 3. Push with tag
git push origin main --tags

# 4. GitHub Actions does the rest:
#    - Builds → Packages .vsix → Creates GitHub Release → Publishes to Marketplace

# 5. Verify
#    - https://marketplace.visualstudio.com/items?itemName=zhichli.vscode-agent-tracing
#    - Install from marketplace in a clean VS Code
```

### Manual publish (fallback)
```bash
npm run package
npx vsce publish
```

---

## Phase 5: Trace Isolation Roadmap (v0.2)

### Current (v0.1): Tags-Based Filtering
- Single Langfuse project, `tags` on each trace for agent identification
- Users filter by tag in dashboard
- Adequate for most use cases

### Future (v0.2): Separate Langfuse Projects per Agent

| Step | Detail |
|------|--------|
| **1. Seed two projects** | After Langfuse starts + health check passes, use Langfuse API to create a second project (INIT vars only support one) |
| **2. Store per-agent keys** | `globalState`: `langfuse.copilot.publicKey`, `langfuse.claude.publicKey`, etc. |
| **3. Pass agent-specific keys to hook** | Config file gets per-agent sections; hook script reads based on detected agent |
| **4. Update dashboard link** | Sidebar UI could link to filtered project view |

**Why defer:** Langfuse INIT seeding only supports 1 project. Creating a 2nd requires hitting the Langfuse REST API post-setup (auth, org lookup, project creation, key extraction). That's ~100 lines of new API integration code — not worth blocking v0.1 for.

### Alternative: `TRACE_AGENTS` env var (v0.2)
If a user only wants to trace one agent:
```json
{
  "env": {
    "TRACE_AGENTS": "github-copilot-chat"
  }
}
```
Hook script checks this var and exits early if current agent isn't in the list.

---

## Sprint Order

```
Phase 1 (P0 fixes)     → 1 session, ~60 lines total
Phase 2 (polish)        → 1 session, mostly manual testing
Phase 3 (CI/CD)         → 1 session, workflow files + secrets
Phase 4 (publish)       → 30 min, run commands + verify

Total: ~3 sessions to marketplace
```
