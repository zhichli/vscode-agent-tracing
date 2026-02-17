#!/usr/bin/env python3
"""
Agent Tracing — Zero-dependency OTLP tracing hook.

Emits standard OpenTelemetry (OTLP JSON) traces to any configured backend
(Langfuse, Jaeger, Honeycomb, Grafana Tempo, Datadog, etc.).

Shared by both VS Code Copilot Chat and Claude. Detects the calling
agent at runtime via stdin format:
  - VS Code: stdin contains {"hookEventName": ..., "transcript_path": ..., "sessionId": ...}
  - Claude: stdin is empty or has no hookEventName; reads latest transcript from ~/.claude/projects/

Install: managed automatically by the Agent Tracing VS Code extension.

Dependencies: Python 3.8+ stdlib only — no pip packages required.
"""

import base64
import json
import os
import signal
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.error import URLError
from urllib.request import Request, urlopen

# ---------------------------------------------------------------------------
# Stdin read timeout (seconds) — prevents zombie processes if an agent
# doesn't close stdin properly.
# ---------------------------------------------------------------------------
STDIN_TIMEOUT_SEC = 30

# ---------------------------------------------------------------------------
# Configuration — env-var-first, .langfuse_config.json fallback
# ---------------------------------------------------------------------------
CONFIG_PATH = Path.home() / ".claude" / "hooks" / ".langfuse_config.json"


def load_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text())
        except (json.JSONDecodeError, IOError):
            pass
    return {}


_config = load_config()

LOG_DIR = _config.get("log_dir", "")
DEBUG = os.environ.get("CC_LANGFUSE_DEBUG", "").lower() == "true"

# Agent environment names (used as tracing environments / service attributes)
AGENT_ENVIRONMENTS = {
    "github-copilot-chat": "github-copilot-chat",
    "claude": "claude",
}

# Scope name for OTel instrumentation
OTEL_SCOPE_NAME = "agent-tracing-hook"
OTEL_SCOPE_VERSION = "0.2.0"
OTEL_SERVICE_NAME = "agent-tracing"

# HTTP export timeout (seconds per exporter)
EXPORT_TIMEOUT_SEC = 10


# ---------------------------------------------------------------------------
# Exporter resolution — reads `exporters` from config, falls back to legacy
# ---------------------------------------------------------------------------

def build_exporters(config: dict) -> List[dict]:
    """Build the list of OTLP exporters from config.

    Priority:
      1. config["exporters"] array (new multi-backend format)
      2. Legacy: construct a Langfuse exporter from env vars / config fields
    """
    if config.get("exporters"):
        return config["exporters"]

    # Legacy fallback — construct Langfuse exporter from old config/env
    pk = os.environ.get("LANGFUSE_PUBLIC_KEY", "") or config.get("public_key", "")
    sk = os.environ.get("LANGFUSE_SECRET_KEY", "") or config.get("secret_key", "")
    host = os.environ.get("LANGFUSE_HOST", "") or config.get("host", "http://localhost:3000")

    if not pk or not sk:
        return []

    auth = base64.b64encode(f"{pk}:{sk}".encode()).decode()
    return [
        {
            "name": "langfuse",
            "endpoint": f"{host.rstrip('/')}/api/public/otel/v1/traces",
            "headers": {"Authorization": f"Basic {auth}"},
        }
    ]


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def _log_base() -> Path:
    return Path(LOG_DIR) if LOG_DIR else Path.home() / ".claude" / "state"


def _log_path() -> Path:
    return _log_base() / "hook.log"


def _write_line(line: str) -> None:
    try:
        p = _log_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a") as f:
            f.write(line)
    except OSError:
        pass


def log(level: str, message: str, agent: str = "unknown", session_id: str = "") -> None:
    now = datetime.now()
    ts = now.strftime("%Y-%m-%d %H:%M:%S") + f".{now.microsecond // 1000:03d}"
    tag = f"{agent}/{session_id}" if session_id else agent
    line = f"{ts} [{level}] [{tag}] {message}\n"
    _write_line(line)
    if DEBUG:
        sys.stderr.write(line)
        sys.stderr.flush()


