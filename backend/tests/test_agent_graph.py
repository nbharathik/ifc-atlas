"""Tests for the LangGraph IFC agent graph.

Pure unit tests: no IfcOpenShell, no real LLM calls, no network.
Covers:
  - IFCAgentState TypedDict validation
  - StateGraph compilation
  - MemorySaver checkpoint round-trip (save + load)
  - GraphManager public API (save_turn, load_thread, delete_thread)
  - State append semantics (messages accumulate across turns)
  - Graceful degradation when thread has no checkpoint
  - Helper functions in agent_graph_nodes
"""

from __future__ import annotations

import pytest
from unittest.mock import patch


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def fresh_manager():
    """Return a GraphManager with a fresh MemorySaver (isolated per test)."""
    from langgraph.graph import StateGraph, END
    from langgraph.checkpoint.memory import MemorySaver
    from app.services.agent_graph import GraphManager
    from app.services.agent_graph_nodes import IFCAgentState

    def _noop(state: IFCAgentState) -> dict:
        return {}

    saver = MemorySaver()
    builder = StateGraph(IFCAgentState)
    builder.add_node("agent", _noop)
    builder.set_entry_point("agent")
    builder.add_edge("agent", END)
    compiled = builder.compile(checkpointer=saver)
    return GraphManager(compiled)


# ---------------------------------------------------------------------------
# IFCAgentState schema
# ---------------------------------------------------------------------------

def test_state_required_keys():
    from app.services.agent_graph_nodes import IFCAgentState
    keys = set(IFCAgentState.__annotations__.keys())
    assert "messages" in keys
    assert "thread_id" in keys
    assert "pending_edit" in keys
    assert "provider" in keys
    assert "turn_events" in keys


def test_make_initial_state_defaults():
    from app.services.agent_graph_nodes import _make_initial_state
    state = _make_initial_state("t-001")
    assert state["thread_id"] == "t-001"
    assert state["messages"] == []
    assert state["pending_edit"] is None
    assert state["session_summary"] == ""
    assert state["provider"] == "openai"
    assert state["model_id"] == "gpt-4o"


def test_make_initial_state_custom():
    from app.services.agent_graph_nodes import _make_initial_state
    state = _make_initial_state("t-002", provider="anthropic", model_id="claude-opus-4-7")
    assert state["provider"] == "anthropic"
    assert state["model_id"] == "claude-opus-4-7"


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def test_extract_final_text_from_chunks():
    from app.services.agent_graph_nodes import extract_final_text
    events = [
        {"type": "chunk", "content": "Hello "},
        {"type": "tool_call", "name": "get_project_info"},
        {"type": "chunk", "content": "world"},
    ]
    assert extract_final_text(events) == "Hello world"


def test_extract_final_text_empty():
    from app.services.agent_graph_nodes import extract_final_text
    assert extract_final_text([]) == ""
    assert extract_final_text([{"type": "tool_call", "name": "foo"}]) == ""


