# Agent Tracing — Spec

## One-Line Definition

> **A VS Code extension that gives AI coding agents (GitHub Copilot Chat, Claude Code) local-first observability through one-click tracing setup with pluggable OTel backends.**

## Top Principles

1. **Zero-config start** — One click to go from fresh install to traces flowing.
2. **OTel-native** — All trace data uses OpenTelemetry GenAI semantic conventions. No vendor lock-in.
3. **Local-first** — All tracing data stays on the developer's machine. No cloud accounts required.
4. **Non-destructive** — Installing/removing hooks never corrupts existing agent configs; all changes are reversible.
5. **Pluggable backends** — Langfuse, Jaeger, Honeycomb, Grafana Tempo, Datadog — any OTLP endpoint works.

---

## 1. Architecture Overview

```
Agent Session                    Hook Script (Python, stdlib only)         Backends
─────────────                    ─────────────────────────────────         ────────
VS Code Copilot ──Stop event──►  agent_tracing_hook.py              ┌──► Langfuse (OTLP)
                     │           ├─ reads stdin JSON                │
Claude Code ─────Stop event──►  ├─ reads transcript JSONL          ├──► Jaeger (OTLP)
                     │           ├─ groups messages into turns      │
                     │           ├─ maps to OTel GenAI spans        ├──► Honeycomb (OTLP)
                     │           ├─ POST OTLP JSON to exporters ───┤
                     │           └─ saves incremental state         └──► Any OTLP endpoint
                     │
             stdin: {session_id, transcript_path, hook_event_name}
```

**Key design**: One Python script, zero pip dependencies, standard OTLP JSON output to N exporters.

---

## 2. Sidebar — Tree View

Single activity bar entry ("Agent Tracing") with one flat tree: **Tracing Solutions**.

### Backend Nodes

```
TRACING SOLUTIONS                                         [↻]
├── Langfuse       Running — localhost:3000          [📄] [⏹]
├── Jaeger         Not configured                         [▶]
```

Each backend is a peer leaf node with its own states:

| State | Langfuse | Jaeger |
|-------|----------|--------|
| **Not configured** | `[▶ Setup]` | `[▶ Setup]` |
| **Running** | `[📄 Dashboard] [⏹ Stop]` | `[📄 Dashboard] [⏹ Stop]` |
| **Stopped** | `[▶ Start]` | `[▶ Start]` |
| **Docker not found** | `[▶ Setup]` (error) | `[▶ Setup]` (error) |

Langfuse additionally has hook enable/disable states, login info, stack version, connect external, and recreate/delete in context menus. Jaeger has delete in context menu.

---

## 3. Setup Flows

### Langfuse Setup
| Step | Detail |
|------|--------|
| 1. Docker check | `docker info` → fail with actionable error if unavailable |
| 2. Write compose | 6-container stack: web, worker, postgres, clickhouse, redis, minio |
| 3. Start | `docker compose up -d --wait` |
| 4. Health poll | `/api/public/health` up to 90s |
| 5. Install hooks | Write script + config + settings.json entry |
| 6. Open dashboard | Auto-opens traces URL in Integrated Browser |

No pip install needed — hook uses only Python stdlib.

### Jaeger Setup
| Step | Detail |
|------|--------|
| 1. Docker check | Same |
| 2. Run container | `docker run -d jaegertracing/jaeger:latest -p 16686:16686 -p 4318:4318` |
| 3. Health poll | Jaeger UI at localhost:16686 |
| 4. Update hook config | Auto-adds Jaeger OTLP exporter to `.langfuse_config.json` |
| 5. Open dashboard | Auto-opens Jaeger search UI |

Single container, zero auth, OTLP enabled by default.

---

## 4. Hook System

### Hook Registration

