"""Runtime allowlist gate on agent tool calls.

The chat router's provider streamers already filter the tools schema via
``_filter_tools(allowed_tools, ...)`` so the LLM never sees disallowed
tools. This test pins ``check_allowlist_block`` - the runtime
defence-in-depth check that runs inside ``router_tool_executor`` and
refuses any call slip-through (prompt injection, multi-turn drift,
legacy history replay).
"""
from __future__ import annotations

from types import SimpleNamespace

from app.api.chat_routes import check_allowlist_block


def _agent(agent_id: str, allowed: frozenset[str] | None) -> SimpleNamespace:
    """Stand-in for the AgentPreset dataclass - only the two attrs the
    gate touches."""
    return SimpleNamespace(id=agent_id, allowed_tools=allowed)


class TestCheckAllowlistBlock:
    def test_no_agent_returns_none(self):
        """Defensive: a null agent never blocks (legacy callers)."""
        assert check_allowlist_block(None, "any_tool") is None

    def test_agent_with_no_allowlist_returns_none(self):
        """``allowed_tools == None`` means "all tools allowed"."""
        agent = _agent("default", None)
        assert check_allowlist_block(agent, "rename_element") is None

    def test_tool_in_allowlist_returns_none(self):
        agent = _agent("read-only", frozenset({"get_project_info", "get_model_stats"}))
        assert check_allowlist_block(agent, "get_project_info") is None
        assert check_allowlist_block(agent, "get_model_stats") is None

    def test_tool_not_in_allowlist_returns_block_envelope(self):
        agent = _agent("read-only", frozenset({"get_project_info"}))
        block = check_allowlist_block(agent, "rename_element")
        assert block is not None
        assert block["blocked_by_allowlist"] is True
        assert "rename_element" in block["error"]
        assert "read-only" in block["error"]

    def test_empty_allowlist_blocks_all_tools(self):
        """An empty frozenset is an explicit allow-nothing config."""
        agent = _agent("locked-down", frozenset())
        for tool in ("get_project_info", "rename_element", "highlight_elements"):
            block = check_allowlist_block(agent, tool)
            assert block is not None
            assert block["blocked_by_allowlist"] is True

    def test_block_envelope_shape(self):
        """Frontend ToolCallDisplay keys off these exact fields."""
        agent = _agent("a1", frozenset())
        block = check_allowlist_block(agent, "rename_element")
        assert set(block.keys()) == {"error", "blocked_by_allowlist"}
        assert isinstance(block["error"], str)
        assert block["blocked_by_allowlist"] is True

    def test_agent_missing_id_attribute_doesnt_crash(self):
        """Defensive: SimpleNamespace without `id` still works."""
        agent = SimpleNamespace(allowed_tools=frozenset())
        block = check_allowlist_block(agent, "rename_element")
        assert block is not None
        # Error message falls back to "?" when id is missing.
        assert "?" in block["error"]
