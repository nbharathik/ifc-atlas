"""Non-streaming provider fallback on the LangGraph path.

Several models proxied through OpenRouter do NOT stream token deltas, so
`on_chat_model_stream` never fires and the turn looked frozen ("the model
isn't generating / it's stuck"). The graph handler now emits the final
message text on `on_chat_model_end` when a round streamed nothing - without
double-emitting streamed models. Mock style mirrors test_stream_retry.py.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services import llm_service
from app.services.llm_service import stream_via_langgraph


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch):
    monkeypatch.setattr(llm_service, "_STREAM_RETRY_BACKOFF_S", 0)


async def _collect(agen):
    return [ev async for ev in agen]


def _run():
    return stream_via_langgraph(
        message="hi", history=[], provider="openrouter", model="deepseek/deepseek-v3.2",
        temperature=0.3, tool_executor=None, system_prompt="sys",
        allowed_tools=None, attachments=None,
    )


def _end_event(text: str, content_list=None):
    content = content_list if content_list is not None else text
    msg = SimpleNamespace(content=content, usage_metadata={"input_tokens": 10, "output_tokens": 5})
    return {"event": "on_chat_model_end", "data": {"output": msg}}


@pytest.mark.asyncio
async def test_nonstreaming_model_final_text_is_emitted():
    """No on_chat_model_stream, only on_chat_model_end with text → text shown."""
    async def _astream(*a, **k):
        yield {"event": "on_chat_model_start", "data": {}}
        yield _end_event("The model has 12 walls.")

    graph = MagicMock()
    graph.astream_events = _astream
    with patch("app.services.agent_graph.build_streaming_agent", return_value=graph):
        events = await _collect(_run())

    chunks = [e for e in events if e["type"] == "chunk"]
    assert chunks, "non-streaming final text must be emitted"
    assert "".join(c["content"] for c in chunks) == "The model has 12 walls."


@pytest.mark.asyncio
async def test_streamed_model_text_not_double_emitted():
    """Streaming model: text arrives via on_chat_model_stream; the model_end
    fallback must NOT re-emit it."""
    async def _astream(*a, **k):
        yield {"event": "on_chat_model_start", "data": {}}
        yield {"event": "on_chat_model_stream", "data": {"chunk": MagicMock(content="Hello ")}}
        yield {"event": "on_chat_model_stream", "data": {"chunk": MagicMock(content="world")}}
        yield _end_event("Hello world")

    graph = MagicMock()
    graph.astream_events = _astream
    with patch("app.services.agent_graph.build_streaming_agent", return_value=graph):
        events = await _collect(_run())

    text = "".join(e["content"] for e in events if e["type"] == "chunk")
    assert text == "Hello world", "streamed text must appear exactly once"


@pytest.mark.asyncio
async def test_nonstreaming_handles_anthropic_style_block_content():
    """A final message whose content is a list of blocks still yields text."""
    async def _astream(*a, **k):
        yield {"event": "on_chat_model_start", "data": {}}
        yield _end_event("", content_list=[{"type": "text", "text": "Done."}])

    graph = MagicMock()
    graph.astream_events = _astream
    with patch("app.services.agent_graph.build_streaming_agent", return_value=graph):
        events = await _collect(_run())

    assert any(e["type"] == "chunk" and e["content"] == "Done." for e in events)


@pytest.mark.asyncio
async def test_per_round_reset_multi_round_mixed():
    """Round 1 streams text (no re-emit); round 2 does not (emit its final)."""
    async def _astream(*a, **k):
        # round 1: streamed
        yield {"event": "on_chat_model_start", "data": {}}
        yield {"event": "on_chat_model_stream", "data": {"chunk": MagicMock(content="streamed1")}}
        yield _end_event("streamed1")
        # round 2: not streamed
        yield {"event": "on_chat_model_start", "data": {}}
        yield _end_event("final2")

    graph = MagicMock()
    graph.astream_events = _astream
    with patch("app.services.agent_graph.build_streaming_agent", return_value=graph):
        events = await _collect(_run())

    text = "".join(e["content"] for e in events if e["type"] == "chunk")
    assert text == "streamed1final2"