Single entry in `~/.claude/settings.json`, serves both VS Code Copilot and Claude Code:

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.claude/hooks/agent_tracing_hook.py",
        "env": {
          "TRACE_TO_LANGFUSE": "true",
          "LANGFUSE_PUBLIC_KEY": "<pk>",
          "LANGFUSE_SECRET_KEY": "<sk>",
          "LANGFUSE_HOST": "http://localhost:3000"
        }
      }]
    }]
  },
  "env": { /* same vars — Claude reads from root env */ }
}
```

### Hook Config File

`~/.claude/hooks/.langfuse_config.json` — written by the extension, read by the hook script:

```json
{
  "public_key": "pk-lf-...",
  "secret_key": "sk-lf-...",
  "host": "http://localhost:3000",
  "log_dir": "<globalStorage>/logs",
  "exporters": [
    {
      "name": "langfuse",
      "endpoint": "http://localhost:3000/api/public/otel/v1/traces",
      "headers": {"Authorization": "Basic <base64(pk:sk)>"}
    },
    {
      "name": "jaeger",
      "endpoint": "http://localhost:4318/v1/traces"
    }
  ]
}
```

Legacy `public_key`/`secret_key`/`host` fields are kept for backward compat. The `exporters` array is the primary config — hook iterates all exporters and POSTs the same OTLP JSON to each.

### Agent Detection

| Field | VS Code Copilot | Claude Code |
|-------|-----------------|-------------|
| stdin key | `hookEventName` (camelCase) | `hook_event_name` (snake_case) |
| session ID | `sessionId` | `session_id` |
| transcript | `transcript_path` | `transcript_path` |

The script reads stdin JSON, detects the agent from the key naming convention, then reads the transcript JSONL file at `transcript_path`.

### File Layout

```
~/.claude/
├── settings.json              ← Hook entry + env vars
├── hooks/
│   ├── agent_tracing_hook.py  ← Shared OTLP hook (both agents)
│   └── .langfuse_config.json  ← Exporters + auth + log dir
└── state/
    ├── agent_tracing.github-copilot-chat.state.json  ← Incremental state
    └── agent_tracing.claude.state.json
```

---

## 5. Hook Processing Pipeline

```
Stop event fires → stdin JSON
  │
  ├── read_stdin() → {session_id, transcript_path, hook_event_name}
  ├── detect_agent() → "github-copilot-chat" | "claude"
  ├── build_exporters() → [{name, endpoint, headers}, ...]
  │
  ├── Read transcript JSONL from transcript_path
  ├── load_state() → {last_line, turn_count} for incremental processing
  │
  ├── Parse transcript into turns:
  │   ├── VS Code: pivot on user.message events, collect assistant.message + tool events
  │   └── Claude:  pivot on user messages, collect assistant + tool_use + tool_result
  │
  ├── For each NEW turn → build OTel spans (see §6)
  │
  ├── Wrap in OTLP JSON: {resourceSpans: [{resource, scopeSpans: [{scope, spans}]}]}
  ├── POST to each exporter via urllib
  │
  └── save_state() → remember last_line + turn_count
