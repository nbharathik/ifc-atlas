from types import SimpleNamespace
from unittest.mock import patch

from app.services.operation_service import Actor
from app.services.tools import _execute_tool_raw


def _envelope():
    change = SimpleNamespace(model_dump=lambda: {
        "express_id": 42,
        "ifc_type": "IfcWall",
        "change": "renamed",
    })
    return SimpleNamespace(
        edit_id="pending-1",
        summary="Preview semantic edit",
        counts={"renamed": 1},
        changes=[change],
        verifier_verdict={"status": "pass"},
    )


def test_chat_agent_semantic_write_is_staged_for_approval():
    with (
        patch("app.services.tools.ifc_service") as service,
        patch("app.services.tools.sandbox_service.propose_edit", return_value=_envelope()) as propose,
    ):
        service.is_loaded = True
        result = _execute_tool_raw(
            "rename_element",
            {"element_id": 42, "new_name": "External wall"},
            actor=Actor.AGENT,
        )

    assert result.get("action") == "pending_edit", result
    assert result["edit_id"] == "pending-1"
    propose.assert_called_once()
    assert propose.call_args.kwargs["operations"] == [{
        "op": "set_name",
        "element_id": 42,
        "new_name": "External wall",
    }]


def test_chat_agent_attribute_write_uses_controlled_sandbox_op():
    with (
        patch("app.services.tools.ifc_service") as service,
        patch("app.services.tools.sandbox_service.propose_edit", return_value=_envelope()) as propose,
    ):
        service.is_loaded = True
        result = _execute_tool_raw(
            "update_element_attribute",
            {"element_id": 42, "attribute": "Description", "new_value": "Fire wall"},
            actor=Actor.AGENT,
        )

    assert result.get("action") == "pending_edit", result
    assert propose.call_args.kwargs["operations"][0]["op"] == "set_attribute"
