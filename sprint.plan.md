# Sprint Plan — OTel Refactor + Multi-Backend Support

> Goal: Refactor the tracing hook from Langfuse Python SDK to zero-dependency OTLP JSON export, enabling pluggable observability backends (Langfuse, Jaeger, Honeycomb, Grafana Tempo, Datadog, etc.).

---

## Motivation

The current hook uses the `langfuse` Python SDK which speaks Langfuse's proprietary REST API. This locks us to a single backend and requires `pip install langfuse` during setup.

**Finding:** Langfuse natively accepts standard OTLP traces at `POST /api/public/otel/v1/traces` (both JSON and Protobuf). The `OtelIngestionProcessor` on the server side maps OTel span attributes to Langfuse-specific fields.

**Architecture shift:**
```
Before:  Transcript → langfuse SDK → proprietary /api/public/ingestion
After:   Transcript → OTLP JSON (stdlib only) → any OTLP endpoint
           ├── Langfuse /api/public/otel/v1/traces
           ├── Jaeger /v1/traces
           ├── Honeycomb, Grafana Tempo, Datadog, etc.
```

Benefits:
- **Zero pip dependencies** — hook uses only Python stdlib (`json`, `urllib`, `uuid`, etc.)
- **Faster setup** — no more `pip install langfuse` step
- **Multi-backend** — add any OTLP-compatible backend by adding an endpoint to config
- **Standard format** — uses the industry-standard OpenTelemetry protocol

---

## Tasks

| # | Task | Files | Status |
|---|------|-------|--------|
| 1 | **Rewrite hook to OTLP JSON** — Replace `langfuse` SDK with zero-dep OTLP JSON construction + `urllib` HTTP POST. Map turns to OTel spans with Langfuse attribute conventions. Backward-compatible config fallback. | `langfuse_hook.py` | DONE |
| 2 | **Update config format with exporters** — `hookManager.ts` writes `exporters` array in `.langfuse_config.json` with OTLP endpoint + auth headers. Old fields kept for backward compat. | `hookManager.ts` | DONE |
| 3 | **Remove pip install from setup** — Delete `ensurePythonLangfuse()` from `langfuseManager.ts` and remove the "Ensuring Python langfuse package" step from `setup()`. | `langfuseManager.ts` | DONE |
| 4 | **Add `additionalExporters` VS Code setting** — Let users configure extra OTLP endpoints (Jaeger, etc.) via VS Code settings. Extension merges these with Langfuse exporter in config. | `package.json`, `hookManager.ts` | DONE |
| 5 | **Add Jaeger example in README** — Document how to add Jaeger as a second backend (docker run + one setting). Demonstrates multi-backend vision. | `README.md` | DONE |
| 6 | **Build check + push** | — | DONE |

---

## Config Format Evolution

### Before (Langfuse-only)
```json
{
  "public_key": "pk-lf-...",
  "secret_key": "sk-lf-...",
  "host": "http://localhost:3000",
  "log_dir": "/path/to/logs"
}
```

### After (multi-backend via exporters)
```json
{
  "public_key": "pk-lf-...",
  "secret_key": "sk-lf-...",
  "host": "http://localhost:3000",
  "log_dir": "/path/to/logs",
  "exporters": [
    {
      "name": "langfuse",
      "endpoint": "http://localhost:3000/api/public/otel/v1/traces",
      "headers": {
        "Authorization": "Basic <base64(pk:sk)>"
      }
    },
    {
      "name": "jaeger",
      "endpoint": "http://localhost:4318/v1/traces"
    }
  ]
}
```

Hook logic:
- If `exporters` array exists → use it (multi-backend path)
- If no `exporters` → construct Langfuse exporter from legacy fields + env vars (backward compat)

---

## OTel Span Mapping

### Langfuse Attribute Conventions
From `packages/shared/src/server/otel/attributes.ts`:

| OTel Span Attribute | Langfuse Field |
|---|---|
| `langfuse.trace.name` | trace name |
| `session.id` | session ID |
| `langfuse.environment` | environment |
| `langfuse.trace.input` | trace input |
| `langfuse.trace.output` | trace output |
| `langfuse.observation.type` | observation type (generation/span) |
| `langfuse.observation.input` | observation input |
| `langfuse.observation.output` | observation output |
| `langfuse.observation.model.name` | model name |

### Span Hierarchy Per Turn
```
Root span (turn)
├── langfuse.trace.name = "user message summary"
├── session.id = "session-123"
├── langfuse.environment = "github-copilot-chat" | "claude"
├── langfuse.trace.input = {role: "user", content: "..."}
├── langfuse.trace.output = {role: "assistant", content: "..."}
│
├── Child: Generation span
│   ├── langfuse.observation.type = "generation"
│   ├── langfuse.observation.model.name = "copilot-agent" | "claude-sonnet-4-..."
│   ├── langfuse.observation.input = {role: "user", content: "..."}
│   └── langfuse.observation.output = {role: "assistant", content: "..."}
│
├── Child: Tool span 1
│   ├── name = "Tool: read_file"
│   └── attributes: tool_name, tool_id, input, output
└── Child: Tool span 2
    └── ...
```

---

## Hiccups & Notes

_(Updated during execution)_

- **No hiccups.** Clean execution across all 6 tasks.
- **Key discovery:** Langfuse's `OtelIngestionProcessor.convertNanoTimestampToISO()` handles string, number, and `{high, low}` formats — standard OTLP JSON string timestamps work perfectly.
- **Key discovery:** Langfuse's `parseId()` accepts hex strings directly (`typeof data === "string" ? data`) — no need for Buffer encoding.
- **Attribute format:** OTLP attribute values must use wrappers (`{stringValue: "..."}`, `{intValue: "N"}`, etc.) — Langfuse's `convertValueToPlainJavascript()` unwraps them server-side.
- **Zero-dep win:** Removing the `pip install langfuse` step eliminates one of the most common setup failure points (pip permission errors, venv conflicts, proxy issues).
