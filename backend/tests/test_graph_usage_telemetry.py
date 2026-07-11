"""Usage/cost telemetry on the LangGraph streaming path (plan R1).

The graph path is the primary streaming path (taken whenever tools + an API
key exist), but it historically never emitted a ``usage`` event - so the
ChatUsageChip, budget_tracker.record(), and budget warnings only worked when
the graph build FAILED and the fallback streamers ran. These tests pin the
fix: on_chat_model_end usage accumulation across model rounds, one usage
event before every exit path, and $ rates resolved from the (UI-editable)
model registry instead of only the legacy static table.

Mocking style follows test_stream_retry.py (patch build_streaming_agent in
its source module, fake astream_events).
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.services import llm_service
from app.services.llm_service import _estimate_cost, stream_via_langgraph


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch):
    monkeypatch.setattr(llm_service, "_STREAM_RETRY_BACKOFF_S", 0)


async def _collect(agen):
    events = []
    async for ev in agen:
        events.append(ev)
    return events


def _run_langgraph(model: str = "gpt-4o"):
    return stream_via_langgraph(
        message="hi",
        history=[],
        provider="openai",
        model=model,
        temperature=0.3,
        tool_executor=None,
        system_prompt="sys",
        allowed_tools=None,
        attachments=None,
    )


def _model_end_event(input_tokens: int, output_tokens: int, cache_read: int = 0):
    """A fake on_chat_model_end event whose output message carries
    usage_metadata the way langchain-core AIMessage does."""
    msg = SimpleNamespace(
        usage_metadata={
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
            "input_token_details": {"cache_read": cache_read},
        }
    )
    return {"event": "on_chat_model_end", "data": {"output": msg}}


# ── happy path ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_graph_path_emits_one_usage_event_summed_across_rounds():
    async def _astream(*args, **kwargs):
        yield {"event": "on_chat_model_stream", "data": {"chunk": MagicMock(content="a")}}
        yield _model_end_event(1000, 50)
        yield {"event": "on_chat_model_stream", "data": {"chunk": MagicMock(content="b")}}
        yield _model_end_event(2000, 150, cache_read=500)

    mock_graph = MagicMock()
    mock_graph.astream_events = _astream

    with patch("app.services.agent_graph.build_streaming_agent", return_value=mock_graph):
        events = await _collect(_run_langgraph())

    usage = [e for e in events if e["type"] == "usage"]
    assert len(usage) == 1, "exactly one usage event per turn"
    ev = usage[0]
    assert ev["input_tokens"] == 3000
    assert ev["output_tokens"] == 200
    assert ev["cache_read_tokens"] == 500
    # gpt-4o has static rates, so cost must be present and positive.
    assert ev["cost_usd"] > 0
    # usage arrives after the content, as the turn summary.
    assert events.index(ev) > max(
        i for i, e in enumerate(events) if e["type"] == "chunk"
    )


@pytest.mark.asyncio
async def test_no_usage_event_when_provider_reports_nothing():
    async def _astream(*args, **kwargs):
        yield {"event": "on_chat_model_stream", "data": {"chunk": MagicMock(content="x")}}

    mock_graph = MagicMock()
    mock_graph.astream_events = _astream

    with patch("app.services.agent_graph.build_streaming_agent", return_value=mock_graph):
        events = await _collect(_run_langgraph())

    assert not [e for e in events if e["type"] == "usage"]


# ── error paths still report burned tokens ───────────────────────────────────

@pytest.mark.asyncio
async def test_mid_stream_error_still_reports_usage():
    async def _astream(*args, **kwargs):
        yield {"event": "on_chat_model_stream", "data": {"chunk": MagicMock(content="partial")}}
        yield _model_end_event(700, 30)
        raise RuntimeError("some weird non-transient bug")

    mock_graph = MagicMock()
    mock_graph.astream_events = _astream

    with patch("app.services.agent_graph.build_streaming_agent", return_value=mock_graph):
        events = await _collect(_run_langgraph())

    assert [e for e in events if e["type"] == "error"], "error surfaced"
    usage = [e for e in events if e["type"] == "usage"]
    assert len(usage) == 1
    assert usage[0]["input_tokens"] == 700


@pytest.mark.asyncio
async def test_usage_accumulates_across_transient_retry():
    """The failed attempt's tokens were billed - the turn total includes them."""
    calls = {"n": 0}

    async def _flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            yield _model_end_event(400, 10)
            raise ConnectionError("Connection reset by peer")
        yield {"event": "on_chat_model_stream", "data": {"chunk": MagicMock(content="ok")}}
        yield _model_end_event(600, 40)

    mock_graph = MagicMock()
    mock_graph.astream_events = _flaky

    with patch("app.services.agent_graph.build_streaming_agent", return_value=mock_graph):
        events = await _collect(_run_langgraph())

    assert calls["n"] == 2
    usage = [e for e in events if e["type"] == "usage"]
    assert len(usage) == 1
    assert usage[0]["input_tokens"] == 1000
    assert usage[0]["output_tokens"] == 50


# ── registry-backed $ rates ──────────────────────────────────────────────────

def _fake_registry(entries):
    reg = MagicMock()
    reg.all.return_value = entries
    return reg


def _entry(model_id, in_rate, out_rate):
    return SimpleNamespace(
        model_id=model_id,
        input_cost_per_1m=in_rate,
        output_cost_per_1m=out_rate,
    )


def test_estimate_cost_prefers_registry_rates():
    with patch("app.services.model_registry.model_registry",
               _fake_registry([_entry("some-new-model", 2.0, 8.0)])):
        cost = _estimate_cost("some-new-model", 1_000_000, 1_000_000)
    assert cost == pytest.approx(10.0)


def test_estimate_cost_registry_overrides_static_table():
    # gpt-4o is in the legacy static table at (5, 15); a registry entry wins.
    with patch("app.services.model_registry.model_registry",
               _fake_registry([_entry("gpt-4o", 1.0, 1.0)])):
        cost = _estimate_cost("gpt-4o", 1_000_000, 0)
    assert cost == pytest.approx(1.0)


def test_estimate_cost_falls_back_to_static_table_then_unknown():
    empty = _fake_registry([])
    with patch("app.services.model_registry.model_registry", empty):
        assert _estimate_cost("gpt-4o", 1_000_000, 0) == pytest.approx(5.0)
        assert _estimate_cost("never-heard-of-it", 1000, 1000) == -1.0


def test_estimate_cost_free_model_is_zero_not_unknown():
    with patch("app.services.model_registry.model_registry",
               _fake_registry([_entry("openrouter/free", 0.0, 0.0)])):
        assert _estimate_cost("openrouter/free", 5000, 5000) == 0.0


def test_registry_seeds_carry_rates_for_default_models():
    """Every enabled built-in seed ships a $ estimate so budget caps accrue
    out of the box (free tiers carry an explicit 0.0, not unknown)."""
    from app.services.model_registry import _BUILTIN_SEEDS

    for seed in _BUILTIN_SEEDS:
        assert seed.input_cost_per_1m is not None, seed.id
        assert seed.output_cost_per_1m is not None, seed.id
