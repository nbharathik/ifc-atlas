"""Tests for the get_cost_summary / get_carbon_summary chat tools.

Pure unit tests: the BoQ / carbon computation is patched at the tools-module
import site, so no real IfcOpenShell model or file IO is needed. The tests
verify argument validation, the summary envelope shape, coverage math, and
tier/tool-set registration.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

FAKE_BOQ = {
    "currency": "USD",
    "group_by": ["ifc_class"],
    "rows": [
        {
            "key": {"ifc_class": "IfcWall"},
            "label": "IfcWall",
            "ifc_class": "IfcWall",
            "count": 10,
            "basis": "area",
            "unit": "m2",
            "quantity": 100.0,
            "rate": 45.0,
            "amount": 4500.0,
            "priced": True,
            "element_ids": None,
        },
        {
            "key": {"ifc_class": "IfcMysteryThing"},
            "label": "IfcMysteryThing",
            "ifc_class": "IfcMysteryThing",
            "count": 2,
            "basis": "count",
            "unit": "nr",
            "quantity": 2.0,
            "rate": 0.0,
            "amount": 0.0,
            "priced": False,
            "element_ids": None,
        },
    ],
    "total": 4500.0,
    "priced_rows": 1,
    "total_rows": 2,
    "truncated": False,
}

FAKE_CARBON = {
    "group_by": ["material"],
    "rows": [
        {
            "key": {"material": "Concrete"},
            "label": "Concrete",
            "material": "Concrete",
            "count": 12,
            "basis": "volume",
            "unit": "m3",
            "quantity": 10.0,
            "factor": 120.0,
            "carbon_kg": 1200.0,
            "factored": True,
            "element_ids": None,
        },
        {
            "key": {"material": "Unobtainium"},
            "label": "Unobtainium",
            "material": "Unobtainium",
            "count": 1,
            "basis": "volume",
            "unit": "m3",
            "quantity": 0.0,
            "factor": 0.0,
            "carbon_kg": 0.0,
            "factored": False,
            "element_ids": None,
        },
    ],
    "total_kg": 1200.0,
    "total_tonnes": 1.2,
    "factored_rows": 1,
    "total_rows": 2,
    "truncated": False,
}


def _run_cost(arguments: dict, boq: dict = FAKE_BOQ):
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as svc, patch(
        "app.services.tools.compute_boq", return_value=boq
    ) as fake:
        svc.is_loaded = True
        svc.get_model_contract.return_value = {
            "model_fingerprint": "f",
            "model_version": 1,
            "edit_id": None,
        }
        result = execute_tool("get_cost_summary", arguments)
    return result, fake


def _run_carbon(arguments: dict, carbon: dict = FAKE_CARBON):
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as svc, patch(
        "app.services.tools.compute_carbon", return_value=carbon
    ) as fake:
        svc.is_loaded = True
        svc.get_model_contract.return_value = {
            "model_fingerprint": "f",
            "model_version": 1,
            "edit_id": None,
        }
        result = execute_tool("get_carbon_summary", arguments)
    return result, fake


# ---------------------------------------------------------------------------
# get_cost_summary
# ---------------------------------------------------------------------------


def test_cost_summary_happy_path():
    result, _ = _run_cost({})
    assert result["currency"] == "USD"
    assert result["total"] == 4500.0
    assert result["total_rows"] == 2
    assert result["priced_rows"] == 1
    assert result["priced_coverage_pct"] == 50.0
    assert result["unpriced_row_labels"] == ["IfcMysteryThing"]
    assert "placeholder" in result["note"]
    # element_ids stripped from every row
    assert all("element_ids" not in row for row in result["rows"])


def test_cost_summary_group_by_forwarded():
    result, fake = _run_cost({"group_by": ["storey"]})
    assert "error" not in result
    args = fake.call_args[0]
    assert args[1] == ["storey"]  # extra_group_by


def test_cost_summary_reserved_group_by_skipped():
    result, fake = _run_cost({"group_by": ["ifc_class", "storey"]})
    assert "error" not in result
    assert fake.call_args[0][1] == ["storey"]


def test_cost_summary_invalid_group_by_errors():
    result, _ = _run_cost({"group_by": ["colour"]})
    assert "error" in result
    assert "Unknown group_by" in result["error"]


def test_cost_summary_top_rows_caps_rows_not_totals():
    result, _ = _run_cost({"top_rows": 1})
    assert result["rows_shown"] == 1
    assert len(result["rows"]) == 1
    assert result["total"] == 4500.0
    assert result["total_rows"] == 2
    assert "rows_note" in result


def test_cost_summary_no_model_error():
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as svc:
        svc.is_loaded = False
        result = execute_tool("get_cost_summary", {})
    assert result == {"error": "No IFC model is currently loaded."}


# ---------------------------------------------------------------------------
# get_carbon_summary
# ---------------------------------------------------------------------------


def test_carbon_summary_happy_path():
    result, _ = _run_carbon({})
    assert result["total_kg"] == 1200.0
    assert result["total_tonnes"] == 1.2
    assert result["factored_rows"] == 1
    assert result["factored_coverage_pct"] == 50.0
    assert result["unfactored_row_labels"] == ["Unobtainium"]
    assert "placeholder" in result["note"]
    assert all("element_ids" not in row for row in result["rows"])


def test_carbon_summary_group_by_forwarded():
    result, fake = _run_carbon({"group_by": ["storey", "material"]})
    assert "error" not in result
    # reserved 'material' silently skipped, storey forwarded
    assert fake.call_args[0][1] == ["storey"]


def test_carbon_summary_invalid_group_by_errors():
    result, _ = _run_carbon({"group_by": ["nonsense"]})
    assert "error" in result
    assert "Unknown group_by" in result["error"]


def test_carbon_summary_no_model_error():
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as svc:
        svc.is_loaded = False
        result = execute_tool("get_carbon_summary", {})
    assert result == {"error": "No IFC model is currently loaded."}


# ---------------------------------------------------------------------------
# Registration: definitions, tier, tool sets
# ---------------------------------------------------------------------------


def test_new_tools_registered_in_definitions_and_tier():
    from app.services.tools import TOOL_BY_NAME, tool_tier

    for name in (
        "get_cost_summary",
        "get_carbon_summary",
        "get_element_relationships",
        "run_model_audit",
    ):
        assert name in TOOL_BY_NAME, name
        assert tool_tier(name)[0] == "read_model", name
        assert TOOL_BY_NAME[name].get("where") == "server", name


def test_new_tools_in_builtin_read_tool_sets():
    from app.services.tool_sets import tool_set_registry

    read_only = tool_set_registry.get("read-only")
    ask_default = tool_set_registry.get("ask-default")
    quantity = tool_set_registry.get("quantity")
    assert read_only is not None and ask_default is not None and quantity is not None
    for name in (
        "get_cost_summary",
        "get_carbon_summary",
        "get_element_relationships",
        "run_model_audit",
    ):
        assert name in read_only.tools, name
        assert name in ask_default.tools, name
    assert "get_cost_summary" in quantity.tools
    assert "get_carbon_summary" in quantity.tools
