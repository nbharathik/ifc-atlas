"""Edit scope: semantic (no viewer reload) vs structural (reload).

Semantic scope must strip the structural write tools so property/metadata
edits never reload the 3D viewer and the agent stays constrained. See
dev/docs/EDIT_SCOPES.md.
"""

from unittest.mock import patch

import pytest

from app.services.tools import (
    semantic_write_tool_names,
    structural_write_tool_names,
    write_edit_tool_names,
)


# ── classification ───────────────────────────────────────────────────────────

def test_structural_and_semantic_partition_the_write_tools():
    structural = structural_write_tool_names()
    semantic = semantic_write_tool_names()
    # Disjoint, and together they cover every write tool.
    assert structural & semantic == set()
    assert structural | semantic == set(write_edit_tool_names())


def test_geometry_tools_are_structural():
    structural = structural_write_tool_names()
    for name in ("edit_structural", "execute_ifc_code"):
        assert name in structural, name


def test_metadata_tools_are_semantic():
    semantic = semantic_write_tool_names()
    for name in ("edit_semantic", "undo_last_edit"):
        assert name in semantic, name


def test_operation_catalogue_marks_reloads_viewer():
    from app.services.operation_service import OperationService, _register_builtins

    svc = OperationService()
    _register_builtins(svc)
    by_name = {op["name"]: op for op in svc.catalogue()}

    # Geometry ops reload; metadata ops don't.
    assert by_name["create_wall"]["reloads_viewer"] is True
    assert by_name["create_wall"]["scope"] == "structural"
    assert by_name["delete_element"]["reloads_viewer"] is True
    assert by_name["set_name"]["reloads_viewer"] is False
    assert by_name["set_name"]["scope"] == "semantic"
    assert by_name["set_property"]["reloads_viewer"] is False
    assert by_name["set_storey_elevation"]["reloads_viewer"] is False  # attribute only


# ── stream_chat tool filtering ───────────────────────────────────────────────

def _edit_agent():
    from app.services.agent_registry import get_agent
    return get_agent("edit-assistant")


async def _run_and_capture_allowed(edit_scope: str):
    """Run stream_chat with the edit agent and capture the allowed_tools that
    reach the streamer."""
    captured = {}

    async def _fake_stream(*args, **kwargs):
        captured["allowed_tools"] = kwargs.get("allowed_tools")
        yield {"type": "chunk", "content": "ok"}

    with patch("app.services.llm_service.get_agent", return_value=_edit_agent()), \
         patch("app.services.llm_service.stream_via_langgraph", side_effect=_fake_stream), \
         patch("app.services.llm_service.get_api_key", return_value="key"), \
         patch("app.services.llm_service.EDIT_MODE_ENABLED", True), \
         patch("app.services.chat_context.model_context_injector.inject",
               side_effect=lambda p, c: p):
        from app.services.llm_service import stream_chat
        async for _ in stream_chat("do it", [], provider="anthropic", edit_scope=edit_scope):
            pass
    return captured["allowed_tools"]


@pytest.mark.asyncio
async def test_semantic_scope_strips_structural_tools():
    allowed = await _run_and_capture_allowed("semantic")
    assert allowed is not None
    # Structural tools gone; semantic write tools + reads remain.
    assert "edit_structural" not in allowed
    assert "execute_ifc_code" not in allowed
    assert "edit_semantic" in allowed
    assert "query_elements" in allowed


@pytest.mark.asyncio
async def test_structural_scope_keeps_structural_tools():
    allowed = await _run_and_capture_allowed("structural")
    assert allowed is not None
    assert "edit_structural" in allowed
    assert "execute_ifc_code" in allowed
    assert "edit_semantic" in allowed
