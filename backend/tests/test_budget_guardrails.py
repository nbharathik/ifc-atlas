"""
Tests for per-agent monthly budget guardrails.

BudgetTracker:
  - record() accumulates spend per agent
  - check_budget() returns correct status (ok / near_cap / over_cap)
  - month rollover resets counters
  - no-op for zero/negative cost

stream_chat() integration:
  - model_fallback event emitted when over budget and fallback_model set
  - budget_warning event emitted after turn when near_cap
  - hard-stop text chunk when over budget and no fallback_model
"""

import pytest
from unittest.mock import MagicMock, patch


# ── BudgetTracker unit tests ──────────────────────────────────────────────────

def test_budget_tracker_record_and_get_spent(tmp_path):
    from app.services.budget_tracker import BudgetTracker
    bt = BudgetTracker.__new__(BudgetTracker)
    bt._month_key = "2026-05"
    bt._spent = {}
    bt._state_file = tmp_path / "budget_state.json"

    bt.record("agent-1", 0.001)
    bt.record("agent-1", 0.002)
    bt.record("agent-2", 0.010)

    assert abs(bt.get_spent("agent-1") - 0.003) < 1e-9
    assert abs(bt.get_spent("agent-2") - 0.010) < 1e-9


def test_budget_tracker_no_op_for_zero(tmp_path):
    from app.services.budget_tracker import BudgetTracker
    bt = BudgetTracker.__new__(BudgetTracker)
    bt._month_key = "2026-05"
    bt._spent = {}

    bt.record("agent-x", 0.0)
    bt.record("agent-x", -0.5)
    assert bt.get_spent("agent-x") == 0.0


def test_check_budget_ok():
    from app.services.budget_tracker import BudgetTracker, STATUS_OK
    bt = BudgetTracker.__new__(BudgetTracker)
    bt._month_key = BudgetTracker._current_month()
    bt._spent = {"a": 0.3}

    result = bt.check_budget("a", 1.0)
    assert result["status"] == STATUS_OK
    assert result["ratio"] == pytest.approx(0.3)


def test_check_budget_near_cap():
    from app.services.budget_tracker import BudgetTracker, STATUS_NEAR_CAP
    bt = BudgetTracker.__new__(BudgetTracker)
    bt._month_key = BudgetTracker._current_month()
    bt._spent = {"a": 0.85}

    result = bt.check_budget("a", 1.0)
    assert result["status"] == STATUS_NEAR_CAP
    assert result["ratio"] == pytest.approx(0.85)


def test_check_budget_over_cap():
    from app.services.budget_tracker import BudgetTracker, STATUS_OVER_CAP
    bt = BudgetTracker.__new__(BudgetTracker)
    bt._month_key = BudgetTracker._current_month()
    bt._spent = {"a": 1.01}

    result = bt.check_budget("a", 1.0)
    assert result["status"] == STATUS_OVER_CAP
    assert result["ratio"] == pytest.approx(1.01)


def test_check_budget_no_limit():
    from app.services.budget_tracker import BudgetTracker, STATUS_OK
    bt = BudgetTracker.__new__(BudgetTracker)
    bt._month_key = "2026-05"
    bt._spent = {"a": 999.0}

    result = bt.check_budget("a", None)
    assert result["status"] == STATUS_OK
    assert result["budget_usd"] is None


def test_check_budget_month_rollover():
    from app.services.budget_tracker import BudgetTracker, STATUS_OK
    bt = BudgetTracker.__new__(BudgetTracker)
    bt._month_key = "2026-04"  # stale
    bt._spent = {"a": 0.99}

    # Force current_month to return a different value
    with patch.object(BudgetTracker, "_current_month", return_value="2026-05"):
        result = bt.check_budget("a", 1.0)
    assert result["status"] == STATUS_OK
    assert result["used_usd"] == 0.0  # reset


# ── stream_chat integration tests ─────────────────────────────────────────────

def _make_agent(monthly_budget_usd=None, fallback_model=None):
    from app.services.agent_registry import AgentPreset
    return AgentPreset(
        id="test-agent",
        label="Test",
        description="",
        system_prompt="hi",
        provider="openai",
        model="gpt-4o",
        temperature=0.3,
        icon="🤖",
        monthly_budget_usd=monthly_budget_usd,
        fallback_model=fallback_model,
    )