def debug(message: str, agent: str = "unknown", session_id: str = "") -> None:
    if DEBUG:
        log("DEBUG", message, agent, session_id)


# ---------------------------------------------------------------------------
# OTLP JSON helpers — build standard OpenTelemetry trace payloads
# ---------------------------------------------------------------------------

def generate_trace_id() -> str:
    """Generate a 32-char hex trace ID (16 bytes)."""
    return uuid.uuid4().hex


def generate_span_id() -> str:
    """Generate a 16-char hex span ID (8 bytes)."""
    return uuid.uuid4().hex[:16]


def now_ns() -> str:
    """Current time as nanosecond string (OTLP JSON standard for uint64)."""
    return str(int(time.time() * 1e9))


def ts_to_ns(iso_or_epoch: Any) -> str:
    """Convert an ISO timestamp string, epoch seconds, or None to nanosecond string."""
    if not iso_or_epoch:
        return now_ns()
    if isinstance(iso_or_epoch, (int, float)):
        return str(int(iso_or_epoch * 1e9))
    if isinstance(iso_or_epoch, str):
        try:
            # Try ISO format
            dt = datetime.fromisoformat(iso_or_epoch.replace("Z", "+00:00"))
            return str(int(dt.timestamp() * 1e9))
        except ValueError:
            pass
    return now_ns()


def otlp_attr(key: str, value: Any) -> Optional[dict]:
    """Create an OTLP attribute entry. Returns None if value is None/empty."""
    if value is None:
        return None
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    if isinstance(value, float):
        return {"key": key, "value": {"doubleValue": value}}
    if isinstance(value, (dict, list)):
        return {"key": key, "value": {"stringValue": json.dumps(value)}}
    s = str(value)
    if not s:
        return None
    return {"key": key, "value": {"stringValue": s}}


def make_span(
    trace_id: str,
    span_id: str,
    name: str,
    start_ns: str,
    end_ns: str,
    attributes: Dict[str, Any],
    parent_span_id: str = "",
    kind: int = 1,  # SPAN_KIND_INTERNAL
    status_code: int = 1,  # STATUS_CODE_OK
) -> dict:
    """Build an OTLP span dict."""
    attrs = [a for a in (otlp_attr(k, v) for k, v in attributes.items()) if a is not None]
    span: Dict[str, Any] = {
        "traceId": trace_id,
        "spanId": span_id,
        "name": name,
        "kind": kind,
        "startTimeUnixNano": start_ns,
        "endTimeUnixNano": end_ns,
        "attributes": attrs,
        "status": {"code": status_code},
    }
    if parent_span_id:
        span["parentSpanId"] = parent_span_id
    return span


def make_resource_spans(
    spans: List[dict],
    agent: str,
    session_id: str = "",
) -> dict:
    """Wrap spans in the OTLP ResourceSpans envelope."""
    resource_attrs = [
        a for a in [
            otlp_attr("service.name", OTEL_SERVICE_NAME),
            otlp_attr("deployment.environment", AGENT_ENVIRONMENTS.get(agent, "default")),
        ] if a is not None
    ]
    return {
        "resource": {"attributes": resource_attrs},
        "scopeSpans": [
            {
                "scope": {"name": OTEL_SCOPE_NAME, "version": OTEL_SCOPE_VERSION},
                "spans": spans,
            }
        ],
    }


def make_otlp_payload(resource_spans: List[dict]) -> dict:
    """Build the full ExportTraceServiceRequest JSON body."""
    return {"resourceSpans": resource_spans}


# ---------------------------------------------------------------------------
# OTLP HTTP/JSON exporter
# ---------------------------------------------------------------------------

