# Sprint Plan — v0.1.0 Marketplace Launch

> Goal: Ship a production-quality v0.1.0 to the VS Code Marketplace with CI/CD, telemetry, and issue-tracking infrastructure.

---

## Active Sprint: Pre-Publish Hardening

### Phase 1: Critical Code Fixes

| # | Task | Files | Status |
|---|------|-------|--------|
| 1.1 | **Guard `settings.json` against corruption** — if file exists but has invalid JSON, refuse to write and surface an error instead of silently overwriting with `{}` | `hookManager.ts` | DONE |
| 1.2 | **Handle non-managed Langfuse on port** — when `isRunning()=true` but `isOurManagedStack()=false` during Setup, offer "Connect to It" or "Change Port" instead of falling through to a port-bind failure | `extension.ts` | DONE |
| 1.3 | **Pin MinIO image** — switch from `cgr.dev/chainguard/minio:latest` to `docker.io/minio/minio` with a release tag. Add TODO comment until exact tag verified. | `stackVersions.ts` | DONE |
| 1.4 | **Python stdin timeout** — wrap `sys.stdin.read()` with a 30 s `signal.alarm()` guard so a broken agent can't leave zombie hook processes | `langfuse_hook.py` | DONE |

### Phase 2: UX Polish

| # | Task | Files | Status |
|---|------|-------|--------|
| 2.1 | **Quiet enable-hook notification** — replace `showInformationMessage` + actions with `flashStatus("Hooks enabled")` for a lightweight toggle | `extension.ts` | DONE |
| 2.2 | **Quiet disable-hook notification** — replace `showWarningMessage` with `flashStatus("Hooks disabled")` | `extension.ts` | DONE |
| 2.3 | **Validate keys on Connect External** — call `validateKeys()` after storing keys; warn (non-blocking) if keys don't work | `extension.ts` | DONE |
| 2.4 | **Auto-start error logging** — replace `.catch(() => {})` with `.catch(e => output.warn(...))` | `extension.ts` | DONE |
| 2.5 | **Remove duplicate `provider.refresh()`** in `stopStack` command | `extension.ts` | DONE |
| 2.6 | **Smaller Docker subnet** — change hardcoded `/16` to `/24` to reduce conflict risk | `langfuseManager.ts` | DONE |
| 2.7 | **Dashboard tab reuse** — `openDashboard()` checks `tabGroups` for an existing Langfuse browser tab and focuses it instead of opening a duplicate | `langfuseManager.ts` | DONE |
| 2.8 | **Dashboard auto-refresh** — documented manual workaround (Langfuse refresh dropdown); URL param approach deferred pending upstream PR | `README.md` | DONE (documented) |

#### 2.8 Auto-Refresh — Research & Resolution

**Problem:** After a hook fires, the user must manually click the Langfuse refresh button (or set auto-refresh via the UI dropdown) to see new traces.

**Research findings (from Langfuse source):**
- Refresh is controlled by `sessionStorage` key `tableRefreshInterval-${projectId}` — **no URL query param** exists
- Interval options: Off (default), 30s, 1m, 5m, 15m — set via a dropdown button in the traces toolbar
- Mechanism: `setInterval` + tick counter that recomputes date ranges and invalidates tRPC queries

| Option | Mechanism | Verdict |
|--------|-----------|---------|
| **A. URL query param** | Append `?refresh=30s` to traces URL | **Dead** — Langfuse has no URL param for this |
| **B. Add URL param to Langfuse** | ~5-line `useEffect` in `TracesTable` to read `?refreshInterval=30000` on mount | Best long-term (upstream PR) — deferred |
| **C. Nginx sub_filter** | Inject `<script>` via reverse proxy | Too heavy for this use case |
| **D. Document it** | Tip in README explaining the dropdown | **Shipped** — good enough for v0.1.0 |

**Resolution:** Option D shipped. Added a Quick Start tip explaining how to enable auto-refresh via the Langfuse traces toolbar dropdown. Option B remains a candidate for a future Langfuse PR.