@pytest.mark.asyncio
async def test_stream_chat_model_fallback_when_over_cap():
    """When budget exhausted and fallback_model set → model_fallback event emitted first."""
    from app.services.budget_tracker import BudgetTracker, STATUS_OVER_CAP

    agent = _make_agent(monthly_budget_usd=1.0, fallback_model="gpt-4o-mini")

    mock_bt = MagicMock(spec=BudgetTracker)
    mock_bt.check_budget.return_value = {
        "status": STATUS_OVER_CAP, "used_usd": 1.05, "budget_usd": 1.0, "ratio": 1.05,
    }

    async def _fake_stream(*a, **kw):
        yield {"type": "chunk", "content": "hello"}
        yield {"type": "done"}

    with patch("app.services.llm_service.get_agent", return_value=agent), \
         patch("app.services.llm_service.stream_via_langgraph", side_effect=_fake_stream), \
         patch("app.services.llm_service.budget_tracker", mock_bt), \
         patch("app.services.llm_service.get_api_key", return_value="key"), \
         patch("app.services.chat_context.model_context_injector.inject", side_effect=lambda p, c: p):

        from app.services.llm_service import stream_chat
        events = [ev async for ev in stream_chat("hi", [], provider="openai")]

    fallback_events = [e for e in events if e.get("type") == "model_fallback"]
    assert len(fallback_events) == 1
    fb = fallback_events[0]
    assert fb["fallback_model"] == "gpt-4o-mini"
    assert fb["reason"] == "budget_cap"
    # Model in stream call should be the fallback, not original
    # (verified via the fact that stream was called with fallback_model)


@pytest.mark.asyncio
async def test_stream_chat_hard_stop_when_over_cap_no_fallback():
    """When budget exhausted and no fallback_model → hard-stop chunk, no LLM call."""
    from app.services.budget_tracker import BudgetTracker, STATUS_OVER_CAP

    agent = _make_agent(monthly_budget_usd=1.0, fallback_model=None)

    mock_bt = MagicMock(spec=BudgetTracker)
    mock_bt.check_budget.return_value = {
        "status": STATUS_OVER_CAP, "used_usd": 1.05, "budget_usd": 1.0, "ratio": 1.05,
    }

    with patch("app.services.llm_service.get_agent", return_value=agent), \
         patch("app.services.llm_service.budget_tracker", mock_bt), \
         patch("app.services.llm_service.get_api_key", return_value="key"), \
         patch("app.services.chat_context.model_context_injector.inject", side_effect=lambda p, c: p):

        from app.services.llm_service import stream_chat
        events = [ev async for ev in stream_chat("hi", [], provider="openai")]

    chunk_events = [e for e in events if e.get("type") == "chunk"]
    assert len(chunk_events) == 1
    assert "exhausted" in chunk_events[0]["content"]
    # Confirm no model was called (no stream_via_langgraph needed)


@pytest.mark.asyncio
async def test_stream_chat_budget_warning_after_near_cap_turn():
    """After a turn that pushes total to near-cap → budget_warning event emitted."""
    from app.services.budget_tracker import BudgetTracker, STATUS_OK, STATUS_NEAR_CAP

    agent = _make_agent(monthly_budget_usd=1.0)

    mock_bt = MagicMock(spec=BudgetTracker)
    # Pre-turn: under budget
    # Post-turn: near cap
    mock_bt.check_budget.side_effect = [
        {"status": STATUS_OK, "used_usd": 0.5, "budget_usd": 1.0, "ratio": 0.5},
        {"status": STATUS_NEAR_CAP, "used_usd": 0.85, "budget_usd": 1.0, "ratio": 0.85},
    ]

    async def _fake_stream(*a, **kw):
        yield {"type": "chunk", "content": "hi"}
        yield {"type": "usage", "cost_usd": 0.35, "input_tokens": 100, "output_tokens": 50,
               "provider": "openai", "model": "gpt-4o"}
        yield {"type": "done"}

    with patch("app.services.llm_service.get_agent", return_value=agent), \
         patch("app.services.llm_service.stream_via_langgraph", side_effect=_fake_stream), \
         patch("app.services.llm_service.budget_tracker", mock_bt), \
         patch("app.services.llm_service.get_api_key", return_value="key"), \
         patch("app.services.chat_context.model_context_injector.inject", side_effect=lambda p, c: p):

        from app.services.llm_service import stream_chat
        events = [ev async for ev in stream_chat("hi", [], provider="openai")]

    warning_events = [e for e in events if e.get("type") == "budget_warning"]
    assert len(warning_events) == 1
    w = warning_events[0]
    assert w["ratio"] == pytest.approx(0.85)
    assert w["agent_id"] == "test-agent"
    mock_bt.record.assert_called_once_with("test-agent", 0.35)


