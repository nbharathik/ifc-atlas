"""
LangGraph IFC agent graph.

Checkpoint container.
  Single identity node; MemorySaver checkpointer. The real LLM call lives in
  llm_service.stream_chat(); the graph only persists thread state so clients
  can reconnect and resume history.

Native streaming agent (this module).
  ``build_streaming_agent()`` creates a ``create_agent`` (LangGraph 1.0+) graph
  with a real LLM node bound to LangChain tool wrappers.  Callers stream via
  ``graph.astream_events()`` and fan WS events from LangGraph event types.
  No checkpointer on the streaming graph (ephemeral per-request); the existing
  ``graph_manager.save_turn()`` checkpoints the finished turn as before.

Usage (llm_service.py):
    from app.services.agent_graph import build_streaming_agent
    graph = build_streaming_agent(provider, model_id, lc_tools, system_prompt)
    async for event in graph.astream_events({"messages": lc_messages}, ...):
        ...

Usage (chat_routes.py - unchanged):
    from app.services.agent_graph import graph_manager
    graph_manager.save_turn(thread_id, messages, pending_edit)

Node functions follow the LangGraph convention: they accept an IFCAgentState
and return a dict with the keys they want to update.  The Annotated[list,
operator.add] annotation on `messages` means returned lists are *appended*
rather than replaced.
"""

from __future__ import annotations

import json
import logging
import operator
from typing import Annotated, Any, Awaitable, Callable, Optional

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
    from app.services.tools import TOOL_DEFINITIONS, execute_tool_off_loop
    from langchain_core.tools import StructuredTool
    from pydantic import create_model

    def _make_coro(tname: str, exec_fn: Optional[ToolExecutorFn], has_args: bool):
        """Return an async coroutine that calls the tool and returns JSON."""
        async def _coro(**kwargs: Any) -> str:
            kw = kwargs if has_args else {}
            if exec_fn is not None:
                result = await exec_fn(tname, kw)
            else:
                result = await execute_tool_off_loop(tname, kw)
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


# ---------------------------------------------------------------------------
# LangGraph imports with graceful fallback
# ---------------------------------------------------------------------------

try:
    from langgraph.graph import StateGraph, END
    from langgraph.checkpoint.memory import MemorySaver
    _LANGGRAPH_OK = True
except ImportError:
    _LANGGRAPH_OK = False
    StateGraph = None  # type: ignore[assignment,misc]
    END = "__end__"   # type: ignore[assignment]
    MemorySaver = None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

def _identity_node(state: IFCAgentState) -> dict:
    """Placeholder node - the checkpoint graph is a single pass-through.

    The actual LLM call happens outside this graph in
    `llm_service.stream_chat` (the streaming agent built by
    `build_streaming_agent` handles native streaming); this graph serves
    only as a checkpoint container.
    """
    # Return empty dict - node makes no state changes.
    # State is updated externally by GraphManager.save_turn().
    return {}


def _build_graph() -> Any:
    """Compile the checkpoint-container IFC agent graph.

    Returns the compiled graph or None if LangGraph is not installed.
    """
    if not _LANGGRAPH_OK:
        logger.warning(
            "langgraph not installed - graph checkpointing disabled. "
            "Install with: pip install langgraph"
        )
        return None

    saver = MemorySaver()

    builder = StateGraph(IFCAgentState)
    builder.add_node("agent", _identity_node)
    builder.set_entry_point("agent")
    builder.add_edge("agent", END)

    return builder.compile(checkpointer=saver)


# Module-level singleton - built once at import time.
_compiled_graph: Any = _build_graph()


# ---------------------------------------------------------------------------
# GraphManager - public API for chat_routes.py
# ---------------------------------------------------------------------------

class GraphManager:
    """Thin façade over the compiled LangGraph StateGraph.

    Methods are safe to call even when LangGraph is not installed - they
    become no-ops and `load_thread` returns None.
    """

    def __init__(self, graph: Any) -> None:
        self._graph = graph

    @property
    def available(self) -> bool:
        return self._graph is not None

    def _config(self, thread_id: str) -> dict:
        return {"configurable": {"thread_id": thread_id}}

    def save_turn(
        self,
        thread_id: str,
        messages: list[dict],
        pending_edit: Optional[dict] = None,
        session_summary: str = "",
        provider: str = "openai",
        model_id: str = "gpt-4o",
        temperature: float = 0.3,
        system_prompt: str = "",
        agent_id: Optional[str] = None,
        allowed_tools: Optional[list[str]] = None,
    ) -> None:
        """Persist a completed turn into the checkpoint store.

        Called by the WS chat handler *after* `stream_chat` completes so the
        graph checkpoint reflects the latest conversation state.
        """
        if not self.available:
            return

        cfg = self._config(thread_id)

        # Try to load existing state so we APPEND rather than overwrite.
        existing = self.load_thread(thread_id)
        if existing is not None:
            base_messages = existing.get("messages", [])
            # Deduplicate: only append messages not already in base
            existing_count = len(base_messages)
            new_messages = messages[existing_count:] if len(messages) > existing_count else []
        else:
            base_messages = []
            new_messages = messages

        state: IFCAgentState = {
            "messages": new_messages,
            "thread_id": thread_id,
            "provider": provider,
            "model_id": model_id,
            "temperature": temperature,
            "system_prompt": system_prompt,
            "agent_id": agent_id,
            "allowed_tools": allowed_tools,
            "pending_edit": pending_edit,
            "session_summary": session_summary,
            "turn_events": [],
        }

        try:
            self._graph.invoke(state, config=cfg)
        except Exception:
            logger.exception("graph_manager.save_turn failed for thread %s", thread_id)

    def load_thread(self, thread_id: str) -> Optional[dict]:
        """Return the latest checkpoint values for a thread or None."""
        if not self.available:
            return None
        try:
            snapshot = self._graph.get_state(self._config(thread_id))
            if snapshot and snapshot.values:
                return dict(snapshot.values)
        except Exception:
            logger.exception("graph_manager.load_thread failed for thread %s", thread_id)
        return None

    def delete_thread(self, thread_id: str) -> None:
        """Remove all checkpoints for a thread (no-op if not found)."""
        if not self.available:
            return
        try:
            saver = getattr(self._graph, "checkpointer", None)
            if saver is not None and hasattr(saver, "delete_thread"):
                saver.delete_thread(thread_id)
        except Exception:
            logger.exception("graph_manager.delete_thread failed for thread %s", thread_id)

    def list_threads(self) -> list[str]:
        """Return known thread IDs (MemorySaver keeps them in memory)."""
        if not self.available:
            return []
        try:
            # MemorySaver stores checkpoints keyed by thread_id in its internal
            # storage dict.  Access via the private attr for introspection.
            saver = getattr(self._graph, "checkpointer", None)
            if saver is None:
                return []
            storage = getattr(saver, "storage", {})
            return list(storage.keys())
        except Exception:
            return []


