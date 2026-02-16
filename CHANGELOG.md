# Changelog

## [0.2.0](https://github.com/zhichli/vscode-agent-tracing/compare/v0.1.1...v0.2.0) (2026-02-16)


### Features

* add @vscode/extension-telemetry dependency ([cd944d1](https://github.com/zhichli/vscode-agent-tracing/commit/cd944d16c0c8a5528ce1ef12b6db959e7532e537))
* add Bicep infra for App Insights + deploy workflow ([66f7262](https://github.com/zhichli/vscode-agent-tracing/commit/66f72625e4c0b79f2cdf1848c4125fdb1091e45e))
* wire telemetry and instrument all commands ([4408aa9](https://github.com/zhichli/vscode-agent-tracing/commit/4408aa92b933995d46718d9ecd0ca62edb7f5682))


### Bug Fixes

* inject telemetry connection string from secret at release time ([b3947cf](https://github.com/zhichli/vscode-agent-tracing/commit/b3947cff8d3f45d0349dfa8a83cf96468f758556))
* pin MinIO image to RELEASE.2025-09-07T16-13-09Z ([c2923f1](https://github.com/zhichli/vscode-agent-tracing/commit/c2923f1b01702571072491e4fdf989d84b607361))

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
