# Sprint Plan — Spec Alignment

> Full sprint to align codebase with spec.md. Derived from plan.md.

## Tasks (prioritized)

| # | Task | Status | Commit |
|---|------|--------|--------|
| 1 | **Unified hook script**: Merge two Python scripts into one `langfuse_hook.py` that detects agent at runtime. Remove old scripts. | [x] | ff101e8 |
| 2 | **Write `.langfuse_config.json`**: Extension writes `~/.claude/hooks/.langfuse_config.json` with keys + log_dir. Script reads it as fallback. | [x] | 19e54b8 |
| 3 | **Per-agent enable/disable in HookManager**: Add `enableAgent(target)` / `disableAgent(target)`. VS Code hook = config-only toggle. Claude hook = settings.json entry toggle. Script stays on disk. Update hook command to point to shared `~/.claude/hooks/langfuse_hook.py`. | [x] | 19e54b8 |
| 4 | **Unified tree view (`TracingSolutionsTreeProvider`)**: Replace `HooksTreeProvider` + `StacksTreeProvider` with single tree. Langfuse = root (collapsible), agents = children. | [x] | bb376b0 |
| 5 | **Update `package.json` contributions**: Single view `agentTracing.solutions`. New commands `enableHook`/`disableHook`. Remove old `installHooks`/`removeHooks`. Inline menus per contextValue. Remove `viewsWelcome`. | [x] | 410be8f |
| 6 | **Rewrite `extension.ts`**: Wire new provider, new commands, remove old command registrations. | [x] | 9553a05 |
| 7 | **UX polish**: Auto-open dashboard after setup. Modal login info. Claude env in root `~/.claude/settings.json`. | [x] | 9553a05 |
| 8 | **Cleanup**: Delete `hooksTreeProvider.ts`, `stacksTreeProvider.ts`, old Python scripts from resources. | [x] | eaf102a |
| 9 | **Build check**: `npm run build` passes. | [x] | — |
| 10 | **Push**: Push all commits to main. | [x] | — |

## Hiccups & Notes

- No blockers encountered. All tasks completed in sequence.
- Tasks 6 + 7 were combined into one commit since extension.ts rewrite and UX polish are tightly coupled.
- The `exec` import was removed from hookManager.ts since the new implementation doesn't shell out.
