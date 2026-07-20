"""WS-level coverage for /api/chat/ws event forwarding.

The chat_loop in chat_routes.py re-emits a fixed whitelist of stream_chat
event types to the browser. These tests pin the contract for the types that
used to be silently dropped (error / model_fallback / budget_warning), the
post-done checkpoint isolation, and the mid-stream disconnect abort, using
TestClient websockets with stream_chat mocked - no real LLM or IFC work.
"""

import asyncio
import logging
import threading
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app


def _client() -> TestClient:
    return TestClient(app, raise_server_exceptions=False)


def _events_stream(events):
    """Build a stream_chat stand-in yielding the given events."""

    async def _fake_stream_chat(*args, **kwargs):
        for ev in events:
            yield ev

    return _fake_stream_chat


def _drain_until_done(ws) -> list[dict]:
    """Receive frames until the turn's terminal 'done' arrives."""
    frames = []
    while True:
        frame = ws.receive_json()
        frames.append(frame)
        if frame.get("type") == "done":
            return frames


def test_error_event_forwarded_with_content_key():
    """In-band stream errors reach the client, normalised to 'content'.

    llm_service emits {"type": "error", "message": ...} (e.g. the mid-stream
    'Agent stream interrupted' marker); the frontend reads data.content. The
    forwarding layer must bridge the key, and the turn must still terminate
    with 'done' carrying the partial text.
    """
    fake = _events_stream([
        {"type": "chunk", "content": "partial "},
        {"type": "error", "message": "Agent stream interrupted; response may be incomplete."},
    ])
    with patch("app.api.chat_routes.stream_chat", side_effect=fake):
        with _client().websocket_connect("/api/chat/ws") as ws:
            ws.send_json({"message": "hi", "provider": "openai", "model": "gpt-5.5"})
            frames = _drain_until_done(ws)

    errors = [f for f in frames if f["type"] == "error"]
    assert errors, "the in-band error event must be forwarded to the client"
    assert errors[0]["content"] == (
        "Agent stream interrupted; response may be incomplete."
    )
    assert frames[-1]["type"] == "done"
    assert frames[-1]["content"] == "partial "


def test_budget_and_fallback_events_forwarded():
    """model_fallback + budget_warning pass through to the client verbatim."""
    fake = _events_stream([
        {
            "type": "model_fallback",
            "original_model": "gpt-5.5",
            "fallback_model": "gpt-5.4-mini",
            "reason": "budget_cap",
            "used_usd": 1.0,
            "budget_usd": 1.0,
        },
        {"type": "chunk", "content": "ok"},
        {
            "type": "budget_warning",
            "used_usd": 0.9,
            "budget_usd": 1.0,
            "ratio": 0.9,
            "agent_id": "default",
            "at_cap": False,
        },
    ])
    with patch("app.api.chat_routes.stream_chat", side_effect=fake):
        with _client().websocket_connect("/api/chat/ws") as ws:
            ws.send_json({"message": "hi", "provider": "openai"})
            frames = _drain_until_done(ws)

    types = [f["type"] for f in frames]
    assert "model_fallback" in types
    assert "budget_warning" in types


def test_save_turn_failure_does_not_emit_error_after_done():
    """A post-turn checkpoint crash must not surface as a chat error.

    'done' is already on the wire when save_turn runs; an error frame after it
    would make the client replace the delivered answer. We assert the next
    frame after 'done' belongs to the NEXT turn, not an error.
    """
    fake = _events_stream([{"type": "chunk", "content": "answer"}])
    with patch("app.api.chat_routes.stream_chat", side_effect=fake), \
         patch("app.api.chat_routes.graph_manager") as mock_gm:
        mock_gm.save_turn.side_effect = RuntimeError("checkpoint exploded")
        with _client().websocket_connect("/api/chat/ws") as ws:
            # use_graph + thread_id make chat_loop call save_turn.
            ws.send_json({
                "message": "hi",
                "provider": "openai",
                "use_graph": True,
                "thread_id": "t-1",
            })
            frames = _drain_until_done(ws)
            # Second turn on the same socket: its first frame proves no error
            # frame was queued between the turns.
            ws.send_json({"message": "again", "provider": "openai"})
            next_frame = ws.receive_json()

    assert mock_gm.save_turn.called, "precondition: save_turn must have run"
    assert [f for f in frames if f["type"] == "error"] == []
    assert next_frame["type"] != "error"


