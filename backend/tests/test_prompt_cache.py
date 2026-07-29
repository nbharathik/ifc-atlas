"""Tests for Anthropic prompt caching + tool-result memoization."""
import pytest
from unittest.mock import patch


# ---------------------------------------------------------------------------
# Pure-function helpers
# ---------------------------------------------------------------------------

class TestAnthropicSystemWithCache:
    def test_wraps_string_in_content_block(self):
        from app.services.llm_service import _anthropic_system_with_cache
        result = _anthropic_system_with_cache("hello world")
        assert len(result) == 1
        block = result[0]
        assert block["type"] == "text"
        assert block["text"] == "hello world"
        assert block["cache_control"] == {"type": "ephemeral"}

    def test_preserves_full_system_text(self):
        from app.services.llm_service import _anthropic_system_with_cache
        long_text = "A" * 5000
        result = _anthropic_system_with_cache(long_text)
        assert result[0]["text"] == long_text

    def test_returns_list(self):
        from app.services.llm_service import _anthropic_system_with_cache
        result = _anthropic_system_with_cache("x")
        assert isinstance(result, list)


class TestAnthropicToolsWithCache:
    def test_adds_cache_control_to_last_tool(self):
        from app.services.llm_service import _anthropic_tools_with_cache
        tools = [
            {"name": "tool_a", "description": "a"},
            {"name": "tool_b", "description": "b"},
        ]
        result = _anthropic_tools_with_cache(tools)
        assert result[-1]["cache_control"] == {"type": "ephemeral"}
        assert "cache_control" not in result[0]

    def test_does_not_mutate_original(self):
        from app.services.llm_service import _anthropic_tools_with_cache
        tools = [{"name": "t", "description": "d"}]
        result = _anthropic_tools_with_cache(tools)
        assert "cache_control" not in tools[0]
        assert "cache_control" in result[-1]

    def test_empty_tools_returns_empty(self):
        from app.services.llm_service import _anthropic_tools_with_cache
        assert _anthropic_tools_with_cache([]) == []

    def test_single_tool_gets_cache_control(self):
        from app.services.llm_service import _anthropic_tools_with_cache
        tools = [{"name": "only", "description": "x"}]
        result = _anthropic_tools_with_cache(tools)
        assert result[0]["cache_control"] == {"type": "ephemeral"}


class TestUsageEvent:
    def test_basic_usage_no_cache(self):
        from app.services.llm_service import _usage_event
        ev = _usage_event("claude-sonnet-4-20250514", "anthropic", 100, 50)
        assert ev["type"] == "usage"
        assert ev["input_tokens"] == 100
        assert ev["output_tokens"] == 50
        assert "cache_read_tokens" not in ev
        assert "cache_creation_tokens" not in ev
        assert "cache_hit_ratio" not in ev

    def test_cache_read_tokens_included(self):
        from app.services.llm_service import _usage_event
        ev = _usage_event("claude-sonnet-4-20250514", "anthropic", 100, 50,
                          cache_read_tokens=80)
        assert ev["cache_read_tokens"] == 80
        assert ev["cache_hit_ratio"] == pytest.approx(0.8, abs=0.001)

    def test_cache_creation_tokens_included(self):
        from app.services.llm_service import _usage_event
        ev = _usage_event("claude-sonnet-4-20250514", "anthropic", 200, 30,
                          cache_creation_tokens=200)
        assert ev["cache_creation_tokens"] == 200

    def test_zero_cache_tokens_not_emitted(self):
        from app.services.llm_service import _usage_event
        ev = _usage_event("claude-sonnet-4-20250514", "anthropic", 100, 50,
                          cache_read_tokens=0, cache_creation_tokens=0)
        assert "cache_read_tokens" not in ev
        assert "cache_creation_tokens" not in ev

    def test_perfect_cache_hit_ratio(self):
        from app.services.llm_service import _usage_event
        ev = _usage_event("claude-sonnet-4-20250514", "anthropic", 500, 50,
                          cache_read_tokens=500)
        assert ev["cache_hit_ratio"] == 1.0

    def test_cost_still_calculated(self):
        from app.services.llm_service import _usage_event
        ev = _usage_event("claude-sonnet-4-20250514", "anthropic", 1_000_000, 100_000,
                          cache_read_tokens=0)
        assert "cost_usd" in ev
        assert ev["cost_usd"] > 0