def test_build_user_turn_messages():
    from app.services.agent_graph_nodes import build_user_turn_messages
    history = [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello"}]
    msgs = build_user_turn_messages("What walls are on floor 2?", history)
    assert msgs[-1] == {"role": "user", "content": "What walls are on floor 2?"}
    assert len(msgs) == 3


def test_append_assistant_turn_with_text():
    from app.services.agent_graph_nodes import append_assistant_turn
    events = [{"type": "chunk", "content": "There are 5 walls."}]
    tcs = [{"name": "search_elements", "result": '{"count":5}'}]
    new_msgs = append_assistant_turn(events, tcs)
    assert new_msgs[0] == {"role": "assistant", "content": "There are 5 walls."}
    assert new_msgs[1]["role"] == "tool"
    assert new_msgs[1]["name"] == "search_elements"


def test_append_assistant_turn_no_text():
    from app.services.agent_graph_nodes import append_assistant_turn
    new_msgs = append_assistant_turn([], [])
    assert new_msgs == []


# ---------------------------------------------------------------------------
# GraphManager checkpoint round-trip
# ---------------------------------------------------------------------------

def test_load_unknown_thread_returns_none(fresh_manager):
    assert fresh_manager.load_thread("no-such-thread") is None


def test_save_and_load_thread(fresh_manager):
    msgs = [
        {"role": "user", "content": "How many walls?"},
        {"role": "assistant", "content": "There are 3 walls."},
    ]
    fresh_manager.save_turn("thread-A", messages=msgs)
    state = fresh_manager.load_thread("thread-A")
    assert state is not None
    assert state["thread_id"] == "thread-A"
    assert len(state["messages"]) == 2
    assert state["messages"][0]["content"] == "How many walls?"


def test_checkpoint_accumulates_across_turns(fresh_manager):
    turn1 = [
        {"role": "user", "content": "Turn 1 question"},
        {"role": "assistant", "content": "Turn 1 answer"},
    ]
    fresh_manager.save_turn("thread-B", messages=turn1)

    turn2 = turn1 + [
        {"role": "user", "content": "Turn 2 question"},
        {"role": "assistant", "content": "Turn 2 answer"},
    ]
    fresh_manager.save_turn("thread-B", messages=turn2)

    state = fresh_manager.load_thread("thread-B")
    # After two saves the messages list should not double-count turn1
    assert len(state["messages"]) == 4


def test_save_pending_edit(fresh_manager):
    edit = {"action": "pending_edit", "edit_id": "e-001", "description": "rename wall"}
    fresh_manager.save_turn("thread-C", messages=[], pending_edit=edit)
    state = fresh_manager.load_thread("thread-C")
    assert state["pending_edit"] == edit


def test_delete_thread(fresh_manager):
    fresh_manager.save_turn("thread-E", messages=[{"role": "user", "content": "test"}])
    assert fresh_manager.load_thread("thread-E") is not None
    fresh_manager.delete_thread("thread-E")
    # After delete via MemorySaver.delete_thread the checkpoint is gone
    state = fresh_manager.load_thread("thread-E")
    assert state is None


# ---------------------------------------------------------------------------
# GraphManager.available flag
# ---------------------------------------------------------------------------

def test_manager_unavailable_returns_none():
    from app.services.agent_graph import GraphManager
    mgr = GraphManager(None)
    assert not mgr.available
    assert mgr.load_thread("x") is None
    # save_turn is a no-op - should not raise
    mgr.save_turn("x", messages=[])
    mgr.delete_thread("x")
    assert mgr.list_threads() == []


# ---------------------------------------------------------------------------
# Global singleton sanity
# ---------------------------------------------------------------------------

def test_global_graph_manager_is_available():
    from app.services.agent_graph import graph_manager
    # langgraph is installed in this environment
    assert graph_manager.available


def test_global_graph_manager_roundtrip():
    from app.services.agent_graph import graph_manager
    tid = "global-test-thread-001"
    msgs = [{"role": "user", "content": "ping"}, {"role": "assistant", "content": "pong"}]
    graph_manager.save_turn(tid, messages=msgs)
    state = graph_manager.load_thread(tid)
    assert state is not None
    assert any(m["content"] == "ping" for m in state["messages"])
    # Cleanup
    graph_manager.delete_thread(tid)


# ---------------------------------------------------------------------------
# make_langchain_tools + build_streaming_agent
# ---------------------------------------------------------------------------

def test_make_langchain_tools_returns_list():
    """make_langchain_tools returns a non-empty list of LangChain tools."""
    from app.services.agent_graph_nodes import make_langchain_tools
    tools = make_langchain_tools(allowed_tools=None, tool_executor_fn=None)
    assert isinstance(tools, list)
    assert len(tools) > 0


def test_make_langchain_tools_all_have_name_and_description():
    """Every returned tool has a non-empty name and description."""
    from app.services.agent_graph_nodes import make_langchain_tools
    tools = make_langchain_tools(allowed_tools=None, tool_executor_fn=None)
    for t in tools:
        assert t.name, f"tool missing name: {t}"
        assert t.description, f"tool '{t.name}' missing description"


def test_make_langchain_tools_allowed_filter():
    """Only tools in allowed_tools frozenset are returned."""
    from app.services.agent_graph_nodes import make_langchain_tools
    allowed = frozenset({"get_project_info", "search_elements"})
    tools = make_langchain_tools(allowed_tools=allowed, tool_executor_fn=None)
    names = {t.name for t in tools}
    assert names == allowed


def test_make_langchain_tools_empty_allowed_returns_empty():
    """Empty frozenset returns no tools (strict filter)."""
    from app.services.agent_graph_nodes import make_langchain_tools
    tools = make_langchain_tools(allowed_tools=frozenset(), tool_executor_fn=None)
    assert tools == []


def test_make_langchain_tools_no_args_tool_has_schema():
    """Zero-parameter tools still have an args_schema (empty Pydantic model)."""
    from app.services.agent_graph_nodes import make_langchain_tools
    tools = make_langchain_tools(
        allowed_tools=frozenset({"get_project_info"}),
        tool_executor_fn=None,
    )
    assert len(tools) == 1
    assert tools[0].args_schema is not None


def test_make_langchain_tools_parametric_tool_schema_fields():
    """search_elements tool schema exposes 'query' as a required field."""
    from app.services.agent_graph_nodes import make_langchain_tools
    tools = make_langchain_tools(
        allowed_tools=frozenset({"search_elements"}),
        tool_executor_fn=None,
    )
    assert len(tools) == 1
    schema = tools[0].args_schema
    assert schema is not None
    fields = schema.model_fields
    assert "query" in fields


@pytest.mark.asyncio
async def test_make_langchain_tools_calls_executor():
    """Tool coroutine calls tool_executor_fn with correct name and args."""
    from app.services.agent_graph_nodes import make_langchain_tools

    calls = []

    async def mock_executor(name: str, args: dict) -> dict:
        calls.append((name, args))
        return {"result": "ok"}

    tools = make_langchain_tools(
        allowed_tools=frozenset({"search_elements"}),
        tool_executor_fn=mock_executor,
    )
    tool = tools[0]
    result = await tool.coroutine(query="walls")
    assert calls == [("search_elements", {"query": "walls"})]
    import json
    parsed = json.loads(result)
    assert parsed["result"] == "ok"


@pytest.mark.asyncio
async def test_make_langchain_tools_no_executor_falls_back_to_execute_tool():
    """Without executor, tool coroutine calls synchronous execute_tool."""
    from app.services.agent_graph_nodes import make_langchain_tools
    import json

    with patch("app.services.tools.execute_tool", return_value={"project_name": "TestProj"}):
        tools = make_langchain_tools(
            allowed_tools=frozenset({"get_project_info"}),
            tool_executor_fn=None,
        )
        result = await tools[0].coroutine()
    parsed = json.loads(result)
    assert parsed["project_name"] == "TestProj"


def test_build_streaming_agent_returns_none_for_unknown_provider():
    """build_streaming_agent returns None for unsupported providers."""
    from app.services.agent_graph import build_streaming_agent
    from app.services.agent_graph_nodes import make_langchain_tools
    tools = make_langchain_tools(frozenset({"get_project_info"}), None)
    graph = build_streaming_agent("gemini", "gemini-1.5", tools, "sys", 0.3)
    assert graph is None


def test_build_streaming_agent_openai_returns_compiled_graph():
    """build_streaming_agent returns a compiled graph for openai when key set."""
    from app.services.agent_graph import build_streaming_agent
    from app.services.agent_graph_nodes import make_langchain_tools
    from unittest.mock import patch

    tools = make_langchain_tools(frozenset({"get_project_info"}), None)
    with patch("app.services.secrets_service.get_api_key", return_value="fake-key-for-test"):
        graph = build_streaming_agent("openai", "gpt-4o", tools, "You are a BIM assistant.", 0.3)
    # Graph should be non-None (compiled CompiledStateGraph)
    assert graph is not None
    assert hasattr(graph, "astream_events")


# ---------------------------------------------------------------------------
# Edge cases for build_streaming_agent + stream_via_langgraph
# ---------------------------------------------------------------------------

def test_build_streaming_agent_empty_tools_returns_none():
    """build_streaming_agent returns None when lc_tools is empty.

    ReAct with no tools is pure overhead - callers should use the simpler
    streaming path (stream_openai / stream_anthropic) instead.
    """
    from app.services.agent_graph import build_streaming_agent

    graph = build_streaming_agent("openai", "gpt-4o", [], "sys", 0.3)
    assert graph is None


def test_build_streaming_agent_missing_api_key_returns_none():
    """build_streaming_agent returns None when the API key is absent."""
    from app.services.agent_graph import build_streaming_agent
    from app.services.agent_graph_nodes import make_langchain_tools

    tools = make_langchain_tools(frozenset({"get_project_info"}), None)
    with patch("app.services.secrets_service.get_api_key", return_value=""):
        graph = build_streaming_agent("openai", "gpt-4o", tools, "sys", 0.3)
    assert graph is None


@pytest.mark.asyncio
async def test_stream_via_langgraph_falls_back_when_graph_none():
    """stream_via_langgraph falls back to stream_openai when graph=None.

    build_streaming_agent is imported locally inside stream_via_langgraph, so
    we must patch the *source* module (app.services.agent_graph), not the caller.
    """
    from app.services.llm_service import stream_via_langgraph

    fallback_events = [{"type": "chunk", "content": "hello from fallback"}]

    async def _fake_stream_openai(*args, **kwargs):
        for ev in fallback_events:
            yield ev

    # Patch in the source module where build_streaming_agent lives
    with patch("app.services.agent_graph.build_streaming_agent", return_value=None), \
         patch("app.services.llm_service.stream_openai", side_effect=_fake_stream_openai):
        events = []
        async for ev in stream_via_langgraph(
            message="hi",
            history=[],
            provider="openai",
            model="gpt-4o",
            temperature=0.3,
            tool_executor=None,
            system_prompt="sys",
            allowed_tools=None,
            attachments=None,
        ):
            events.append(ev)

    assert events == fallback_events


@pytest.mark.asyncio
async def test_stream_via_langgraph_yields_error_on_mid_stream_failure():
    """After yielding content, a graph exception emits error event, not restart."""
    from app.services.llm_service import stream_via_langgraph
    from unittest.mock import MagicMock

    # Mock graph that yields one chunk then raises
    async def _bad_astream(*args, **kwargs):
        yield {"event": "on_chat_model_stream", "data": {
            "chunk": MagicMock(content="partial answer")
        }}
        raise RuntimeError("network failure mid-stream")

    mock_graph = MagicMock()
    mock_graph.astream_events = _bad_astream

    # Patch in the source module (local import pattern)
    with patch("app.services.agent_graph.build_streaming_agent", return_value=mock_graph):
        events = []
        async for ev in stream_via_langgraph(
            message="hi",
            history=[],
            provider="openai",
            model="gpt-4o",
            temperature=0.3,
            tool_executor=None,
            system_prompt="sys",
            allowed_tools=None,
            attachments=None,
        ):
            events.append(ev)

    types = [e["type"] for e in events]
    assert "chunk" in types, "should have emitted the partial chunk"
    assert "error" in types, "should emit error after mid-stream failure"
    # Must NOT restart streaming (no second chunk from the fallback path)
    chunk_events = [e for e in events if e["type"] == "chunk"]
    assert len(chunk_events) == 1, "only the one partial chunk should be present"


@pytest.mark.asyncio
async def test_stream_via_langgraph_fallback_failure_yields_error_event():
    """An unrecoverable raw-streamer failure (non-param 400, 429, auth,
    network) surfaces as a clean in-band error event instead of escaping as
    a raw exception that the WS envelope stringifies over the whole turn."""
    from app.services.llm_service import stream_via_langgraph

    async def _exploding_stream_openai(*args, **kwargs):
        raise RuntimeError("Error code: 400 - {'error': {'message': 'boom'}}")
        yield  # pragma: no cover - makes this an async generator

    with patch("app.services.agent_graph.build_streaming_agent", return_value=None), \
         patch("app.services.llm_service.stream_openai", side_effect=_exploding_stream_openai):
        events = []
        async for ev in stream_via_langgraph(
            message="hi",
            history=[],
            provider="openai",
            model="gpt-5.5",
            temperature=0.2,
            tool_executor=None,
            system_prompt="sys",
            allowed_tools=None,
            attachments=None,
        ):
            events.append(ev)

    assert events, "the failure must surface as an event, not an exception"
    assert events[-1]["type"] == "error"
    assert "request failed" in events[-1]["message"]


@pytest.mark.asyncio
async def test_stream_via_langgraph_recursion_limit_raised_and_messaged():
    """The graph runs with a raised recursion_limit, and hitting it mid-stream
    emits the specific tool-call-limit error message (not the generic one).

    High-effort reasoning models (gpt-5.x) chain more tool rounds than
    LangGraph's default 25-superstep limit allows; the resulting
    GraphRecursionError used to surface only as a console traceback while the
    chat turn silently truncated.
    """
    from app.services.llm_service import stream_via_langgraph
    from langgraph.errors import GraphRecursionError
    from unittest.mock import MagicMock

    seen_config: dict = {}

    async def _recursion_astream(*args, **kwargs):
        seen_config.update(kwargs.get("config") or {})
        yield {"event": "on_chat_model_stream", "data": {
            "chunk": MagicMock(content="partial answer")
        }}
        raise GraphRecursionError("Recursion limit of 25 reached")

    mock_graph = MagicMock()
    mock_graph.astream_events = _recursion_astream

    with patch("app.services.agent_graph.build_streaming_agent", return_value=mock_graph):
        events = []
        async for ev in stream_via_langgraph(
            message="hi",
            history=[],
            provider="openai",
            model="gpt-5.5",
            temperature=0.2,
            tool_executor=None,
            system_prompt="sys",
            allowed_tools=None,
            attachments=None,
        ):
            events.append(ev)

    errors = [e for e in events if e["type"] == "error"]
    assert errors, "GraphRecursionError mid-stream must emit an error event"
    assert "tool-call limit" in errors[0]["message"]
    assert seen_config.get("recursion_limit", 0) >= 50, (
        "astream_events must run with a raised recursion_limit"
    )


def test_friendly_provider_error_classification():
    """Quota/billing/auth/rate-limit/connectivity errors classify; bugs don't.

    The classifier is import-free (reads status/code/text) so one helper covers
    both the OpenAI and Anthropic SDK exception hierarchies.
    """
    from app.services.llm_service import _friendly_provider_error

    # OpenAI 429 insufficient_quota.
    quota = RuntimeError(
        "Error code: 429 - {'error': {'message': 'You exceeded your current "
        "quota', 'type': 'insufficient_quota', 'code': 'insufficient_quota'}}"
    )
    msg = _friendly_provider_error("openai", quota)
    assert msg and ("credit" in msg.lower() or "quota" in msg.lower())
    assert "OpenAI" in msg

    # Anthropic 400 low credit balance.
    credit = RuntimeError(
        "Error code: 400 - {'type': 'error', 'error': {'message': 'Your credit "
        "balance is too low to access the Anthropic API.'}}"
    )
    assert _friendly_provider_error("anthropic", credit)

    # Bad key (status_code attribute present, OpenAI/Anthropic style).
    auth = RuntimeError("invalid api key")
    assert _friendly_provider_error("openai", auth)

    # A genuine code bug must NOT be swallowed - keep the traceback.
    assert _friendly_provider_error("openai", RuntimeError("some weird bug")) is None
    assert _friendly_provider_error("openai", KeyError("messages")) is None


@pytest.mark.asyncio
async def test_stream_via_langgraph_quota_error_short_circuits_fallback():
    """A recognised quota/billing error surfaces a clean, actionable message
    and does NOT re-hit the provider via the raw fallback (which would fail
    identically and spam a second traceback into the console)."""
    from app.services.llm_service import stream_via_langgraph
    from unittest.mock import MagicMock

    async def _quota_astream(*args, **kwargs):
        raise RuntimeError(
            "Error code: 429 - {'error': {'message': 'You exceeded your current "
            "quota', 'type': 'insufficient_quota', 'code': 'insufficient_quota'}}"
        )
        yield  # pragma: no cover - makes this an async generator

    mock_graph = MagicMock()
    mock_graph.astream_events = _quota_astream

    fallback_called = False

    async def _fallback_openai(*args, **kwargs):
        nonlocal fallback_called
        fallback_called = True
        yield {"type": "chunk", "content": "should not happen"}

    with patch("app.services.agent_graph.build_streaming_agent", return_value=mock_graph), \
         patch("app.services.llm_service.stream_openai", side_effect=_fallback_openai):
        events = []
        async for ev in stream_via_langgraph(
            message="hi",
            history=[],
            provider="openai",
            model="gpt-4o",
            temperature=0.3,
            tool_executor=None,
            system_prompt="sys",
            allowed_tools=None,
            attachments=None,
        ):
            events.append(ev)

    assert not fallback_called, "a quota error must not re-hit the provider"
    assert events and events[-1]["type"] == "error"
    msg = events[-1]["message"].lower()
    assert "credit" in msg or "quota" in msg
    # The clean message must NOT be the raw 'request failed: ...' blob.
    assert "request failed" not in msg


@pytest.mark.asyncio
async def test_stream_via_langgraph_unknown_provider_yields_error_chunk():
    """Unknown provider that also fails graph build → error message yielded."""
    from app.services.llm_service import stream_via_langgraph

    with patch("app.services.agent_graph.build_streaming_agent", return_value=None):
        events = []
        async for ev in stream_via_langgraph(
            message="hi",
            history=[],
            provider="unknown-llm",
            model="x",
            temperature=0.3,
            tool_executor=None,
            system_prompt="sys",
            allowed_tools=None,
            attachments=None,
        ):
            events.append(ev)

    assert len(events) == 1
    assert events[0]["type"] == "chunk"
    assert "Unknown provider" in events[0]["content"]


@pytest.mark.asyncio
async def test_stream_chat_routes_openai_through_langgraph():
    """stream_chat routes openai provider through stream_via_langgraph.

    stream_via_langgraph is called with positional + keyword args from stream_chat,
    so we capture *args in the spy and check the third positional arg (provider).
    """
    from app.services.llm_service import stream_chat

    captured: list[tuple] = []  # (args, kwargs)

    async def _spy(*args, **kwargs):
        captured.append((args, kwargs))
        yield {"type": "chunk", "content": "ok"}

    with patch("app.services.llm_service.stream_via_langgraph", side_effect=_spy):
        events = []
        async for ev in stream_chat(
            message="hello",
            history=[],
            provider="openai",
            model="gpt-4o",
        ):
            events.append(ev)

    assert captured, "stream_via_langgraph must have been called"
    # provider is the 3rd positional arg (index 2)
    args, _kw = captured[0]
    assert args[2] == "openai"
    assert any(e["type"] == "chunk" for e in events)


@pytest.mark.asyncio
async def test_stream_via_langgraph_tool_result_from_toolmessage():
    """Regression test for tool results delivered as a ToolMessage.

    Under LangChain 1.x, ``on_tool_end`` delivers ``data['output']`` as a
    ``ToolMessage`` (not a str). The old handler called ``json.dumps`` on it,
    which raised ``TypeError`` and - because ``on_tool_start`` already set
    ``_yielded_any`` - emitted a truncation *error* event instead of the tool
    result. This builds the real ``create_agent`` graph with a fake
    tool-calling model (no live LLM, no IFC load) and asserts a ``tool_result``
    is emitted and no ``error`` event appears.
    """
    import json
    from langchain.agents import create_agent
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
    from langchain_core.tools import tool as tool_dec

    from app.services.llm_service import stream_via_langgraph

    @tool_dec
    def echo(x: int) -> str:
        """Echo a number back as a JSON string (mimics the app's tool coroutines)."""
        return json.dumps({"ok": True, "x": x})

    class FakeToolModel(BaseChatModel):
        """Replays a scripted tool-call then a final answer; ignores bind_tools."""
        step: int = 0

        @property
        def _llm_type(self) -> str:
            return "fake-tool-model"

        def bind_tools(self, tools, **kwargs):
            return self

        def _script(self) -> AIMessage:
            if self.step == 0:
                self.step = 1
                return AIMessage(
                    content="",
                    tool_calls=[{"name": "echo", "args": {"x": 5},
                                 "id": "call_1", "type": "tool_call"}],
                )
            return AIMessage(content="done")

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            return ChatResult(generations=[ChatGeneration(message=self._script())])

        async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
            return ChatResult(generations=[ChatGeneration(message=self._script())])

    graph = create_agent(model=FakeToolModel(), tools=[echo])

    with patch("app.services.agent_graph.build_streaming_agent", return_value=graph), \
         patch("app.services.agent_graph_nodes.make_langchain_tools", return_value=[echo]):
        events = []
        async for ev in stream_via_langgraph(
            message="hi",
            history=[],
            provider="openai",
            model="gpt-4o",
            temperature=0.3,
            tool_executor=None,
            system_prompt="sys",
            allowed_tools=None,
            attachments=None,
        ):
            events.append(ev)

    types = [e["type"] for e in events]
    assert "tool_result" in types, f"expected a tool_result event, got {types}"
    assert "error" not in types, f"regression: tool turn errored out: {types}"
    tool_result = next(e for e in events if e["type"] == "tool_result")
    assert "ok" in str(tool_result["result"])