# Public singleton used by chat_routes.py
graph_manager = GraphManager(_compiled_graph)


# ---------------------------------------------------------------------------
# build_streaming_agent (ephemeral, per-request)
# ---------------------------------------------------------------------------

def build_streaming_agent(
    provider: str,
    model_id: str,
    lc_tools: list,
    system_prompt: str,
    temperature: float = 0.3,
    sampling: Any = None,
) -> Any:
    """Build a LangGraph ReAct agent for native streaming via astream_events.

    Returns a compiled ``CompiledStateGraph`` or ``None`` when the provider is
    unsupported, the required LangChain integration is not installed, or when
    ``lc_tools`` is empty (ReAct with no tools is pure overhead - callers should
    use a simple streaming path instead).

    The returned graph is ephemeral (no checkpointer).  Callers should:

        graph = build_streaming_agent(...)
        if graph is None:
            # fall back to stream_openai / stream_anthropic
            ...
        async for event in graph.astream_events({"messages": lc_msgs},
                                                config={"configurable": {"thread_id": tid}},
                                                version="v2"):
            ...

    Args:
        provider: "openai" or "anthropic".
        model_id: LLM model ID string.
        lc_tools: list of LangChain BaseTool objects (from make_langchain_tools).
        system_prompt: string injected as the system message.
        temperature: sampling temperature (used only when ``sampling`` is None).
        sampling: optional ``provider_params.SamplingParams`` resolved from the
            Model Registry. When provided, its temperature / top_p / max output
            tokens / reasoning settings are mapped to the provider's LangChain
            constructor kwargs (and override ``temperature``). When None, the
            legacy temperature-only behaviour is preserved.
    """
    if not _LANGGRAPH_OK:
        return None

    # ReAct with no tools is identical to a plain chat call but adds graph
    # overhead.  Signal callers to use the simpler streaming path instead.
    if not lc_tools:
        return None

    # Resolve provider sampling kwargs. With a registry entry, the mapper applies
    # the reasoning/temperature compatibility rules; without one we keep the
    # single temperature kwarg exactly as before.
    if sampling is not None:
        from app.services.provider_params import langchain_llm_kwargs
        sampling_kwargs = langchain_llm_kwargs(provider, sampling, model_id)
    else:
        sampling_kwargs = {"temperature": temperature}

    try:
        from app.services.secrets_service import get_api_key
        if provider == "openai":
            from langchain_openai import ChatOpenAI
            openai_key = get_api_key("openai")
            if not openai_key:
                return None
            llm = ChatOpenAI(
                model=model_id,
                api_key=openai_key,
                streaming=True,
                **sampling_kwargs,
            )
        elif provider == "anthropic":
            from langchain_anthropic import ChatAnthropic
            anthropic_key = get_api_key("anthropic")
            if not anthropic_key:
                return None
            llm = ChatAnthropic(
                model=model_id,
                api_key=anthropic_key,
                streaming=True,
                **sampling_kwargs,
            )
        elif provider == "openrouter":
            from langchain_openai import ChatOpenAI
            from app.core.config import OPENROUTER_BASE_URL
            openrouter_key = get_api_key("openrouter")
            if not openrouter_key:
                return None
            llm = ChatOpenAI(
                model=model_id,
                api_key=openrouter_key,
                base_url=OPENROUTER_BASE_URL,
                streaming=True,
                default_headers={
                    "HTTP-Referer": "https://nbharathik.github.io/ifc-atlas/",
                    "X-Title": "IFC Atlas",
                },
                **sampling_kwargs,
            )
        else:
            return None

        # LangGraph 1.0+ ships create_agent in langchain.agents
        try:
            from langchain.agents import create_agent
            graph = create_agent(
                model=llm,
                tools=lc_tools,
                system_prompt=system_prompt or None,
            )
        except (ImportError, TypeError):
            # Fallback: deprecated langgraph.prebuilt.create_react_agent
            from langgraph.prebuilt import create_react_agent  # type: ignore[attr-defined]
            graph = create_react_agent(
                model=llm,
                tools=lc_tools,
                prompt=system_prompt or None,
            )

        return graph

    except ModuleNotFoundError as exc:
        logger.warning(
            "LangChain provider package missing for provider=%s (%s). "
            "Install backend requirements to enable streaming agent tools.",
            provider,
            exc.name,
        )
        return None
    except Exception:
        logger.exception("build_streaming_agent failed for provider=%s", provider)
        return None
