#!/usr/bin/env python3
"""
Agent Tracing — VS Code Copilot Chat → Langfuse tracing hook.

Runs as a VS Code agent Stop hook. Reads the session transcript via the
transcript_path passed on stdin (VS Code hooks API), parses conversation
turns, and sends them to a Langfuse instance as traces.

Install: managed automatically by the Agent Tracing VS Code extension.
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from langfuse import Langfuse
except ImportError:
    print(json.dumps({}), flush=True)
    sys.exit(0)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
LOG_FILE = Path.home() / ".claude" / "state" / "agent_tracing.vscode.log"
STATE_FILE = Path.home() / ".claude" / "state" / "agent_tracing.vscode.state.json"
DEBUG = os.environ.get("CC_LANGFUSE_DEBUG", "").lower() == "true"


def log(level: str, message: str) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG_FILE, "a") as f:
        f.write(f"{ts} [{level}] {message}\n")


def debug(message: str) -> None:
    if DEBUG:
        log("DEBUG", message)


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text())
    except (json.JSONDecodeError, IOError):
        return {}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


def output_and_exit(data: dict | None = None) -> None:
    print(json.dumps(data or {}), flush=True)
    sys.exit(0)


# ---------------------------------------------------------------------------
# VS Code URI handling
# ---------------------------------------------------------------------------

def resolve_uri(value: Any) -> str:
    """Extract fsPath from a VS Code URI object, or return the string as-is."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get("fsPath") or value.get("path") or ""
    return ""


# ---------------------------------------------------------------------------
# Stdin parsing
# ---------------------------------------------------------------------------

def read_hook_input() -> dict:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return {}
        hook_input = json.loads(raw)
        if "transcript_path" in hook_input:
            hook_input["transcript_path"] = resolve_uri(hook_input["transcript_path"])
        if "cwd" in hook_input:
            hook_input["cwd"] = resolve_uri(hook_input["cwd"])
        debug(f"Hook input: hookEventName={hook_input.get('hookEventName')}, "
              f"sessionId={hook_input.get('sessionId')}, "
              f"transcript_path={hook_input.get('transcript_path')}")
        return hook_input
    except (json.JSONDecodeError, IOError) as e:
        debug(f"Failed to parse stdin: {e}")
        return {}


# ---------------------------------------------------------------------------
# Transcript parsing
# ---------------------------------------------------------------------------

def parse_events(lines: list[str]) -> list[dict]:
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


def extract_session_info(events: list[dict]) -> dict:
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


def group_into_turns(events: list[dict]) -> list[dict]:
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


def get_assistant_text(turn: dict) -> str:
    for am in reversed(turn["assistant_messages"]):
        content = am.get("data", {}).get("content", "")
        if content:
            return content
    return ""


def get_reasoning(turn: dict) -> str:
    parts = []
    for am in turn["assistant_messages"]:
        r = am.get("data", {}).get("reasoningText", "")
        if r:
            parts.append(r)
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Langfuse trace creation
# ---------------------------------------------------------------------------

def create_trace(
    langfuse: Langfuse,
    session_id: str,
    turn_num: int,
    turn: dict,
    session_info: dict,
) -> None:
    user_text = turn["user_content"]
    output_text = get_assistant_text(turn)
    reasoning = get_reasoning(turn)
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

            is_subagent = te["name"] == "runSubagent"
            span_name = f"Tool: {te['name']}"
            if is_subagent:
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

    debug(f"Created trace for turn {turn_num}")


# ---------------------------------------------------------------------------
# Transcript processing
# ---------------------------------------------------------------------------

def process_transcript(langfuse: Langfuse, session_id: str, transcript_file: Path, state: dict) -> int:
    session_state = state.get(session_id, {})
    last_line = session_state.get("last_line", 0)
    turn_count = session_state.get("turn_count", 0)

    lines = transcript_file.read_text().strip().split("\n")
    total_lines = len(lines)

    if last_line >= total_lines:
        return 0

    all_events = parse_events(lines)
    if not all_events:
        return 0

    session_info = extract_session_info(all_events)
    all_turns = group_into_turns(all_events)
    new_turns = all_turns[turn_count:]

    if not new_turns:
        state[session_id] = {"last_line": total_lines, "turn_count": len(all_turns), "updated": datetime.now(timezone.utc).isoformat()}
        save_state(state)
        return 0

    created = 0
    for idx, turn in enumerate(new_turns):
        create_trace(langfuse, session_id, turn_count + idx + 1, turn, session_info)
        created += 1

    state[session_id] = {"last_line": total_lines, "turn_count": turn_count + created, "updated": datetime.now(timezone.utc).isoformat()}
    save_state(state)
    return created


# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------

def main() -> None:
    script_start = datetime.now()
    try:
        debug("VS Code hook started")
        hook_input = read_hook_input()

        if os.environ.get("TRACE_TO_LANGFUSE", "").lower() != "true":
            debug("Tracing disabled")
            output_and_exit()

        pk = os.environ.get("CC_LANGFUSE_PUBLIC_KEY") or os.environ.get("LANGFUSE_PUBLIC_KEY")
        sk = os.environ.get("CC_LANGFUSE_SECRET_KEY") or os.environ.get("LANGFUSE_SECRET_KEY")
        host = os.environ.get("CC_LANGFUSE_HOST") or os.environ.get("LANGFUSE_HOST", "https://cloud.langfuse.com")

        if not pk or not sk:
            log("ERROR", "Langfuse API keys not set")
            output_and_exit()

        langfuse = Langfuse(public_key=pk, secret_key=sk, host=host)
        state = load_state()

        session_id = hook_input.get("sessionId", "")
        transcript_path = hook_input.get("transcript_path", "")

        if not transcript_path:
            debug("No transcript_path in stdin")
            output_and_exit()

        transcript_file = Path(transcript_path)
        if not transcript_file.exists():
            debug(f"Transcript not found: {transcript_path}")
            output_and_exit()

        if not session_id:
            session_id = transcript_file.stem

        turns = process_transcript(langfuse, session_id, transcript_file, state)
        langfuse.flush()

        duration = (datetime.now() - script_start).total_seconds()
        log("INFO", f"Processed {turns} turn(s) in {duration:.1f}s")

        langfuse.shutdown()
    except Exception as e:
        try:
            log("ERROR", f"Unhandled: {e}")
        except Exception:
            pass

    output_and_exit()


if __name__ == "__main__":
    main()
