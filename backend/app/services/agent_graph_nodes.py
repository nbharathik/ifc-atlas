"""
LangGraph agent node definitions for the IFC viewer.

Two layers: a single agent node that wraps the existing tool-call loop, and
llm_agent_node + make_langchain_tools for native streaming via astream_events.

Node functions follow the LangGraph convention: they accept an IFCAgentState
and return a dict with the keys they want to update.  The Annotated[list,
operator.add] annotation on `messages` means returned lists are *appended*
rather than replaced.
"""

from __future__ import annotations

import json
import logging
from typing import Annotated, Any, Callable, Awaitable, Optional
import operator

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# State schema
# ---------------------------------------------------------------------------

try:
    from typing import TypedDict
except ImportError:
    from typing_extensions import TypedDict


class IFCAgentState(TypedDict):
    """Shared mutable state threaded through the IFC agent graph.

    `messages` uses operator.add so each node *appends* new turns rather
    than replacing the whole list - safe for parallel execution.
    """
    messages: Annotated[list[dict], operator.add]
    thread_id: str
    provider: str           # "openai" | "anthropic"
    model_id: str
    temperature: float
    system_prompt: str
    agent_id: Optional[str]
    allowed_tools: Optional[list[str]]
    pending_edit: Optional[dict]    # tier-3 diff staged by the last turn
    session_summary: str            # from session_memory block
    turn_events: Annotated[list[dict], operator.add]  # WS events this turn


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_initial_state(
    thread_id: str,
    provider: str = "openai",
    model_id: str = "gpt-4o",
    temperature: float = 0.3,
    system_prompt: str = "",
    agent_id: Optional[str] = None,
    allowed_tools: Optional[list[str]] = None,
) -> IFCAgentState:
    """Return a blank state for a new thread."""
    return IFCAgentState(
        messages=[],
        thread_id=thread_id,
        provider=provider,
        model_id=model_id,
        temperature=temperature,
        system_prompt=system_prompt,
        agent_id=agent_id,
        allowed_tools=allowed_tools,
        pending_edit=None,
        session_summary="",
        turn_events=[],
    )


def _extract_tool_call_summary(events: list[dict]) -> dict:
    """Scan turn events for pending_edit markers."""
    pending_edit = None
    for ev in events:
        if ev.get("type") == "tool_result":
            try:
                parsed = json.loads(ev.get("result", "{}") or "{}")
                if parsed.get("action") == "pending_edit":
                    pending_edit = parsed
            except (json.JSONDecodeError, TypeError):
                pass
    return {"pending_edit": pending_edit}


# ---------------------------------------------------------------------------
# Single agent node (tool-call loop wrapper)
# ---------------------------------------------------------------------------

def build_user_turn_messages(
    user_message: str,
    history: list[dict],
) -> list[dict]:
    """Merge history + user message into the messages list for state."""
    msgs = list(history)
    msgs.append({"role": "user", "content": user_message})
    return msgs


def extract_final_text(turn_events: list[dict]) -> str:
    """Reconstruct the assistant's reply text from chunk events."""
    return "".join(
        ev.get("content", "")
        for ev in turn_events
        if ev.get("type") == "chunk"
    )


def append_assistant_turn(
    turn_events: list[dict],
    tool_calls: list[dict],
) -> list[dict]:
    """Return new message dicts produced this turn (assistant + tool results).

    Used to keep `state.messages` up to date so subsequent turns have history.
    """
    new_msgs: list[dict] = []
    text = extract_final_text(turn_events)
    if text:
        new_msgs.append({"role": "assistant", "content": text})
    for tc in tool_calls:
        new_msgs.append({
            "role": "tool",
            "name": tc.get("name"),
            "result": tc.get("result"),
        })
    return new_msgs


# ---------------------------------------------------------------------------
# LangChain tool wrappers (native streaming)
# ---------------------------------------------------------------------------

# Type alias for the async tool executor used by chat_routes.py
ToolExecutorFn = Callable[[str, dict], Awaitable[dict]]

_JSON_TYPE_MAP: dict[str, type] = {
    "string": str,
    "integer": int,
    "number": float,
    "boolean": bool,
    "array": list,
    "object": dict,
}


def _build_pydantic_schema(parameters: dict, model_name: str) -> Any:
    """Return a Pydantic model class for the given JSON-schema parameters dict.

    Returns None when the tool has no properties (zero-parameter tools).
    """
    from pydantic import Field, create_model
    from typing import Optional as Opt

    props = parameters.get("properties", {})
    if not props:
        return None
    req = set(parameters.get("required", []))
    fields: dict[str, Any] = {}
    for fname, fprop in props.items():
        py_type: type = _JSON_TYPE_MAP.get(fprop.get("type", "string"), object)
        desc = fprop.get("description", "")
        if fname in req:
            fields[fname] = (py_type, Field(..., description=desc))
        else:
            fields[fname] = (Opt[py_type], Field(default=None, description=desc))  # type: ignore[assignment]
    return create_model(model_name, **fields)


def make_langchain_tools(
    allowed_tools: Optional[frozenset],
    tool_executor_fn: Optional[ToolExecutorFn] = None,
) -> list:
    """Wrap TOOL_DEFINITIONS as LangChain StructuredTools for native streaming.

    Each tool wraps either *tool_executor_fn* (the chat_routes router that
    handles client-vs-server dispatch) or falls back to the synchronous
    ``execute_tool`` for purely server-side invocation.

    The coroutine returns a JSON-serialised result string so LangGraph's
    ToolNode stores it in the message history verbatim.

    Args:
        allowed_tools: frozenset of allowed tool names; None = all tools.
        tool_executor_fn: async (name, args_dict) → dict.  None = sync fallback.
    """
    from app.services.tools import TOOL_DEFINITIONS, execute_tool
    from langchain_core.tools import StructuredTool
    from pydantic import create_model

    def _make_coro(tname: str, exec_fn: Optional[ToolExecutorFn], has_args: bool):
        """Return an async coroutine that calls the tool and returns JSON."""
        async def _coro(**kwargs: Any) -> str:
            kw = kwargs if has_args else {}
            if exec_fn is not None:
                result = await exec_fn(tname, kw)
            else:
                result = execute_tool(tname, kw)
            if not isinstance(result, dict):
                result = {"result": result}
            return json.dumps(result)
        return _coro

    lc_tools = []
    for tdef in TOOL_DEFINITIONS:
        name: str = tdef["name"]
        if allowed_tools is not None and name not in allowed_tools:
            continue
        description: str = tdef.get("description", "")
        parameters: dict = tdef.get("parameters", {})

        schema_cls = _build_pydantic_schema(parameters, f"_{name}_args")
        has_args = schema_cls is not None
        if not has_args:
            schema_cls = create_model(f"_{name}_empty")

        coro = _make_coro(name, tool_executor_fn, has_args)
        lc_tool = StructuredTool.from_function(
            coroutine=coro,
            name=name,
            description=description,
            args_schema=schema_cls,
        )
        lc_tools.append(lc_tool)

    return lc_tools