### Phase 3: Documentation Alignment

| # | Task | Files | Status |
|---|------|-------|--------|
| 3.1 | **Spec: remove "Click row → opens dashboard"** from §2 (tree click not implemented; dashboard opened via inline icon) | `spec.md` | DONE |
| 3.2 | **Spec: update Disable behavior in §4/§6** — disable now removes script + config file (clean uninstall); enable re-copies from extension resources | `spec.md` | DONE |
| 3.3 | **README: fix states table** — remove `🔌 Connect` from "Not configured" inline icons (it's a Command Palette action, not inline) | `README.md` | DONE |

---

## Pre-Publish Pipeline

### Phase 4: Marketplace Account Setup

One-time steps (manual, ~30 min):

| # | Step | Detail |
|---|------|--------|
| 4.1 | **Create Azure DevOps organization** | Go to `https://dev.azure.com` → create an org (or use existing). |
| 4.2 | **Create Personal Access Token (PAT)** | Org Settings → Personal Access Tokens → New Token. Scopes: **Marketplace → Manage**. Expiry: 1 year. Copy immediately. |
| 4.3 | **Create VS Code Marketplace publisher** | Run `npx vsce create-publisher zhichli` or visit `https://marketplace.visualstudio.com/manage`. Use the publisher ID `zhichli` (must match `package.json`). |
| 4.4 | **Verify publisher** | Run `npx vsce login zhichli` and paste the PAT. Confirm with `npx vsce ls-publishers`. |
| 4.5 | **Add `VSCE_PAT` to GitHub repo secrets** | GitHub → Settings → Secrets and variables → Actions → New repository secret → name: `VSCE_PAT`, value: the PAT from 4.2. |
| 4.6 | **(Optional) Open VSX token** | Create account at `https://open-vsx.org` → Access Tokens → create. Add as `OVSX_PAT` in GitHub secrets. Enables Cursor/VSCodium installs. |

### Phase 5: CI/CD Pipeline with Auto-Versioning

> Current state: `ci.yml` (build on push/PR) and `release.yml` (publish on `v*` tag) exist and work. Add auto-versioning via `release-please`.

| # | Task | Status |
|---|------|--------|
| 5.1 | **Add `release-please` workflow** — creates version-bump PRs from conventional commits. On merge: bumps `package.json`, updates `CHANGELOG.md`, creates a GitHub Release with a `v*` tag, which triggers the existing `release.yml` publish. | TODO |
| 5.2 | **Add `CHANGELOG.md` automation** — `release-please` generates this from conventional commit messages. Remove hand-written entries. | TODO |
| 5.3 | **Verify `release.yml` triggers correctly** — release-please creates a tag → existing workflow publishes to Marketplace + Open VSX. Dry-run with a test tag. | TODO |

**Workflow: Release-Please (new file: `.github/workflows/release-please.yml`)**

```yaml
name: Release Please

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          release-type: node
          package-name: vscode-agent-tracing
```

**How it works:**
1. Developer merges PRs with conventional commit messages (`feat:`, `fix:`, `chore:`)
2. `release-please` opens/updates a "Release PR" that bumps version + updates CHANGELOG
3. When you merge the Release PR, it creates a git tag (`v0.1.1`) + GitHub Release
4. The existing `release.yml` triggers on the `v*` tag → builds → publishes

**Manual override:** `npm version patch && git push --tags` to bypass release-please for hotfixes.

### Phase 6: GitHub Project Setup

| # | Task | Status |
|---|------|--------|
| 6.1 | **Bug report issue template** — `.github/ISSUE_TEMPLATE/bug_report.yml` with OS, VS Code version, Docker version, extension version, steps, logs | DONE |
| 6.2 | **Feature request issue template** — `.github/ISSUE_TEMPLATE/feature_request.yml` | DONE |
| 6.3 | **Issue template config** — `.github/ISSUE_TEMPLATE/config.yml` disabling blank issues, linking to Discussions | TODO |
| 6.4 | **(Optional) Security policy** — `SECURITY.md` with vulnerability reporting instructions | TODO |
| 6.5 | **(Optional) Code of Conduct** — `CODE_OF_CONDUCT.md` (Contributor Covenant) | TODO |

### Phase 7: Telemetry & Monitoring

> **Best practice for VS Code extension authors:** Use [`@vscode/extension-telemetry`](https://github.com/microsoft/vscode-extension-telemetry), the official Microsoft package that wraps Azure Application Insights. It automatically respects the user's `telemetry.telemetryLevel` VS Code setting — no additional consent UI needed. This is the same package used by Microsoft's own extensions (Python, C++, Java, etc.).

| # | Task | Status |
|---|------|--------|
| 7.1 | **Create Azure Application Insights resource** | TODO |
| 7.2 | **Install `@vscode/extension-telemetry`** | TODO |
| 7.3 | **Initialize telemetry reporter in `activate()`** | TODO |
| 7.4 | **Instrument key events** | TODO |
| 7.5 | **Set up Azure dashboard + alerts** | TODO |

#### 7.1 Azure Application Insights Setup

1. Azure Portal → Create Resource → Application Insights
2. Name: `agent-tracing-prod`, Region: your preference
3. Copy the **Connection String** (not the old Instrumentation Key)

#### 7.2–7.3 Integration

```bash
npm install @vscode/extension-telemetry
```

In `package.json`, add (top-level, not inside `contributes`):
```json
{
  "applicationinsights.connectionstring": "<your-connection-string>"
}
```

In `extension.ts`:
```typescript
import TelemetryReporter from "@vscode/extension-telemetry";

let telemetry: TelemetryReporter;

export function activate(context: vscode.ExtensionContext) {
  telemetry = new TelemetryReporter(context);
  context.subscriptions.push(telemetry);
  // ...
}
```

#### 7.4 Key Events to Instrument

| Event Name | Properties | When |
|------------|-----------|------|
| `setup/complete` | `duration_ms`, `agent` | Setup finishes successfully |
| `setup/failed` | `error`, `step` | Setup fails at any step |
| `stack/start` | `mode` (managed/external) | User starts Langfuse |
| `stack/stop` | — | User stops Langfuse |
| `hook/enable` | — | Hooks toggled on |
| `hook/disable` | — | Hooks toggled off |
| `hook/error` | `error_summary` | Hook log watcher detects ERROR |
| `connect/external` | `host_hash` (hashed, no PII) | User connects to external Langfuse |
| `dashboard/open` | `target` (integrated/external) | User opens dashboard |

**Error tracking:** Wrap command handlers with `telemetry.sendTelemetryErrorEvent("command/error", { command, message })`.

#### 7.5 Azure Dashboard

- **KQL queries** for: DAU, setup success rate, error rate by type, agent distribution
- **Alerts** for: error rate spike (>5% of activations in 1 hr), setup failure rate (>20%)
- **Workbook** pinned to Azure Portal for at-a-glance monitoring

#### Privacy

- Never send: file paths, project names, trace content, API keys, hostnames
- Hash any identifiers before sending (e.g., SHA-256 of host URL)
- All telemetry is automatically disabled when the user sets `telemetry.telemetryLevel: "off"` in VS Code
- Add a privacy note in README: *"This extension collects anonymous usage telemetry via Azure Application Insights to improve the product. It respects your VS Code telemetry settings."*

### Phase 8: Public-Facing Polish

| # | Task | Status |
|---|------|--------|
| 8.1 | **Marketplace description** — `package.json` `description` is compelling (✓ already good) | DONE |
| 8.2 | **Extension icon** — verify `resources/icons/agent-tracing-128.png` is sharp at 128×128 | DONE |
| 8.3 | **Gallery banner** — add `galleryBanner` to `package.json` for marketplace hero area | TODO |
| 8.4 | **Screenshots** — capture 2-3 screenshots: (1) fresh install, (2) running with dashboard, (3) Langfuse traces view. Place in `resources/screenshots/`. Reference in README. | TODO |
| 8.5 | **Marketplace badges** — add build status + version badges to README | TODO |
| 8.6 | **CHANGELOG.md** — hand-written for v0.1.0, then automated by release-please for future versions | DONE |
| 8.7 | **Verify `.vsixignore`** — ensure no source files, `node_modules`, or dev docs leak into the package | TODO |
| 8.8 | **Verify `vsce ls` output** — final package contents check | TODO |

**Gallery banner** (add to `package.json`):
```json
{
  "galleryBanner": {
    "color": "#1e1e2e",
    "theme": "dark"
  }
}
```

### Phase 9: Pre-Publish Testing

| # | Task | Status |
|---|------|--------|
| 9.1 | **Clean VM / container test** — fresh Linux with Docker + VS Code, install from `.vsix`, run full setup E2E | TODO |
| 9.2 | **Verify Copilot Chat hook fires** → trace appears in Langfuse dashboard | TODO |
| 9.3 | **Verify Claude hook fires** → trace appears in Langfuse dashboard | TODO |
| 9.4 | **Session grouping** — multiple turns group under one session in Langfuse | TODO |
| 9.5 | **Environment filtering** — separate `github-copilot-chat` and `claude` environments | TODO |
| 9.6 | **Enable/disable toggle** — hooks toggle correctly, no leftover config | TODO |
| 9.7 | **Stop/start stack** — containers stop/start, health check passes | TODO |
| 9.8 | **Connect external** — connect to a separate Langfuse instance | TODO |
| 9.9 | **Disconnect** — hooks disabled, config cleaned | TODO |
| 9.10 | **Port conflict** — change port setting, re-setup | TODO |
| 9.11 | **Multiple VS Code windows** — nudge debounce works, no hook write races | TODO |

### Phase 10: Launch Day Checklist

```bash
# 1. Ensure main is clean and CI passes
git checkout main && git pull
npm run build && npx tsc --noEmit

# 2. Tag (or merge release-please PR)
npm version patch  # creates v0.1.0 tag
git push origin main --tags

# 3. CI does the rest → GitHub Release + Marketplace publish

# 4. Verify
open "https://marketplace.visualstudio.com/items?itemName=zhichli.vscode-agent-tracing"
# Install from marketplace in a clean VS Code window

# 5. Monitor
# Azure Application Insights → Live Metrics (first 15 min)
# GitHub Issues → watch for first-hour bug reports

# 6. Announce
# - GitHub Discussions: "v0.1.0 released"
# - Reddit: r/vscode, r/CodingWithAI
# - Twitter/X: demo GIF + marketplace link
```

---

## Completed Phases (reference)

<details>
<summary>Phase: P0 Bug Fixes (sprint 1)</summary>

| # | Task | Status |
|---|------|--------|
| — | Add `session_id` + Langfuse environments to traces | DONE |
| — | Fix `disconnect` to also disable hooks | DONE |
| — | Wrap enable/disable in try-catch | DONE |
| — | Add hooks-on/off to node description | DONE |
| — | Debounce nudge notification (5 min cooldown in globalState) | DONE |

</details>

<details>
<summary>Phase: GitHub Release Workflow</summary>

| # | Task | Status |
|---|------|--------|
| — | `.github/workflows/release.yml` — tag-triggered publish | DONE |
| — | `.github/workflows/ci.yml` — build + type-check on push/PR | DONE |

</details>

<details>
<summary>Phase: Trace Isolation via Langfuse Environments</summary>

- VS Code Copilot Chat → environment `github-copilot-chat`
- Claude → environment `claude`
- Users filter by environment in Langfuse nav-bar dropdown (global filter)
- Org: **VS Code**, Project: **Agent Tracing**

</details>
