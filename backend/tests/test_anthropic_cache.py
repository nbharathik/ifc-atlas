"""Anthropic prompt-cache markers + usage telemetry.

``cache_control: ephemeral`` markers are wired onto
Anthropic's system block + last tool definition, and the usage event
carries ``cache_read_tokens`` / ``cache_creation_tokens`` /
``cache_hit_ratio`` / ``cached_cost_usd``. The frontend ChatPanel
chip renders the hit ratio as a green ⚡-prefixed badge.

These tests pin the contract so a refactor (e.g. moving providers to a
new LangGraph wrapper) cannot silently drop the markers and regress
the cache hit rate - the only way to know the cache is hitting on a
real account is to read the usage event, so dropping the markers
would only show up in production billing.
"""

from __future__ import annotations

from app.services.llm_service import (
    _anthropic_system_with_cache,
    _anthropic_tools_with_cache,
    _usage_event,
)


# ---------------------------------------------------------------------------
# Cache-control markers - system block
# ---------------------------------------------------------------------------


class TestAnthropicSystemCache:
    def test_wraps_system_in_content_block_with_cache_control(self):
        blocks = _anthropic_system_with_cache("You are an IFC analyst.")
        assert isinstance(blocks, list)
        assert len(blocks) == 1
        block = blocks[0]
        assert block["type"] == "text"
        assert block["text"] == "You are an IFC analyst."
        assert block["cache_control"] == {"type": "ephemeral"}

    def test_empty_system_still_gets_cache_marker(self):
        """Even an empty system stays wrapped - the contract is the cache
        marker, not the content. If a caller passes empty system text it
        still gets the structured block."""
        blocks = _anthropic_system_with_cache("")
        assert blocks[0]["cache_control"] == {"type": "ephemeral"}

    def test_marker_uses_ephemeral_not_persistent(self):
        """Anthropic supports ``ephemeral`` (5-min) and longer ``permanent``
        cache controls. Our pricing model assumes ephemeral. If anyone
        flips this to permanent, billing changes - this test catches it."""
        blocks = _anthropic_system_with_cache("x")
        assert blocks[0]["cache_control"]["type"] == "ephemeral"


# ---------------------------------------------------------------------------
# Cache-control markers - last tool only
# ---------------------------------------------------------------------------


class TestAnthropicToolsCache:
    def test_empty_tools_returns_empty_list(self):
        assert _anthropic_tools_with_cache([]) == []

    def test_marks_only_the_last_tool_block(self):
        """Anthropic caches up to the last cache_control marker, so
        marking only the last tool caches the entire tool list. Marking
        more than one would be wasted breakpoints."""
        tools = [
            {"name": "a", "description": "first"},
            {"name": "b", "description": "second"},
            {"name": "c", "description": "third"},
        ]
        result = _anthropic_tools_with_cache(tools)
        assert "cache_control" not in result[0]
        assert "cache_control" not in result[1]
        assert result[2]["cache_control"] == {"type": "ephemeral"}

    def test_does_not_mutate_input(self):
        tools = [{"name": "a"}, {"name": "b"}]
        original = [dict(t) for t in tools]
        _anthropic_tools_with_cache(tools)
        assert tools == original

    def test_single_tool_gets_marker(self):
        tools = [{"name": "only", "description": "x"}]
        result = _anthropic_tools_with_cache(tools)
        assert result[0]["cache_control"] == {"type": "ephemeral"}

    def test_preserves_existing_tool_fields(self):
        tools = [{
            "name": "search",
            "description": "Find elements",
            "input_schema": {"type": "object"},
        }]
        result = _anthropic_tools_with_cache(tools)
        assert result[0]["name"] == "search"
        assert result[0]["description"] == "Find elements"
        assert result[0]["input_schema"] == {"type": "object"}


# ---------------------------------------------------------------------------
# Usage event - cache_hit_ratio + cached_cost_usd
# ---------------------------------------------------------------------------


class TestUsageEventCacheFields:
    def test_no_cache_activity_omits_cache_fields(self):
        """Backwards compat: a turn with no caching should not surface
        cache fields on the usage event (frontend conditional render
        keys off field absence)."""
        ev = _usage_event(
            model="claude-sonnet-4-20250514",
            provider="anthropic",
            input_tokens=1000,
            output_tokens=500,
            cache_read_tokens=0,
            cache_creation_tokens=0,
        )
        assert "cache_read_tokens" not in ev
        assert "cache_creation_tokens" not in ev
        assert "cache_hit_ratio" not in ev

    def test_cache_read_surfaces_hit_ratio(self):
        ev = _usage_event(
            model="claude-sonnet-4-20250514",
            provider="anthropic",
            input_tokens=1000,
            output_tokens=500,
            cache_read_tokens=800,
            cache_creation_tokens=0,
        )
        assert ev["cache_read_tokens"] == 800
        # 800/1000 = 0.8
        assert ev["cache_hit_ratio"] == 0.8

    def test_cache_creation_surfaces_creation_field(self):
        ev = _usage_event(
            model="claude-sonnet-4-20250514",
            provider="anthropic",
            input_tokens=1000,
            output_tokens=200,
            cache_read_tokens=0,
            cache_creation_tokens=500,
        )
        assert ev["cache_creation_tokens"] == 500
        # 0 cache read = 0% hit ratio
        assert ev["cache_hit_ratio"] == 0.0

    def test_cached_cost_lower_than_full_cost(self):
        """Cache-read tokens are billed at a discount; cached_cost_usd
        should be lower than the implied full cost."""
        ev = _usage_event(
            model="claude-sonnet-4-20250514",
            provider="anthropic",
            input_tokens=10000,
            output_tokens=1000,
            cache_read_tokens=8000,
            cache_creation_tokens=0,
        )
        assert "cached_cost_usd" in ev
        assert "cost_usd" in ev
        if ev.get("cached_cost_usd") is not None and ev.get("cost_usd") is not None:
            # cached < full because 8000/10000 input tokens are free-ish
            assert ev["cached_cost_usd"] < ev["cost_usd"]

    def test_usage_event_shape_for_frontend_chip(self):
        """The frontend chip reads input_tokens, output_tokens,
        cache_hit_ratio. Pin the field names so a backend rename
        breaks here, not in production."""
        ev = _usage_event(
            model="claude-sonnet-4-20250514",
            provider="anthropic",
            input_tokens=1000,
            output_tokens=500,
            cache_read_tokens=600,
            cache_creation_tokens=100,
        )
        # Frontend keys off these exact names (snake_case from API).
        assert "input_tokens" in ev
        assert "output_tokens" in ev
        assert "cache_read_tokens" in ev
        assert "cache_creation_tokens" in ev
        assert "cache_hit_ratio" in ev
        assert ev["type"] == "usage"
        assert ev["provider"] == "anthropic"
