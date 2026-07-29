"""Per-turn cost telemetry tests.

Covers:
  - _estimate_cost: known models, unknown models.
  - _usage_event: shape + cost_usd presence.
  - stream_openai: emits usage event after non-tool turn.
  - stream_anthropic: emits usage event from final_message.usage.
  - stream_openrouter: emits usage event.
  - upload fire-and-forget: ingestion schedules derived-data work.
"""

from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


# ---------------------------------------------------------------------------
# _estimate_cost
# ---------------------------------------------------------------------------

def test_estimate_cost_known_model():
    from app.services.llm_service import _estimate_cost
    # gpt-4o: $5/M input, $15/M output
    cost = _estimate_cost("gpt-4o", input_tokens=1_000, output_tokens=500)
    expected = (1_000 * 5 + 500 * 15) / 1_000_000
    assert abs(cost - expected) < 1e-9


def test_estimate_cost_unknown_model():
    from app.services.llm_service import _estimate_cost
    assert _estimate_cost("unknown-future-model-xyz", 100, 100) == -1.0


def test_estimate_cost_zero_tokens():
    from app.services.llm_service import _estimate_cost
    assert _estimate_cost("gpt-4o", 0, 0) == 0.0


def test_estimate_cost_openrouter_deepseek():
    from app.services.llm_service import _estimate_cost
    cost = _estimate_cost("deepseek/deepseek-chat", 10_000, 5_000)
    assert cost > 0


# ---------------------------------------------------------------------------
# _usage_event shape
# ---------------------------------------------------------------------------

def test_usage_event_has_required_keys():
    from app.services.llm_service import _usage_event
    ev = _usage_event("gpt-4o", "openai", 100, 200)
    assert ev["type"] == "usage"
    assert ev["model"] == "gpt-4o"
    assert ev["provider"] == "openai"
    assert ev["input_tokens"] == 100
    assert ev["output_tokens"] == 200
    assert "cost_usd" in ev
    assert ev["cost_usd"] > 0


def test_usage_event_no_cost_for_unknown_model():
    from app.services.llm_service import _usage_event
    ev = _usage_event("futuristic-llm", "openai", 100, 100)
    assert "cost_usd" not in ev


# ---------------------------------------------------------------------------
# stream_openai - usage event emitted
# ---------------------------------------------------------------------------

async def _aiter(*items):
    for item in items:
        yield item


def _mk_text_chunk(text: str):
    chunk = MagicMock()
    chunk.choices = [MagicMock()]
    chunk.choices[0].delta.content = text
    chunk.choices[0].delta.tool_calls = None
    chunk.usage = None
    return chunk


def _mk_usage_chunk(prompt_tokens: int, completion_tokens: int):
    chunk = MagicMock()
    chunk.choices = []
    chunk.usage = MagicMock()
    chunk.usage.prompt_tokens = prompt_tokens
    chunk.usage.completion_tokens = completion_tokens
    return chunk


@pytest.mark.asyncio
async def test_stream_openai_emits_usage_event():
    from app.services.llm_service import stream_openai

    fake_stream = _aiter(
        _mk_text_chunk("Hello"),
        _mk_usage_chunk(50, 20),
    )
    mock_client = MagicMock()
    mock_client.chat.completions.create = AsyncMock(return_value=fake_stream)

    with patch("app.services.llm_service.get_api_key", return_value="key"), \
         patch("openai.AsyncOpenAI", return_value=mock_client):
        events = []
        async for ev in stream_openai("hi", [], model="gpt-4o"):
            events.append(ev)

    usage_evts = [e for e in events if e.get("type") == "usage"]
    assert len(usage_evts) == 1
    u = usage_evts[0]
    assert u["input_tokens"] == 50
    assert u["output_tokens"] == 20
    assert u["provider"] == "openai"
    assert u["model"] == "gpt-4o"


@pytest.mark.asyncio
async def test_stream_openai_no_usage_when_tokens_zero():
    """No usage event emitted when the provider sends 0/0 tokens (shouldn't happen but guard)."""
    from app.services.llm_service import stream_openai

    fake_stream = _aiter(_mk_usage_chunk(0, 0))
    mock_client = MagicMock()
    mock_client.chat.completions.create = AsyncMock(return_value=fake_stream)

    with patch("app.services.llm_service.get_api_key", return_value="key"), \
         patch("openai.AsyncOpenAI", return_value=mock_client):
        events = [ev async for ev in stream_openai("hi", [], model="gpt-4o")]

    assert not any(e.get("type") == "usage" for e in events)


# ---------------------------------------------------------------------------
# stream_anthropic - usage event from final_message.usage
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_stream_anthropic_emits_usage_event():
    from app.services.llm_service import stream_anthropic

    mock_usage = MagicMock()
    mock_usage.input_tokens = 80
    mock_usage.output_tokens = 30
    mock_usage.cache_read_input_tokens = None
    mock_usage.cache_creation_input_tokens = None

    mock_final = MagicMock()
    mock_final.content = []
    mock_final.usage = mock_usage

    mock_stream_ctx = AsyncMock()
    mock_stream_ctx.__aenter__ = AsyncMock(return_value=mock_stream_ctx)
    mock_stream_ctx.__aexit__ = AsyncMock(return_value=None)
    mock_stream_ctx.text_stream = _aiter("Hello from Claude")
    mock_stream_ctx.get_final_message = AsyncMock(return_value=mock_final)

    mock_client = MagicMock()
    mock_client.messages.stream = MagicMock(return_value=mock_stream_ctx)

    with patch("app.services.llm_service.get_api_key", return_value="key"), \
         patch("anthropic.AsyncAnthropic", return_value=mock_client):
        events = [ev async for ev in stream_anthropic("hi", [], model="claude-sonnet-4-20250514")]

    usage_evts = [e for e in events if e.get("type") == "usage"]
    assert len(usage_evts) == 1
    u = usage_evts[0]
    assert u["input_tokens"] == 80
    assert u["output_tokens"] == 30
    assert u["provider"] == "anthropic"


# ---------------------------------------------------------------------------
# upload fire-and-forget (IFC ingestion service)
# ---------------------------------------------------------------------------

def test_upload_native_parse_is_scheduled_by_ingestion_service():
    """The route delegates and ingestion schedules derived-data warm-up."""
    from pathlib import Path

    route_src = (
        Path(__file__).parents[1] / "app" / "api" / "ifc_routes.py"
    ).read_text(encoding="utf-8")
    service_src = (
        Path(__file__).parents[1]
        / "app"
        / "services"
        / "ifc_ingestion_service.py"
    ).read_text(encoding="utf-8")

    assert "_ifc_ingestion_service().ingest" in route_src
    assert "asyncio.create_task(operation)" in service_src
    assert "self._warm_derived_data(" in service_src
