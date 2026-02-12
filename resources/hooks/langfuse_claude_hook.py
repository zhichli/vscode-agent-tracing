#!/usr/bin/env python3
"""
Agent Tracing — Claude Code → Langfuse tracing hook.

Runs as a Claude Code Stop hook. Reads conversation transcripts from
~/.claude/projects/ and sends them to a Langfuse instance as traces.

When called by VS Code (hookEventName present in stdin), it exits immediately
since the dedicated VS Code hook handles that case.

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
LOG_FILE = Path.home() / ".claude" / "state" / "agent_tracing.claude.log"
STATE_FILE = Path.home() / ".claude" / "state" / "agent_tracing.claude.state.json"
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
# Stdin / VS Code detection
# ---------------------------------------------------------------------------

def read_stdin_safe() -> dict:
    try:
        raw = sys.stdin.read()
        if raw.strip():
            return json.loads(raw)
    except Exception:
        pass
    return {}


# ---------------------------------------------------------------------------
# Claude Code transcript helpers
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Transcript discovery
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Turn grouping
# ---------------------------------------------------------------------------

def group_into_turns(messages: list[dict]) -> list[dict]:
    """Group messages into user→assistant turns."""
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


# ---------------------------------------------------------------------------
# Trace creation
# ---------------------------------------------------------------------------

def create_trace(
    langfuse: Langfuse,
    session_id: str,
    turn_num: int,
    turn: dict,
) -> None:
    user_text = turn["user_text"]
    assistant_texts = [get_text_content(m) for m in turn["assistant_messages"]]
    final_output = next((t for t in reversed(assistant_texts) if t), "")

    metadata: dict[str, Any] = {
        "source": "claude-code",
        "turn_number": turn_num,
        "session_id": session_id,
    }

    with langfuse.start_as_current_span(
        name=f"Turn {turn_num}",
        input={"role": "user", "content": user_text},
        metadata=metadata,
    ) as trace_span:
        # Model info
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

    all_turns = group_into_turns(all_messages)
    new_turns = all_turns[turn_count:]

    if not new_turns:
        state[session_id] = {"last_line": total_lines, "turn_count": len(all_turns), "updated": datetime.now(timezone.utc).isoformat()}
        save_state(state)
        return 0

    created = 0
    for idx, turn in enumerate(new_turns):
        create_trace(langfuse, session_id, turn_count + idx + 1, turn)
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
        debug("Claude Code hook started")

        # Detect VS Code invocation and skip
        hook_input = read_stdin_safe()
        if hook_input.get("hookEventName"):
            debug("Skipping: called by VS Code")
            output_and_exit()

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

        result = find_latest_transcript()
        if not result:
            debug("No transcript file found")
            output_and_exit()

        session_id, transcript_file = result
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