```

**Incremental**: Hook only processes turns added since last invocation. State is per-agent, per-session.

---

## 6. OTel GenAI Semantic Convention Mapping

References:
- [GenAI Spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/)
- [GenAI Agent Spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/)

### Span Hierarchy (per turn)

```
invoke_agent {Agent Name}     ← root span, INTERNAL
├── chat {model}              ← generation span, CLIENT
├── execute_tool {tool1}      ← tool span, INTERNAL
├── invoke_agent {subagent}   ← subagent span (for Task/runSubagent), INTERNAL
│   ├── chat {model}          ← subagent's own generation
│   ├── execute_tool {grep}   ← subagent's tool calls
│   └── ...
├── execute_tool {tool2}      ← tool span, INTERNAL
└── ...
```

One trace per turn. Each turn = user message → agent response (possibly with multiple tool calls).
Subagent invocations are nested `invoke_agent` spans within the same trace, not flat `execute_tool`.

### Resource Attributes

| Attribute | Value |
|-----------|-------|
| `service.name` | `"agent-tracing"` |
| `deployment.environment` | `"github-copilot-chat"` or `"claude"` |

### Root Span: `invoke_agent {Agent}`

| OTel Attribute | VS Code Source | Claude Source |
|---|---|---|
| `gen_ai.operation.name` | `"invoke_agent"` | `"invoke_agent"` |
| `gen_ai.agent.name` | `"GitHub Copilot"` | `"Claude Code"` |
| `gen_ai.provider.name` | `"openai"` | `"anthropic"` |
| `gen_ai.conversation.id` | `sessionId` from stdin | `session_id` from stdin |
| `gen_ai.request.model` | ❌ not available | ✅ `message.model` |
| `gen_ai.response.model` | ❌ not available | ✅ `message.model` |
| `gen_ai.input.messages` | User prompt (OTel message schema) | User prompt (OTel message schema) |
| `gen_ai.output.messages` | Final assistant text (OTel message schema) | Final assistant text (OTel message schema) |

### Chat Span: `chat {model}`

| OTel Attribute | VS Code Source | Claude Source |
|---|---|---|
| `gen_ai.operation.name` | `"chat"` | `"chat"` |
| `gen_ai.provider.name` | `"openai"` | `"anthropic"` |
| `gen_ai.request.model` | `"copilot-agent"` (hardcoded) | From `message.model` (e.g. `claude-opus-4-6`) |
| `gen_ai.response.model` | Same | Same |
| `gen_ai.input.messages` | User prompt | User prompt |
| `gen_ai.output.messages` | Assistant response | Assistant response |
| `gen_ai.reasoning` | ✅ from `reasoningText` | ❌ not captured (thinking exists but dropped) |

### Tool Span: `execute_tool {name}`

| OTel Attribute | VS Code Source | Claude Source |
|---|---|---|
| `gen_ai.operation.name` | `"execute_tool"` | `"execute_tool"` |
| `gen_ai.tool.name` | `toolRequests[].name` | `tool_use.name` |
| `gen_ai.tool.call.id` | `toolCallId` | `tool_use.id` |
| `gen_ai.tool.call.arguments` | `toolRequests[].arguments` (JSON string) | `tool_use.input` (object) |
| `gen_ai.tool.call.result` | `{completed, success}` (metadata only) | `tool_result.content` (actual result text) |
| `error.type` | ❌ not set | `"tool_error"` if `is_error` |

### Subagent Spans: `invoke_agent {subagent_name}`

Both agents support subagent/sub-task invocations but expose them very differently.

#### VS Code Copilot Chat — `runSubagent`

In the Copilot transcript, subagents appear as regular tool calls:

```
assistant.message:
  toolRequests: [{
    toolCallId: "toolu_01GXdjynGi5sJwe5Hf4EvFi4",
    name: "runSubagent",
    arguments: "{\"prompt\": \"Search for hello...\", \"description\": \"Count hello occurrences\"}",
    type: "function"
  }]

tool.execution_start:
  toolCallId: "toolu_01GXdjynGi5sJwe5Hf4EvFi4"
  toolName: "runSubagent"
  arguments: {prompt: "...", description: "Count hello occurrences"}
  timestamp: "2026-02-17T23:48:33.202Z"

tool.execution_complete:
  toolCallId: "toolu_01GXdjynGi5sJwe5Hf4EvFi4"
  success: true
  timestamp: "2026-02-17T23:48:44.685Z"
