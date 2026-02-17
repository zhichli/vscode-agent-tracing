#!/usr/bin/env python3
"""
Agent Tracing — Zero-dependency OTLP tracing hook (OTel GenAI semconv).

Emits standard OpenTelemetry (OTLP JSON) traces following the GenAI semantic
conventions (https://opentelemetry.io/docs/specs/semconv/gen-ai/) to any
configured backend (Langfuse, Jaeger, Honeycomb, Grafana Tempo, Datadog, etc.).

Shared by both VS Code Copilot Chat and Claude Code. Detects the calling
agent at runtime via stdin format:
  - VS Code: stdin contains {"hookEventName": ..., "transcript_path": ..., "sessionId": ...}
  - Claude:  stdin contains {"hook_event_name": "Stop", "session_id": ..., "transcript_path": ...}

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
from typing import Any, Dict, List, Optional
from urllib.error import URLError
from urllib.request import Request, urlopen

# ---------------------------------------------------------------------------
# Stdin read timeout (seconds)
# ---------------------------------------------------------------------------
STDIN_TIMEOUT_SEC = 30

# ---------------------------------------------------------------------------
# Configuration
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

# OTel scope / resource constants
OTEL_SCOPE_NAME = "agent-tracing-hook"
OTEL_SCOPE_VERSION = "0.3.0"
OTEL_SERVICE_NAME = "agent-tracing"

EXPORT_TIMEOUT_SEC = 10

# Agent metadata
AGENT_META = {
    "github-copilot-chat": {
        "provider": "openai",
        "agent_name": "GitHub Copilot",
        "default_model": "copilot-agent",
        "environment": "github-copilot-chat",
    },
    "claude": {
        "provider": "anthropic",
        "agent_name": "Claude Code",
        "default_model": "claude-sonnet-4-20250514",
        "environment": "claude",
    },
}


# ---------------------------------------------------------------------------
# Exporter resolution
# ---------------------------------------------------------------------------

def build_exporters(config: dict) -> List[dict]:
    if config.get("exporters"):
        return config["exporters"]
    pk = os.environ.get("LANGFUSE_PUBLIC_KEY", "") or config.get("public_key", "")
    sk = os.environ.get("LANGFUSE_SECRET_KEY", "") or config.get("secret_key", "")
    host = os.environ.get("LANGFUSE_HOST", "") or config.get("host", "http://localhost:3000")
    if not pk or not sk:
        return []
    auth = base64.b64encode(f"{pk}:{sk}".encode()).decode()
    return [{
        "name": "langfuse",
        "endpoint": f"{host.rstrip('/')}/api/public/otel/v1/traces",
        "headers": {"Authorization": f"Basic {auth}"},
    }]


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def _log_path() -> Path:
    base = Path(LOG_DIR) if LOG_DIR else Path.home() / ".claude" / "state"
    return base / "hook.log"


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


def debug(msg: str, agent: str = "unknown", sid: str = "") -> None:
    if DEBUG:
        log("DEBUG", msg, agent, sid)


# ---------------------------------------------------------------------------
# OTLP JSON helpers
# ---------------------------------------------------------------------------

def gen_trace_id() -> str:
    return uuid.uuid4().hex

def gen_span_id() -> str:
    return uuid.uuid4().hex[:16]

def now_ns() -> str:
    return str(int(time.time() * 1e9))

def ts_to_ns(v: Any) -> str:
    if not v:
        return now_ns()
    if isinstance(v, (int, float)):
        return str(int(v * 1e9))
    if isinstance(v, str):
        try:
            dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
            return str(int(dt.timestamp() * 1e9))
        except ValueError:
            pass
    return now_ns()

def attr(key: str, value: Any) -> Optional[dict]:
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
    trace_id: str, span_id: str, name: str,
    start_ns: str, end_ns: str, attributes: Dict[str, Any],
    parent_span_id: str = "", kind: int = 1,
    status_code: int = 1,
) -> dict:
    attrs = [a for a in (attr(k, v) for k, v in attributes.items()) if a is not None]
    span: Dict[str, Any] = {
        "traceId": trace_id, "spanId": span_id, "name": name,
        "kind": kind, "startTimeUnixNano": start_ns, "endTimeUnixNano": end_ns,
        "attributes": attrs, "status": {"code": status_code},
    }
    if parent_span_id:
        span["parentSpanId"] = parent_span_id
    return span


def make_resource_spans(spans: List[dict], agent: str) -> dict:
    meta = AGENT_META.get(agent, {})
    res_attrs = [a for a in [
        attr("service.name", OTEL_SERVICE_NAME),
        attr("deployment.environment", meta.get("environment", "default")),
    ] if a is not None]
    return {
        "resource": {"attributes": res_attrs},
        "scopeSpans": [{"scope": {"name": OTEL_SCOPE_NAME, "version": OTEL_SCOPE_VERSION}, "spans": spans}],
    }


def export_otlp(payload: dict, exporters: List[dict], agent: str = "unknown", sid: str = "") -> int:
    body = json.dumps(payload).encode("utf-8")
    ok = 0
    for exp in exporters:
        name = exp.get("name", "?")
        endpoint = exp.get("endpoint", "")
        if not endpoint:
            continue
        headers = {"Content-Type": "application/json"}
        headers.update(exp.get("headers", {}))
        try:
            req = Request(endpoint, data=body, headers=headers, method="POST")
            with urlopen(req, timeout=EXPORT_TIMEOUT_SEC) as resp:
                debug(f"Exported to {name}: HTTP {resp.status}", agent, sid)
                ok += 1
        except (URLError, Exception) as e:
            log("WARN", f"Export to {name} failed: {e}", agent, sid)
    return ok


# ---------------------------------------------------------------------------
# OTel GenAI message format helpers
# ---------------------------------------------------------------------------

def format_input_message(role: str, text: str) -> dict:
    """Format per OTel gen_ai.input.messages JSON schema."""
    return {"role": role, "parts": [{"type": "text", "content": text}]}


def format_output_message(text: str, finish_reason: str = "stop") -> dict:
    """Format per OTel gen_ai.output.messages JSON schema."""
    return {"role": "assistant", "parts": [{"type": "text", "content": text}], "finish_reason": finish_reason}


def format_tool_call_message(tool_name: str, tool_call_id: str, arguments: Any) -> dict:
    """Format a tool_call part for input messages."""
    return {"role": "assistant", "parts": [{"type": "tool_call", "id": tool_call_id, "name": tool_name, "arguments": arguments if isinstance(arguments, dict) else {}}]}


def format_tool_result_message(tool_call_id: str, result: Any) -> dict:
    """Format a tool result part."""
    content = result if isinstance(result, str) else json.dumps(result) if result else ""
    return {"role": "tool", "parts": [{"type": "tool_call_response", "id": tool_call_id, "output": content[:2000]}]}


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def trace_name(user_text: str, turn_num: int, max_len: int = 80) -> str:
    for raw_line in user_text.split("\n"):
        line = raw_line.strip().lstrip(">#- ").strip()
        if line:
            return (line[:max_len].rstrip() + "\u2026") if len(line) > max_len else line
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
    # VS Code Copilot Chat uses "hookEventName" (camelCase)
    if hook_input.get("hookEventName"):
        return "github-copilot-chat"
    # Claude Code uses "hook_event_name" (snake_case)
    if hook_input.get("hook_event_name"):
        return "claude"
    return "claude"  # fallback


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
    tool_completes: dict[str, dict] = {}
    for ev in events:
        t = ev.get("type", "")
        if t == "tool.execution_complete":
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


def build_vscode_turn_spans(session_id: str, turn_num: int, turn: dict, session_info: dict, agent: str) -> List[dict]:
    meta = AGENT_META[agent]
    user_text = turn["user_content"]
    output_text = get_vscode_assistant_text(turn)
    reasoning = get_vscode_reasoning(turn)
    tool_execs = turn["tool_executions"]

    trace_id = gen_trace_id()
    root_span_id = gen_span_id()
    turn_ts = ts_to_ns(turn.get("timestamp"))
    end_ts = now_ns()
    spans: List[dict] = []

    # Root span: invoke_agent
    root_attrs: Dict[str, Any] = {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": meta["agent_name"],
        "gen_ai.provider.name": meta["provider"],
        "gen_ai.conversation.id": session_id,
        "gen_ai.input.messages": json.dumps([format_input_message("user", user_text)]),
        "gen_ai.output.messages": json.dumps([format_output_message(output_text)]),
    }
    for key in ("producer", "vscode_version", "version"):
        if session_info.get(key):
            root_attrs[key] = session_info[key]

    spans.append(make_span(
        trace_id=trace_id, span_id=root_span_id,
        name=f"invoke_agent {meta['agent_name']}",
        start_ns=turn_ts, end_ns=end_ts, attributes=root_attrs,
    ))

    # Generation span: chat
    gen_output = [format_output_message(output_text)]
    g_span_id = gen_span_id()
    gen_attrs: Dict[str, Any] = {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": meta["provider"],
        "gen_ai.request.model": meta["default_model"],
        "gen_ai.response.model": meta["default_model"],
        "gen_ai.input.messages": json.dumps([format_input_message("user", user_text)]),
        "gen_ai.output.messages": json.dumps(gen_output),
    }
    if reasoning:
        gen_attrs["gen_ai.reasoning"] = reasoning[:2000]

    spans.append(make_span(
        trace_id=trace_id, span_id=g_span_id,
        parent_span_id=root_span_id,
        name=f"chat {meta['default_model']}",
        start_ns=turn_ts, end_ns=end_ts, attributes=gen_attrs, kind=3,  # CLIENT
    ))

    # Tool spans: execute_tool
    for te in tool_execs:
        try:
            tool_input = json.loads(te["arguments"]) if isinstance(te["arguments"], str) else te["arguments"]
        except (json.JSONDecodeError, TypeError):
            tool_input = {"raw": te["arguments"]}

        tool_name = te["name"]
        tool_call_id = te.get("tool_call_id", "")
        span_name = f"execute_tool {tool_name}"

        tool_output: Dict[str, Any] = {"completed": te.get("completed", False)}
        if te.get("success") is not None:
            tool_output["success"] = te["success"]

        t_span_id = gen_span_id()
        spans.append(make_span(
            trace_id=trace_id, span_id=t_span_id,
            parent_span_id=root_span_id, name=span_name,
            start_ns=turn_ts, end_ns=end_ts,
            attributes={
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": tool_name,
                "gen_ai.tool.call.id": tool_call_id,
                "gen_ai.tool.call.arguments": json.dumps(tool_input),
                "gen_ai.tool.call.result": json.dumps(tool_output),
            },
        ))

    return spans


def process_vscode(exporters: List[dict], hook_input: dict) -> int:
    agent = "github-copilot-chat"
    session_id = hook_input.get("sessionId", "")
    transcript_path = ""
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

    all_spans: List[dict] = []
    for idx, turn in enumerate(new_turns):
        all_spans.extend(build_vscode_turn_spans(session_id, turn_count + idx + 1, turn, session_info, agent))

    if all_spans:
        payload = {"resourceSpans": [make_resource_spans(all_spans, agent)]}
        export_otlp(payload, exporters, agent, session_id)

    created = len(new_turns)
    state[session_id] = {"last_line": total_lines, "turn_count": turn_count + created, "updated": datetime.now(timezone.utc).isoformat()}
    save_state(agent, state)
    return created


# ===========================================================================
# Claude Code handler
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
        return [i for i in content if isinstance(i, dict) and i.get("type") == "tool_use"]
    return []

def get_tool_results(msg: dict) -> list:
    content = get_content(msg)
    if isinstance(content, list):
        return [i for i in content if isinstance(i, dict) and i.get("type") == "tool_result"]
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


def group_claude_turns(messages: list[dict]) -> list[dict]:
    turns: list[dict] = []
    current: dict | None = None
    for msg in messages:
        if is_user(msg):
            tool_results = get_tool_results(msg)
            if tool_results and current is not None:
                for tr in tool_results:
                    tid = tr.get("tool_use_id", "")
                    if tid:
                        current["tool_results"][tid] = tr
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
                tid = tr.get("tool_use_id", "")
                if tid:
                    current["tool_results"][tid] = tr
    if current is not None:
        turns.append(current)
    return turns


def build_claude_turn_spans(session_id: str, turn_num: int, turn: dict, agent: str) -> List[dict]:
    meta = AGENT_META[agent]
    user_text = turn["user_text"]
    assistant_texts = [get_text_content(m) for m in turn["assistant_messages"]]
    final_output = next((t for t in reversed(assistant_texts) if t), "")

    # Extract model from first assistant message
    model = meta["default_model"]
    if turn["assistant_messages"]:
        first_am = turn["assistant_messages"][0]
        model = first_am.get("model") or (first_am.get("message", {}) or {}).get("model") or model

    trace_id = gen_trace_id()
    root_span_id = gen_span_id()
    turn_ts = now_ns()
    end_ts = now_ns()
    spans: List[dict] = []

    # Root span: invoke_agent
    spans.append(make_span(
        trace_id=trace_id, span_id=root_span_id,
        name=f"invoke_agent {meta['agent_name']}",
        start_ns=turn_ts, end_ns=end_ts,
        attributes={
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.agent.name": meta["agent_name"],
            "gen_ai.provider.name": meta["provider"],
            "gen_ai.conversation.id": session_id,
            "gen_ai.request.model": model,
            "gen_ai.response.model": model,
            "gen_ai.input.messages": json.dumps([format_input_message("user", user_text)]),
            "gen_ai.output.messages": json.dumps([format_output_message(final_output)]),
        },
    ))

    # Generation span: chat
    g_span_id = gen_span_id()
    spans.append(make_span(
        trace_id=trace_id, span_id=g_span_id,
        parent_span_id=root_span_id,
        name=f"chat {model}",
        start_ns=turn_ts, end_ns=end_ts,
        attributes={
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": meta["provider"],
            "gen_ai.request.model": model,
            "gen_ai.response.model": model,
            "gen_ai.input.messages": json.dumps([format_input_message("user", user_text)]),
            "gen_ai.output.messages": json.dumps([format_output_message(final_output)]),
        },
        kind=3,  # CLIENT
    ))

    # Tool spans: execute_tool
    for tc in turn["tool_calls"]:
        tc_name = tc.get("name", "unknown")
        tc_id = tc.get("id", "")
        tc_input = tc.get("input", {})

        result = turn["tool_results"].get(tc_id, {})
        result_content = result.get("content", "")
        is_error = result.get("is_error", False)

        t_span_id = gen_span_id()
        t_attrs: Dict[str, Any] = {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": tc_name,
            "gen_ai.tool.call.id": tc_id,
            "gen_ai.tool.call.arguments": json.dumps(tc_input),
        }
        if result_content:
            rc = result_content[:2000] if isinstance(result_content, str) else str(result_content)[:2000]
            t_attrs["gen_ai.tool.call.result"] = rc
        if is_error:
            t_attrs["error.type"] = "tool_error"

        spans.append(make_span(
            trace_id=trace_id, span_id=t_span_id,
            parent_span_id=root_span_id,
            name=f"execute_tool {tc_name}",
            start_ns=turn_ts, end_ns=end_ts,
            attributes=t_attrs,
            status_code=2 if is_error else 1,
        ))

    return spans


def process_claude(exporters: List[dict], hook_input: dict) -> int:
    agent = "claude"
    session_id = hook_input.get("session_id", "")
    transcript_path = hook_input.get("transcript_path", "")

    if not transcript_path:
        debug("No transcript_path in stdin — Claude hook requires it", agent, session_id)
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

    all_spans: List[dict] = []
    for idx, turn in enumerate(new_turns):
        all_spans.extend(build_claude_turn_spans(session_id, turn_count + idx + 1, turn, agent))

    if all_spans:
        payload = {"resourceSpans": [make_resource_spans(all_spans, agent)]}
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
        session_id = hook_input.get("sessionId") or hook_input.get("session_id", "")

        transcript = ""
        if "transcript_path" in hook_input:
            transcript = resolve_uri(hook_input["transcript_path"])

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
            turns = process_claude(exporters, hook_input)

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
