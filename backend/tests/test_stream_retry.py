"""Stream retry - one automatic retry for transient provider stream failures.

A mid-stream connection reset / provider 5xx / incomplete stream used to kill
the whole chat turn (in-band error, no second attempt). stream_via_langgraph
and its raw fallback now retry ONCE with the same messages after a short
backoff; a second failure takes the pre-existing in-band error path. Follows
the mocking style of test_agent_graph.py (patch build_streaming_agent in its
source module, fake astream_events).
"""

from unittest.mock import MagicMock, patch

import pytest

from app.services import llm_service
from app.services.llm_service import _is_transient_stream_error, stream_via_langgraph


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch):
    """Zero the retry backoff so tests don't sleep."""
    monkeypatch.setattr(llm_service, "_STREAM_RETRY_BACKOFF_S", 0)


async def _collect(agen):
    events = []
    async for ev in agen:
        events.append(ev)
    return events


def _run_langgraph(mock_graph):
    return stream_via_langgraph(
        message="hi",
        history=[],
        provider="openai",
        model="gpt-4o",
        temperature=0.3,
        tool_executor=None,
        system_prompt="sys",
        allowed_tools=None,
        attachments=None,
    )


# ── classifier ───────────────────────────────────────────────────────────────

def test_transient_classifier_accepts_resets_5xx_incomplete():
    assert _is_transient_stream_error(ConnectionError("Connection reset by peer"))
    assert _is_transient_stream_error(RuntimeError("peer closed connection without sending complete message body (incomplete chunked read)"))
    assert _is_transient_stream_error(RuntimeError("Server disconnected without sending a response."))
    exc = RuntimeError("Internal server error")
    exc.status_code = 503
    assert _is_transient_stream_error(exc)
    assert _is_transient_stream_error(RuntimeError("Anthropic is overloaded, please retry"))


def test_transient_classifier_rejects_quota_auth_and_bugs():
    # Quota / rate-limit / auth failures must NOT be auto-retried.
    assert not _is_transient_stream_error(RuntimeError(
        "Error code: 429 - {'error': {'message': 'You exceeded your current "
        "quota', 'code': 'insufficient_quota'}}"
    ))
    assert not _is_transient_stream_error(RuntimeError("invalid api key"))
    # Genuine code bugs are not transient either.
    assert not _is_transient_stream_error(RuntimeError("some weird bug"))
    assert not _is_transient_stream_error(KeyError("messages"))
    assert not _is_transient_stream_error(RuntimeError("Recursion limit of 25 reached"))


# ── graph path ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_pre_stream_transient_retries_silently_then_succeeds():
    """A transient failure before any content: one silent retry, no error,
    no notice chunk polluting the answer."""
    calls = {"n": 0}

    async def _flaky_astream(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("Connection reset by peer")
        yield {"event": "on_chat_model_stream", "data": {
            "chunk": MagicMock(content="hello")
        }}

    mock_graph = MagicMock()
    mock_graph.astream_events = _flaky_astream

    with patch("app.services.agent_graph.build_streaming_agent", return_value=mock_graph):
        events = await _collect(_run_langgraph(mock_graph))

    assert calls["n"] == 2, "exactly one retry"
    assert [e["type"] for e in events] == ["chunk"]
    assert events[0]["content"] == "hello"


@pytest.mark.asyncio
async def test_mid_stream_transient_retries_with_notice():
    """A transient failure after content was sent: retry once, with an
    in-band notice chunk so the user understands the restart."""
    calls = {"n": 0}

    async def _flaky_astream(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            yield {"event": "on_chat_model_stream", "data": {
                "chunk": MagicMock(content="partial ")
            }}
            raise ConnectionError("Connection reset by peer")
        yield {"event": "on_chat_model_stream", "data": {
            "chunk": MagicMock(content="full answer")
        }}

    mock_graph = MagicMock()
    mock_graph.astream_events = _flaky_astream

    with patch("app.services.agent_graph.build_streaming_agent", return_value=mock_graph):
        events = await _collect(_run_langgraph(mock_graph))

    assert calls["n"] == 2
    assert [e["type"] for e in events] == ["chunk", "chunk", "chunk"]
    assert events[0]["content"] == "partial "
    assert "retrying" in events[1]["content"], "notice chunk between attempts"
    assert events[2]["content"] == "full answer"
    assert not [e for e in events if e["type"] == "error"]


@pytest.mark.asyncio
async def test_second_transient_failure_takes_error_path():
    """Retry budget is ONE: a second transient failure emits the existing
    in-band error event (friendly connectivity message) - no infinite loop."""
    calls = {"n": 0}

    async def _always_failing(*args, **kwargs):
        calls["n"] += 1
        yield {"event": "on_chat_model_stream", "data": {
            "chunk": MagicMock(content="partial ")
        }}
        raise ConnectionError("Connection reset by peer")

    mock_graph = MagicMock()
    mock_graph.astream_events = _always_failing

    with patch("app.services.agent_graph.build_streaming_agent", return_value=mock_graph):
        events = await _collect(_run_langgraph(mock_graph))

    assert calls["n"] == 2, "one retry, then give up"
    assert events[-1]["type"] == "error"
    assert "connection" in events[-1]["message"].lower()


@pytest.mark.asyncio
async def test_non_transient_mid_stream_failure_not_retried():
    """A genuine bug mid-stream keeps the old behaviour: no retry, in-band
    error immediately (pins the pre-existing contract alongside the retry)."""
    calls = {"n": 0}

    async def _bug_astream(*args, **kwargs):
        calls["n"] += 1
        yield {"event": "on_chat_model_stream", "data": {
            "chunk": MagicMock(content="partial")
        }}
        raise RuntimeError("some weird bug")

    mock_graph = MagicMock()
    mock_graph.astream_events = _bug_astream

    with patch("app.services.agent_graph.build_streaming_agent", return_value=mock_graph):
        events = await _collect(_run_langgraph(mock_graph))

    assert calls["n"] == 1, "non-transient failures must not be retried"
    assert events[-1]["type"] == "error"


# ── raw fallback path ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_fallback_streamer_transient_failure_retries_once():
    """graph=None routes through the raw streamer; a transient failure there
    also gets exactly one retry before the in-band error conversion."""
    calls = {"n": 0}

    async def _flaky_openai(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("Connection reset by peer")
        yield {"type": "chunk", "content": "recovered"}

    with patch("app.services.agent_graph.build_streaming_agent", return_value=None), \
         patch("app.services.llm_service.stream_openai", side_effect=_flaky_openai):
        events = await _collect(_run_langgraph(None))

    assert calls["n"] == 2
    assert events[-1] == {"type": "chunk", "content": "recovered"}
    assert not [e for e in events if e["type"] == "error"]


@pytest.mark.asyncio
async def test_fallback_streamer_second_failure_yields_error():
    calls = {"n": 0}

    async def _always_failing_openai(*args, **kwargs):
        calls["n"] += 1
        raise ConnectionError("Connection reset by peer")
        yield  # pragma: no cover - makes this an async generator

    with patch("app.services.agent_graph.build_streaming_agent", return_value=None), \
         patch("app.services.llm_service.stream_openai", side_effect=_always_failing_openai):
        events = await _collect(_run_langgraph(None))

    assert calls["n"] == 2
    assert events and events[-1]["type"] == "error"