```

**Key data available**:
- `description` field → maps to `gen_ai.agent.name` or span name
- `prompt` field → maps to `gen_ai.input.messages`
- Real start/end timestamps from `tool.execution_start`/`tool.execution_complete`
- `success` boolean
- **No subagent-internal transcript** — VS Code does not expose what the subagent did internally (its tool calls, reasoning, etc.)

#### Claude Code — `Task`

In the Claude transcript, subagents appear as `tool_use` with `name: "Task"` in the parent. The result comes back as `tool_result` with rich `toolUseResult` metadata:

**Parent transcript** (tool_use call):
```
assistant message, content: [{
  type: "tool_use",
  id: "toolu_01QmhMwjvMokT4N4Jci2jz4d",
  name: "Task",
  input: {
    description: "Count 'hello' in repo",
    prompt: "Search the entire repository...",
    subagent_type: "general-purpose"
  }
}]
```

**Parent transcript** (tool_result with rich metadata):
```
user message, content: [{type: "tool_result", tool_use_id: "toolu_01Qm...", content: [...]}]
toolUseResult: {
  status: "completed",
  agentId: "a9fc150",              ← links to subagent transcript file
  prompt: "Search the entire...",
  content: [{text: "...6 matches"}],
  totalDurationMs: 5191,           ← real wall-clock duration
  totalTokens: 11290,              ← total tokens consumed
  totalToolUseCount: 1,            ← number of tool calls in subagent
  usage: {                         ← detailed token breakdown
    input_tokens: 1,
    cache_creation_input_tokens: 155,
    cache_read_input_tokens: 11118,
    output_tokens: 16
  }
}
```

**Subagent transcript** (`subagents/agent-a9fc150.jsonl`) — a full mini-session:
```
Line 1: user message (the Task prompt)
Line 2: assistant → tool_use (Grep with arguments)
Line 3: progress events (PreToolUse/PostToolUse hooks)
Line 4: user → tool_result (grep output: "Found 6 total occurrences")
Line 5: progress events
Line 6: assistant → text ("The total number is 6")
Line 7: progress → SubagentStop event
```

Each subagent JSONL has the same format as the parent session but with:
- `isSidechain: true` on every line
- `agentId` field identifying the subagent
- Same `sessionId` as parent (shared conversation context)
- Its own user/assistant/tool_use/tool_result message flow

#### Recommended OTel Mapping for Subagents

Per the [OTel GenAI Agent Spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/) semconv, subagents should be `invoke_agent` spans, not `execute_tool` spans:

**Target span hierarchy with subagents:**
```
invoke_agent GitHub Copilot          ← or Claude Code
├── chat copilot-agent
├── invoke_agent "Count hello"       ← subagent (was execute_tool runSubagent)
│   ├── gen_ai.agent.id = "a9fc150"
│   ├── gen_ai.agent.name = "Count 'hello' in repo"
│   ├── gen_ai.input.messages = [subagent prompt]
│   ├── gen_ai.output.messages = [subagent result]
│   ├── gen_ai.usage.input_tokens = ...    (Claude only)
│   ├── gen_ai.usage.output_tokens = ...   (Claude only)
│   │
│   ├── chat claude-opus-4-6        ← from subagent transcript (Claude only)
│   └── execute_tool Grep           ← from subagent transcript (Claude only)
│       ├── gen_ai.tool.call.arguments = {pattern: "hello", ...}
│       └── gen_ai.tool.call.result = "Found 6 total occurrences"
│
├── invoke_agent "Count usage"       ← second subagent, parallel
│   ├── ...
│   └── ...
└── chat copilot-agent              ← final response generation
```

**Attribute mapping for subagent spans:**

| OTel Attribute | VS Code Source | Claude Source |
|---|---|---|
| `gen_ai.operation.name` | `"invoke_agent"` | `"invoke_agent"` |
| `gen_ai.agent.name` | `runSubagent.description` | `Task.input.description` |
| `gen_ai.agent.id` | ❌ not available | `toolUseResult.agentId` (e.g. `a9fc150`) |
| `gen_ai.provider.name` | `"openai"` | `"anthropic"` |
| `gen_ai.input.messages` | `runSubagent.prompt` | `Task.input.prompt` |
| `gen_ai.output.messages` | ❌ not available (no result content) | `toolUseResult.content` |
| `gen_ai.usage.input_tokens` | ❌ | `toolUseResult.usage.input_tokens + cache_read` |
| `gen_ai.usage.output_tokens` | ❌ | `toolUseResult.usage.output_tokens` |
| Span start time | `tool.execution_start.timestamp` | `Task tool_use message.timestamp` |
| Span end time | `tool.execution_complete.timestamp` | `toolUseResult` message.timestamp |
| Span duration | ✅ from timestamps | ✅ `toolUseResult.totalDurationMs` |

**Key implementation decisions:**

1. **Same trace, nested spans**: Subagent spans share the parent's `traceId` and are children of the root `invoke_agent` span. This keeps the full turn in one trace in Jaeger/backends.

2. **Claude subagent internals**: Since Claude provides separate subagent transcript files (`subagents/agent-{id}.jsonl`), the hook can parse them and create child spans (chat + tool calls). These become grandchild spans under the `invoke_agent` subagent span.

3. **VS Code subagent as opaque span**: Copilot doesn't expose subagent internals. The `invoke_agent` span will have `gen_ai.input.messages` (the prompt) but the internals are a black box — just start/end timestamps and success.

4. **Parallel subagents**: Both agents can launch subagents in parallel. Multiple `invoke_agent` child spans under the same parent is valid OTel. With real timestamps, the Jaeger timeline view will correctly show them as concurrent.

---

## 7. Source Transcript Formats

### VS Code Copilot Chat — JSONL Events

Triggered by the VS Code hooks system. Stdin provides `{hookEventName, sessionId, transcript_path}`.

| Event type | Key data | Used by hook? |
|---|---|---|
| `session.start` | `sessionId`, `copilotVersion`, `vscodeVersion`, `producer`, `startTime` | Partial (version/producer as custom attrs) |
| `user.message` | `content` (string), `attachments` | ✅ content only (attachments dropped) |
| `assistant.message` | `content`, `reasoningText`, `toolRequests[]` (toolCallId, name, arguments), `messageId` | ✅ all extracted |
| `assistant.turn_start/end` | `turnId` | ❌ not used (user.message is the pivot) |
| `tool.execution_start` | `toolCallId`, `toolName`, `arguments` (parsed), timestamp | ❌ has real timestamps — not used |
| `tool.execution_complete` | `toolCallId`, `success` | ✅ success flag only |

**Not available from Copilot**: model name, token counts, stop_reason.

### Claude Code — JSONL Messages

Triggered by Claude Code's hooks system. Stdin provides `{hook_event_name, session_id, transcript_path, cwd, stop_hook_active}`.

| Message type | Key data | Used by hook? |
|---|---|---|
| `user` (real) | `message.content[{type:"text", text}]`, `cwd`, `version`, `gitBranch`, `permissionMode`, `timestamp` | ✅ text only (metadata dropped) |
| `user` (tool result) | `message.content[{type:"tool_result", tool_use_id, content}]`, `toolUseResult` ({status, totalDurationMs, totalTokens, agentId, usage}) | Partial (content only, rich metadata dropped) |
| `assistant` (text) | `message.content[{type:"text", text}]`, `model`, `message.usage` (full token breakdown), `message.id` | ✅ text + model (usage dropped) |
| `assistant` (thinking) | `message.content[{type:"thinking", thinking, signature}]` | ❌ entirely dropped |
| `assistant` (tool_use) | `message.content[{type:"tool_use", id, name, input}]` | ✅ name + id + input |
| `queue-operation` | Internal bookkeeping | ❌ skipped |

---

## 8. Known Gaps

| # | Gap | Severity | Detail |
|---|-----|----------|--------|
| 1 | **Timestamps fabricated** | High | All spans use `now_ns()` for start/end. Real timestamps from transcripts (user.message, tool.execution_start/complete, assistant.message) are mostly ignored. Spans show zero duration. |
| 2 | **Token usage not captured** | Medium | Claude provides `message.usage` (input_tokens, output_tokens, cache tokens) and `toolUseResult.totalTokens`. Copilot doesn't expose tokens. Semconv: `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`. |
| 3 | **Thinking/reasoning dropped for Claude** | Medium | Claude has `{type:"thinking", thinking:"..."}` content blocks. VS Code `reasoningText` is captured as non-standard `gen_ai.reasoning`. Claude thinking entirely lost. |
| 4 | **Tool results incomplete for VS Code** | Low | Copilot `tool.execution_complete` only has `{success}` — no result content. Stored as `{completed, success}` metadata. |
| 5 | **Input/output messages flattened** | Medium | We extract only the final text. Actual transcripts have multi-part content (text + tool_use + tool_result interleaved). The OTel message schema supports tool_call/tool_call_response parts — we don't use them. |
| 6 | **No finish_reasons** | Low | Claude provides `stop_reason`. Semconv: `gen_ai.response.finish_reasons`. Not captured. |
| 7 | **Subagents not nested** | High | `Task`/`runSubagent` are currently flat `execute_tool` spans. Per §6, should be `invoke_agent` child spans. Claude has separate subagent transcripts in `subagents/agent-{id}.jsonl` — these should be parsed to create nested chat + tool spans. VS Code provides start/end timestamps but no internals. |
| 8 | **`gen_ai.tool.type` not set** | Low | Semconv defines `function`/`extension`/`datastore`. Not classified. |
| 9 | **Claude metadata dropped** | Low | `cwd`, `gitBranch`, `version`, `permissionMode`, `toolUseResult.totalDurationMs` — all available, none captured. |
| 10 | **Message format helpers unused** | Bug | `format_tool_call_message()` / `format_tool_result_message()` are defined but never called. Tool calls should appear in `gen_ai.input.messages`. |
| 11 | **No SubagentStop hook** | Medium | Only `Stop` event is registered. Claude fires `SubagentStop` with `agent_transcript_path` for each subagent — could be used to trace subagents in real-time. Currently we rely on parsing subagent files from the parent transcript's `toolUseResult.agentId`. |
| 12 | **Legacy env var name** | Low | `TRACE_TO_LANGFUSE` should be renamed to `AGENT_TRACING_ENABLED`. |

---

## 9. Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agentTracing.langfuse.port` | `3000` | Langfuse dashboard port |
| `agentTracing.langfuse.autoStart` | `false` | Auto-start Langfuse on VS Code open |
| `agentTracing.jaeger.uiPort` | `16686` | Jaeger UI port |
| `agentTracing.jaeger.otlpPort` | `4318` | Jaeger OTLP HTTP port |
| `agentTracing.additionalExporters` | `[]` | Extra OTLP endpoints (array of `{name, endpoint, headers?}`) |

