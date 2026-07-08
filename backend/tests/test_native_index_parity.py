"""Parity tests for native_index vs IfcOpenShell tool paths.

Readiness-aware routing serves 6 read tools through
``metadata_index_service`` (the native TS metadata index) when
IfcOpenShell isn't ready. The catch: two
code paths serve the same tool, so a field added to one branch and not
the other silently diverges - bug is invisible until a user notices
the LLM's answer differs depending on warmup state.

This test suite mocks both ``ifc_service`` and ``metadata_index_service``
with synthetic-but-identical data, calls each tool through each path,
and asserts that the **normalized output** matches.

What's a "normalized" comparison:
- ``_source`` and ``_complete`` differ by design (they identify which
  path served the query); stripped before comparison.
- ``_memo`` is set by the tool cache; stripped.
- Field types must match (no string-vs-int divergence).
- Top-level key set must match.
- For list-valued fields, lengths must match.

Full data-equivalence parity (load BasicHouse.ifc, build native index
via sidecar, compare actual element IDs) is deferred to a v1.1
``requires_ifc_load``-marked suite - requires a running sidecar +
Linux CI to avoid the Windows/Py3.13 SIGSEGV in IfcOpenShell.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.services.tools import _NATIVE_INDEX_ELIGIBLE_TOOLS, _execute_tool_raw


# ---------------------------------------------------------------------------
# Comparable shapes
# ---------------------------------------------------------------------------

_INTERNAL_KEYS = {"_source", "_complete", "_memo"}


def _stripped(result: dict) -> dict:
    """Drop router-internal annotations so the two paths' outputs can be
    compared key-for-key."""
    return {k: v for k, v in result.items() if k not in _INTERNAL_KEYS}


def _type_signature(value: object) -> str:
    """Stable type signature so the parity comparison ignores values
    but pins types (string-vs-int divergence guard)."""
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, str):
        return "str"
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        return "dict"
    if value is None:
        return "none"
    return type(value).__name__


def _shape_signature(d: dict) -> dict[str, str]:
    """Map each key to its value's type. Two outputs with identical
    shape_signatures have identical structural contracts."""
    return {k: _type_signature(v) for k, v in d.items()}


# ---------------------------------------------------------------------------
# Synthetic fixtures
# ---------------------------------------------------------------------------


def _project_info_model_dump() -> dict:
    """ifc_service.get_project_info().model_dump() shape."""
    return {
        "name": "BasicHouse",
        "description": "Demo IFC",
        "schema_version": "IFC4",
        "author": None,
        "organization": None,
    }


def _native_project_info() -> dict:
    """metadata_index_service.get_project_info() returns a raw dict
    (not a Pydantic model) in the same shape as the ifc_service one."""
    return _project_info_model_dump()


def _model_stats_dump() -> dict:
    return {
        "total_elements": 149,
        "by_type": {"IfcWall": 12, "IfcDoor": 5},
        "storeys": ["Floor 0", "Floor 1"],
        "schema_version": "IFC4",
    }


def _element_summary(express_id: int, name: str = "x") -> SimpleNamespace:
    return SimpleNamespace(
        model_dump=lambda: {
            "express_id": express_id,
            "global_id": f"g{express_id}",
            "ifc_type": "IfcWall",
            "name": name,
            "storey": "Floor 0",
        }
    )


def _storey_summary(idx: int) -> SimpleNamespace:
    return SimpleNamespace(
        model_dump=lambda: {
            "express_id": 100 + idx,
            "name": f"Floor {idx}",
            "elevation": idx * 3.0,
        }
    )


@pytest.fixture
def both_backends_loaded(monkeypatch):
    """Wire ``ifc_service`` + ``metadata_index_service`` so both serve
    the same synthetic data. The autouse repo-wide conftest already
    marks ifcopenshell ready; we only need to stub the data methods."""
    from app.services import tools as tools_mod

    # ifc_service stubs - return identical-shape data to the native path.
    fake_ifc = MagicMock()
    fake_ifc.is_loaded = True
    fake_ifc.get_project_info.return_value = SimpleNamespace(
        model_dump=_project_info_model_dump
    )
    fake_ifc.get_model_stats.return_value = SimpleNamespace(
        model_dump=_model_stats_dump
    )
    fake_ifc.search.return_value = SimpleNamespace(
        model_dump=lambda: {
            "elements": [_element_summary(1).model_dump()],
            "total": 1,
            "query": "wall",
        }
    )
    fake_ifc.get_elements_by_type.return_value = [_element_summary(1), _element_summary(2)]
    fake_ifc.get_elements_by_storey.return_value = [_element_summary(1)]
    fake_ifc.get_storeys.return_value = [_storey_summary(0), _storey_summary(1)]
    monkeypatch.setattr(tools_mod, "ifc_service", fake_ifc)

    # metadata_index_service stubs - same data shape.
    fake_mi = MagicMock()
    fake_mi.is_loaded = True
    fake_mi.get_project_info.return_value = _native_project_info()
    fake_mi.get_model_stats.return_value = _model_stats_dump()
    fake_mi.search.return_value = [_element_summary(1)]
    fake_mi.get_elements_by_type.return_value = [
        _element_summary(1), _element_summary(2)
    ]
    fake_mi.get_elements_by_storey.return_value = [_element_summary(1)]
    fake_mi.get_storeys.return_value = [_storey_summary(0), _storey_summary(1)]
    monkeypatch.setattr(tools_mod, "metadata_index_service", fake_mi)

    return fake_ifc, fake_mi


def _call_via_native(monkeypatch, tool_name: str, args: dict) -> dict:
    """Route the call through the native_index path."""
    # Force _native_index_ready to True; the body picks `_mi`.
    from app.services import tools as tools_mod
    monkeypatch.setattr(tools_mod, "_native_index_ready", lambda: True)
    return _execute_tool_raw(tool_name, args)


def _call_via_ifcopenshell(monkeypatch, tool_name: str, args: dict) -> dict:
    """Route the call through the ifcopenshell path."""
    from app.services import tools as tools_mod
    # Disable native_index so `_mi` is None inside the body.
    monkeypatch.setattr(tools_mod, "_native_index_ready", lambda: False)
    return _execute_tool_raw(tool_name, args)


# ---------------------------------------------------------------------------
# Per-tool parity
# ---------------------------------------------------------------------------


class TestParityShape:
    """Structural parity - both paths return same key set + types."""

    def test_get_project_info_parity(self, both_backends_loaded, monkeypatch):
        native = _call_via_native(monkeypatch, "get_project_info", {})
        full = _call_via_ifcopenshell(monkeypatch, "get_project_info", {})
        assert _shape_signature(_stripped(native)) == _shape_signature(_stripped(full))
        # Both must carry _source + _complete (readiness-routing annotations).
        for r in (native, full):
            assert "_source" in r
            assert "_complete" in r

    def test_get_model_stats_parity(self, both_backends_loaded, monkeypatch):
        native = _call_via_native(monkeypatch, "get_model_stats", {})
        full = _call_via_ifcopenshell(monkeypatch, "get_model_stats", {})
        assert _shape_signature(_stripped(native)) == _shape_signature(_stripped(full))

    def test_search_elements_parity(self, both_backends_loaded, monkeypatch):
        native = _call_via_native(monkeypatch, "search_elements", {"query": "wall"})
        full = _call_via_ifcopenshell(monkeypatch, "search_elements", {"query": "wall"})
        assert _shape_signature(_stripped(native)) == _shape_signature(_stripped(full))
        assert _stripped(native).get("total") == _stripped(full).get("total")
        assert _stripped(native).get("query") == _stripped(full).get("query")

    def test_get_elements_by_type_parity(self, both_backends_loaded, monkeypatch):
        args = {"ifc_type": "IfcWall"}
        native = _call_via_native(monkeypatch, "get_elements_by_type", args)
        full = _call_via_ifcopenshell(monkeypatch, "get_elements_by_type", args)
        assert _shape_signature(_stripped(native)) == _shape_signature(_stripped(full))
        assert _stripped(native).get("ifc_type") == _stripped(full).get("ifc_type")
        assert _stripped(native).get("count") == _stripped(full).get("count")

    def test_get_elements_by_storey_parity(self, both_backends_loaded, monkeypatch):
        args = {"storey_id": 100}
        native = _call_via_native(monkeypatch, "get_elements_by_storey", args)
        full = _call_via_ifcopenshell(monkeypatch, "get_elements_by_storey", args)
        assert _shape_signature(_stripped(native)) == _shape_signature(_stripped(full))
        assert _stripped(native).get("storey_id") == _stripped(full).get("storey_id")
        assert _stripped(native).get("count") == _stripped(full).get("count")

    def test_get_storeys_parity(self, both_backends_loaded, monkeypatch):
        native = _call_via_native(monkeypatch, "get_storeys", {})
        full = _call_via_ifcopenshell(monkeypatch, "get_storeys", {})
        assert _shape_signature(_stripped(native)) == _shape_signature(_stripped(full))
        # Both should return a `storeys` list of the same length.
        assert len(_stripped(native)["storeys"]) == len(_stripped(full)["storeys"])


class TestParityAnnotations:
    """Readiness-routing annotations - _source + _complete semantics."""

    def test_native_path_marks_source_native(self, both_backends_loaded, monkeypatch):
        for tool in _NATIVE_INDEX_ELIGIBLE_TOOLS:
            args: dict = {}
            if tool == "search_elements":
                args = {"query": "x"}
            elif tool == "get_elements_by_type":
                args = {"ifc_type": "IfcWall"}
            elif tool == "get_elements_by_storey":
                args = {"storey_id": 100}
            result = _call_via_native(monkeypatch, tool, args)
            assert result["_source"] == "native_index", \
                f"{tool}: native path should mark _source='native_index'"

    def test_ifcopenshell_path_marks_source_ifcopenshell(
        self, both_backends_loaded, monkeypatch,
    ):
        for tool in _NATIVE_INDEX_ELIGIBLE_TOOLS:
            args: dict = {}
            if tool == "search_elements":
                args = {"query": "x"}
            elif tool == "get_elements_by_type":
                args = {"ifc_type": "IfcWall"}
            elif tool == "get_elements_by_storey":
                args = {"storey_id": 100}
            result = _call_via_ifcopenshell(monkeypatch, tool, args)
            assert result["_source"] == "ifcopenshell", \
                f"{tool}: ifcopenshell path should mark _source='ifcopenshell'"

    def test_ifcopenshell_path_always_complete(
        self, both_backends_loaded, monkeypatch,
    ):
        """ifcopenshell is the full path - _complete is always True."""
        for tool in _NATIVE_INDEX_ELIGIBLE_TOOLS:
            args: dict = {}
            if tool == "search_elements":
                args = {"query": "x"}
            elif tool == "get_elements_by_type":
                args = {"ifc_type": "IfcWall"}
            elif tool == "get_elements_by_storey":
                args = {"storey_id": 100}
            result = _call_via_ifcopenshell(monkeypatch, tool, args)
            assert result["_complete"] is True

    def test_native_path_complete_when_ifcopenshell_loaded(
        self, both_backends_loaded, monkeypatch,
    ):
        """When ifc_service is ALSO loaded, native data matches the full
        data, so _complete should be True."""
        for tool in _NATIVE_INDEX_ELIGIBLE_TOOLS:
            args: dict = {}
            if tool == "search_elements":
                args = {"query": "x"}
            elif tool == "get_elements_by_type":
                args = {"ifc_type": "IfcWall"}
            elif tool == "get_elements_by_storey":
                args = {"storey_id": 100}
            result = _call_via_native(monkeypatch, tool, args)
            assert result["_complete"] is True