def test_model_fingerprint_mismatch_prefixes_notice_once():
    """A viewer/backend model mismatch prepends a sync notice, once.

    The frontend flips to a freshly-opened model before the backend persist
    lands; a chat turn in that window must say the backend may still answer
    from the previous model instead of doing so silently. A persisting
    mismatch warns on the first turn only.
    """
    fake = _events_stream([{"type": "chunk", "content": "answer"}])
    with patch("app.api.chat_routes.stream_chat", side_effect=fake), \
         patch("app.api.chat_routes.model_context_injector") as mock_ctx, \
         patch("app.api.chat_routes.ifc_service") as mock_ifc:
        mock_ctx.get_context_block.return_value = ""
        mock_ifc.is_loaded = True
        mock_ifc.model_fingerprint = "server-fp"
        with _client().websocket_connect("/api/chat/ws") as ws:
            ws.send_json({
                "message": "hi",
                "provider": "openai",
                "model_fingerprint": "client-fp",
            })
            frames = _drain_until_done(ws)
            ws.send_json({
                "message": "again",
                "provider": "openai",
                "model_fingerprint": "client-fp",
            })
            frames_second = _drain_until_done(ws)

    chunks = [f["content"] for f in frames if f["type"] == "chunk"]
    assert chunks and chunks[0].startswith("Note: the backend is still syncing")
    assert "answer" in "".join(chunks)
    second_chunks = [f["content"] for f in frames_second if f["type"] == "chunk"]
    assert not any(c.startswith("Note:") for c in second_chunks), (
        "the same mismatch must not warn again on the same connection"
    )


def test_matching_fingerprint_gets_no_notice():
    """No sync notice when the viewer and backend agree on the model."""
    fake = _events_stream([{"type": "chunk", "content": "answer"}])
    with patch("app.api.chat_routes.stream_chat", side_effect=fake), \
         patch("app.api.chat_routes.model_context_injector") as mock_ctx, \
         patch("app.api.chat_routes.ifc_service") as mock_ifc:
        mock_ctx.get_context_block.return_value = ""
        mock_ifc.is_loaded = True
        mock_ifc.model_fingerprint = "same-fp"
        with _client().websocket_connect("/api/chat/ws") as ws:
            ws.send_json({
                "message": "hi",
                "provider": "openai",
                "model_fingerprint": "same-fp",
            })
            frames = _drain_until_done(ws)

    chunks = [f["content"] for f in frames if f["type"] == "chunk"]
    assert not any(c.startswith("Note:") for c in chunks)


def test_client_disconnect_mid_stream_aborts_turn(caplog):
    """A client that vanishes mid-stream must not crash the chat loop.

    Regression: chat_loop kept forwarding chunks after the browser closed the
    socket; starlette raised RuntimeError ("Unexpected ASGI message
    'websocket.send', after sending 'websocket.close'"), which was logged as
    'chat loop error' while the provider stream kept running for nobody.
    Now the turn aborts and the stream generator is closed promptly.
    """
    caplog.set_level(logging.INFO, logger="app.api.chat_routes")
    stream_closed = threading.Event()

    async def fake_stream_chat(*args, **kwargs):
        try:
            yield {"type": "chunk", "content": "hello"}
            while True:
                await asyncio.sleep(0.01)
                yield {"type": "chunk", "content": "x"}
        finally:
            stream_closed.set()

    with patch("app.api.chat_routes.stream_chat", side_effect=fake_stream_chat):
        with _client().websocket_connect("/api/chat/ws") as ws:
            ws.send_json({"message": "hi", "provider": "openai"})
            first = ws.receive_json()
            assert first["type"] == "chunk"
            # Leaving the context closes the socket while the fake stream is
            # still yielding - the mid-turn disconnect under test.

    assert stream_closed.wait(timeout=5), (
        "stream_chat generator must be closed when the client disconnects"
    )
    assert "chat loop error" not in caplog.text, (
        "a mid-stream disconnect must abort the turn, not surface as an error"
    )