---

## 10. Platform & Scope

| Target | Status |
|--------|--------|
| Linux / macOS | Primary |
| Windows (WSL) | Supported |
| Windows (native) | Future |
| VS Code forks (Cursor, Windsurf) | Future |
| GitHub Copilot Chat + Claude Code | Primary |
| Other agents (Cline, Roo) | Future |
| Langfuse (self-hosted Docker) | ✅ Shipped |
| Langfuse (cloud) | Future |
| Jaeger (Docker) | ✅ Shipped |
| Honeycomb / Tempo / Datadog | Via `additionalExporters` setting |

---

## 11. Non-Goals

| Feature | Rationale |
|---------|-----------|
| Custom hook script editing | Extension owns the hook script |
| Real-time streaming trace viewer | Backend dashboards handle this |
| Trace export/backup | Docker volumes persist data |
| Per-agent hook customization | Single hook serves all agents |
| Token cost calculation | Backends handle this (Langfuse has cost tracking) |
| Inline code annotations | Out of scope — we instrument, not annotate |

---

## Appendix: Commands

| Command | ID |
|---------|----|
| Langfuse: Full Setup | `agentTracing.setup` |
| Langfuse: Start | `agentTracing.startStack` |
| Langfuse: Stop | `agentTracing.stopStack` |
| Langfuse: Recreate | `agentTracing.recreateStack` |
| Langfuse: Delete | `agentTracing.purgeStack` |
| Langfuse: Open Dashboard | `agentTracing.openDashboard` |
| Langfuse: Open External | `agentTracing.openDashboardExternal` |
| Langfuse: Login Info | `agentTracing.showLoginInfo` |
| Langfuse: Stack Info | `agentTracing.showStackVersion` |
| Langfuse: Connect External | `agentTracing.connectExternal` |
| Langfuse: Disconnect | `agentTracing.disconnect` |
| Jaeger: Setup | `agentTracing.jaeger.setup` |
| Jaeger: Start | `agentTracing.jaeger.start` |
| Jaeger: Stop | `agentTracing.jaeger.stop` |
| Jaeger: Delete | `agentTracing.jaeger.purge` |
| Jaeger: Open Dashboard | `agentTracing.jaeger.openDashboard` |
| Jaeger: Open External | `agentTracing.jaeger.openDashboardExternal` |
| Enable Hooks | `agentTracing.enableHook` |
| Disable Hooks | `agentTracing.disableHook` |
| Show Hook Log | `agentTracing.showHookLog` |
| Refresh | `agentTracing.refresh` |