def export_otlp(payload: dict, exporters: List[dict], agent: str = "unknown", session_id: str = "") -> int:
    """POST the OTLP JSON payload to all configured exporters.

    Returns the number of successful exports.
    """
    body = json.dumps(payload).encode("utf-8")
    ok_count = 0
    for exporter in exporters:
        name = exporter.get("name", exporter.get("endpoint", "unknown"))
        endpoint = exporter.get("endpoint", "")
        if not endpoint:
            log("WARN", f"Exporter '{name}' has no endpoint — skipping", agent, session_id)
            continue
        headers = {"Content-Type": "application/json"}
        headers.update(exporter.get("headers", {}))
        try:
            req = Request(endpoint, data=body, headers=headers, method="POST")
            with urlopen(req, timeout=EXPORT_TIMEOUT_SEC) as resp:
                debug(f"Exported to {name}: HTTP {resp.status}", agent, session_id)
                ok_count += 1
        except URLError as e:
            log("WARN", f"Export to {name} failed: {e}", agent, session_id)
        except Exception as e:
            log("WARN", f"Export to {name} error: {e}", agent, session_id)
    return ok_count


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def trace_name(user_text: str, turn_num: int, max_len: int = 80) -> str:
    """Derive a short, readable trace name from the user's message."""
    for raw_line in user_text.split("\n"):
        line = raw_line.strip().lstrip(">#- ").strip()
        if line:
            if len(line) > max_len:
                return line[:max_len].rstrip() + "\u2026"
            return line
    return f"Turn {turn_num}"


def output_and_exit(data: dict | None = None, code: int = 0) -> None:
    print(json.dumps(data or {}), flush=True)
    sys.exit(code)


# ---------------------------------------------------------------------------
# State management (per-agent)
# ---------------------------------------------------------------------------

def _state_path(agent: str) -> Path:
    return Path.home() / ".claude" / "state" / f"agent_tracing.{agent}.state.json"


def load_state(agent: str) -> dict:
    p = _state_path(agent)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, IOError):
        return {}


def save_state(agent: str, state: dict) -> None:
    p = _state_path(agent)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(state, indent=2))


# ---------------------------------------------------------------------------
# Stdin parsing
# ---------------------------------------------------------------------------