class TestMemoizableTools:
    def test_read_model_tools_in_memoizable_set(self):
        from app.services.llm_service import _MEMOIZABLE_TOOLS
        assert "get_project_info" in _MEMOIZABLE_TOOLS
        assert "get_storeys" in _MEMOIZABLE_TOOLS
        assert "search_elements" in _MEMOIZABLE_TOOLS
        assert "get_element_details" in _MEMOIZABLE_TOOLS
        assert "execute_ifc_query_code" in _MEMOIZABLE_TOOLS

    def test_write_tools_not_in_memoizable_set(self):
        from app.services.llm_service import _MEMOIZABLE_TOOLS
        assert "rename_element" not in _MEMOIZABLE_TOOLS
        assert "update_property_value" not in _MEMOIZABLE_TOOLS
        assert "execute_ifc_code" not in _MEMOIZABLE_TOOLS

    def test_viewer_tools_not_in_memoizable_set(self):
        from app.services.llm_service import _MEMOIZABLE_TOOLS
        assert "highlight_elements" not in _MEMOIZABLE_TOOLS
        assert "isolate_elements" not in _MEMOIZABLE_TOOLS


# ---------------------------------------------------------------------------
# Integration: stream_anthropic uses cache-control system + tools
# ---------------------------------------------------------------------------

class MockBlock:
    def __init__(self, block_type, **kwargs):
        self.type = block_type
        for k, v in kwargs.items():
            setattr(self, k, v)


class MockUsage:
    def __init__(self, input_tokens=10, output_tokens=5,
                 cache_read_input_tokens=0, cache_creation_input_tokens=0):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.cache_read_input_tokens = cache_read_input_tokens
        self.cache_creation_input_tokens = cache_creation_input_tokens


class MockFinalMessage:
    def __init__(self, content=None, usage=None):
        self.content = content or [MockBlock("text", text="hello")]
        self.usage = usage or MockUsage()


class MockStream:
    def __init__(self, text="hello", usage=None):
        self._text = text
        self._message = MockFinalMessage(usage=usage)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def get_final_message(self):
        return self._message

    @property
    def text_stream(self):
        async def _gen():
            yield self._text
        return _gen()


@pytest.mark.asyncio
async def test_stream_anthropic_emits_cache_read_tokens():
    """stream_anthropic passes cache stats from usage into the usage WS event."""
    from app.services.llm_service import stream_anthropic

    mock_usage = MockUsage(input_tokens=200, output_tokens=40,
                           cache_read_input_tokens=150, cache_creation_input_tokens=0)
    mock_stream = MockStream(text="Test response", usage=mock_usage)

    with patch("anthropic.AsyncAnthropic") as MockClient:
        MockClient.return_value.messages.stream.return_value = mock_stream
        with patch("app.services.llm_service.get_api_key", return_value="test-key"):
            events = []
            async for ev in stream_anthropic("Hello", [], model="claude-sonnet-4-20250514"):
                events.append(ev)

    usage_evs = [e for e in events if e.get("type") == "usage"]
    assert len(usage_evs) == 1
    uev = usage_evs[0]
    assert uev["cache_read_tokens"] == 150
    assert "cache_hit_ratio" in uev
    assert uev["cache_hit_ratio"] == pytest.approx(0.75, abs=0.01)


@pytest.mark.asyncio
async def test_stream_anthropic_system_is_content_block():
    """stream_anthropic passes system as a list of content blocks (not a string)."""
    from app.services.llm_service import stream_anthropic

    captured_kwargs: dict = {}
    mock_stream = MockStream()

    with patch("anthropic.AsyncAnthropic") as MockClient:
        def _fake_stream(**kwargs):
            captured_kwargs.update(kwargs)
            return mock_stream
        MockClient.return_value.messages.stream.side_effect = _fake_stream
        with patch("app.services.llm_service.get_api_key", return_value="test-key"):
            async for _ in stream_anthropic("Hello", [], system_prompt="Custom system"):
                pass

    system = captured_kwargs.get("system")
    assert isinstance(system, list), "system must be a list of content blocks"
    assert system[0]["type"] == "text"
    assert system[0]["cache_control"] == {"type": "ephemeral"}
    assert "Custom system" in system[0]["text"]
