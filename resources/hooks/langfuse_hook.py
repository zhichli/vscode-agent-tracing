#!/usr/bin/env python3
"""
Agent Tracing — Unified Langfuse tracing hook.

Shared by both VS Code Copilot Chat and Claude. Detects the calling
agent at runtime via stdin format:
  - VS Code: stdin contains {"hookEventName": ..., "transcript_path": ..., "sessionId": ...}
  - Claude: stdin is empty or has no hookEventName; reads latest transcript from ~/.claude/projects/

Install: managed automatically by the Agent Tracing VS Code extension.
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

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

_env_pk = os.environ.get("LANGFUSE_PUBLIC_KEY", "")
_env_sk = os.environ.get("LANGFUSE_SECRET_KEY", "")
_env_host = os.environ.get("LANGFUSE_HOST", "")

LANGFUSE_PUBLIC_KEY = _env_pk or _config.get("public_key", "")
LANGFUSE_SECRET_KEY = _env_sk or _config.get("secret_key", "")
LANGFUSE_HOST = _env_host or _config.get("host", "http://localhost:3000")
KEY_SOURCE = "env" if _env_pk else ("config" if _config.get("public_key") else "none")
LOG_DIR = _config.get("log_dir", "")
DEBUG = os.environ.get("CC_LANGFUSE_DEBUG", "").lower() == "true"

# Agent environment names for Langfuse (used as tracing environments)
AGENT_ENVIRONMENTS = {
    "github-copilot-chat": "github-copilot-chat",
    "claude": "claude",
}

try:
    from langfuse import Langfuse
except ImportError:
    print(json.dumps({}), flush=True)
    sys.exit(0)


# ---------------------------------------------------------------------------
# Logging
#
# Two destinations:
#   1. Per-session:  <log_dir>/<agent>/<YYYY-MM-DD>/<sessionId>.log
#   2. Aggregate:    <log_dir>/hook.log  (all agents, all sessions — tail -f friendly)
# Plus stderr when CC_LANGFUSE_DEBUG=true for immediate terminal visibility.
# ---------------------------------------------------------------------------

def _log_base() -> Path:
    return Path(LOG_DIR) if LOG_DIR else Path.home() / ".claude" / "state"


def _session_log_path(agent: str, session_id: str) -> Path:
    """Per-session log: <base>/<agent>/<YYYY-MM-DD>/<sessionId>.log"""
    return _log_base() / agent / datetime.now().strftime("%Y-%m-%d") / f"{session_id}.log"


def _aggregate_log_path() -> Path:
    """Single aggregate log: <base>/hook.log"""
    return _log_base() / "hook.log"


def _write_line(path: Path, line: str) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a") as f:
            f.write(line)
    except OSError:
        pass


def log(level: str, message: str, agent: str = "unknown", session_id: str = "") -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    tag = f"{agent}/{session_id}" if session_id else agent
    line = f"{ts} [{level}] [{tag}] {message}\n"

    # Always write to aggregate log
    _write_line(_aggregate_log_path(), line)

    # Also write to per-session log when we have a session
    if session_id:
        _write_line(_session_log_path(agent, session_id), line)

    # Stderr in debug mode for immediate terminal visibility
    if DEBUG:
        sys.stderr.write(line)
        sys.stderr.flush()


def debug(message: str, agent: str = "unknown", session_id: str = "") -> None:
    if DEBUG:
        log("DEBUG", message, agent, session_id)


def output_and_exit(data: dict | None = None) -> None:
    print(json.dumps(data or {}), flush=True)
    sys.exit(0)


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
        raw = sys.stdin.read()
        if not raw.strip():
            return {}
        return json.loads(raw)
    except (json.JSONDecodeError, IOError):
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


def create_vscode_trace(langfuse: Langfuse, session_id: str, turn_num: int, turn: dict, session_info: dict) -> None:
    user_text = turn["user_content"]
    output_text = get_vscode_assistant_text(turn)
    reasoning = get_vscode_reasoning(turn)
    tool_execs = turn["tool_executions"]

    metadata: dict[str, Any] = {
        "source": "vscode-copilot-chat",
        "turn_number": turn_num,
        "session_id": session_id,
    }
    for key in ("producer", "vscode_version", "version"):
        if session_info.get(key):
            metadata[key] = session_info[key]

    with langfuse.start_as_current_span(
        name=f"Turn {turn_num}",
        input={"role": "user", "content": user_text},
        metadata=metadata,
    ) as trace_span:
        langfuse.update_current_trace(
            session_id=session_id,
            input={"role": "user", "content": user_text},
            metadata=metadata,
        )
        gen_output: dict[str, Any] = {"role": "assistant", "content": output_text}
        if reasoning:
            gen_output["reasoning"] = reasoning[:2000]

        with langfuse.start_as_current_observation(
            name="Copilot Response",
            as_type="generation",
            model="copilot-agent",
            input={"role": "user", "content": user_text},
            output=gen_output,
            metadata={"tool_count": len(tool_execs)},
        ):
            pass

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

            with langfuse.start_as_current_span(
                name=span_name,
                input=tool_input,
                metadata={"tool_name": te["name"], "tool_id": te.get("tool_call_id", "")},
            ) as tool_span:
                tool_span.update(output={"completed": te.get("completed", False), "success": te.get("success")})

        trace_span.update(output={"role": "assistant", "content": output_text})


def process_vscode(langfuse: Langfuse, hook_input: dict) -> int:
    session_id = hook_input.get("sessionId", "")
    transcript_path = hook_input.get("transcript_path", "")
    if "transcript_path" in hook_input:
        transcript_path = resolve_uri(hook_input["transcript_path"])

    if not transcript_path:
        debug("No transcript_path in stdin", "github-copilot-chat", session_id)
        return 0

    transcript_file = Path(transcript_path)
    if not transcript_file.exists():
        debug(f"Transcript not found: {transcript_path}", "github-copilot-chat", session_id)
        return 0

    if not session_id:
        session_id = transcript_file.stem

    state = load_state("github-copilot-chat")
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
        save_state("github-copilot-chat", state)
        return 0

    created = 0
    for idx, turn in enumerate(new_turns):
        create_vscode_trace(langfuse, session_id, turn_count + idx + 1, turn, session_info)
        created += 1

    state[session_id] = {"last_line": total_lines, "turn_count": turn_count + created, "updated": datetime.now(timezone.utc).isoformat()}
    save_state("github-copilot-chat", state)
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


def create_claude_trace(langfuse: Langfuse, session_id: str, turn_num: int, turn: dict) -> None:
    user_text = turn["user_text"]
    assistant_texts = [get_text_content(m) for m in turn["assistant_messages"]]
    final_output = next((t for t in reversed(assistant_texts) if t), "")

    metadata: dict[str, Any] = {
        "source": "claude",
        "turn_number": turn_num,
        "session_id": session_id,
    }

    with langfuse.start_as_current_span(
        name=f"Turn {turn_num}",
        input={"role": "user", "content": user_text},
        metadata=metadata,
    ) as trace_span:
        langfuse.update_current_trace(
            session_id=session_id,
            input={"role": "user", "content": user_text},
            metadata=metadata,
        )
        model = "claude-sonnet-4-20250514"
        if turn["assistant_messages"]:
            first_am = turn["assistant_messages"][0]
            model = first_am.get("model", model)

        with langfuse.start_as_current_observation(
            name="Claude Response",
            as_type="generation",
            model=model,
            input={"role": "user", "content": user_text},
            output={"role": "assistant", "content": final_output},
            metadata={"tool_count": len(turn["tool_calls"])},
        ):
            pass

        for tc in turn["tool_calls"]:
            tc_name = tc.get("name", "unknown")
            tc_id = tc.get("id", "")
            tc_input = tc.get("input", {})

            result = turn["tool_results"].get(tc_id, {})
            result_content = result.get("content", "")
            is_error = result.get("is_error", False)

            with langfuse.start_as_current_span(
                name=f"Tool: {tc_name}",
                input=tc_input,
                metadata={"tool_name": tc_name, "tool_id": tc_id},
            ) as tool_span:
                tool_span.update(output={
                    "content": result_content[:2000] if isinstance(result_content, str) else str(result_content)[:2000],
                    "is_error": is_error,
                })

        trace_span.update(output={"role": "assistant", "content": final_output})


def process_claude(langfuse: Langfuse) -> int:
    result = find_latest_transcript()
    if not result:
        debug("No transcript file found", "claude")
        return 0

    session_id, transcript_file = result
    state = load_state("claude")
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
        save_state("claude", state)
        return 0

    created = 0
    for idx, turn in enumerate(new_turns):
        create_claude_trace(langfuse, session_id, turn_count + idx + 1, turn)
        created += 1

    state[session_id] = {"last_line": total_lines, "turn_count": turn_count + created, "updated": datetime.now(timezone.utc).isoformat()}
    save_state("claude", state)
    return created


# ===========================================================================
# Entry point
# ===========================================================================

def main() -> None:
    script_start = datetime.now()
    agent = "unknown"
    session_id = ""
    try:
        hook_input = read_stdin()
        agent = detect_agent(hook_input)
        session_id = hook_input.get("sessionId", "")

        # Always log invocation with useful context
        transcript = ""
        if agent == "github-copilot-chat":
            raw_tp = hook_input.get("transcript_path", "")
            transcript = resolve_uri(raw_tp) if raw_tp else ""
        log("INFO", f"Hook invoked: agent={agent} keys={KEY_SOURCE} host={LANGFUSE_HOST}", agent, session_id)
        debug(f"stdin keys: {list(hook_input.keys())}", agent, session_id)
        if transcript:
            debug(f"transcript: {transcript}", agent, session_id)

        if os.environ.get("TRACE_TO_LANGFUSE", "").lower() != "true":
            log("INFO", "Tracing disabled (TRACE_TO_LANGFUSE != true) — exiting", agent, session_id)
            output_and_exit()

        if not LANGFUSE_PUBLIC_KEY or not LANGFUSE_SECRET_KEY:
            log("ERROR", f"Langfuse API keys not set (source={KEY_SOURCE})", agent, session_id)
            output_and_exit()

        langfuse = Langfuse(
            public_key=LANGFUSE_PUBLIC_KEY,
            secret_key=LANGFUSE_SECRET_KEY,
            host=LANGFUSE_HOST,
            environment=AGENT_ENVIRONMENTS.get(agent, "default"),
        )

        if agent == "github-copilot-chat":
            turns = process_vscode(langfuse, hook_input)
        else:
            turns = process_claude(langfuse)

        langfuse.flush()
        duration = (datetime.now() - script_start).total_seconds()
        log("INFO", f"Done: {turns} turn(s) in {duration:.1f}s", agent, session_id)
        langfuse.shutdown()
    except Exception as e:
        try:
            log("ERROR", f"Unhandled: {e}", agent, session_id)
        except Exception:
            pass

    output_and_exit()


if __name__ == "__main__":
    main()
