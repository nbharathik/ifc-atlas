"""Capability guard: warn when an edit turn uses a non-tool-calling model.

Editing requires tool calling. Pointing an edit-category agent at a model the
registry marks as non-tool-calling (common on OpenRouter) used to silently
produce a chat reply that never edited anything - looking like a hang. The
guard emits an explicit warning chunk first.
"""

from unittest.mock import MagicMock, patch

import pytest

from app.services.agent_registry import AgentPreset
from app.services.model_registry import ModelEntry


def _edit_agent():
    return AgentPreset(
        id="edit-assistant", label="Edit", description="", system_prompt="edit",
        provider="anthropic", model="claude-sonnet-4-20250514", temperature=0.1,
        icon="edit", category="edit",
    )


def _ask_agent():
    return AgentPreset(
        id="default", label="Default", description="", system_prompt="ask",
        provider="openai", model="gpt-4o", temperature=0.3, icon="star", category="ask",
    )


def _entry(supports_tools: bool):
    return ModelEntry(
        id="or-model", provider="openrouter", model_id="some/model",
        display_name="Some OR Model", supports_tools=supports_tools,
    )


async def _run(agent, entry):
    async def _fake_stream(*a, **kw):
        yield {"type": "chunk", "content": "(model reply)"}

    reg = MagicMock()
    reg.get.return_value = entry
    with patch("app.services.llm_service.get_agent", return_value=agent), \
         patch("app.services.llm_service.stream_via_langgraph", side_effect=_fake_stream), \
         patch("app.services.llm_service.get_api_key", return_value="key"), \
         patch("app.services.model_registry.model_registry", reg), \
         patch("app.services.model_context_injector.model_context_injector.inject", side_effect=lambda p, c: p):
        from app.services.llm_service import stream_chat
        return [
            ev async for ev in stream_chat(
                "add a wall", [], provider="openrouter", model_registry_id="or-model",
            )
        ]


@pytest.mark.asyncio
async def test_edit_turn_warns_on_non_tool_model():
    events = await _run(_edit_agent(), _entry(supports_tools=False))
    warnings = [e for e in events if e.get("type") == "chunk" and "tool calling" in e.get("content", "")]
    assert warnings, "expected a capability warning for a non-tool edit model"
    assert "Some OR Model" in warnings[0]["content"]


@pytest.mark.asyncio
async def test_edit_turn_no_warning_when_tools_supported():
    events = await _run(_edit_agent(), _entry(supports_tools=True))
    assert not [e for e in events if "not supporting tool calling" in e.get("content", "")]


@pytest.mark.asyncio
async def test_ask_turn_never_warns():
    """Ask agents are read-only; a non-tool model there is fine."""
    events = await _run(_ask_agent(), _entry(supports_tools=False))
    assert not [e for e in events if "not supporting tool calling" in e.get("content", "")]
