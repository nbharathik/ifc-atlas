"""Registry-model revalidation - stale selections are surfaced.

A model_registry_id can go stale between the moment the UI loaded the
catalogue and the moment the chat request arrives (entry deleted or disabled
in Chat Manager - Models). stream_chat used to fall through silently to the
request's raw provider/model; now it emits an in-band notice chunk describing
exactly what runs instead. Provider-side validation of the model id itself
(stale model_id hitting a 404) is surfaced via _friendly_provider_error.
"""

from unittest.mock import patch

import pytest

from app.services import model_registry as mr
from app.services.llm_service import _friendly_provider_error, stream_chat


@pytest.fixture
def reg(tmp_path, monkeypatch):
    """Fresh, seeded registry on a throwaway file, swapped in as the singleton
    that stream_chat resolves at call time."""
    monkeypatch.setattr(mr, "_DATA_DIR", tmp_path)
    monkeypatch.setattr(mr, "_MODELS_FILE", tmp_path / "models.json")
    fresh = mr.ModelRegistry()
    monkeypatch.setattr(mr, "model_registry", fresh)
    return fresh


def _capture_stream(seen: dict):
    """stream_via_langgraph stand-in that records the resolved routing."""

    async def _fake(message, history, provider, model, temperature,
                    tool_executor, **kwargs):
        seen["provider"] = provider
        seen["model"] = model
        yield {"type": "chunk", "content": "ok"}

    return _fake


async def _run_chat(model_registry_id: str | None):
    events = []
    async for ev in stream_chat(
        message="hi",
        history=[],
        provider="openai",
        model="gpt-4o",
        model_registry_id=model_registry_id,
    ):
        events.append(ev)
    return events


@pytest.mark.asyncio
async def test_valid_enabled_entry_resolves_without_notice(reg):
    """Happy path pinned: an enabled entry routes provider/model with no
    revalidation notice injected into the turn."""
    seen: dict = {}
    with patch("app.services.llm_service.stream_via_langgraph", new=_capture_stream(seen)):
        events = await _run_chat("anthropic-claude-haiku-4-5")

    assert seen == {"provider": "anthropic", "model": "claude-haiku-4-5"}
    assert [e["content"] for e in events if e["type"] == "chunk"] == ["ok"]


@pytest.mark.asyncio
async def test_missing_entry_emits_notice_and_falls_back(reg):
    """A deleted/unknown registry id is surfaced, not silently substituted."""
    seen: dict = {}
    with patch("app.services.llm_service.stream_via_langgraph", new=_capture_stream(seen)):
        events = await _run_chat("ghost-entry")

    # Falls back to the request's explicit provider/model.
    assert seen == {"provider": "openai", "model": "gpt-4o"}
    notice = events[0]
    assert notice["type"] == "chunk"
    assert "ghost-entry" in notice["content"]
    assert "no longer exists" in notice["content"]
    assert "openai/gpt-4o" in notice["content"]
    assert events[-1]["content"] == "ok"


@pytest.mark.asyncio
async def test_disabled_entry_snaps_to_enabled_same_provider(reg):
    """Disabled entry: snap to the first enabled entry of the same provider
    and say so."""
    reg.set_enabled("openai-gpt-5-5", False)
    seen: dict = {}
    with patch("app.services.llm_service.stream_via_langgraph", new=_capture_stream(seen)):
        events = await _run_chat("openai-gpt-5-5")

    assert seen["provider"] == "openai"
    assert seen["model"] == "gpt-5.5-pro", "first enabled openai entry in sort order"
    notice = events[0]
    assert notice["type"] == "chunk"
    assert "disabled" in notice["content"]
    assert "GPT-5.5 Pro" in notice["content"]


@pytest.mark.asyncio
async def test_disabled_entry_without_alternative_proceeds_with_notice(reg):
    """When no other enabled entry exists for the provider, the disabled entry
    still runs - but never silently."""
    for m in reg.all():
        if m.provider == "openai":
            reg.set_enabled(m.id, False)
    seen: dict = {}
    with patch("app.services.llm_service.stream_via_langgraph", new=_capture_stream(seen)):
        events = await _run_chat("openai-gpt-5-5")

    assert seen == {"provider": "openai", "model": "gpt-5.5"}
    notice = events[0]
    assert notice["type"] == "chunk"
    assert "no other enabled entry" in notice["content"]


def test_friendly_error_surfaces_stale_model_id():
    """Provider-side revalidation: a model-not-found rejection classifies as
    an expected operational error with an actionable message, instead of a
    raw 404 blob."""
    openai_style = RuntimeError(
        "Error code: 404 - {'error': {'message': 'The model `gpt-9-turbo` does "
        "not exist or you do not have access to it.', 'code': 'model_not_found'}}"
    )
    msg = _friendly_provider_error("openai", openai_style)
    assert msg is not None
    assert "model" in msg.lower()
    assert "Models" in msg  # points at Chat Manager - Models

    anthropic_style = RuntimeError("model: claude-nonexistent-9")
    anthropic_style.status_code = 404
    assert _friendly_provider_error("anthropic", anthropic_style) is not None

    # Unrecognised errors still keep the full traceback path (return None).
    assert _friendly_provider_error("openai", RuntimeError("some weird bug")) is None