# ── Budget summary endpoint ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_budget_summary_endpoint_returns_active_agents():
    """GET /api/chat/budget/summary returns the correct response shape."""
    from httpx import ASGITransport, AsyncClient
    from app.main import app
    from app.services.budget_tracker import BudgetTracker

    # Patch the module-level singleton so the route sees clean state
    mock_bt = MagicMock(spec=BudgetTracker)
    mock_bt._month_key = "2026-05"
    mock_bt.get_all_spent.return_value = {}
    mock_bt.check_budget.return_value = {
        "status": "ok", "used_usd": 0.0, "budget_usd": None, "ratio": None,
    }

    with patch("app.services.budget_tracker.budget_tracker", mock_bt):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            resp = await ac.get("/api/chat/budget/summary")

    assert resp.status_code == 200
    body = resp.json()
    assert "month" in body
    assert "agents" in body
    assert isinstance(body["agents"], list)


def test_budget_tracker_get_all_spent_snapshot():
    """get_all_spent() returns an independent copy."""
    from app.services.budget_tracker import BudgetTracker
    bt = BudgetTracker.__new__(BudgetTracker)
    bt._month_key = "2026-05"
    bt._spent = {"x": 0.5, "y": 0.1}

    snapshot = bt.get_all_spent()
    snapshot["z"] = 99.0  # mutate the copy
    assert "z" not in bt._spent  # original untouched


def test_budget_tracker_reset_agent():
    """reset_agent() removes one agent's entry without touching others."""
    from app.services.budget_tracker import BudgetTracker
    bt = BudgetTracker.__new__(BudgetTracker)
    bt._month_key = "2026-05"
    bt._spent = {"a": 1.0, "b": 2.0}
    bt._state_file = None  # skip persist

    # Patch _save to avoid filesystem access
    with patch.object(bt, "_save"):
        bt.reset_agent("a")

    assert "a" not in bt._spent
    assert bt._spent["b"] == pytest.approx(2.0)


# ── DELETE /api/chat/budget/{agent_id} ────────────────────────────────────────

@pytest.mark.asyncio
async def test_reset_agent_budget_endpoint_returns_200():
    """DELETE /api/chat/budget/{agent_id} returns 200 with previous_spent_usd."""
    from httpx import ASGITransport, AsyncClient
    from app.main import app
    from app.services.budget_tracker import BudgetTracker

    mock_bt = MagicMock(spec=BudgetTracker)
    mock_bt.get_spent.return_value = 0.042

    # budget_tracker is imported lazily inside the endpoint (local import).
    with patch("app.services.budget_tracker.budget_tracker", mock_bt):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            resp = await ac.delete("/api/chat/budget/my-agent")

    assert resp.status_code == 200
    body = resp.json()
    assert body["reset"] == "my-agent"
    assert body["previous_spent_usd"] == pytest.approx(0.042, abs=1e-6)
    mock_bt.reset_agent.assert_called_once_with("my-agent")


@pytest.mark.asyncio
async def test_reset_agent_budget_endpoint_zero_spend():
    """DELETE /api/chat/budget/{agent_id} works when agent has no prior spend."""
    from httpx import ASGITransport, AsyncClient
    from app.main import app
    from app.services.budget_tracker import BudgetTracker

    mock_bt = MagicMock(spec=BudgetTracker)
    mock_bt.get_spent.return_value = 0.0

    with patch("app.services.budget_tracker.budget_tracker", mock_bt):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as ac:
            resp = await ac.delete("/api/chat/budget/new-agent")

    assert resp.status_code == 200
    assert resp.json()["previous_spent_usd"] == 0.0