def resolve_uri(value: Any) -> str:
    """Extract fsPath from a VS Code URI object, or return the string as-is."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get("fsPath") or value.get("path") or ""
    return ""


def read_stdin() -> dict:
    try:
        if hasattr(signal, "SIGALRM"):
            old_handler = signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError("stdin read timed out")))
            signal.alarm(STDIN_TIMEOUT_SEC)
        raw = sys.stdin.read()
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old_handler)
        if not raw.strip():
            return {}
        return json.loads(raw)
    except (json.JSONDecodeError, IOError, TimeoutError):
        return {}


def detect_agent(hook_input: dict) -> str:
    """Detect which agent invoked this hook."""
    if hook_input.get("hookEventName"):
        return "github-copilot-chat"
    return "claude"


# ===========================================================================
# VS Code Copilot Chat handler
# ===========================================================================

def parse_vscode_events(lines: list[str]) -> list[dict]:
    events = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def extract_vscode_session_info(events: list[dict]) -> dict:
    for ev in events:
        if ev.get("type") == "session.start":
            data = ev.get("data", {})
            return {
                "session_id": data.get("sessionId", ""),
                "version": data.get("copilotVersion", ""),
                "vscode_version": data.get("vscodeVersion", ""),
                "producer": data.get("producer", ""),
                "start_time": data.get("startTime", ""),
            }
    return {}


def group_vscode_turns(events: list[dict]) -> list[dict]:
    turns: list[dict] = []
    current_turn: dict | None = None

    tool_starts: dict[str, dict] = {}
    tool_completes: dict[str, dict] = {}
    for ev in events:
        t = ev.get("type", "")
        if t == "tool.execution_start":
            tc_id = ev.get("data", {}).get("toolCallId", "")
            if tc_id:
                tool_starts[tc_id] = ev
        elif t == "tool.execution_complete":
            tc_id = ev.get("data", {}).get("toolCallId", "")
            if tc_id:
                tool_completes[tc_id] = ev

    for ev in events:
        t = ev.get("type", "")
        if t == "user.message":
            if current_turn is not None:
                turns.append(current_turn)
            data = ev.get("data", {})
            current_turn = {
                "user_content": data.get("content", ""),
                "assistant_messages": [],
                "tool_executions": [],
                "timestamp": ev.get("timestamp", ""),
            }
        elif t == "assistant.message" and current_turn is not None:
            current_turn["assistant_messages"].append(ev)

    if current_turn is not None:
        turns.append(current_turn)

    for turn in turns:
        for am in turn["assistant_messages"]:
            for tr in am.get("data", {}).get("toolRequests", []):
                tc_id = tr.get("toolCallId", "")
                if tc_id:
                    turn["tool_executions"].append({
                        "tool_call_id": tc_id,
                        "name": tr.get("name", "unknown"),
                        "arguments": tr.get("arguments", "{}"),
                        "completed": tc_id in tool_completes,
                        "success": tool_completes.get(tc_id, {}).get("data", {}).get("success", False)
                        if tc_id in tool_completes else None,
                    })
    return turns


def get_vscode_assistant_text(turn: dict) -> str:
    for am in reversed(turn["assistant_messages"]):
        content = am.get("data", {}).get("content", "")
        if content:
            return content
    return ""


def get_vscode_reasoning(turn: dict) -> str:
    parts = []
    for am in turn["assistant_messages"]:
        r = am.get("data", {}).get("reasoningText", "")
        if r:
            parts.append(r)
    return "\n".join(parts)


def build_vscode_turn_spans(
    session_id: str,
    turn_num: int,
    turn: dict,
    session_info: dict,
    agent: str,
) -> List[dict]:
    """Convert a VS Code turn into a list of OTLP spans."""
    user_text = turn["user_content"]
    output_text = get_vscode_assistant_text(turn)
    reasoning = get_vscode_reasoning(turn)
    tool_execs = turn["tool_executions"]

    trace_id = generate_trace_id()
    root_span_id = generate_span_id()
    turn_ts = ts_to_ns(turn.get("timestamp"))
    end_ts = now_ns()

    spans: List[dict] = []

    # Root span — the turn itself
    root_attrs: Dict[str, Any] = {
        "langfuse.trace.name": trace_name(user_text, turn_num),
        "session.id": session_id,
        "langfuse.environment": AGENT_ENVIRONMENTS.get(agent, "default"),
        "langfuse.trace.input": json.dumps({"role": "user", "content": user_text}),
        "langfuse.trace.output": json.dumps({"role": "assistant", "content": output_text}),
        "turn_number": turn_num,
        "source": "vscode-copilot-chat",
    }
    for key in ("producer", "vscode_version", "version"):
        if session_info.get(key):
            root_attrs[key] = session_info[key]

    spans.append(make_span(
        trace_id=trace_id,
        span_id=root_span_id,
        name=trace_name(user_text, turn_num),
        start_ns=turn_ts,
        end_ns=end_ts,
        attributes=root_attrs,
    ))

    # Generation span — model response
    gen_output: Dict[str, Any] = {"role": "assistant", "content": output_text}
    if reasoning:
        gen_output["reasoning"] = reasoning[:2000]

    gen_span_id = generate_span_id()
    spans.append(make_span(
        trace_id=trace_id,
        span_id=gen_span_id,
        parent_span_id=root_span_id,
        name="Copilot Response",
        start_ns=turn_ts,
        end_ns=end_ts,
        attributes={
            "langfuse.observation.type": "generation",
            "langfuse.observation.model.name": "copilot-agent",
            "langfuse.observation.input": json.dumps({"role": "user", "content": user_text}),
            "langfuse.observation.output": json.dumps(gen_output),
            "tool_count": len(tool_execs),
        },
    ))

    # Tool spans
    for te in tool_execs:
        try:
            tool_input = json.loads(te["arguments"]) if isinstance(te["arguments"], str) else te["arguments"]
        except (json.JSONDecodeError, TypeError):
            tool_input = {"raw": te["arguments"]}

        span_name = f"Tool: {te['name']}"
        if te["name"] == "runSubagent":
            try:
                args = json.loads(te["arguments"]) if isinstance(te["arguments"], str) else te["arguments"]
                desc = args.get("description", "")
                if desc:
                    span_name = f"Tool: runSubagent — {desc}"
            except Exception:
                pass

        tool_span_id = generate_span_id()
        tool_output: Dict[str, Any] = {
            "completed": te.get("completed", False),
        }
        if te.get("success") is not None:
            tool_output["success"] = te["success"]

        spans.append(make_span(
            trace_id=trace_id,
            span_id=tool_span_id,
            parent_span_id=root_span_id,
            name=span_name,
            start_ns=turn_ts,
            end_ns=end_ts,
            attributes={
                "langfuse.observation.input": json.dumps(tool_input),
                "langfuse.observation.output": json.dumps(tool_output),
                "tool_name": te["name"],
                "tool_id": te.get("tool_call_id", ""),
            },
        ))

    return spans


def process_vscode(exporters: List[dict], hook_input: dict) -> int:
    agent = "github-copilot-chat"
    session_id = hook_input.get("sessionId", "")
    transcript_path = hook_input.get("transcript_path", "")
    if "transcript_path" in hook_input:
        transcript_path = resolve_uri(hook_input["transcript_path"])

    if not transcript_path:
        debug("No transcript_path in stdin", agent, session_id)
        return 0

    transcript_file = Path(transcript_path)
    if not transcript_file.exists():
        debug(f"Transcript not found: {transcript_path}", agent, session_id)
        return 0

    if not session_id:
        session_id = transcript_file.stem

    state = load_state(agent)
    session_state = state.get(session_id, {})
    last_line = session_state.get("last_line", 0)
    turn_count = session_state.get("turn_count", 0)

    lines = transcript_file.read_text().strip().split("\n")
    total_lines = len(lines)

    if last_line >= total_lines:
        return 0

    all_events = parse_vscode_events(lines)
    if not all_events:
        return 0

    session_info = extract_vscode_session_info(all_events)
    all_turns = group_vscode_turns(all_events)
    new_turns = all_turns[turn_count:]

    if not new_turns:
        state[session_id] = {"last_line": total_lines, "turn_count": len(all_turns), "updated": datetime.now(timezone.utc).isoformat()}
        save_state(agent, state)
        return 0

    # Build all spans across turns
    all_spans: List[dict] = []
    for idx, turn in enumerate(new_turns):
        spans = build_vscode_turn_spans(session_id, turn_count + idx + 1, turn, session_info, agent)
        all_spans.extend(spans)

    # Export as a single OTLP batch
    if all_spans:
        resource_span = make_resource_spans(all_spans, agent, session_id)
        payload = make_otlp_payload([resource_span])
        export_otlp(payload, exporters, agent, session_id)

    created = len(new_turns)
    state[session_id] = {"last_line": total_lines, "turn_count": turn_count + created, "updated": datetime.now(timezone.utc).isoformat()}
    save_state(agent, state)
    return created


# ===========================================================================
# Claude handler
# ===========================================================================

def get_content(msg: dict) -> Any:
    if isinstance(msg, dict):
        if "message" in msg:
            return msg["message"].get("content")
        return msg.get("content")
    return None


def get_tool_calls(msg: dict) -> list:
    content = get_content(msg)
    if isinstance(content, list):
        return [item for item in content if isinstance(item, dict) and item.get("type") == "tool_use"]
    return []


def get_tool_results(msg: dict) -> list:
    content = get_content(msg)
    if isinstance(content, list):
        return [item for item in content if isinstance(item, dict) and item.get("type") == "tool_result"]
    return []


def get_text_content(msg: dict) -> str:
    content = get_content(msg)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts)
    return ""


def is_assistant(msg: dict) -> bool:
    role = msg.get("role") or (msg.get("message", {}) or {}).get("role")
    return role == "assistant"


def is_user(msg: dict) -> bool:
    role = msg.get("role") or (msg.get("message", {}) or {}).get("role")
    return role == "user"


def find_latest_transcript() -> tuple[str, Path] | None:
    projects_dir = Path.home() / ".claude" / "projects"
    if not projects_dir.exists():
        return None

    latest_file = None
    latest_mtime = 0

    for project_dir in projects_dir.iterdir():
        if not project_dir.is_dir():
            continue
        for tf in project_dir.glob("*.jsonl"):
            mtime = tf.stat().st_mtime
            if mtime > latest_mtime:
                latest_mtime = mtime
                latest_file = tf

    if latest_file:
        try:
            first_line = latest_file.read_text().split("\n")[0]
            first_msg = json.loads(first_line)
            session_id = first_msg.get("sessionId", latest_file.stem)
            return (session_id, latest_file)
        except (json.JSONDecodeError, IOError, IndexError):
            return None
    return None


def group_claude_turns(messages: list[dict]) -> list[dict]:
    turns: list[dict] = []
    current: dict | None = None

    for msg in messages:
        if is_user(msg):
            tool_results = get_tool_results(msg)
            if tool_results and current is not None:
                for tr in tool_results:
                    tool_use_id = tr.get("tool_use_id", "")
                    if tool_use_id:
                        current["tool_results"][tool_use_id] = tr
            else:
                if current is not None:
                    turns.append(current)
                current = {
                    "user_text": get_text_content(msg),
                    "assistant_messages": [],
                    "tool_calls": [],
                    "tool_results": {},
                }
        elif is_assistant(msg) and current is not None:
            current["assistant_messages"].append(msg)
            for tc in get_tool_calls(msg):
                current["tool_calls"].append(tc)
        elif current is not None:
            for tr in get_tool_results(msg):
                tool_use_id = tr.get("tool_use_id", "")
                if tool_use_id:
                    current["tool_results"][tool_use_id] = tr

    if current is not None:
        turns.append(current)
    return turns


def build_claude_turn_spans(
    session_id: str,
    turn_num: int,
    turn: dict,
    agent: str,
) -> List[dict]:
    """Convert a Claude turn into a list of OTLP spans."""
    user_text = turn["user_text"]
    assistant_texts = [get_text_content(m) for m in turn["assistant_messages"]]
    final_output = next((t for t in reversed(assistant_texts) if t), "")

    trace_id = generate_trace_id()
    root_span_id = generate_span_id()
    turn_ts = now_ns()
    end_ts = now_ns()

    spans: List[dict] = []

    # Root span — the turn
    root_attrs: Dict[str, Any] = {
        "langfuse.trace.name": trace_name(user_text, turn_num),
        "session.id": session_id,
        "langfuse.environment": AGENT_ENVIRONMENTS.get(agent, "default"),
        "langfuse.trace.input": json.dumps({"role": "user", "content": user_text}),
        "langfuse.trace.output": json.dumps({"role": "assistant", "content": final_output}),
        "turn_number": turn_num,
        "source": "claude",
    }

    spans.append(make_span(
        trace_id=trace_id,
        span_id=root_span_id,
        name=trace_name(user_text, turn_num),
        start_ns=turn_ts,
        end_ns=end_ts,
        attributes=root_attrs,
    ))

    # Generation span — model response
    model = "claude-sonnet-4-20250514"
    if turn["assistant_messages"]:
        first_am = turn["assistant_messages"][0]
        model = first_am.get("model", model)

    gen_span_id = generate_span_id()
    spans.append(make_span(
        trace_id=trace_id,
        span_id=gen_span_id,
        parent_span_id=root_span_id,
        name="Claude Response",
        start_ns=turn_ts,
        end_ns=end_ts,
        attributes={
            "langfuse.observation.type": "generation",
            "langfuse.observation.model.name": model,
            "langfuse.observation.input": json.dumps({"role": "user", "content": user_text}),
            "langfuse.observation.output": json.dumps({"role": "assistant", "content": final_output}),
            "tool_count": len(turn["tool_calls"]),
        },
    ))

    # Tool spans
    for tc in turn["tool_calls"]:
        tc_name = tc.get("name", "unknown")
        tc_id = tc.get("id", "")
        tc_input = tc.get("input", {})

        result = turn["tool_results"].get(tc_id, {})
        result_content = result.get("content", "")
        is_error = result.get("is_error", False)

        tool_span_id = generate_span_id()
        tool_output = {
            "content": result_content[:2000] if isinstance(result_content, str) else str(result_content)[:2000],
            "is_error": is_error,
        }

        spans.append(make_span(
            trace_id=trace_id,
            span_id=tool_span_id,
            parent_span_id=root_span_id,
            name=f"Tool: {tc_name}",
            start_ns=turn_ts,
            end_ns=end_ts,
            attributes={
                "langfuse.observation.input": json.dumps(tc_input),
                "langfuse.observation.output": json.dumps(tool_output),
                "tool_name": tc_name,
                "tool_id": tc_id,
            },
            status_code=2 if is_error else 1,  # STATUS_CODE_ERROR=2, STATUS_CODE_OK=1
        ))

    return spans


def process_claude(exporters: List[dict]) -> int:
    agent = "claude"
    result = find_latest_transcript()
    if not result:
        debug("No transcript file found", agent)
        return 0

    session_id, transcript_file = result
    state = load_state(agent)
    session_state = state.get(session_id, {})
    last_line = session_state.get("last_line", 0)
    turn_count = session_state.get("turn_count", 0)

    lines = transcript_file.read_text().strip().split("\n")
    total_lines = len(lines)

    if last_line >= total_lines:
        return 0

    all_messages = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            all_messages.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    if not all_messages:
        return 0

    all_turns = group_claude_turns(all_messages)
    new_turns = all_turns[turn_count:]

    if not new_turns:
        state[session_id] = {"last_line": total_lines, "turn_count": len(all_turns), "updated": datetime.now(timezone.utc).isoformat()}
        save_state(agent, state)
        return 0

    # Build all spans across turns
    all_spans: List[dict] = []
    for idx, turn in enumerate(new_turns):
        spans = build_claude_turn_spans(session_id, turn_count + idx + 1, turn, agent)
        all_spans.extend(spans)

    # Export as a single OTLP batch
    if all_spans:
        resource_span = make_resource_spans(all_spans, agent, session_id)
        payload = make_otlp_payload([resource_span])
        export_otlp(payload, exporters, agent, session_id)

    created = len(new_turns)
    state[session_id] = {"last_line": total_lines, "turn_count": turn_count + created, "updated": datetime.now(timezone.utc).isoformat()}
    save_state(agent, state)
    return created


# ===========================================================================
# Entry point
# ===========================================================================

def main() -> None:
    script_start = datetime.now()
    agent = "unknown"
    session_id = ""
    exit_code = 0
    try:
        hook_input = read_stdin()
        agent = detect_agent(hook_input)
        session_id = hook_input.get("sessionId", "")

        # Always log invocation with useful context
        transcript = ""
        if agent == "github-copilot-chat":
            raw_tp = hook_input.get("transcript_path", "")
            transcript = resolve_uri(raw_tp) if raw_tp else ""

        exporters = build_exporters(_config)
        exporter_names = [e.get("name", "?") for e in exporters]
        log("INFO", f"Hook invoked: agent={agent} exporters={exporter_names}", agent, session_id)
        debug(f"stdin keys: {list(hook_input.keys())}", agent, session_id)
        if transcript:
            debug(f"transcript: {transcript}", agent, session_id)

        if os.environ.get("TRACE_TO_LANGFUSE", "").lower() != "true":
            log("INFO", "Tracing disabled (TRACE_TO_LANGFUSE != true) — exiting", agent, session_id)
            output_and_exit()

        if not exporters:
            log("ERROR", "No exporters configured (no keys/endpoints found)", agent, session_id)
            output_and_exit(code=1)

        if agent == "github-copilot-chat":
            turns = process_vscode(exporters, hook_input)
        else:
            turns = process_claude(exporters)

        duration = (datetime.now() - script_start).total_seconds()
        log("INFO", f"Done: {turns} turn(s) in {duration:.1f}s → {exporter_names}", agent, session_id)
    except Exception as e:
        exit_code = 1
        try:
            log("ERROR", f"Unhandled: {e}", agent, session_id)
        except Exception:
            pass

    output_and_exit(code=exit_code)


if __name__ == "__main__":
    main()
