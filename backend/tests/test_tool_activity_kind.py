from app.services.tools import tool_activity_kind, tool_tier, write_edit_tool_names


def test_tool_activity_kind_distinguishes_user_visible_effects():
    assert tool_activity_kind("query_elements") == "read_only"
    assert tool_activity_kind("viewer_control") == "viewer_action"
    assert tool_activity_kind("validate_model") == "validation"
    assert tool_activity_kind("edit_semantic") == "semantic_edit"
    assert tool_activity_kind("edit_structural") == "geometry_edit"
    assert tool_activity_kind("execute_ifc_query_code") == "code_read"
    assert tool_activity_kind("execute_ifc_code") == "code_edit"
    assert tool_activity_kind("undo_last_edit") == "model_edit"


def test_edit_history_is_read_only_and_available_outside_edit_mode():
    assert tool_tier("get_edit_history")[0] == "read_model"
    assert "get_edit_history" not in write_edit_tool_names()
